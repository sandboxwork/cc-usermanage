# cc-usermanage

[English](README.md) | **한국어**

여러 Claude Code 계정을 프로필로 보관해 두고, 홈(`~/`)에서 사용하는 계정을 바꾸거나 요금제 사용량을 확인하는 도구입니다.

> **비공식 도구입니다.** Anthropic이 만들거나 보증한 도구가 아니며 Anthropic과 관계가 없습니다. Claude Code의 로컬 파일 형식과 실험적(experimental) 출력에 의존하므로, Claude Code 업데이트로 동작하지 않게 될 수 있습니다.

- 외부 패키지 없이 Node.js만으로 동작합니다.
- 서버와의 통신(사용량 조회, 토큰 갱신)은 모두 공식 `claude` CLI를 실행해서 맡깁니다. **Anthropic 엔드포인트에는 절대 직접 접근하지 않습니다.** 이 스크립트가 하는 일은 로컬 파일 읽기·쓰기와 `claude` 실행뿐입니다.
- 모든 응답은 stdout에 **JSON 하나**로 출력합니다. stderr에는 아무것도 출력하지 않습니다.

## 목차

1. [설치와 빠른 시작](#설치와-빠른-시작)
2. [프로필 폴더](#프로필-폴더)
3. [명령어](#명령어)
4. [작동 원리](#작동-원리) — 사용량 조회, 토큰 처리, 보관함 동기화, 자동 등록, 로그인 만료
5. [사용 가능 판정 규칙](#사용-가능-판정-규칙)
6. [자동 계정 선택 규칙](#자동-계정-선택-규칙)
7. [응답 형식](#응답-형식)
8. [종료 코드](#종료-코드)
9. [오류](#오류)
10. [주의 사항](#주의-사항)
11. [설정](#설정)

## 설치와 빠른 시작

```bash
npm install -g cc-usermanage     # 설치 후 cc-usermanage 명령 사용
npx cc-usermanage help           # 설치 없이 실행
node usermanage.js help          # 저장소에서 직접 실행
```

```bash
cc-usermanage help                        # 사용법 안내
cc-usermanage info                        # 모든 계정의 사용량 조회
cc-usermanage info alice@example.com      # 한 계정의 사용량 조회
cc-usermanage turn alice@example.com      # 지정한 계정으로 바꾸기
cc-usermanage turn                        # 사용량이 가장 넉넉한 계정으로 바꾸기
cc-usermanage sync                        # 사용 중인 계정의 최신 토큰을 프로필에 복사
```

**요구 사항**
- Node.js 18 이상 (22에서 확인). 외부 패키지 의존성은 없습니다.
- `claude` CLI가 `PATH`에 있어야 합니다 (2.1.296에서 확인)
- 각 계정은 claude.ai 구독 계정(Pro / Max / Team 등)이어야 합니다. 사용량 정보는 구독 세션에서만 나옵니다.
- **Linux** (Linux에서 확인). Claude Code가 인증정보를 `~/.claude/.credentials.json` 파일에 저장하는 환경이어야 합니다.
  - **macOS는 지원하지 않습니다.** macOS의 Claude Code는 인증정보를 키체인에 저장합니다. macOS에서 실행하면 오류를 냅니다.
  - Windows는 확인하지 않았습니다.

**용도**: 개인 계정과 회사 계정을 오가는 경우처럼, 정당하게 쓸 수 있는 여러 계정을 한 기기에서 관리하기 위한 도구입니다. 한 사람이 여러 좌석이나 계정을 번갈아 써서 사용 한도를 우회하는 것은 Anthropic 이용 약관에 어긋날 수 있습니다. 사용 전에 약관을 확인하세요.

## 프로필 폴더

계정마다 폴더(프로필)를 하나씩 만들어 **보관함 `~/.claude.credentials/`** 아래에 둡니다. 프로필 폴더 구조는 홈 디렉터리와 같습니다.

```
~/                                       # 홈: 지금 사용 중인 계정
├── .claude.json
├── .claude/
│   └── .credentials.json
└── .claude.credentials/                 # 보관함 (권한 700)
    ├── <아무 이름>/
    │   ├── .claude.json                 # oauthAccount.emailAddress 로 계정을 식별
    │   └── .claude/
    │       └── .credentials.json        # OAuth 토큰 (claudeAiOauth)
    └── <아무 이름>/
        └── ...
```

- **폴더 이름은 상관없습니다.** 계정은 폴더 이름이 아니라 `.claude.json`의 `oauthAccount.emailAddress`로 찾습니다. 이메일 비교는 대소문자를 구분하지 않습니다.
- 두 파일 중 하나라도 없거나 이메일이 없는 폴더는 무시합니다. 그 밖의 파일(백업, 캐시 등)이 있어도 상관없습니다.
- 다음 폴더는 건너뛰고, `info`(전체)와 자동 `turn` 응답의 `skipped_profiles`에 알립니다. 프로필 하나에 문제가 있어도 다른 계정은 정상적으로 동작합니다.
  - `.claude.json`이 깨져서 읽을 수 없는 폴더
  - 이미 찾은 프로필과 **같은 이메일**의 폴더. 어느 쪽 토큰이 최신인지 알 수 없으므로 먼저 찾은 것만 쓰고, 나머지는 하나만 남기라고 알립니다.
- **계정 추가 (자동 등록)**: 홈에서 그 계정으로 Claude Code에 로그인(`claude` → `/login`)한 뒤 아무 명령이나 한 번 실행하면 됩니다 (예: `cc-usermanage sync`). 홈에 로그인된 계정이 보관함에 없으면 **새 프로필 폴더를 자동으로 만들어 등록합니다** ([자동 등록](#자동-등록)). 직접 만들어도 됩니다. 그 계정의 `~/.claude.json`과 `~/.claude/.credentials.json`을 새 폴더에 같은 구조로 복사하세요.
- 위치는 환경 변수 `USERMANAGE_DIR`로 바꿀 수 있습니다. 기본값은 `~/.claude.credentials/`이며, `~`는 실행하는 사용자의 홈(`HOME`)입니다. 스크립트가 어디에 있든 같은 보관함을 씁니다.
- Claude Code는 `~/.claude/`와 `~/.claude.json`만 쓰고 `~/.claude.credentials/`는 건드리지 않습니다.

> ⚠️ 이 폴더에는 유효한 OAuth 토큰이 들어 있습니다. git에 올리거나 공유하지 마세요. 파일 권한은 `600`을 유지합니다.

## 명령어

| 명령 | 하는 일 | 홈 변경 |
|---|---|---|
| `turn <email>` | 홈의 계정을 `<email>` 계정으로 바꿉니다. 사용량과 관계없이 지정한 대로 바꿉니다. | 예 |
| `turn` | 모든 계정의 사용량을 조회해 가장 넉넉한 계정으로 바꿉니다. | 필요할 때만 |
| `info <email>` | `<email>` 계정의 요금제 사용량을 조회합니다. | 아니요 |
| `info` | 모든 계정의 요금제 사용량을 동시에 조회합니다. | 아니요 |
| `sync` | 홈에서 사용 중인 계정의 최신 인증정보를 그 계정의 프로필에 복사합니다. 프로필이 없으면 새로 만들어 등록합니다. | 아니요 |
| `help` (`--help`, `-h`) | 사용법을 JSON으로 출력합니다. | 아니요 |

`sync`를 뺀 모든 명령은 실행할 때마다 **먼저 `sync`와 같은 동기화를 자동으로 합니다** ([보관함 동기화](#보관함-동기화)). 결과는 응답의 `sync` 필드에 들어갑니다.

명령 없이 실행하거나, 모르는 명령을 주거나, 인자가 너무 많으면 사용법 오류(종료 코드 1)입니다.

### `turn <email>` — 지정한 계정으로 바꾸기

1. 프로필 폴더에서 `<email>` 계정을 찾습니다. 없으면 사용 가능한 이메일 목록과 함께 오류입니다.
2. 홈이 이미 그 계정이면 아무것도 바꾸지 않습니다 (`changed: false`). 이메일로만 비교합니다.
3. **대상 계정의 인증 파일을 검사합니다.** 파일이 손상됐거나 토큰이 비어 있으면(이미 로그아웃된 상태) 아무것도 바꾸지 않고 `ok: false`, `login_required: true`로 끝납니다. 홈의 살아 있는 토큰을 쓸 수 없는 토큰으로 덮어쓰지 않기 위해서입니다. 토큰 값이 있지만 서버에서 무효인 경우(리프레시 토큰 만료 등)는 실행해 봐야 알 수 있으므로 여기서 걸러지지 않습니다.
4. **떠나는 계정의 최신 토큰을 그 계정의 프로필 폴더에 되돌려 저장합니다.** 프로필 인증 파일의 `claudeAiOauth` 키만 홈의 것으로 바꾸고, 프로필 `.claude.json`의 `oauthAccount` 키만 갱신합니다. 다음 경우에는 이 단계를 건너뜁니다(`saved_previous_to: null`).
   - 홈 계정이 프로필에 없는 계정: 보통은 명령 시작 때 [자동 등록](#자동-등록)되므로 이 경우가 생기지 않습니다. 자동 등록이 실패했을 때만 해당하며, 그 계정의 토큰은 아래 백업에만 남습니다.
   - 홈 인증 파일의 토큰이 비어 있거나 손상됨: 프로필의 기존 토큰을 덮어쓰지 않습니다.
5. 홈의 두 파일을 `~/.claude/backups/`에 백업합니다.
   - `.credentials.json.usermanage.<타임스탬프>`
   - `.claude.json.usermanage.<타임스탬프>`
6. 교체합니다. **인증에 쓰는 키 하나씩만 바꾸고 나머지는 모두 보존합니다.**
   - `~/.claude/.credentials.json`: **`claudeAiOauth` 키만** 대상 계정 것으로 바꿉니다. 이 파일의 다른 키(예: 다른 서비스의 인증 정보)는 그대로 둡니다. 홈 파일이 손상돼 읽을 수 없으면 보존할 수 없으므로 `claudeAiOauth`만 담아 새로 쓰고, 손상된 원본은 백업에 남습니다.
   - `~/.claude.json`: **`oauthAccount` 키만** 대상 계정 것으로 바꿉니다. 프로젝트 목록, 설정 등 나머지 키는 그대로 둡니다. `userID`, `machineID`도 이 설치·기기의 식별자이므로 바꾸지 않습니다.

`claudeAiOauth`에는 `accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`가 들어 있고, `oauthAccount`에는 이메일, 이름, 계정·조직 UUID, 역할 등 계정 프로필이 들어 있습니다.

모든 파일 쓰기는 임시 파일에 쓴 뒤 `rename`하는 방식이라 중간에 깨진 파일이 남지 않습니다. 쓰는 파일의 권한은 `600`이고, Claude Code와 같은 형식으로 씁니다 (`.credentials.json`은 한 줄 JSON, `.claude.json`은 2칸 들여쓰기).

> `~/.claude.json`에는 이전 계정 기준으로 저장된 것으로 보이는 캐시 키(`cachedUsageUtilization`, `modelAccessCache` 등)도 있습니다. 기존 자료를 보존하는 원칙에 따라 이것들도 그대로 둡니다. Claude Code가 실행되면서 새 계정 기준으로 다시 받아오지만, 교체 직후 잠깐 이전 계정의 캐시 정보가 보일 수 있습니다.

### `turn` — 가장 넉넉한 계정으로 바꾸기

1. 모든 계정의 사용량을 동시에 조회합니다 (`info`와 같은 방식).
2. [사용 가능 판정 규칙](#사용-가능-판정-규칙)과 [자동 계정 선택 규칙](#자동-계정-선택-규칙)에 따라 계정을 고릅니다.
3. 고른 계정이 지금 계정과 다르면 `turn <email>`과 같은 과정으로 바꿉니다.

### `info <email>` / `info` — 사용량 조회

- 홈의 계정은 바꾸지 않습니다. Claude Code 세션을 쓰는 중에도 실행할 수 있습니다.
- `/usage`는 Claude Code의 로컬 명령이라 모델을 호출하지 않습니다. **비용이 들지 않습니다.** 한 계정에 약 3~5초 걸리고, `info`(전체)는 모든 계정을 동시에 조회하므로 전체 시간도 비슷합니다.
- 조회 중 토큰이 갱신되면 새 토큰을 알맞은 곳에 저장합니다 ([토큰 처리](#토큰-처리)).

### `sync` — 보관함을 최신으로

홈에서 사용 중인 계정의 프로필(보관함)을 홈의 최신 상태로 맞춥니다. 자세한 내용은 [보관함 동기화](#보관함-동기화)를 보세요.

## 작동 원리

### 사용량 조회

계정마다 다음 명령을 실행하고 출력을 한 줄씩 읽습니다.

```bash
claude -p /usage --output-format stream-json --verbose --no-session-persistence
```

- `-p`: 대화형 화면 없이 한 번 실행하고 끝냅니다.
- `--output-format stream-json`: 한 줄에 JSON 메시지 하나씩 출력합니다 (`system`(init) → `assistant` → `result`).
- `assistant` 메시지에 실린 `usage_report.rate_limits`가 서버에서 받은 사용량 원본입니다. 이것을 그대로 꺼내고, 판정용 요약(`summary`)을 덧붙입니다.
- `system`(init) 메시지에서 `claude_code_version`을 읽습니다.
- `--no-session-persistence`: 실행할 때마다 세션 기록이 쌓이지 않게 합니다.
- `claude`는 빈 임시 폴더(`/tmp/usermanage-XXXXXX/`)를 작업 폴더로 삼아 실행합니다. 프로젝트의 `CLAUDE.md`, 설정, 훅이 섞이지 않게 하기 위해서입니다.
- 60초 안에 끝나지 않으면 `claude`를 종료하고 오류로 처리합니다.

### 어떤 계정으로 조회하는가

`claude`는 인증정보를 항상 `$HOME/.claude/.credentials.json`에서 읽습니다. 그래서 `claude`를 실행할 때 환경 변수 `HOME`을 바꿔서 계정을 고릅니다.

| 계정 | 실행 방식 |
|---|---|
| 홈에서 사용 중인 계정 (`active: true`) | 실제 홈 그대로 실행합니다. |
| 그 밖의 계정 | 일회용 임시 HOME(`/tmp/usermanage-home-XXXXXX/`)을 만들고 프로필의 `.claude.json`과 `.claude/.credentials.json`만 복사한 뒤, `HOME=임시폴더`로 실행합니다. |

프로필 폴더를 그대로 HOME으로 쓰지 않는 이유가 있습니다. 그렇게 하면 Claude Code가 그 폴더에 동기화된 스킬, 캐시, 플러그인, MCP 로그 등을 수 MB씩 만들어 놓기 때문입니다.

임시 폴더는 조회가 끝나면 오류가 나더라도 지웁니다. 다만 `kill -9`나 전원 차단처럼 프로세스가 갑자기 죽으면 남을 수 있습니다. 이때는 `rm -rf /tmp/usermanage-*`로 지웁니다. 임시 폴더 위치는 `TMPDIR`로 바꿀 수 있습니다.

### 토큰 처리

- **액세스 토큰**: 약 8시간 유효합니다. 만료되면 `claude`가 실행될 때 리프레시 토큰으로 새 토큰 쌍을 받아 인증 파일을 덮어씁니다. 이 스크립트는 갱신을 직접 하지 않고 `claude`에 맡깁니다.
- **리프레시 토큰은 회전(rotate)합니다.** 갱신에 쓰면 새 리프레시 토큰이 발급되고 **옛 것은 무효가 됩니다.**
- 그래서 원칙은 이렇습니다. **한 계정의 "살아있는" 토큰은 항상 한 곳에만 있습니다.**
  - 홈에서 사용 중인 계정은 홈(`~/`)이 최신입니다. 프로필 폴더의 사본은 낡았을 수 있습니다.
  - 그 밖의 계정은 프로필 폴더가 최신입니다.
- 이 원칙을 지키기 위해 다음과 같이 동작합니다.
  - `turn`은 떠나는 계정의 토큰을 프로필에 되돌려 저장합니다.
  - `info`는 사용 중인 계정이면 홈으로 조회합니다.
  - 임시 HOME으로 조회한 계정은 끝난 뒤 인증 파일이 바뀌었는지 확인합니다. 바뀌었으면(갱신됨) 프로필 인증 파일의 `claudeAiOauth` 키만 새 것으로 바꾸고 다른 키는 보존합니다. 조회가 실패해도 갱신된 토큰은 저장합니다.
  - 단, **토큰이 지워진 인증 파일은 프로필에 되돌려 쓰지 않습니다** ([로그인 만료](#로그인-만료)). `turn`에서 떠나는 계정의 인증 파일이 지워진 상태여도 마찬가지입니다.
- **리프레시 토큰은 갱신해도 만료 시각이 연장되지 않는 것으로 관찰되었습니다** (약 4주). 만료되면 그 계정으로 다시 로그인해서 프로필 파일을 새로 받아야 합니다. 각 계정의 만료 시각은 `info` 응답의 `tokens.refresh_token_expires_at`에 나옵니다.

### 보관함 동기화

토큰은 Claude Code를 쓰는 동안 계속 갱신됩니다. 그래서 **홈에서 사용 중인 계정은 홈의 토큰만 최신이 되고, 프로필(보관함)의 사본은 낡아 갑니다.** 다른 계정으로 `turn`하는 순간 최신 토큰이 프로필에 저장되므로, 계정을 바꿨다가 돌아오는 데는 문제가 없습니다. 하지만 그 전에 홈의 `~/.claude`가 지워지거나 망가지면 프로필의 낡은 사본으로는 복구하지 못할 수 있습니다.

이를 줄이기 위해 홈의 최신 인증정보를 프로필에 수시로 복사합니다.

- **언제**
  - `sync`를 뺀 모든 명령(`turn`, `info`, `help`)을 실행할 때 맨 먼저 합니다.
  - `info`는 조회 중 홈의 토큰이 갱신될 수 있으므로 끝난 뒤 한 번 더 합니다.
  - `sync` 명령으로 직접 할 수 있습니다.
- **무엇을**
  - 프로필 인증 파일의 `claudeAiOauth` 키만 홈 것으로 바꿉니다.
  - 프로필 `.claude.json`의 `oauthAccount` 키만 홈 것으로 바꿉니다.
  - 다른 키는 보존하고, 이미 같으면 아무것도 쓰지 않습니다.
- **안전한 이유**: 사용 중인 계정의 프로필은 이 스크립트가 읽어서 쓰지 않습니다(`info`는 홈으로 조회). 복사해 두어도 같은 토큰을 두 곳에서 쓰는 일이 생기지 않습니다.
- **복사하지 않는 경우**: 홈 인증 파일이 없거나 손상됐거나 토큰이 비어 있으면(로그아웃 상태) 복사하지 않습니다. 프로필의 기존 토큰을 지키기 위해서입니다.
- **다른 명령에서의 동기화는 실패해도 명령을 막지 않습니다.** 결과만 `sync` 필드에 알립니다.
- **한계**: 동기화와 동기화 사이에 홈의 토큰이 갱신되면 그동안은 프로필이 낡습니다. 항상 최신으로 두려면 `sync`를 cron 등으로 주기적으로 실행하세요.

| `sync.status` | 의미 | `sync` 명령의 `ok` |
|---|---|---|
| `synced` | 복사함 | `true` |
| `registered` | 홈 계정이 보관함에 없어서 새 프로필을 만들어 등록함 ([자동 등록](#자동-등록)) | `true` |
| `up_to_date` | 이미 같음 | `true` |
| `no_active_account` | 홈에 로그인된 계정이 없음 | `false` |
| `home_credentials_unusable` | 홈 인증 파일이 없거나 손상됐거나 토큰이 비어 있음. 복사하지 않음 | `false` |
| `error` | 동기화 중 예외 (다른 명령에서만, `error`에 메시지) | — |

### 자동 등록

홈에 로그인된 계정이 보관함에 **아예 없으면**, 동기화할 때 새 프로필을 만들어 등록합니다. 그래서 어떤 명령이든 한 번 실행하면, 다른 계정으로 바꾸기 전에 반드시 보관함에 들어갑니다. 등록하지 않고 다른 계정으로 바꾸면 그 계정의 토큰은 백업 파일에만 남아 되돌아오기 어렵습니다.

- **폴더 이름**: 이메일을 그대로 씁니다 (예: `~/.claude.credentials/new@example.com/`). 영문자·숫자·`. _ @ + -` 외의 문자는 `_`로 바꿉니다. 같은 이름의 폴더가 이미 있으면 그 폴더는 건드리지 않고 `-2`, `-3`처럼 번호를 붙입니다.
- **담는 것**: 인증에 필요한 키만 담습니다. 홈의 프로젝트 목록이나 다른 서비스 인증 정보는 복사하지 않습니다.
  - `.claude/.credentials.json`: `claudeAiOauth`
  - `.claude.json`: `oauthAccount`
- **권한**: `.claude/` 폴더는 `700`, 파일은 `600`입니다.
- **보관함 폴더(`~/.claude.credentials/`)가 없으면** 권한 `700`으로 함께 만듭니다. 그래서 프로필이 하나도 없는 상태에서도 시작할 수 있습니다.
- **등록하지 않는 경우**: 홈 인증 파일이 없거나 손상됐거나 토큰이 비어 있으면(로그아웃 상태) 등록하지 않습니다 (`home_credentials_unusable`).
- 등록 결과는 응답의 `sync.status`가 `registered`이고, `sync.profile`이 새 폴더 이름입니다.

### 토큰에 문제가 있을 때

| 상황 | 동작 | 결과 |
|---|---|---|
| 액세스 토큰만 만료 (리프레시 토큰 유효) | `claude`가 자동 갱신하고 조회합니다. 새 토큰은 알맞은 곳에 저장합니다 | 정상 (`ok: true`) |
| 액세스·리프레시 토큰 모두 만료 또는 무효 | 아래 [로그인 만료](#로그인-만료) | `login_required: true` |
| 인증 파일에 토큰이 비어 있음 (이미 로그아웃됨) | `claude`를 실행하지 않고 바로 실패 | `login_required: true` |
| 인증 파일이 JSON으로 읽히지 않음 (손상) | `claude`를 실행하지 않고 바로 실패 | `login_required: true` |
| 인증 파일이 없음 (사용 중인 계정) | `claude`를 실행하지 않고 바로 실패 | `login_required: true` |
| 프로필의 `.claude.json`이 손상 | 그 프로필을 건너뜀 | `skipped_profiles`에 표시 |
| `turn <email>`의 대상 계정 인증 파일에 토큰이 없거나 손상 | 교체하지 않음 (홈·프로필 모두 그대로) | `ok: false`, `login_required: true` |

어느 경우든 프로필의 인증 파일은 바꾸지 않습니다. 실패한 계정이 있어도 `info`(전체)는 나머지 계정을 모두 조회하고, 자동 `turn`은 그 계정을 후보에서 뺀 채 나머지 중에서 고릅니다.

### 로그인 만료

액세스 토큰과 리프레시 토큰이 모두 만료되었거나 무효인 경우의 동작입니다 (실제로 재현해 확인).

1. `claude`가 리프레시 토큰으로 갱신을 시도하다 실패합니다.
2. `claude`는 **오류를 내지 않고** 인증 파일의 `accessToken`, `refreshToken`을 빈 문자열로, `expiresAt`을 0으로 지웁니다. 사실상 로그아웃 상태가 됩니다.
3. `/usage`는 구독 정보 없이 성공으로 끝나고, `usage_report`를 싣지 않습니다.

이 스크립트는 `claude`가 끝난 뒤 인증 파일에 토큰이 남아 있는지 확인해서 이 상황을 감지합니다.

- 계정 객체가 `ok: false`, **`login_required: true`**가 되고, `error`는 `로그인이 만료되었습니다 ...`입니다.
- 프로필 계정이면 프로필의 인증 파일은 **바꾸지 않습니다.** 갱신이 일시적인 이유로 실패했다면 원래 토큰이 아직 살아 있을 수 있기 때문입니다.
- 홈에서 사용 중인 계정이면 `claude`가 홈의 인증 파일을 직접 지웁니다. 이 스크립트가 막을 수 없으므로, 홈은 로그아웃 상태가 됩니다.
- 자동 `turn`에서는 이 계정을 후보에서 뺍니다 (`unverified_accounts`). 지금 계정이 이 상태면 다른 계정으로 바꿉니다 (`reason: current_account_unverified`). 이때 지워진 홈의 인증 파일은 프로필에 저장하지 않습니다 (`saved_previous_to: null`).

**복구 방법**: 그 계정으로 Claude Code에 다시 로그인한 뒤(`claude` 실행 → `/login`), 홈의 `~/.claude.json`과 `~/.claude/.credentials.json`을 그 계정의 프로필 폴더에 복사합니다. 지금 홈에서 다른 계정을 쓰고 있다면, 빈 폴더를 `HOME`으로 지정해(`HOME=/tmp/newlogin claude`) 로그인하면 홈을 건드리지 않고 새 인증 파일을 얻을 수 있습니다.

## 사용 가능 판정 규칙

`usage_report.rate_limits.limits[]`의 각 한도 행은 `kind`, `percent`(0~100), `resets_at`(ISO 8601) 등을 가집니다. 주요 `kind`는 다음과 같습니다.

| kind | 의미 | 판정에 사용 |
|---|---|---|
| `session` | 5시간 한도 | ✅ |
| `weekly_all` | 주간 전체 한도 | ✅ |
| `weekly_scoped` 등 그 밖의 것 | 특정 모델(예: Fable)에만 걸리는 한도 | ❌ (동점일 때 비교만) |

**규칙: `session`과 `weekly_all`이 모두 100% 미만이면 사용 가능(`available`)입니다.**

세부 규칙은 다음과 같습니다.
- 하나라도 100% 이상이면 **고갈(`exhausted`)**입니다.
- **응답에 없는 한도는 그 요금제에 없는 한도로 봅니다.** 예를 들어 Team 요금제 응답에는 `weekly_all` 행이 없고, 이때는 `session`만으로 판정합니다.
- **초기화 시각(`resets_at`)이 이미 지난 한도는 0%로 봅니다.** 서버 값이 늦게 갱신된 것으로 간주합니다.
- 다음 경우는 판정할 수 없으므로 **`unknown`**입니다.
  - `session`과 `weekly_all`이 둘 다 응답에 없음
  - 둘 중 하나라도 `percent`가 숫자가 아님(`null` 등)
- 특정 모델 한도(`weekly_scoped` 등)가 100%여도 그 모델만 못 쓸 뿐이므로 고갈로 보지 않습니다.
- 추가 사용(`extra_usage`)이 켜진 계정은 실제로는 한도를 넘어도 유료로 계속 쓸 수 있습니다. 하지만 판정에는 넣지 않고 `extra_usage_enabled`로 표시만 합니다.

판정에서 나오는 값은 다음과 같습니다.
- **여유(`headroom`)** = 100 − (판정에 쓰는 한도 중 가장 높은 사용률). 가장 빡빡한 한도가 `binding_limit`입니다.
- **다시 쓸 수 있는 시각(`available_at`)** = 100%에 닿은 한도들이 모두 초기화되는 시각입니다. 고갈된 한도 중 하나라도 `resets_at`이 없으면 `null`입니다. 사용 가능한 계정이면 조회 시각입니다.

## 자동 계정 선택 규칙

`turn`(이메일 없이)은 다음 순서로 계정을 고릅니다.

1. 모든 계정을 동시에 조회합니다. **조회에 실패했거나 `unknown`인 계정은 후보에서 뺍니다** (`unverified_accounts`).
2. 후보를 정렬합니다.
   1. 사용 가능한 계정이 고갈된 계정보다 앞입니다.
   2. 사용 가능한 계정끼리는 `headroom`이 큰 순서이고, 같으면 `scoped_headroom`이 큰 순서입니다.
   3. 고갈된 계정끼리는 `available_at`이 이른 순서입니다(시각을 모르면 맨 뒤).
3. 다음 표에 따라 결정합니다.

| 상황 | 동작 | `result` | `reason` |
|---|---|---|---|
| 지금 계정이 사용 가능하고, 1등과의 여유 차이가 `SWITCH_MARGIN`(10%p) 미만 | 그대로 둡니다 | `unchanged` | `current_is_good_enough` |
| 지금 계정이 사용 가능하고, 1등이 10%p 이상 넉넉함 | 1등으로 바꿉니다 | `switched` | `better_account` |
| 지금 계정이 고갈됨 | 차이와 상관없이 1등으로 바꿉니다 | `switched` | `current_account_exhausted` |
| 지금 계정이 후보에 없음 (조회 실패, `unknown`, 프로필에 없는 계정) | 1등으로 바꿉니다 | `switched` | `current_account_unverified` |
| 사용 가능한 계정이 없고, 모든 계정이 확인됨 | **가장 먼저 풀리는 계정**으로 바꿉니다. 지금 계정이 그만큼 빨리 풀리면 그대로 둡니다 | `all_exhausted` | `all_exhausted` |
| 사용 가능한 계정이 없고, 확인하지 못한 계정이 있음 | 위와 같습니다 | `no_usable_account` | `no_usable_account_some_unverified` |
| 후보가 하나도 없음 (전부 조회 실패 또는 `unknown`) | 아무것도 바꾸지 않습니다 | — (`ok: false`) | — |

차이 기준(`SWITCH_MARGIN`)을 두는 이유는 비슷한 계정끼리 실행할 때마다 왔다 갔다 하지 않게 하기 위해서입니다.

사용 가능한 계정이 없을 때는 종료 코드가 `2`이고, 가장 먼저 풀리는 계정과 그 시각, 지금부터 남은 시간이 응답에 들어갑니다.

- `next_available_account`: 가장 먼저 풀리는 계정 (= 고른 계정, `to`와 같음)
- `next_available_at`: 그 계정이 풀리는 시각
- `next_available_in_seconds`: 응답 시점부터 풀리기까지 남은 초 (올림, 최소 0)

"풀리는 시각"은 그 계정에서 100%에 닿은 한도들이 **모두** 초기화되는 시각입니다. 예를 들어 5시간 한도는 30분 뒤, 주간 한도는 내일 풀리면 내일입니다. 풀리는 시각을 알 수 없으면 세 필드 중 시각과 남은 초는 `null`입니다.

## 응답 형식

모든 응답은 다음 공통 필드로 시작합니다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `command` | string \| null | 실행한 명령 (`turn`, `info`, `help` 등). 명령이 없으면 `null` |
| `ok` | boolean | 성공 여부 |
| `error` | string | 실패했을 때만. 사람이 읽는 오류 메시지 |
| `sync` | object | `sync`를 뺀 명령에서, 자동 동기화 결과 `{ status, synced, account, profile }` ([보관함 동기화](#보관함-동기화)). 사용법 오류 등 명령이 시작되지 못하면 없음 |

`info`의 `sync.synced`는 명령 전후 두 번의 동기화 중 한 번이라도 복사했으면 `true`이고, `status`는 마지막 동기화의 결과입니다.

시각은 모두 ISO 8601 UTC 문자열입니다 (예: `2026-10-10T08:46:11.013Z`).

### 계정 객체 (`account`)

`info`의 `account`, `info`(전체)의 `accounts[]`, `turn`(자동)의 `accounts[]`에 쓰입니다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `email` | string | 계정 이메일 |
| `profile` | string | 프로필 폴더 이름 |
| `active` | boolean | 지금 홈에서 사용 중인 계정인지 |
| `ok` | boolean | 이 계정의 조회 성공 여부 |
| `error` | string | 조회에 실패했을 때만 |
| `login_required` | boolean | 조회에 실패했을 때만. `true`면 로그인이 만료되어 다시 로그인해야 합니다 ([로그인 만료](#로그인-만료)) |
| `tokens.access_token_expires_at` | string \| null | 액세스 토큰 만료 시각 (조회 후 기준) |
| `tokens.refresh_token_expires_at` | string \| null | 리프레시 토큰 만료 시각. 이때가 지나면 다시 로그인해야 합니다 |
| `claude_code_version` | string \| null | 조회에 쓴 Claude Code 버전 (성공했을 때만) |
| `summary` | object | 판정 요약 (성공했을 때만, 아래 표) |
| `rate_limits` | object | 서버가 보낸 원본 (성공했을 때만, **`turn` 자동 응답에는 없음**) |

`tokens`는 사용 중인 계정이면 홈의 인증 파일에서, 그 밖의 계정이면 프로필의 인증 파일에서 읽습니다.

### 판정 요약 (`summary`)

| 필드 | 타입 | 설명 |
|---|---|---|
| `status` | `"available"` \| `"exhausted"` \| `"unknown"` | 판정 결과 |
| `usable` | boolean | `status === "available"` |
| `headroom` | number \| null | 남은 여유(%). `unknown`이면 `null` |
| `binding_limit` | object \| null | 가장 빡빡한 한도 `{ kind, percent, resets_at }`. `unknown`이면 `null` |
| `available_at` | string \| null | 다시 쓸 수 있게 되는 시각. 사용 가능하면 조회 시각이고, 모르면 `null` |
| `checked_limits` | object | 판정에 쓴 한도별 사용률 `{ session, weekly_all }`. 응답에 없던 한도는 `null`. 초기화 시각이 지난 한도는 0으로 표시 |
| `scoped_headroom` | number | 특정 모델 한도 기준의 여유(%). 없으면 100 |
| `extra_usage_enabled` | boolean | 추가 사용(overage)이 켜져 있는지 |

### 원본 사용량 (`rate_limits`)

`claude`가 준 `usage_report.rate_limits`를 가공하지 않고 그대로 싣습니다. Claude Code가 **실험적(experimental)** 필드로 표시한 것이라, 버전에 따라 형식이 바뀔 수 있습니다.

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

`severity`는 고갈된 한도에서 `"critical"`로 관찰되었습니다. `extra_usage.used_credits`는 최소 화폐 단위(USD면 센트)입니다.

### `info <email>`

**성공** (종료 코드 0)

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
  }
}
```

**조회 실패** (종료 코드 1): `account`에 `ok: false`와 `error`가 들어갑니다.

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
  }
}
```

### `info` (전체)

| 필드 | 타입 | 설명 |
|---|---|---|
| `ok` | boolean | 모든 계정의 조회에 성공하고 건너뛴 프로필이 없으면 `true` |
| `error` | string | 문제가 있을 때만 (`"N개 계정의 사용량 조회에 실패했습니다"`, `"N개 프로필을 읽지 못했습니다"`를 쉼표로 연결) |
| `fetched_at` | string | 조회 시각 |
| `active` | string \| null | 지금 홈에서 사용 중인 계정의 이메일 |
| `usable_accounts` | string[] | 사용 가능한 계정 이메일 |
| `failed_accounts` | string[] | 조회에 실패한 계정 이메일 |
| `skipped_profiles` | object[] | `.claude.json`을 읽지 못해 건너뛴 프로필 `{ profile, error }` |
| `accounts` | 계정 객체[] | 모든 계정 (프로필 폴더 순서) |

한 계정이라도 조회에 실패하면 `ok: false`, 종료 코드 1입니다. 그래도 나머지 계정 결과는 `accounts`에 모두 들어갑니다.

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
  ]
}
```

### `turn <email>`

| 필드 | 타입 | 설명 |
|---|---|---|
| `mode` | `"manual"` | |
| `from` | string \| null | 바꾸기 전 홈 계정 이메일 |
| `to` | string | 바꾼 뒤 홈 계정 이메일 |
| `changed` | boolean | 실제로 바꿨는지 (이미 그 계정이면 `false`) |
| `saved_previous_to` | string \| null | 떠나는 계정의 토큰을 저장한 프로필 폴더 이름. 저장하지 않았으면 `null` |
| `backup` | object \| null | 백업 파일 경로 `{ credentials, claude_json }`. 바꾸지 않았으면 `null` |

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
  }
}
```

### `turn` (자동)

`turn <email>`의 필드(`from`, `to`, `changed`, `saved_previous_to`, `backup`)에 다음이 더해집니다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `mode` | `"auto"` | |
| `result` | `"switched"` \| `"unchanged"` \| `"all_exhausted"` \| `"no_usable_account"` | 결과 ([자동 계정 선택 규칙](#자동-계정-선택-규칙) 표) |
| `reason` | string | 결정 이유 (같은 표) |
| `usable` | boolean | 바꾼 뒤의 계정이 지금 사용 가능한지 |
| `next_available_account` | string \| null | 사용 가능한 계정이 없을 때, 가장 먼저 풀리는 계정. 사용 가능하면 `null` |
| `next_available_at` | string \| null | 사용 가능한 계정이 없을 때, 그 계정이 풀리는 시각. 사용 가능하거나 시각을 모르면 `null` |
| `next_available_in_seconds` | number \| null | 응답 시점부터 `next_available_at`까지 남은 초 (올림, 최소 0). 사용 가능하거나 시각을 모르면 `null` |
| `unverified_accounts` | string[] | 조회에 실패했거나 `unknown`이라 후보에서 뺀 계정 |
| `skipped_profiles` | object[] | `.claude.json`을 읽지 못해 건너뛴 프로필 `{ profile, error }` |
| `switch_margin` | number | 적용한 차이 기준(%p) |
| `accounts` | 계정 객체[] | 모든 계정의 조회 결과 (`rate_limits` 원본은 빠짐) |

**계정을 바꾼 경우** (종료 코드 0)

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
  "accounts": [ "..." ]
}
```

**모든 계정이 고갈된 경우** (종료 코드 2)

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
  "accounts": [ "..." ]
}
```

**확인할 수 있는 계정이 없는 경우** (종료 코드 1). 아무것도 바꾸지 않습니다.

```json
{
  "command": "turn",
  "ok": false,
  "mode": "auto",
  "error": "사용량을 확인할 수 있는 계정이 없습니다",
  "unverified_accounts": ["alice@example.com", "bob@example.com"],
  "accounts": [ "..." ]
}
```

### `sync`

| 필드 | 타입 | 설명 |
|---|---|---|
| `status` | string | [보관함 동기화](#보관함-동기화)의 표 |
| `synced` | boolean | 실제로 복사했는지 |
| `account` | string \| null | 홈에서 사용 중인 계정 |
| `profile` | string \| null | 그 계정의 프로필 폴더 이름 |

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

복사할 수 없으면 `ok: false`, 종료 코드 1이고 `error`에 이유가 들어갑니다.

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
  "cautions": [ "..." ]
}
```

`switch_margin` 값과 `profiles.dir`은 실행 중인 설정의 실제 값입니다.

## 종료 코드

| 코드 | 의미 |
|---|---|
| `0` | 성공 |
| `1` | 실패. `sync`에서 복사할 수 없음, 사용법 오류, 프로필 없음, 조회 실패, `info`(전체)에서 한 계정이라도 조회 실패하거나 프로필을 건너뜀, 자동 `turn`에서 확인할 수 있는 계정이 없음, 지원하지 않는 환경(macOS) |
| `2` | 자동 `turn`에서 사용 가능한 계정이 없음 (`result`가 `all_exhausted` 또는 `no_usable_account`). 계정 교체 자체는 정상 수행됨 |

셸 스크립트 예시:

```bash
cc-usermanage turn > /tmp/turn.json
case $? in
  0) echo "사용 가능: $(jq -r .to /tmp/turn.json)" ;;
  2) echo "모두 고갈, $(jq -r .next_available_account /tmp/turn.json) 가 $(jq -r .next_available_in_seconds /tmp/turn.json)초 뒤 풀림" ;;
  *) echo "실패: $(jq -r .error /tmp/turn.json)" ;;
esac
```

## 오류

| 상황 | `error` 메시지 |
|---|---|
| macOS에서 실행 | `macOS 는 지원하지 않습니다. ...` |
| 명령이 없거나 잘못됨, 인자 과다 | `사용법: cc-usermanage turn [<email>] \| info [<email>] \| sync \| help` |
| 프로필 폴더 없음 | `프로필 폴더가 없습니다: <경로>` |
| 유효한 프로필 없음 | `프로필이 하나도 없습니다: <경로>` (홈에 로그인된 계정이 있으면 자동 등록되므로, 홈도 로그인되지 않은 경우에만 발생) |
| 이메일에 맞는 프로필 없음 | `<email> 에 해당하는 프로필이 없습니다. 사용 가능: <이메일 목록>` (건너뛴 프로필이 있으면 `(읽지 못한 프로필: <이름>)` 추가) |
| `turn <email>` 대상의 인증 파일에 토큰이 없거나 손상 | `<email>: 인증 파일에 토큰이 없습니다 ...` 등 (`login_required: true`, 아무것도 바꾸지 않음) |
| 같은 이메일의 프로필이 둘 이상 | 나중에 찾은 프로필이 `skipped_profiles`에 `<email> 계정의 프로필이 이미 있습니다 (<이름>). 하나만 남기세요` |
| `claude` 실행 불가 | `claude를 실행할 수 없습니다: <원인>` |
| 60초 초과 | `60초 안에 응답이 없습니다` |
| `claude`가 결과 없이 종료 | `claude가 결과 메시지 없이 종료됐습니다 (exit N): <stderr 마지막 줄>` |
| `claude` 실행 오류 | `claude 실행 오류: <subtype> (HTTP <status>)` |
| 로그인 만료 (갱신 실패로 토큰이 지워짐) | `로그인이 만료되었습니다 (refresh token 만료 또는 무효). ...` (`login_required: true`) |
| 인증 파일에 토큰이 없음 | `인증 파일에 토큰이 없습니다 (이미 로그아웃된 상태). ...` (`login_required: true`) |
| 인증 파일 손상 | `인증 파일이 손상되었습니다 (JSON 오류). ...` (`login_required: true`) |
| 인증 파일 없음 | `인증 파일이 없습니다. ...` (`login_required: true`) |
| `usage_report` 없음 | `/usage 결과에 usage_report가 없습니다 (...)`: 구독 세션이 아니거나 필드를 싣지 않는 버전 |
| `rate_limits`가 `null` | `요금제 사용량을 가져오지 못했습니다 (...)` |
| 예상하지 못한 예외 | 예외의 스택 트레이스 |

조회 오류는 계정 객체의 `error`에 들어가고, `info <email>`은 최상위 `error`에도 `<email>: ` 접두어를 붙여 넣습니다.

## 주의 사항

- **`turn` 전에는 실행 중인 Claude Code 세션을 모두 종료하세요.** 실행 중인 세션은 옛 토큰을 메모리에 들고 있다가 인증 파일을 다시 덮어쓸 수 있습니다. `turn` 후에 Claude Code를 다시 실행하면 새 계정이 적용됩니다.
- 사용 중인 계정의 프로필은 명령을 실행할 때마다 홈의 최신 토큰으로 갱신되지만, 그 사이에는 낡아 있을 수 있습니다. 홈이 망가졌을 때 프로필로 복구하려면 최근에 `sync`가 실행됐는지 확인하세요.
- **같은 계정의 토큰 사본을 두 곳에서 쓰지 마세요.** 한쪽에서 갱신되면 다른 쪽의 리프레시 토큰이 무효가 됩니다. 프로필 폴더를 수동으로 복사하거나 되돌릴 때 특히 주의하세요. 홈에서 사용 중인 계정의 프로필 사본은 낡았을 수 있으니, 그 사본으로 덮어쓰지 마세요.
- **리프레시 토큰이 만료되면**(`tokens.refresh_token_expires_at`) 그 계정은 `login_required: true`로 조회에 실패합니다. [로그인 만료](#로그인-만료)의 복구 방법을 따르세요. `turn <email>`은 인증 파일에 토큰이 비어 있거나 손상된 계정으로는 바꾸지 않지만, 토큰 값은 있는데 서버에서 무효인 계정은 미리 알 수 없으므로 그대로 바꿉니다.
- `usage_report`는 Claude Code의 실험적 필드입니다. Claude Code를 업데이트한 뒤 `info`가 `usage_report가 없습니다` 오류를 내면 형식이 바뀐 것입니다.
- `turn <email>`은 고갈된 계정이라도 지정한 대로 바꿉니다. 사용 가능 여부를 확인하려면 먼저 `info <email>`을 실행하세요.
- 프로필 폴더와 백업(`~/.claude/backups/*.usermanage.*`)에는 토큰이 들어 있습니다. 필요 없는 백업은 지우세요.
- Team 요금제의 좌석은 원래 한 사람에게 하나씩 배정됩니다. 한 사람이 여러 좌석을 번갈아 써서 사용 한도를 늘리는 용도로 쓰면 Anthropic 이용 약관에 어긋날 수 있습니다.

## 설정

| 항목 | 위치 | 기본값 | 설명 |
|---|---|---|---|
| 프로필 폴더 (보관함) | 환경 변수 `USERMANAGE_DIR` | `~/.claude.credentials/` | |
| 임시 폴더 | 환경 변수 `TMPDIR` | `/tmp` | 임시 HOME과 작업 폴더가 생기는 곳 |
| 자동 교체 차이 기준 | 코드 상수 `SWITCH_MARGIN` | `10` | %p |
| 사용 가능 판정 한도 | 코드 상수 `GLOBAL_LIMIT_KINDS` | `session`, `weekly_all` | |
| 조회 제한 시간 | 코드 상수 `INFO_TIMEOUT_MS` | `60000` | 밀리초, 계정당 |

## 라이선스

[MIT](LICENSE)
