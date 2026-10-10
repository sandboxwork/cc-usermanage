#!/usr/bin/env node
// cc-usermanage — 여러 Claude Code 계정을 보관해 두고 바꾸거나 사용량을 확인한다.
// Anthropic 의 공식 도구가 아니며 Anthropic 과 관계가 없다.
//
// 사용법 (npm 으로 설치하면 cc-usermanage, 직접 실행하면 node usermanage.js):
//   cc-usermanage turn <email>   홈(~/)의 Claude Code 계정을 <email> 계정으로 교체
//   cc-usermanage turn           사용량이 가장 넉넉한 계정으로 교체
//   cc-usermanage info <email>   <email> 계정의 요금제 사용량 조회
//   cc-usermanage info           모든 계정의 요금제 사용량 조회
//   cc-usermanage sync           사용 중인 계정의 최신 인증정보를 프로필에 복사 (다른 명령도 자동으로 함)
//
// 모든 응답은 stdout 에 JSON 하나로 출력한다. 성공이면 "ok": true, 실패면 "ok": false 와 "error".
// 종료 코드: 0 성공, 1 실패(info 전체 조회는 한 계정이라도 조회 실패),
//            2 자동 turn 에서 사용 가능한 계정이 없음.
//
// 프로필 폴더(보관함, 기본: ~/.claude.credentials/, USERMANAGE_DIR로 변경 가능)의 하위 폴더(이름 무관) 중
// .claude.json 의 oauthAccount.emailAddress 가 <email> 인 것을 계정으로 쓴다.
// 프로필 폴더는 홈과 같은 구조다: <폴더>/.claude.json, <폴더>/.claude/.credentials.json
//
// 원칙: 한 계정의 "살아있는" 토큰은 항상 한 곳에만 있다.
//   - 홈에서 사용 중인 계정 → 홈(~/)이 최신. 프로필 폴더의 사본은 낡았을 수 있다.
//   - 그 밖의 계정        → 프로필 폴더가 최신.
// refresh token 은 쓰면 회전(rotate)되므로, 같은 토큰을 두 곳에서 쓰면 한쪽이 무효가 된다.
// 그래서 turn 은 떠나는 계정의 토큰을 프로필에 되돌려 놓고, info 는 사용 중인 계정이면 홈으로 조회한다.
//
// 금지: Anthropic 엔드포인트(API·인증·사용량)에 절대 직접 접근하지 않는다. http/https/fetch 를 쓰지 않으며,
// 서버와의 통신(사용량 조회, 토큰 갱신)은 모두 공식 `claude` CLI 를 실행해서 맡긴다.
// 이 스크립트가 하는 일은 로컬 파일 읽기·쓰기와 `claude` 실행뿐이다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const PROFILES_DIR = process.env.USERMANAGE_DIR || path.join(HOME, '.claude.credentials');
const HOME_JSON = path.join(HOME, '.claude.json');
const HOME_CREDS = path.join(HOME, '.claude', '.credentials.json');
const INFO_TIMEOUT_MS = 60000;
// 자동 turn 에서 현재 계정보다 여유가 이만큼(%p) 이상 많아야 바꾼다. 비슷한 계정끼리 매번 오가지 않게.
const SWITCH_MARGIN = 10;
// 계정 전체 사용을 막는 한도. 이 밖의 한도(weekly_scoped 등)는 특정 모델에만 걸리므로 동점일 때만 본다.
const GLOBAL_LIMIT_KINDS = new Set(['session', 'weekly_all']);

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ALL_EXHAUSTED = 2;

class UsageError extends Error {}
// 로그인이 풀린 경우 (refresh token 만료·무효로 claude 가 인증정보의 토큰을 지움). 다시 로그인해야 한다.
class LoginRequiredError extends Error {}

// 인증 파일 내용에 쓸 수 있는 토큰이 들어 있는지. claude 는 갱신에 실패하면 토큰을 빈 문자열로 지운다.
function hasTokens(credsText) {
  try {
    const o = JSON.parse(credsText).claudeAiOauth || {};
    return !!o.accessToken && !!o.refreshToken;
  } catch {
    return false;
  }
}

