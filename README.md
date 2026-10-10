# cc-usermanage

**English** | [한국어](README.ko.md)

Keep several Claude Code accounts on one machine as profiles. Switch the account your home directory (`~/`) uses, and check each account's plan usage.

> **Unofficial tool.** It is not made or endorsed by Anthropic and is not affiliated with Anthropic. It relies on Claude Code's local file layout and on experimental output, so a Claude Code update may break it.

- Plain Node.js, no dependencies.
- All server communication (usage lookups, token refresh) is delegated to the official `claude` CLI. **This tool never calls Anthropic endpoints directly.** It only reads and writes local files and runs `claude`.
- Every command prints **exactly one JSON object** to stdout. Nothing is written to stderr.
- Program messages (`error` strings, `help` text) are currently in Korean. Field names and status values are English.

## Contents

1. [Install and quick start](#install-and-quick-start)
2. [Profile folder](#profile-folder)
3. [Commands](#commands)
4. [How it works](#how-it-works): usage lookup, tokens, vault sync, auto-registration, expired login
5. [Usability rule](#usability-rule)
6. [Automatic account selection](#automatic-account-selection)
7. [Response format](#response-format)
8. [Exit codes](#exit-codes)
9. [Errors](#errors)
10. [Cautions](#cautions)
11. [Configuration](#configuration)

## Install and quick start

```bash
npm install -g cc-usermanage     # then use the cc-usermanage command
npx cc-usermanage help           # run without installing
node usermanage.js help          # run from a checkout
```

```bash
cc-usermanage help                        # usage
cc-usermanage info                        # usage of all accounts
cc-usermanage info alice@example.com      # usage of one account
cc-usermanage turn alice@example.com      # switch to that account
cc-usermanage turn                        # switch to the account with the most headroom
cc-usermanage sync                        # copy the active account's latest token into its profile
```

**Requirements**
- Node.js 18+ (verified on 22). No dependencies.
- The `claude` CLI on `PATH` (verified on 2.1.296).
- Each account must be a claude.ai subscription (Pro / Max / Team, etc.). Usage data is only available in subscription sessions.
- **Linux** (verified). Claude Code must store credentials in the file `~/.claude/.credentials.json`.
  - **macOS is not supported.** Claude Code on macOS stores credentials in the Keychain. The tool exits with an error on macOS.
  - Windows is untested.

**Intended use**: managing several accounts you are legitimately entitled to use on one machine, for example switching between a personal and a work account. Rotating multiple seats or accounts to get around usage limits may violate Anthropic's terms. Check the terms before use.

## Profile folder

Each account gets its own folder (a profile) under the **vault, `~/.claude.credentials/`**. A profile has the same layout as a home directory.

```
~/                                       # home: the account in use
├── .claude.json
├── .claude/
│   └── .credentials.json
└── .claude.credentials/                 # vault (mode 700)
    ├── <any name>/
    │   ├── .claude.json                 # account identified by oauthAccount.emailAddress
    │   └── .claude/
    │       └── .credentials.json        # OAuth tokens (claudeAiOauth)
    └── <any name>/
        └── ...
```

- **Folder names don't matter.** Accounts are found by `oauthAccount.emailAddress` in `.claude.json`, not by folder name. Email comparison is case-insensitive.
- Folders missing either file, or without an email, are ignored. Extra files (backups, caches) are fine.
- These folders are skipped and reported in `skipped_profiles` (in `info` for all accounts and in automatic `turn`). One bad profile doesn't affect the others.
  - A folder whose `.claude.json` cannot be parsed.
  - A folder with the **same email** as one already found. There is no way to tell which copy holds the newer token, so only the first one is used and you are asked to keep just one.
- **Adding an account (auto-registration)**: log in to Claude Code with that account in your home (`claude` → `/login`), then run any command once (e.g. `cc-usermanage sync`). If the home account is not in the vault, **a new profile folder is created automatically** ([Auto-registration](#auto-registration)). You can also create one by hand: copy that account's `~/.claude.json` and `~/.claude/.credentials.json` into a new folder with the same layout.
- Change the location with the `USERMANAGE_DIR` environment variable. The default is `~/.claude.credentials/`, where `~` is the running user's `HOME`. The same vault is used wherever the script lives.
- Claude Code only uses `~/.claude/` and `~/.claude.json`; it never touches `~/.claude.credentials/`.

> ⚠️ This folder holds live OAuth tokens. Never commit or share it. File modes stay at `600`.

## Commands

| Command | What it does | Changes home |
|---|---|---|
| `turn <email>` | Switches the home account to `<email>`, regardless of usage. | Yes |
| `turn` | Looks up every account's usage and switches to the one with the most headroom. | Only if needed |
| `info <email>` | Looks up the plan usage of `<email>`. | No |
| `info` | Looks up the plan usage of every account, in parallel. | No |
| `sync` | Copies the active home account's latest credentials into its profile. Creates and registers the profile if missing. | No |
| `help` (`--help`, `-h`) | Prints usage as JSON. | No |

Every command except `sync` **first runs the same sync automatically** ([Vault sync](#vault-sync)). The result is in the response's `sync` field.

Running with no command, an unknown command, or too many arguments is a usage error (exit code 1).

### `turn <email>`: switch to a given account

1. Find the `<email>` profile. If none matches, fail with the list of available emails.
2. If home is already that account, change nothing (`changed: false`). Only the email is compared.
3. **Check the target's credentials file.** If it is corrupt or its tokens are empty (already logged out), change nothing and fail with `ok: false`, `login_required: true`. This keeps a live home token from being overwritten by an unusable one. Tokens that are present but rejected by the server (e.g. expired refresh token) can only be detected by running `claude`, so they pass this check.
4. **Save the outgoing account's latest token back to its profile.** Only the `claudeAiOauth` key of the profile's credentials file and the `oauthAccount` key of its `.claude.json` are replaced. This step is skipped (`saved_previous_to: null`) when:
   - the home account has no profile: normally impossible, because it is [auto-registered](#auto-registration) at the start of every command. If registration failed, that account's token survives only in the backup below.
   - the home credentials are empty or corrupt: the profile's existing token is not overwritten.
5. Back up the two home files to `~/.claude/backups/`:
   - `.credentials.json.usermanage.<timestamp>`
   - `.claude.json.usermanage.<timestamp>`
6. Switch. **Only the one key used for auth is replaced in each file; everything else is kept.**
   - `~/.claude/.credentials.json`: **only `claudeAiOauth`** is replaced with the target's. Other keys (e.g. credentials for other services) stay. If the home file is corrupt and cannot be parsed, nothing can be preserved, so a new file with just `claudeAiOauth` is written; the corrupt original remains in the backup.
   - `~/.claude.json`: **only `oauthAccount`** is replaced. Projects, settings, and all other keys stay. `userID` and `machineID` identify this install/machine and are not changed.

`claudeAiOauth` holds `accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`. `oauthAccount` holds the account profile: email, name, account/org UUIDs, role, etc.

All writes go to a temp file followed by `rename`, so no half-written file is left behind. Files are written with mode `600` and in Claude Code's own format (`.credentials.json` as single-line JSON, `.claude.json` with 2-space indent).

> `~/.claude.json` also contains cache keys that look account-specific (`cachedUsageUtilization`, `modelAccessCache`, ...). Following the keep-existing-data principle, these are left alone. Claude Code refreshes them for the new account as it runs, but right after a switch you may briefly see the previous account's cached info.

### `turn`: switch to the account with the most headroom

1. Look up every account's usage in parallel (same as `info`).
2. Pick an account using the [usability rule](#usability-rule) and [automatic account selection](#automatic-account-selection).
3. If it differs from the current account, switch the same way as `turn <email>`.

### `info <email>` / `info`: usage lookup

- Never changes the home account. Safe to run while a Claude Code session is open.
- `/usage` is a local Claude Code command and does not call a model. **It costs nothing.** One account takes about 3–5 s; `info` for all accounts runs in parallel, so it takes about the same.
- If a token is refreshed during the lookup, the new token is saved in the right place ([Tokens](#tokens)).

### `sync`: keep the vault current

Brings the active account's profile up to date with home. See [Vault sync](#vault-sync).

## How it works

### Usage lookup

For each account the tool runs the following and reads the output line by line:

```bash
claude -p /usage --output-format stream-json --verbose --no-session-persistence
```

- `-p`: run once, non-interactively.
- `--output-format stream-json`: one JSON message per line (`system`(init) → `assistant` → `result`).
- `usage_report.rate_limits` on the `assistant` message is the raw usage from the server. It is passed through as-is, plus a `summary` used for decisions.
- `claude_code_version` comes from the `system`(init) message.
- `--no-session-persistence`: don't accumulate session history.
- `claude` runs in an empty temp working directory (`/tmp/usermanage-XXXXXX/`) so that no project `CLAUDE.md`, settings, or hooks get mixed in.
- If it doesn't finish within 60 s, `claude` is terminated (SIGTERM, then SIGKILL after 5 s) and the lookup fails.

### Which account is queried

`claude` always reads credentials from `$HOME/.claude/.credentials.json`, so the account is selected by setting `HOME` when running `claude`.

| Account | How it runs |
|---|---|
| The active home account (`active: true`) | In the real home. |
| Any other account | A throwaway temp HOME (`/tmp/usermanage-home-XXXXXX/`) gets copies of the profile's `.claude.json` and `.claude/.credentials.json`, and `claude` runs with `HOME=<temp>`. |

The profile folder itself is not used as HOME because Claude Code would fill it with synced skills, caches, plugins, MCP logs, etc. (several MB).

Temp folders are removed when the lookup ends, even on error. If the process dies abruptly (`kill -9`, power loss) they can be left behind; remove them with `rm -rf /tmp/usermanage-*`. Set `TMPDIR` to change the location.

### Tokens

- **Access token**: valid for about 8 hours. When expired, `claude` uses the refresh token to get a new pair and overwrites the credentials file. This tool never refreshes tokens itself; it leaves that to `claude`.
- **Refresh tokens rotate.** Using one issues a new refresh token and **invalidates the old one.**
- Hence the rule: **an account's live token exists in exactly one place.**
  - For the active home account, home (`~/`) is authoritative. The profile copy may be stale.
  - For every other account, its profile is authoritative.
- To keep that rule:
  - `turn` saves the outgoing account's token back into its profile.
  - `info` queries the active account through home.
  - After a temp-HOME lookup, the tool checks whether the credentials changed (refreshed). If so, only the profile's `claudeAiOauth` key is replaced; other keys are kept. Refreshed tokens are saved even if the lookup failed.
  - However, **credentials whose tokens were wiped are never written back to a profile** ([Expired login](#expired-login)). The same applies to the outgoing account in `turn`.
- **Refreshing does not appear to extend the refresh token's expiry** (about 4 weeks). Once it expires, log in to that account again and refresh the profile. Each account's expiry is in `tokens.refresh_token_expires_at` in `info`.

### Vault sync

Tokens are refreshed continually while you use Claude Code. So **for the active account only the home token stays current, and the profile (vault) copy goes stale.** Because `turn` saves the latest token into the profile the moment you switch away, switching back and forth works fine. But if `~/.claude` gets deleted or damaged before then, the stale profile copy may not be enough to recover.

To reduce that risk, the tool copies home's latest credentials into the profile frequently.

- **When**
  - At the start of every command except `sync` (`turn`, `info`, `help`).
  - `info` does it once more at the end, since home's token may have been refreshed during the lookup.
  - On demand with `sync`.
- **What**
  - Only the profile credentials' `claudeAiOauth` key is replaced with home's.
  - Only the profile `.claude.json`'s `oauthAccount` key is replaced with home's.
  - Other keys are kept; nothing is written if already identical.
- **Why it's safe**: this tool never reads the active account's profile to use it (`info` goes through home). Keeping a copy there never results in the same token being used in two places.
- **When it doesn't copy**: if the home credentials are missing, corrupt, or have empty tokens (logged out), nothing is copied, to protect the profile's existing token.
- **Sync failures inside other commands never block the command.** They are only reported in the `sync` field.
- **Limitation**: between syncs, the profile goes stale again whenever home's token is refreshed. To keep it current at all times, run `sync` periodically (e.g. from cron).

| `sync.status` | Meaning | `ok` of the `sync` command |
|---|---|---|
| `synced` | Copied | `true` |
| `registered` | Home account wasn't in the vault; a new profile was created ([Auto-registration](#auto-registration)) | `true` |
| `up_to_date` | Already identical | `true` |
| `no_active_account` | No account is logged in at home | `false` |
| `home_credentials_unusable` | Home credentials missing, corrupt, or empty. Not copied | `false` |
| `error` | Exception during sync (only inside other commands; message in `error`) | n/a |

### Auto-registration

If the account logged in at home is **not in the vault at all**, sync creates a new profile for it. So running any command once guarantees the account is in the vault before you switch away. Switching away without registering would leave its token only in a backup file, making it hard to come back.

- **Folder name**: the email as-is (e.g. `~/.claude.credentials/new@example.com/`). Characters other than letters, digits, and `. _ @ + -` become `_`. If a folder with that name already exists, it is left untouched and a suffix like `-2`, `-3` is added.
- **Contents**: only the keys needed for auth. Home's projects or other services' credentials are not copied.
  - `.claude/.credentials.json`: `claudeAiOauth`
  - `.claude.json`: `oauthAccount`
- **Modes**: `.claude/` is `700`, files are `600`.
- **If the vault (`~/.claude.credentials/`) doesn't exist**, it is created with mode `700`. You can start with no profiles at all.
- **Not registered when** the home credentials are missing, corrupt, or empty (`home_credentials_unusable`).
- On registration, `sync.status` is `registered` and `sync.profile` is the new folder name.

### When something is wrong with the tokens

| Situation | Behavior | Result |
|---|---|---|
| Access token expired (refresh token valid) | `claude` refreshes and the lookup succeeds; the new token is saved | Success (`ok: true`) |
| Access and refresh tokens both expired or invalid | See [Expired login](#expired-login) | `login_required: true` |
| Credentials file has empty tokens (already logged out) | Fails immediately without running `claude` | `login_required: true` |
| Credentials file is not valid JSON | Fails immediately without running `claude` | `login_required: true` |
| Credentials file missing (active account) | Fails immediately without running `claude` | `login_required: true` |
| Profile `.claude.json` corrupt | Profile skipped | Listed in `skipped_profiles` |
| `turn <email>` target has empty or corrupt credentials | No switch (home and profiles untouched) | `ok: false`, `login_required: true` |

In every case the profile's credentials file is left unchanged. `info` for all accounts still queries the remaining accounts, and automatic `turn` picks from the rest.

### Expired login

What happens when both the access and refresh tokens are expired or invalid (reproduced and verified):

1. `claude` tries to refresh and fails.
2. `claude` **does not report an error**; it blanks `accessToken` and `refreshToken` and sets `expiresAt` to 0 in the credentials file. Effectively logged out.
3. `/usage` succeeds without subscription data and without a `usage_report`.

The tool detects this by checking, after `claude` exits, whether tokens remain in the credentials file.

- The account object gets `ok: false`, **`login_required: true`**, and an `error` saying the login has expired.
- For a profile account, the profile's credentials file is **not changed**. If the refresh failed for a transient reason, the original token may still be valid.
- For the active home account, `claude` blanks the home credentials itself. The tool cannot prevent that, so home ends up logged out.
- Automatic `turn` excludes this account (`unverified_accounts`). If it is the current account, `turn` switches to another one (`reason: current_account_unverified`) without saving the blanked home credentials into the profile (`saved_previous_to: null`).

**Recovery**: log in to that account again (`claude` → `/login`), then copy home's `~/.claude.json` and `~/.claude/.credentials.json` into that account's profile. If home is using another account, log in with an empty folder as `HOME` (`HOME=/tmp/newlogin claude`) to get fresh credentials without touching home.

## Usability rule

Each row of `usage_report.rate_limits.limits[]` has `kind`, `percent` (0–100), `resets_at` (ISO 8601), etc. The main kinds:

| kind | Meaning | Used for the rule |
|---|---|---|
| `session` | 5-hour limit | ✅ |
| `weekly_all` | Weekly limit (all models) | ✅ |
| `weekly_scoped` and others | Limit for a specific model (e.g. Fable) | ❌ (tie-breaker only) |

**Rule: an account is usable (`available`) when both `session` and `weekly_all` are below 100%.**

Details:
- If either is at or above 100%, the account is **`exhausted`**.
- **A limit missing from the response is treated as not existing on that plan.** For example, Team plan responses have no `weekly_all` row; then only `session` decides.
- **A limit whose `resets_at` has already passed counts as 0%**, on the assumption that the server value is lagging.
- The status is **`unknown`** when:
  - neither `session` nor `weekly_all` is present, or
  - either has a non-numeric `percent` (`null`, etc.).
- A model-specific limit (`weekly_scoped`, ...) at 100% only blocks that model, so it does not make the account exhausted.
- Accounts with extra usage (`extra_usage`) enabled can keep going past the limit at extra cost. This is not part of the rule; it is only reported as `extra_usage_enabled`.

Derived values:
- **`headroom`** = 100 − (highest percent among the rule's limits). That tightest limit is `binding_limit`.
- **`available_at`** = when all limits at 100% have reset. `null` if any exhausted limit has no `resets_at`. For usable accounts it is the lookup time.

## Automatic account selection

`turn` (without an email) picks an account as follows:

1. Look up every account in parallel. **Accounts whose lookup failed or are `unknown` are excluded** (`unverified_accounts`).
2. Sort the candidates:
   1. Usable before exhausted.
   2. Among usable: larger `headroom` first, then larger `scoped_headroom`.
   3. Among exhausted: earlier `available_at` first (unknown time last).
3. Decide:

| Situation | Action | `result` | `reason` |
|---|---|---|---|
| Current account usable, and the best one is less than `SWITCH_MARGIN` (10 pp) ahead | Keep | `unchanged` | `current_is_good_enough` |
| Current account usable, and the best one is at least 10 pp ahead | Switch to the best | `switched` | `better_account` |
| Current account exhausted | Switch to the best regardless of margin | `switched` | `current_account_exhausted` |
| Current account not a candidate (lookup failed, `unknown`, or no profile) | Switch to the best | `switched` | `current_account_unverified` |
| No usable account, all accounts verified | Switch to the **account that becomes available first**; keep the current one if it is as early | `all_exhausted` | `all_exhausted` |
| No usable account, some accounts unverified | Same as above | `no_usable_account` | `no_usable_account_some_unverified` |
| No candidates at all (all failed or `unknown`) | Change nothing | n/a (`ok: false`) | n/a |

The margin (`SWITCH_MARGIN`) prevents flipping between similar accounts on every run.

When no account is usable the exit code is `2`, and the response tells you which account frees up first, when, and how long from now:

- `next_available_account`: the account that becomes available first (the chosen one, same as `to`)
- `next_available_at`: when it becomes available
- `next_available_in_seconds`: seconds from the response until then (rounded up, minimum 0)

"Becomes available" means **all** of that account's limits at 100% have reset. E.g. if the 5-hour limit resets in 30 minutes and the weekly limit tomorrow, it is tomorrow. If the time is unknown, the time and seconds are `null`.

## Response format

Every response starts with these common fields:

| Field | Type | Description |
|---|---|---|
| `command` | string \| null | The command run (`turn`, `info`, `help`, ...). `null` if none |
| `ok` | boolean | Success |
| `error` | string | Only on failure. Human-readable message |
| `sync` | object | For every command except `sync`: the automatic sync result `{ status, synced, account, profile }` ([Vault sync](#vault-sync)). Absent if the command never started (e.g. usage error) |

For `info`, `sync.synced` is `true` if either of the two syncs (before/after) copied anything, and `status` is that of the last one.

All timestamps are ISO 8601 UTC strings (e.g. `2026-10-10T08:46:11.013Z`).

### Account object (`account`)

Used in `info`'s `account`, and in `accounts[]` of `info` (all) and automatic `turn`.

| Field | Type | Description |
|---|---|---|
| `email` | string | Account email |
| `profile` | string | Profile folder name |
| `active` | boolean | Whether this is the account currently in use at home |
| `ok` | boolean | Whether this account's lookup succeeded |
| `error` | string | Only on failure |
| `login_required` | boolean | Only on failure. `true` means the login expired and you must log in again ([Expired login](#expired-login)) |
| `tokens.access_token_expires_at` | string \| null | Access token expiry (as of after the lookup) |
| `tokens.refresh_token_expires_at` | string \| null | Refresh token expiry. After this you must log in again |
| `claude_code_version` | string \| null | Claude Code version used (success only) |
| `summary` | object | Decision summary (success only; see below) |
| `rate_limits` | object | Raw server data (success only; **omitted in automatic `turn`**) |

`tokens` is read from home's credentials for the active account and from the profile's for other accounts.

### Decision summary (`summary`)

| Field | Type | Description |
|---|---|---|
| `status` | `"available"` \| `"exhausted"` \| `"unknown"` | Result |
| `usable` | boolean | `status === "available"` |
| `headroom` | number \| null | Remaining headroom (%). `null` if `unknown` |
| `binding_limit` | object \| null | Tightest limit `{ kind, percent, resets_at }`. `null` if `unknown` |
| `available_at` | string \| null | When it becomes usable. Lookup time if usable; `null` if unknown |
| `checked_limits` | object | Percent per rule limit `{ session, weekly_all }`. `null` if absent. Limits past their reset time show 0 |
| `scoped_headroom` | number | Headroom against model-specific limits (%). 100 if none |
| `extra_usage_enabled` | boolean | Whether extra usage (overage) is enabled |

### Raw usage (`rate_limits`)

`usage_report.rate_limits` from `claude`, unmodified. Claude Code marks it **experimental**, so its shape may change between versions.

```json
{
  "limits": [
    {
      "kind": "session",
      "group": "session",
      "percent": 6,
      "resets_at": "2026-10-10T12:40:00.457052+00:00",
      "scope": null,
      "severity": "normal",
      "is_active": true
    },
    {
      "kind": "weekly_scoped",
      "group": "weekly",
      "percent": 0,
      "resets_at": "2026-10-11T21:00:00+00:00",
      "scope": { "model": { "display_name": "Fable" }, "surface": null },
      "severity": "normal",
      "is_active": false
    }
  ],
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null,
    "currency": null
  }
}
```

`severity` was observed as `"critical"` on an exhausted limit. `extra_usage.used_credits` is in minor currency units (cents for USD).

### `info <email>`

**Success** (exit 0)

```json
{
  "command": "info",
  "ok": true,
  "fetched_at": "2026-10-10T08:46:11.013Z",
  "account": {
    "email": "carol@example.com",
    "profile": "user3",
    "active": false,
    "ok": true,
    "tokens": {
      "access_token_expires_at": "2026-10-10T16:40:10.772Z",
      "refresh_token_expires_at": "2026-11-07T08:26:09.772Z"
    },
    "claude_code_version": "2.1.296",
    "summary": {
      "checked_limits": { "session": 0, "weekly_all": 100 },
      "scoped_headroom": 100,
      "extra_usage_enabled": false,
      "status": "exhausted",
      "usable": false,
      "headroom": 0,
      "binding_limit": {
        "kind": "weekly_all",
        "percent": 100,
        "resets_at": "2026-10-11T13:59:59.938095+00:00"
      },
      "available_at": "2026-10-11T13:59:59.938Z"
    },
    "rate_limits": { "limits": [ "..." ], "extra_usage": { "...": "..." } }
  },
  "sync": { "status": "up_to_date", "synced": false, "account": "bob@example.com", "profile": "user2" }
}
```

**Lookup failed** (exit 1): `account` has `ok: false` and `error`.

```json
{
  "command": "info",
  "ok": false,
  "error": "carol@example.com: claude 실행 오류: error_during_execution (HTTP 401)",
  "account": {
    "email": "carol@example.com",
    "profile": "user3",
    "active": false,
    "ok": false,
    "error": "claude 실행 오류: error_during_execution (HTTP 401)",
    "login_required": false,
    "tokens": { "access_token_expires_at": "...", "refresh_token_expires_at": "..." }
  },
  "sync": { "...": "..." }
}
```

### `info` (all accounts)

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | `true` if every lookup succeeded and no profile was skipped |
| `error` | string | Only when something went wrong (counts of failed accounts and/or unreadable profiles) |
| `fetched_at` | string | Lookup time |
| `active` | string \| null | Email of the account in use at home |
| `usable_accounts` | string[] | Emails of usable accounts |
| `failed_accounts` | string[] | Emails whose lookup failed |
| `skipped_profiles` | object[] | Skipped profiles `{ profile, error }` |
| `accounts` | account object[] | All accounts (in profile folder order) |

If any lookup fails: `ok: false`, exit 1. The other accounts' results are still in `accounts`.

```json
{
  "command": "info",
  "ok": true,
  "fetched_at": "2026-10-10T08:46:11.020Z",
  "active": "bob@example.com",
  "usable_accounts": ["alice@example.com", "bob@example.com"],
  "failed_accounts": [],
  "skipped_profiles": [],
  "accounts": [
    { "email": "alice@example.com", "profile": "user1", "active": false, "ok": true, "summary": { "status": "available", "headroom": 94, "...": "..." }, "...": "..." },
    { "email": "bob@example.com",   "profile": "user2", "active": true,  "ok": true, "summary": { "status": "available", "headroom": 98, "...": "..." }, "...": "..." },
    { "email": "carol@example.com", "profile": "user3", "active": false, "ok": true, "summary": { "status": "exhausted", "headroom": 0, "...": "..." }, "...": "..." }
  ],
  "sync": { "...": "..." }
}
```

### `turn <email>`

| Field | Type | Description |
|---|---|---|
| `mode` | `"manual"` | |
| `from` | string \| null | Home account before |
| `to` | string | Home account after |
| `changed` | boolean | Whether anything was switched (`false` if already that account) |
| `saved_previous_to` | string \| null | Profile folder the outgoing token was saved to; `null` if not saved |
| `backup` | object \| null | Backup paths `{ credentials, claude_json }`; `null` if nothing changed |

```json
{
  "command": "turn",
  "ok": true,
  "mode": "manual",
  "from": "bob@example.com",
  "to": "alice@example.com",
  "changed": true,
  "saved_previous_to": "user2",
  "backup": {
    "credentials": "/home/me/.claude/backups/.credentials.json.usermanage.1791621109869",
    "claude_json": "/home/me/.claude/backups/.claude.json.usermanage.1791621109869"
  },
  "sync": { "...": "..." }
}
```

### `turn` (automatic)

Adds the following to the `turn <email>` fields (`from`, `to`, `changed`, `saved_previous_to`, `backup`):

| Field | Type | Description |
|---|---|---|
| `mode` | `"auto"` | |
| `result` | `"switched"` \| `"unchanged"` \| `"all_exhausted"` \| `"no_usable_account"` | Outcome (see [Automatic account selection](#automatic-account-selection)) |
| `reason` | string | Why (same table) |
| `usable` | boolean | Whether the account in use afterwards is usable now |
| `next_available_account` | string \| null | When nothing is usable: the account that frees up first. `null` otherwise |
| `next_available_at` | string \| null | When nothing is usable: when that account frees up. `null` otherwise or if unknown |
| `next_available_in_seconds` | number \| null | Seconds from the response to `next_available_at` (rounded up, min 0). `null` otherwise or if unknown |
| `unverified_accounts` | string[] | Accounts excluded because the lookup failed or was `unknown` |
| `skipped_profiles` | object[] | Skipped profiles `{ profile, error }` |
| `switch_margin` | number | Margin applied (pp) |
| `accounts` | account object[] | Every account's lookup (without raw `rate_limits`) |

**Switched** (exit 0)

```json
{
  "command": "turn",
  "ok": true,
  "mode": "auto",
  "result": "switched",
  "reason": "current_account_exhausted",
  "from": "carol@example.com",
  "to": "bob@example.com",
  "changed": true,
  "saved_previous_to": "user3",
  "backup": { "credentials": "...", "claude_json": "..." },
  "usable": true,
  "next_available_account": null,
  "next_available_at": null,
  "next_available_in_seconds": null,
  "unverified_accounts": [],
  "skipped_profiles": [],
  "switch_margin": 10,
  "accounts": [ "..." ],
  "sync": { "...": "..." }
}
```

**Every account exhausted** (exit 2)

```json
{
  "command": "turn",
  "ok": true,
  "mode": "auto",
  "result": "all_exhausted",
  "reason": "all_exhausted",
  "from": "carol@example.com",
  "to": "carol@example.com",
  "changed": false,
  "saved_previous_to": null,
  "backup": null,
  "usable": false,
  "next_available_account": "carol@example.com",
  "next_available_at": "2026-10-11T13:59:59.731Z",
  "next_available_in_seconds": 104159,
  "unverified_accounts": [],
  "skipped_profiles": [],
  "switch_margin": 10,
  "accounts": [ "..." ],
  "sync": { "...": "..." }
}
```

**No account could be verified** (exit 1). Nothing is changed.

```json
{
  "command": "turn",
  "ok": false,
  "mode": "auto",
  "error": "사용량을 확인할 수 있는 계정이 없습니다",
  "unverified_accounts": ["alice@example.com", "bob@example.com"],
  "skipped_profiles": [],
  "accounts": [ "..." ],
  "sync": { "...": "..." }
}
```

### `sync`

| Field | Type | Description |
|---|---|---|
| `status` | string | See the table in [Vault sync](#vault-sync) |
| `synced` | boolean | Whether anything was copied |
| `account` | string \| null | Account in use at home |
| `profile` | string \| null | Its profile folder name |

```json
{
  "command": "sync",
  "ok": true,
  "status": "synced",
  "synced": true,
  "account": "bob@example.com",
  "profile": "user2"
}
```

If nothing can be copied: `ok: false`, exit 1, with the reason in `error`.

### `help`

```json
{
  "command": "help",
  "ok": true,
  "description": "...",
  "commands": [ { "usage": "cc-usermanage turn <email>", "description": "..." } ],
  "output": "...",
  "exit_codes": { "0": "...", "1": "...", "2": "..." },
  "usable_rule": "...",
  "account_status": { "available": "...", "exhausted": "...", "unknown": "..." },
  "profiles": { "dir": "/home/me/.claude.credentials", "layout": "...", "note": "..." },
  "cautions": [ "..." ],
  "sync": { "...": "..." }
}
```

The margin and `profiles.dir` reflect the running configuration.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure: `sync` couldn't copy, usage error, no profiles, lookup failed, `info` (all) had a failed lookup or skipped profile, automatic `turn` couldn't verify any account, unsupported platform |
| `2` | Automatic `turn` found no usable account (`result` is `all_exhausted` or `no_usable_account`). The switch itself completed normally |

Shell example:

```bash
cc-usermanage turn > /tmp/turn.json
case $? in
  0) echo "usable: $(jq -r .to /tmp/turn.json)" ;;
  2) echo "all exhausted; $(jq -r .next_available_account /tmp/turn.json) frees up in $(jq -r .next_available_in_seconds /tmp/turn.json)s" ;;
  *) echo "failed: $(jq -r .error /tmp/turn.json)" ;;
esac
```

## Errors

Messages are in Korean; the English meaning is given in parentheses.

| Situation | `error` message |
|---|---|
| Running on macOS | `macOS 는 지원하지 않습니다. ...` (macOS is not supported) |
| No/unknown command, too many arguments | `사용법: cc-usermanage turn [<email>] \| info [<email>] \| sync \| help` (usage) |
| Vault folder missing | `프로필 폴더가 없습니다: <path>` (profile folder not found) |
| No valid profiles | `프로필이 하나도 없습니다: <path>` (no profiles). Only when home isn't logged in either, since a logged-in home account is auto-registered |
| No profile for the email | `<email> 에 해당하는 프로필이 없습니다. 사용 가능: <emails>` (no such profile; available: ...), plus `(읽지 못한 프로필: <names>)` (unreadable profiles) if any were skipped |
| `turn <email>` target credentials empty or corrupt | `<email>: 인증 파일에 토큰이 없습니다 ...` etc. (`login_required: true`, nothing changed) |
| Two profiles with the same email | The later one appears in `skipped_profiles` with `<email> 계정의 프로필이 이미 있습니다 (<name>). 하나만 남기세요` (profile already exists; keep only one) |
| `claude` cannot be run | `claude를 실행할 수 없습니다: <cause>` (cannot run claude) |
| More than 60 s | `60초 안에 응답이 없습니다` (no response within 60 s) |
| `claude` exited without a result | `claude가 결과 메시지 없이 종료됐습니다 (exit N): <last stderr line>` |
| `claude` reported an error | `claude 실행 오류: <subtype> (HTTP <status>)` |
| Login expired (tokens wiped after a failed refresh) | `로그인이 만료되었습니다 (refresh token 만료 또는 무효). ...` (`login_required: true`) |
| Empty tokens in credentials | `인증 파일에 토큰이 없습니다 (이미 로그아웃된 상태). ...` (`login_required: true`) |
| Corrupt credentials | `인증 파일이 손상되었습니다 (JSON 오류). ...` (`login_required: true`) |
| Credentials file missing | `인증 파일이 없습니다. ...` (`login_required: true`) |
| No `usage_report` | `/usage 결과에 usage_report가 없습니다 (...)`: not a subscription session, or a Claude Code version without this field |
| `rate_limits` is `null` | `요금제 사용량을 가져오지 못했습니다 (...)` (could not get plan usage) |
| Unexpected exception | Stack trace |

Lookup errors go into the account object's `error`; `info <email>` also puts them in the top-level `error`, prefixed with `<email>: `.

## Cautions

- **Quit all running Claude Code sessions before `turn`.** A running session keeps the old token in memory and may write it back over the credentials file. Start Claude Code again after `turn` to use the new account.
- The active account's profile is refreshed from home on every command, but may be stale in between. Before relying on it to recover a broken home, check that `sync` ran recently.
- **Never use copies of the same account's token in two places.** A refresh on one side invalidates the other side's refresh token. Be careful when copying or restoring profile folders by hand, and never overwrite home with the (possibly stale) profile copy of the active account.
- **When a refresh token expires** (`tokens.refresh_token_expires_at`), lookups for that account fail with `login_required: true`. Follow the recovery steps in [Expired login](#expired-login). `turn <email>` refuses targets with empty or corrupt credentials, but cannot know in advance that non-empty tokens are rejected by the server, so it switches to those.
- `usage_report` is an experimental Claude Code field. If `info` starts failing with "no usage_report" after a Claude Code update, the format has changed.
- `turn <email>` switches even to an exhausted account. Run `info <email>` first to check.
- Profiles and backups (`~/.claude/backups/*.usermanage.*`) contain tokens. Delete backups you no longer need.
- Team plan seats are meant for one person each. Using one person's multiple seats in rotation to raise usage limits may violate Anthropic's terms.

## Configuration

| Item | Where | Default | Notes |
|---|---|---|---|
| Vault (profile folder) | env `USERMANAGE_DIR` | `~/.claude.credentials/` | |
| Temp folder | env `TMPDIR` | `/tmp` | Where temp HOMEs and working dirs are created |
| Auto-switch margin | constant `SWITCH_MARGIN` | `10` | pp |
| Limits used by the rule | constant `GLOBAL_LIMIT_KINDS` | `session`, `weekly_all` | |
| Lookup timeout | constant `INFO_TIMEOUT_MS` | `60000` | ms, per account |

## License

[MIT](LICENSE)