// 인증 파일에서 claudeAiOauth 키만 바꾸고 나머지 키는 보존한 내용을 만든다.
// base 가 없거나 깨졌으면 보존할 것이 없으므로 src 의 claudeAiOauth 만 담는다.
// Claude Code 와 같은 형식(한 줄 JSON)으로 쓴다.
function mergeOauth(baseText, srcText) {
  let base = {};
  try {
    const parsed = baseText == null ? {} : JSON.parse(baseText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
  } catch {}
  return JSON.stringify({ ...base, claudeAiOauth: JSON.parse(srcText).claudeAiOauth });
}

const readIfExists = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 임시 파일에 쓴 뒤 rename 해서 중간에 깨진 파일이 남지 않게 한다.
function writeAtomic(file, text) {
  const tmp = `${file}.usermanage-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, obj) {
  writeAtomic(file, JSON.stringify(obj, null, 2));
}

const sameEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// allowEmpty: 동기화(자동 등록)는 프로필이 하나도 없어도 진행해야 하므로 오류 대신 빈 목록을 돌려준다.
function loadProfiles({ allowEmpty = false } = {}) {
  if (!fs.existsSync(PROFILES_DIR)) {
    if (allowEmpty) return Object.assign([], { skipped: [] });
    throw new UsageError(`프로필 폴더가 없습니다: ${PROFILES_DIR}`);
  }
  const profiles = [];
  // 건너뛴 프로필 (.claude.json 이 깨졌거나 같은 계정이 중복). 다른 계정까지 막지 않도록 건너뛰고 응답에 알린다.
  const skipped = [];
  for (const name of fs.readdirSync(PROFILES_DIR)) {
    const dir = path.join(PROFILES_DIR, name);
    const jsonFile = path.join(dir, '.claude.json');
    const credsFile = path.join(dir, '.claude', '.credentials.json');
    if (!fs.existsSync(jsonFile) || !fs.existsSync(credsFile)) continue;
    let email;
    try {
      email = readJson(jsonFile).oauthAccount?.emailAddress;
    } catch (e) {
      skipped.push({ profile: name, error: `.claude.json 을 읽을 수 없습니다: ${e.message}` });
      continue;
    }
    if (!email) continue;
    // 같은 계정의 프로필이 둘이면 어느 쪽 토큰이 최신인지 알 수 없다. 먼저 찾은 것만 쓰고 나머지는 알린다.
    const dup = profiles.find((p) => sameEmail(p.email, email));
    if (dup) {
      skipped.push({ profile: name, error: `${email} 계정의 프로필이 이미 있습니다 (${dup.name}). 하나만 남기세요` });
      continue;
    }
    profiles.push({ name, dir, email, jsonFile, credsFile });
  }
  if (!profiles.length && !allowEmpty) throw new UsageError(`프로필이 하나도 없습니다: ${PROFILES_DIR}`);
  profiles.skipped = skipped;
  return profiles;
}

function findProfile(profiles, email) {
  const p = profiles.find((x) => sameEmail(x.email, email));
  if (!p) {
    const skipped = profiles.skipped?.length ? ` (읽지 못한 프로필: ${profiles.skipped.map((x) => x.profile).join(', ')})` : '';
    throw new UsageError(`${email} 에 해당하는 프로필이 없습니다. 사용 가능: ${profiles.map((x) => x.email).join(', ')}${skipped}`);
  }
  return p;
}

function readHomeJson() {
  return fs.existsSync(HOME_JSON) ? readJson(HOME_JSON) : {};
}

const currentHomeEmail = () => readHomeJson().oauthAccount?.emailAddress || null;

// ---------------------------------------------------------------- 계정 교체

function switchTo(profiles, target) {
  const homeJson = readHomeJson();
  const from = homeJson.oauthAccount?.emailAddress || null;
  if (sameEmail(from, target.email)) {
    return { from, to: target.email, changed: false, saved_previous_to: null, backup: null };
  }

  // 대상 계정의 인증 파일에 쓸 수 있는 토큰이 없으면 바꾸지 않는다. 홈의 토큰을 지우지 않기 위해서다.
  const targetCredsText = fs.readFileSync(target.credsFile, 'utf8');
  const targetCredsError = checkCredsText(targetCredsText);
  if (targetCredsError) throw new LoginRequiredError(`${target.email}: ${targetCredsError.message}`);

  // 떠나는 계정의 최신 인증정보를 프로필에 되돌려 저장한다. 프로필 인증 파일의 다른 키는 보존한다.
  // 로그인이 풀려 토큰이 지워진 인증정보는 저장하지 않는다 (프로필의 기존 토큰을 덮어쓰지 않도록).
  const current = from && profiles.find((p) => sameEmail(p.email, from));
  let savedTo = null;
  const homeCredsText = fs.existsSync(HOME_CREDS) ? fs.readFileSync(HOME_CREDS, 'utf8') : null;
  if (current && homeCredsText && hasTokens(homeCredsText)) {
    writeAtomic(current.credsFile, mergeOauth(readIfExists(current.credsFile), homeCredsText));
    const profJson = readJson(current.jsonFile);
    profJson.oauthAccount = homeJson.oauthAccount;
    writeJsonAtomic(current.jsonFile, profJson);
    savedTo = current.name;
  }

  // 교체 전 백업
  const backupDir = path.join(HOME, '.claude', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = Date.now();
  const backup = {};
  if (fs.existsSync(HOME_CREDS)) {
    backup.credentials = path.join(backupDir, `.credentials.json.usermanage.${stamp}`);
    fs.copyFileSync(HOME_CREDS, backup.credentials);
  }
  if (fs.existsSync(HOME_JSON)) {
    backup.claude_json = path.join(backupDir, `.claude.json.usermanage.${stamp}`);
    fs.copyFileSync(HOME_JSON, backup.claude_json);
  }

  // 교체: 인증 파일은 claudeAiOauth 키만, .claude.json 은 oauthAccount 키만 바꾸고 나머지는 보존한다.
  fs.mkdirSync(path.dirname(HOME_CREDS), { recursive: true });
  writeAtomic(HOME_CREDS, mergeOauth(homeCredsText, targetCredsText));
  homeJson.oauthAccount = readJson(target.jsonFile).oauthAccount;
  writeJsonAtomic(HOME_JSON, homeJson);

  return { from, to: target.email, changed: true, saved_previous_to: savedTo, backup };
}

// ---------------------------------------------------------------- 동기화

// 홈에서 사용 중인 계정의 최신 인증정보를 그 계정의 프로필에 복사해 둔다 (보관함을 최신으로 유지).
// 사용 중인 계정의 프로필은 이 스크립트가 읽어서 쓰지 않으므로, 복사해 두어도 토큰 충돌이 생기지 않는다.
// 인증 파일은 claudeAiOauth 키만, .claude.json 은 oauthAccount 키만 바꾸고 나머지는 보존한다.
//
//   status  'synced'                     복사함
//           'up_to_date'                 이미 같음
//           'registered'                 홈 계정이 프로필에 없어서 새 프로필을 만들어 등록함
//           'no_active_account'          홈에 로그인된 계정이 없음
//           'home_credentials_unusable'  홈 인증 파일이 없거나 손상됐거나 토큰이 비어 있음 (프로필을 덮어쓰거나 만들지 않음)
function syncActive(profiles) {
  const homeJson = readHomeJson();
  const account = homeJson.oauthAccount?.emailAddress || null;
  const result = (status, profile = null) => ({ status, synced: status === 'synced' || status === 'registered', account, profile });
  if (!account) return result('no_active_account');
  const profile = profiles.find((p) => sameEmail(p.email, account));
  const homeCredsText = readIfExists(HOME_CREDS);
  if (!homeCredsText || checkCredsText(homeCredsText)) return result('home_credentials_unusable', profile?.name ?? null);
  if (!profile) return result('registered', registerProfile(account, homeJson, homeCredsText));

  let changed = false;
  const profCredsText = readIfExists(profile.credsFile);
  const homeOauth = JSON.stringify(JSON.parse(homeCredsText).claudeAiOauth);
  let profOauth = null;
  try { profOauth = JSON.stringify(JSON.parse(profCredsText).claudeAiOauth); } catch {}
  if (homeOauth !== profOauth) {
    writeAtomic(profile.credsFile, mergeOauth(profCredsText, homeCredsText));
    changed = true;
  }
  const profJson = readJson(profile.jsonFile);
  if (JSON.stringify(profJson.oauthAccount) !== JSON.stringify(homeJson.oauthAccount)) {
    profJson.oauthAccount = homeJson.oauthAccount;
    writeJsonAtomic(profile.jsonFile, profJson);
    changed = true;
  }
  return result(changed ? 'synced' : 'up_to_date', profile.name);
}

// 홈 계정을 새 프로필로 등록한다. 인증에 필요한 키만 담는다
// (.credentials.json 에는 claudeAiOauth, .claude.json 에는 oauthAccount). 폴더 이름은 이메일로 짓는다.
function registerProfile(email, homeJson, homeCredsText) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  const base = email.replace(/[^A-Za-z0-9._@+-]/g, '_');
  let name = base;
  for (let i = 2; fs.existsSync(path.join(PROFILES_DIR, name)); i++) name = `${base}-${i}`;
  const dir = path.join(PROFILES_DIR, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, '.claude', '.credentials.json'), mergeOauth(null, homeCredsText));
  writeJsonAtomic(path.join(dir, '.claude.json'), { oauthAccount: homeJson.oauthAccount });
  return name;
}

// 다른 명령의 앞뒤에서 부르는 동기화. 실패해도 명령 자체는 막지 않는다.
function trySyncActive() {
  try {
    return syncActive(loadProfiles({ allowEmpty: true }));
  } catch (e) {
    return { status: 'error', synced: false, account: null, profile: null, error: e.message };
  }
}

function cmdSync() {
  const r = syncActive(loadProfiles({ allowEmpty: true }));
  const ok = ['synced', 'up_to_date', 'registered'].includes(r.status);
  const messages = {
    no_active_account: '홈에 로그인된 계정이 없습니다',
    home_credentials_unusable: '홈 인증 파일이 없거나 손상됐거나 토큰이 비어 있어 복사하지 않았습니다 (프로필은 그대로)',
  };
  return {
    exitCode: ok ? EXIT_OK : EXIT_FAIL,
    body: { ok, ...(ok ? {} : { error: messages[r.status] }), ...r },
  };
}

// ---------------------------------------------------------------- 사용량 조회

// 인증 파일을 확인한다. 없거나 깨졌거나 토큰이 비어 있으면 그 계정은 쓸 수 없다 (다시 로그인 필요).
function checkCredsFile(home) {
  const credsFile = path.join(home, '.claude', '.credentials.json');
  if (!fs.existsSync(credsFile)) return new LoginRequiredError('인증 파일이 없습니다. 이 계정으로 다시 로그인한 뒤 프로필을 새로 받아야 합니다');
  return checkCredsText(fs.readFileSync(credsFile, 'utf8'));
}

function checkCredsText(text) {
  try {
    JSON.parse(text);
  } catch {
    return new LoginRequiredError('인증 파일이 손상되었습니다 (JSON 오류). 이 계정으로 다시 로그인한 뒤 프로필을 새로 받아야 합니다');
  }
  if (!hasTokens(text)) return new LoginRequiredError('인증 파일에 토큰이 없습니다 (이미 로그아웃된 상태). 이 계정으로 다시 로그인한 뒤 프로필을 새로 받아야 합니다');
  return null;
}

// `claude -p /usage` 의 stream-json 출력에서 assistant 메시지의 usage_report 를 꺼낸다.
// /usage 는 로컬 명령이라 모델을 호출하지 않는다 (비용 0). usage_report 는 실험적 필드다.
// home 을 HOME 으로 지정해 실행하므로, 그 폴더의 인증정보로 조회하고 토큰이 갱신되면 그 폴더에 저장된다.
function fetchUsage(home) {
  return new Promise((resolve, reject) => {
    const credsError = checkCredsFile(home);
    if (credsError) return reject(credsError);
    // 프로젝트 설정·CLAUDE.md·훅이 섞이지 않도록 빈 임시 폴더에서 실행한다.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'usermanage-'));
    const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
    const child = spawn(
      'claude',
      ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
      { cwd, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buf = '', stderr = '', version = null, report = null, result = null;
    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'system' && m.subtype === 'init') version = m.claude_code_version || null;
      else if (m.type === 'assistant' && !m.parent_tool_use_id && m.usage_report) report = m.usage_report;
      else if (m.type === 'result') result = m;
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // SIGTERM 을 무시하면 이 스크립트도 끝나지 않으므로 잠시 뒤 강제 종료한다.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      reject(new Error(`${INFO_TIMEOUT_MS / 1000}초 안에 응답이 없습니다`));
    }, INFO_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`claude를 실행할 수 없습니다: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      handleLine(buf);
      const lastErr = stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : '';
      if (!result) return reject(new Error(`claude가 결과 메시지 없이 종료됐습니다 (exit ${code})${lastErr}`));
      if (result.is_error) {
        const status = result.api_error_status != null ? ` (HTTP ${result.api_error_status})` : '';
        return reject(new Error(`claude 실행 오류: ${result.subtype}${status}`));
      }
      // 갱신에 실패하면 claude 는 오류 없이 토큰을 지우고, /usage 는 구독 정보 없이 성공으로 끝난다.
      const credsFile = path.join(home, '.claude', '.credentials.json');
      if (!fs.existsSync(credsFile) || !hasTokens(fs.readFileSync(credsFile, 'utf8'))) {
        return reject(new LoginRequiredError('로그인이 만료되었습니다 (refresh token 만료 또는 무효). 이 계정으로 다시 로그인한 뒤 프로필을 새로 받아야 합니다'));
      }
      if (!report) return reject(new Error('/usage 결과에 usage_report가 없습니다 (claude.ai 구독 세션이 아니거나, 이 필드를 싣지 않는 버전)'));
      if (!report.rate_limits) return reject(new Error('요금제 사용량을 가져오지 못했습니다 (usage_report.rate_limits가 null)'));
      resolve({ version, report });
    });
  });
}

// 프로필 폴더를 그대로 HOME 으로 쓰면 Claude Code 가 스킬·캐시·플러그인 등을 잔뜩 만들어 놓는다.
// 그래서 인증정보만 일회용 HOME 에 복사해 조회하고, 토큰이 갱신됐으면 그것만 프로필에 되돌려 쓴다.
async function fetchUsageForProfile(profile) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usermanage-home-'));
  try {
    const tmpCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(tmpCreds), { recursive: true, mode: 0o700 });
    const before = fs.readFileSync(profile.credsFile, 'utf8');
    fs.writeFileSync(tmpCreds, before, { mode: 0o600 });
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), fs.readFileSync(profile.jsonFile, 'utf8'), { mode: 0o600 });
    try {
      return await fetchUsage(tmpHome);
    } finally {
      // 실패했더라도 갱신된 토큰은 살려야 한다 (옛 refresh token 은 이미 무효일 수 있다).
      // 단, 토큰이 지워졌거나 깨진 파일은 되돌려 쓰지 않는다. 일시적 실패였다면 원래 토큰이 아직 살아 있을 수 있다.
      const after = fs.existsSync(tmpCreds) ? fs.readFileSync(tmpCreds, 'utf8') : before;
      // 프로필 인증 파일의 다른 키는 보존하고 claudeAiOauth 만 바꾼다.
      if (after !== before && hasTokens(after)) writeAtomic(profile.credsFile, mergeOauth(readIfExists(profile.credsFile), after));
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

// rate_limits 를 계정 선택에 쓰는 요약으로 바꾼다.
//
// 사용 가능 규칙: 전체 사용을 막는 한도(session = 5시간, weekly_all = 주간 전체)가 모두 100% 미만이어야 한다.
//   - 응답에 없는 한도는 그 요금제에 없는 한도로 본다 (예: Team 요금제는 weekly_all 행이 없다).
//     단, 둘 다 없거나 사용률이 숫자가 아니면 판정할 수 없으므로 'unknown' 이다.
//   - 초기화 시각이 이미 지난 한도는 서버 값이 늦게 갱신된 것으로 보고 0%로 친다.
//   - 특정 모델 한도(weekly_scoped 등)는 그 모델만 막으므로 판정에 넣지 않고, 동점일 때만 비교한다.
//
//   status        'available' | 'exhausted' | 'unknown'
//   usable        status === 'available'
//   headroom      판정 한도 중 가장 빡빡한 것 기준의 남은 여유(%). unknown 이면 null
//   checked_limits  판정에 쓴 한도별 사용률 (응답에 없던 한도는 null)
//   available_at  다시 쓸 수 있게 되는 시각 (고갈된 한도들이 모두 초기화되는 시각). 사용 가능이면 지금, 모르면 null
//   scoped_headroom  특정 모델 한도 기준의 여유
function summarize(rateLimits, now = Date.now()) {
  const limits = (rateLimits.limits || []).map((l) => {
    const resetMs = l.resets_at ? Date.parse(l.resets_at) : NaN;
    const raw = typeof l.percent === 'number' && Number.isFinite(l.percent) ? l.percent : null;
    const percent = Number.isFinite(resetMs) && resetMs <= now ? 0 : raw;
    return { kind: l.kind, percent, resets_at: l.resets_at || null, resetMs };
  });
  const global = limits.filter((l) => GLOBAL_LIMIT_KINDS.has(l.kind));
  const scoped = limits.filter((l) => !GLOBAL_LIMIT_KINDS.has(l.kind) && l.percent !== null);
  const checked_limits = Object.fromEntries([...GLOBAL_LIMIT_KINDS].map((k) => {
    const rows = global.filter((l) => l.kind === k);
    return [k, rows.length ? Math.max(...rows.map((l) => l.percent ?? NaN)) : null];
  }));
  const base = {
    checked_limits,
    scoped_headroom: Math.max(0, 100 - Math.max(0, ...scoped.map((l) => l.percent))),
    extra_usage_enabled: !!rateLimits.extra_usage?.is_enabled,
  };

  if (!global.length || global.some((l) => l.percent === null)) {
    return { status: 'unknown', usable: false, headroom: null, binding_limit: null, available_at: null, ...base };
  }

  const tightest = global.reduce((a, b) => (b.percent > a.percent ? b : a));
  const exhaustedLimits = global.filter((l) => l.percent >= 100);
  const resetTimes = exhaustedLimits.map((l) => l.resetMs).filter(Number.isFinite);
  const exhausted = exhaustedLimits.length > 0;
  return {
    status: exhausted ? 'exhausted' : 'available',
    usable: !exhausted,
    headroom: Math.max(0, 100 - tightest.percent),
    binding_limit: { kind: tightest.kind, percent: tightest.percent, resets_at: tightest.resets_at },
    available_at: exhausted
      ? (resetTimes.length === exhaustedLimits.length ? new Date(Math.max(...resetTimes)).toISOString() : null)
      : new Date(now).toISOString(),
    ...base,
  };
}

// 토큰 만료 시각. refresh token 이 만료되면 그 계정은 다시 로그인(claude /login)해서 프로필을 새로 받아야 한다.
function tokenExpiry(credsFile) {
  try {
    const o = readJson(credsFile).claudeAiOauth || {};
    const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    return { access_token_expires_at: iso(o.expiresAt), refresh_token_expires_at: iso(o.refreshTokenExpiresAt) };
  } catch {
    return { access_token_expires_at: null, refresh_token_expires_at: null };
  }
}

async function queryAccount(profile, activeEmail) {
  const active = sameEmail(activeEmail, profile.email);
  const credsFile = active ? HOME_CREDS : profile.credsFile;
  const base = { email: profile.email, profile: profile.name, active };
  try {
    const usage = active ? await fetchUsage(HOME) : await fetchUsageForProfile(profile);
    return {
      ...base,
      ok: true,
      tokens: tokenExpiry(credsFile), // 조회 중 갱신됐을 수 있으므로 조회 후에 읽는다
      claude_code_version: usage.version,
      summary: summarize(usage.report.rate_limits),
      rate_limits: usage.report.rate_limits,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: e.message,
      login_required: e instanceof LoginRequiredError,
      tokens: tokenExpiry(credsFile),
    };
  }
}

// ---------------------------------------------------------------- 명령

async function cmdInfo(email) {
  const profiles = loadProfiles();
  const target = findProfile(profiles, email);
  const account = await queryAccount(target, currentHomeEmail());
  if (!account.ok) return { exitCode: EXIT_FAIL, body: { ok: false, error: `${account.email}: ${account.error}`, account } };
  return { exitCode: EXIT_OK, body: { ok: true, fetched_at: new Date().toISOString(), account } };
}

async function cmdInfoAll() {
  const profiles = loadProfiles();
  const activeEmail = currentHomeEmail();
  const accounts = await Promise.all(profiles.map((p) => queryAccount(p, activeEmail)));
  const failed = accounts.filter((a) => !a.ok).map((a) => a.email);
  const usable = accounts.filter((a) => a.ok && a.summary.usable).map((a) => a.email);
  const problems = [
    failed.length ? `${failed.length}개 계정의 사용량 조회에 실패했습니다` : null,
    profiles.skipped.length ? `${profiles.skipped.length}개 프로필을 읽지 못했습니다` : null,
  ].filter(Boolean);
  return {
    exitCode: problems.length ? EXIT_FAIL : EXIT_OK,
    body: {
      ok: !problems.length,
      ...(problems.length ? { error: problems.join(', ') } : {}),
      fetched_at: new Date().toISOString(),
      active: activeEmail,
      usable_accounts: usable,
      failed_accounts: failed,
      skipped_profiles: profiles.skipped,
      accounts,
    },
  };
}

function cmdTurnTo(email) {
  const profiles = loadProfiles();
  const target = findProfile(profiles, email);
  return { exitCode: EXIT_OK, body: { ok: true, mode: 'manual', ...switchTo(profiles, target) } };
}

// 더 좋은 후보가 앞에 오도록 정렬하는 비교 함수. 후보는 status 가 available 또는 exhausted 인 계정뿐이다.
function compareCandidates(a, b) {
  const sa = a.summary, sb = b.summary;
  if (sa.usable !== sb.usable) return sa.usable ? -1 : 1;
  if (sa.usable) return (sb.headroom - sa.headroom) || (sb.scoped_headroom - sa.scoped_headroom);
  // 둘 다 고갈: 먼저 다시 쓸 수 있게 되는 계정이 앞. 시각을 모르면 뒤로.
  const ta = sa.available_at ? Date.parse(sa.available_at) : Infinity;
  const tb = sb.available_at ? Date.parse(sb.available_at) : Infinity;
  return ta - tb;
}

async function cmdTurnAuto() {
  const profiles = loadProfiles();
  const activeEmail = currentHomeEmail();
  const accounts = await Promise.all(profiles.map((p) => queryAccount(p, activeEmail)));
  // 조회 실패·판정 불가 계정은 쓸 수 있는지 확인할 수 없으므로 후보에서 뺀다.
  const candidates = accounts.filter((a) => a.ok && a.summary.status !== 'unknown').sort(compareCandidates);
  const unverified = accounts.filter((a) => !candidates.includes(a)).map((a) => a.email);
  const accountsOut = accounts.map(({ rate_limits, ...a }) => a); // 요약만 싣는다. 원본은 info 로 본다.

  if (!candidates.length) {
    return {
      exitCode: EXIT_FAIL,
      body: {
        ok: false,
        mode: 'auto',
        error: '사용량을 확인할 수 있는 계정이 없습니다',
        unverified_accounts: unverified,
        skipped_profiles: profiles.skipped,
        accounts: accountsOut,
      },
    };
  }

  const best = candidates[0];
  const current = candidates.find((a) => a.active);
  let chosen = best;
  let reason;

  if (!best.summary.usable) {
    // 사용 가능한 계정이 없음: 가장 먼저 풀리는 계정으로 바꿔 둔다. 지금 계정이 그만큼 빨리 풀리면 그대로 둔다.
    if (current && compareCandidates(current, best) <= 0) chosen = current;
    // 확인하지 못한 계정이 있으면 "모두 고갈"이라고 단정할 수 없다.
    reason = unverified.length ? 'no_usable_account_some_unverified' : 'all_exhausted';
  } else if (current && current.summary.usable && best.summary.headroom - current.summary.headroom < SWITCH_MARGIN) {
    chosen = current;
    reason = 'current_is_good_enough';
  } else {
    reason = !current ? 'current_account_unverified' : current.summary.usable ? 'better_account' : 'current_account_exhausted';
  }

  const switched = switchTo(profiles, profiles.find((p) => sameEmail(p.email, chosen.email)));
  const noUsable = !chosen.summary.usable;
  // 사용 가능한 계정이 없을 때: 고른 계정(= 가장 먼저 풀리는 계정)이 풀리는 시각과 지금부터 남은 초.
  // 풀리는 시각을 모르면 둘 다 null 이다.
  const nextAt = noUsable ? chosen.summary.available_at : null;
  const nextInSeconds = nextAt ? Math.max(0, Math.ceil((Date.parse(nextAt) - Date.now()) / 1000)) : null;
  return {
    exitCode: noUsable ? EXIT_ALL_EXHAUSTED : EXIT_OK,
    body: {
      ok: true,
      mode: 'auto',
      result: noUsable ? (unverified.length ? 'no_usable_account' : 'all_exhausted') : (switched.changed ? 'switched' : 'unchanged'),
      reason,
      ...switched,
      usable: !noUsable,
      next_available_account: noUsable ? chosen.email : null,
      next_available_at: nextAt,
      next_available_in_seconds: nextInSeconds,
      unverified_accounts: unverified,
      skipped_profiles: profiles.skipped,
      switch_margin: SWITCH_MARGIN,
      accounts: accountsOut,
    },
  };
}

// ---------------------------------------------------------------- main

const USAGE = '사용법: cc-usermanage turn [<email>] | info [<email>] | sync | help';

function cmdHelp() {
  return {
    exitCode: EXIT_OK,
    body: {
      ok: true,
      description: '여러 Claude Code 계정을 프로필로 보관해 두고, 계정을 바꾸거나 요금제 사용량을 확인한다.',
      commands: [
        { usage: 'cc-usermanage turn <email>', description: '홈(~/)의 계정을 <email> 계정으로 바꾼다. 사용량과 관계없이 지정한 계정으로 바꾸지만, 그 계정의 인증 파일에 토큰이 없으면 바꾸지 않는다.' },
        { usage: 'cc-usermanage turn', description: `모든 계정의 사용량을 조회해 가장 넉넉한 계정으로 바꾼다. 지금 계정보다 여유가 ${SWITCH_MARGIN}%p 이상 많을 때만 바꾸며, 사용 가능한 계정이 없으면 가장 먼저 풀리는 계정으로 바꿔 둔다.` },
        { usage: 'cc-usermanage info <email>', description: '<email> 계정의 요금제 사용량을 조회한다.' },
        { usage: 'cc-usermanage info', description: '모든 계정의 요금제 사용량을 조회한다.' },
        { usage: 'cc-usermanage sync', description: '홈에서 사용 중인 계정의 최신 인증정보를 그 계정의 프로필에 복사한다. 프로필이 없으면 새로 만들어 등록한다. 다른 명령도 실행할 때마다 이것을 자동으로 한다.' },
        { usage: 'cc-usermanage help', description: '이 안내를 출력한다.' },
      ],
      output: '모든 응답은 stdout 에 JSON 하나로 출력한다. 성공이면 "ok": true, 실패면 "ok": false 와 "error".',
      exit_codes: {
        0: '성공',
        1: '실패 (info 전체 조회는 한 계정이라도 조회 실패하거나 읽지 못한 프로필이 있음)',
        2: '자동 turn 에서 사용 가능한 계정이 없음',
      },
      usable_rule: '5시간 한도(session)와 주간 전체 한도(weekly_all)가 모두 100% 미만이면 사용 가능. 응답에 없는 한도는 그 요금제에 없는 한도로 본다.',
      account_status: {
        available: '사용 가능',
        exhausted: '한도 고갈. available_at 에 다시 쓸 수 있게 되는 시각',
        unknown: '사용량을 판정할 수 없음. 자동 turn 의 후보에서 빠진다',
      },
      profiles: {
        dir: PROFILES_DIR,
        layout: '<dir>/<아무 이름>/.claude.json, <dir>/<아무 이름>/.claude/.credentials.json',
        note: '폴더 이름은 상관없고 .claude.json 의 이메일로 계정을 찾는다. USERMANAGE_DIR 로 위치를 바꿀 수 있다. 홈에 로그인된 계정이 프로필에 없으면 이메일 이름의 폴더로 자동 등록한다.',
      },
      cautions: [
        'turn 하기 전에 실행 중인 Claude Code 세션을 모두 종료할 것. 실행 중인 세션이 옛 토큰으로 파일을 덮어쓸 수 있다.',
        'refresh token 이 만료되면(info 의 tokens.refresh_token_expires_at) 그 계정으로 다시 로그인해 프로필을 새로 받아야 한다.',
        '계정을 바꿀 때 인증 파일은 claudeAiOauth 키만, .claude.json 은 oauthAccount 키만 바꾸고 나머지는 그대로 둔다.',
      ],
    },
  };
}

async function main() {
  const [cmd, email, ...rest] = process.argv.slice(2);
  let out;
  try {
    // macOS 의 Claude Code 는 인증정보를 ~/.claude/.credentials.json 이 아니라 키체인에 저장하므로 다룰 수 없다.
    if (process.platform === 'darwin') {
      throw new UsageError('macOS 는 지원하지 않습니다. macOS 의 Claude Code 는 인증정보를 파일이 아니라 키체인에 저장합니다');
    }
    if (rest.length) throw new UsageError(USAGE);
    if (cmd === 'sync') {
      if (email) throw new UsageError(USAGE);
      out = cmdSync();
    } else {
      // 어떤 명령이든 먼저 사용 중인 계정의 최신 인증정보를 보관함(프로필)에 복사해 둔다.
      const before = trySyncActive();
      if (cmd === 'help' || cmd === '--help' || cmd === '-h') out = cmdHelp();
      else if (cmd === 'turn') out = email ? cmdTurnTo(email) : await cmdTurnAuto();
      else if (cmd === 'info') out = email ? await cmdInfo(email) : await cmdInfoAll();
      else throw new UsageError(USAGE);
      // info 는 조회 중 홈의 토큰이 갱신될 수 있으므로 끝난 뒤 한 번 더 복사한다.
      // turn 은 교체할 때 떠나는 계정을 이미 저장하므로 다시 할 필요가 없다.
      const after = cmd === 'info' ? trySyncActive() : null;
      out.body.sync = after ? { ...after, synced: before.synced || after.synced } : before;
    }
  } catch (e) {
    if (e instanceof LoginRequiredError) out = { exitCode: EXIT_FAIL, body: { ok: false, error: e.message, login_required: true } };
    else out = { exitCode: EXIT_FAIL, body: { ok: false, error: e instanceof UsageError ? e.message : String(e && e.stack || e) } };
  }
  process.stdout.write(JSON.stringify({ command: cmd || null, ...out.body }, null, 2) + '\n');
  process.exitCode = out.exitCode;
}

main();
