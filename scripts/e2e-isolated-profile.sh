#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `npx -y @deepseek-ai/dsh@0.1.7-rc.2` cache; the @next cache (c8633a...) is 0.2.0-rc.1 now.
DSH_BIN="${DSH_BIN:-/Users/jwyuan/.npm/_npx/4f4f47d9854f3c73/node_modules/.bin/dsh}"
DSH_EXPECTED_VERSION="${DSH_EXPECTED_VERSION:-0.1.7-rc.2}"
PROFILE="wuyou-test"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
PATCH_PATH="${PROFILE_DIR}/cordis.patch.yml"
PACKAGE_PATH="${PROFILE_DIR}/package.json"
INSTALLED_PLUGIN="${PROFILE_DIR}/node_modules/@nanmicoder/dsh-wuyou-agent"
WEB_PATCH="${HOME}/.dsh/profiles/web/cordis.patch.yml"
WEB_PACKAGE="${HOME}/.dsh/profiles/web/package.json"
ARTIFACT_DIR="${E2E_ARTIFACTS_DIR:-${ROOT_DIR}/test/e2e/artifacts-v2.1}"
if [[ "${ARTIFACT_DIR}" != /* ]]; then
  ARTIFACT_DIR="${ROOT_DIR}/${ARTIFACT_DIR}"
fi
PATCH_TEMPLATE="${E2E_PATCH_TEMPLATE:-${ROOT_DIR}/test/e2e/wuyou-test.patch.template.yml}"
ACP_PACKAGE_VERSION="${E2E_ACP_PACKAGE_VERSION:-0.1.5-rc.2}"
LOG_FIRST="${ARTIFACT_DIR}/wuyou-isolated.log"
LOG_RESTART="${ARTIFACT_DIR}/wuyou-isolated-restart.log"
LOG_RESTART_AFTER_SPAWN="${ARTIFACT_DIR}/wuyou-isolated-restart-after-spawn.log"
LOG_BUNDLE_REMOVED="${ARTIFACT_DIR}/wuyou-bundle-removed.log"
LOG_BUNDLE_RESTORED="${ARTIFACT_DIR}/wuyou-bundle-restored.log"
COOKIE_JAR="${ARTIFACT_DIR}/wuyou-cookie.txt"
STATE_BEFORE="${ARTIFACT_DIR}/state-before.json"
STATE_AFTER="${ARTIFACT_DIR}/state-after.json"
STATE_RESTART="${ARTIFACT_DIR}/state-restart.json"
STATE_RESTART_AFTER_SPAWN="${ARTIFACT_DIR}/state-restart-after-spawn.json"
BUNDLE_RESTORED_STATE="${ARTIFACT_DIR}/bundle-restored-state.json"
CREATE_RESPONSE="${ARTIFACT_DIR}/create-response.json"
TESTER_RESAVE_RESPONSE="${ARTIFACT_DIR}/tester-resave-response.json"
POST_WRITE_RESAVE_RESPONSE="${ARTIFACT_DIR}/post-write-resave-response.json"
ROLE_CLEAR_RESPONSE="${ARTIFACT_DIR}/member-role-null-response.json"
EFFORT_CLEAR_RESPONSE="${ARTIFACT_DIR}/subagent-effort-null-response.json"
INVALID_PROVIDER_RESPONSE="${ARTIFACT_DIR}/member-provider-null-response.json"
FORK_CONVERT_RESPONSE="${ARTIFACT_DIR}/fork-convert-response.json"
ACP_CONVERT_RESPONSE="${ARTIFACT_DIR}/acp-convert-response.json"
ACP_EDIT_RESPONSE="${ARTIFACT_DIR}/acp-edit-response.json"
ACP_CREATE_RESPONSE="${ARTIFACT_DIR}/acp-create-response.json"
ACP_BACK_TO_SPAWN_RESPONSE="${ARTIFACT_DIR}/acp-back-to-spawn-response.json"
ACP_READONLY_RESPONSE="${ARTIFACT_DIR}/acp-readonly-response.json"
STALE_RESPONSE="${ARTIFACT_DIR}/stale-response.json"
INVALID_INPUT_RESPONSE="${ARTIFACT_DIR}/invalid-input-response.json"
DUPLICATE_ID_RESPONSE="${ARTIFACT_DIR}/duplicate-id-response.json"
BROWSER_RESULT="${ARTIFACT_DIR}/browser-result.json"
BROWSER_SCREENSHOT="${ARTIFACT_DIR}/browser-settings.png"
BROWSER_SCREENSHOT_MOBILE="${ARTIFACT_DIR}/browser-settings-mobile.png"
PATCH_BACKUP="${ARTIFACT_DIR}/cordis.patch.before.yml"
PATCH_INITIAL="${ARTIFACT_DIR}/cordis.patch.initial.yml"
PATCH_AFTER_CREATE="${ARTIFACT_DIR}/cordis.patch.after-create.yml"
ACP_BEFORE_EDIT_PATCH="${ARTIFACT_DIR}/cordis.patch.before-acp-edit.yml"
PATCH_AFTER_MUTATIONS="${ARTIFACT_DIR}/cordis.patch.after-mutations.yml"
PATCH_DIFF="${ARTIFACT_DIR}/cordis.patch.diff"
MEMBER_ADD_RESPONSE="${ARTIFACT_DIR}/member-add-response.json"
MEMBER_UPDATE_RESPONSE="${ARTIFACT_DIR}/member-update-response.json"
MEMBER_REMOVE_RESPONSE="${ARTIFACT_DIR}/member-remove-response.json"
MEMBER_REMOVE_HELPER_RESPONSE="${ARTIFACT_DIR}/member-remove-helper-response.json"
MEMBER_REMOVE_CODER_RESPONSE="${ARTIFACT_DIR}/member-remove-coder-response.json"
LAST_MEMBER_RESPONSE="${ARTIFACT_DIR}/last-member-response.json"
PRODUCTION_HASHES="${ARTIFACT_DIR}/production-hashes.txt"
ATOMIC_WRITE_SOURCE="${ARTIFACT_DIR}/atomic-write-source.json"
INSTALL_PACKAGE="${ARTIFACT_DIR}/package-after-install.json"
BUNDLE_PACKAGE_BACKUP="${ARTIFACT_DIR}/package.before-bundle-contrast.json"
BUNDLE_CONTRAST="${ARTIFACT_DIR}/bundle-contrast.json"
BUNDLE_REMOVED_RESPONSE="${ARTIFACT_DIR}/bundle-removed-response.txt"
BUNDLE_DUMP="${ARTIFACT_DIR}/dump-config.txt"
FILE_MODE="${ARTIFACT_DIR}/file-mode.json"
CREDENTIAL_SCAN="${ARTIFACT_DIR}/credential-scan.txt"
R6_NEGATIVE_LOG="${ARTIFACT_DIR}/r6-negative-mount-error.log"

SERVER_PID=""
PORT=""
TOKEN=""
BASE_URL=""
PROFILE_RESTORED=0
BUNDLE_RESTORED=0
TOKEN_PIPE=""
WEB_PATCH_BEFORE=""
WEB_PACKAGE_BEFORE=""
WEB_PATCH_MODE_BEFORE=""
WEB_PACKAGE_MODE_BEFORE=""

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

file_mode() {
  local mode
  mode="$(stat -f '%Lp' "$1" 2>/dev/null || true)"
  if [[ "${mode}" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s' "${mode}"
  else
    stat -c '%a' "$1"
  fi
}

assert_mode_600() {
  local path="$1" label="$2" mode
  mode="$(file_mode "${path}")"
  [[ "${mode}" == "600" ]] || fail "${label}: expected file mode 600, got ${mode}"
  printf '%s' "${mode}"
}

fail() {
  printf 'E2E_FAIL: %s\n' "$*" >&2
  exit 1
}

check_dsh_mount_errors() {
  local log_path="$1" phrase
  [[ -f "${log_path}" ]] || return 1
  local phrases=(
    'cannot enforce maxDepth'
    'does not support child agentOptions'
    'does not support child model selection'
    'does not support `backgroundMode: continuable`'
  )
  for phrase in "${phrases[@]}"; do
    if grep -Fq -- "${phrase}" "${log_path}"; then
      printf 'E2E_R6_MOUNT_ERROR phrase=%s log=%s\n' "${phrase}" "${log_path}" >&2
      return 1
    fi
  done
  return 0
}

assert_no_dsh_mount_errors() {
  local log_path="$1" label="${2:-startup}"
  if ! check_dsh_mount_errors "${log_path}"; then
    fail "${label} log contains a dsh-tool-subagent mount error"
  fi
  printf 'E2E_R6_MOUNT_CHECK label=%s passed=1\n' "${label}"
}

prove_dsh_mount_detector_rejects_bad_log() {
  printf 'dsh-tool-subagent: cannot enforce maxDepth\n' >"${R6_NEGATIVE_LOG}"
  if check_dsh_mount_errors "${R6_NEGATIVE_LOG}"; then
    fail "R6 negative mount-error detector accepted a known bad log"
  fi
  printf 'E2E_R6_NEGATIVE detector_rejected=1 phrase=cannot-enforce-maxDepth\n'
}

stop_server() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 40); do
      if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  SERVER_PID=""
}

restore_profile() {
  if [[ -f "${PATCH_BACKUP}" ]] && [[ "${PROFILE_RESTORED}" -eq 0 ]]; then
    cp "${PATCH_BACKUP}" "${PATCH_PATH}"
    PROFILE_RESTORED=1
  fi
}

redact_file() {
  local path="$1"
  [[ -f "${path}" ]] || return 0
  perl -pi -e 's/[?&]token=[A-Za-z0-9_-]+/[redacted-token]/g; s/dsh-auth=[^;[:space:]]+/[redacted-auth]/g; s/k_[A-Za-z0-9_-]{20,}/[redacted-key]/g' "${path}"
}

redact_artifacts() {
  while IFS= read -r -d '' path; do
    redact_file "${path}"
  done < <(find "${ARTIFACT_DIR}" -type f \( -name '*.log' -o -name '*.json' -o -name '*.txt' -o -name '*.yml' \) -print0 2>/dev/null)
}

cleanup() {
  local exit_code=$?
  stop_server
  if [[ -n "${TOKEN_PIPE}" ]]; then
    rm -f "${TOKEN_PIPE}"
    TOKEN_PIPE=""
  fi
  if [[ -f "${BUNDLE_PACKAGE_BACKUP}" ]] && [[ "${BUNDLE_RESTORED}" -eq 0 ]]; then
    cp "${BUNDLE_PACKAGE_BACKUP}" "${PACKAGE_PATH}"
    BUNDLE_RESTORED=1
  fi
  restore_profile
  rm -f "${COOKIE_JAR}"
  redact_artifacts
  if [[ -n "${WEB_PATCH_BEFORE}" ]] && [[ "$(sha256 "${WEB_PATCH}")" != "${WEB_PATCH_BEFORE}" ]]; then
    printf 'E2E_CLEANUP_ERROR: production cordis.patch.yml changed\n' >&2
    exit_code=1
  fi
  if [[ -n "${WEB_PACKAGE_BEFORE}" ]] && [[ "$(sha256 "${WEB_PACKAGE}")" != "${WEB_PACKAGE_BEFORE}" ]]; then
    printf 'E2E_CLEANUP_ERROR: production package.json changed\n' >&2
    exit_code=1
  fi
  if [[ -n "${WEB_PATCH_MODE_BEFORE}" ]] && [[ "$(file_mode "${WEB_PATCH}")" != "${WEB_PATCH_MODE_BEFORE}" ]]; then
    printf 'E2E_CLEANUP_ERROR: production cordis.patch.yml permissions changed\n' >&2
    exit_code=1
  fi
  if [[ -n "${WEB_PACKAGE_MODE_BEFORE}" ]] && [[ "$(file_mode "${WEB_PACKAGE}")" != "${WEB_PACKAGE_MODE_BEFORE}" ]]; then
    printf 'E2E_CLEANUP_ERROR: production package.json permissions changed\n' >&2
    exit_code=1
  fi
  if [[ -n "${WEB_PATCH_BEFORE}" ]]; then
    {
      printf 'web.cordis.patch.before=%s\n' "${WEB_PATCH_BEFORE}"
      printf 'web.cordis.patch.after=%s\n' "$(sha256 "${WEB_PATCH}")"
      printf 'web.cordis.patch.mode.before=%s\n' "${WEB_PATCH_MODE_BEFORE}"
      printf 'web.cordis.patch.mode.after=%s\n' "$(file_mode "${WEB_PATCH}")"
      printf 'web.package.json.before=%s\n' "${WEB_PACKAGE_BEFORE}"
      printf 'web.package.json.after=%s\n' "$(sha256 "${WEB_PACKAGE}")"
      printf 'web.package.json.mode.before=%s\n' "${WEB_PACKAGE_MODE_BEFORE}"
      printf 'web.package.json.mode.after=%s\n' "$(file_mode "${WEB_PACKAGE}")"
    } >"${PRODUCTION_HASHES}"
  fi
  credential_status=passed
  if grep -RIEq '[?&]token=|dsh-auth=|(^|[^[:alnum:]])k_[A-Za-z0-9_-]{20,}' "${ARTIFACT_DIR}" 2>/dev/null; then
    printf 'E2E_FAIL:credential-residue\n' >&2
    credential_status=failed
    exit_code=1
  fi
  if grep -RIEq '(^|[^[:alnum:]])(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._-]{12,})' "${ARTIFACT_DIR}" 2>/dev/null; then
    printf 'E2E_CLEANUP_ERROR: credential-like value found in retained artifacts\n' >&2
    credential_status=failed
    exit_code=1
  fi
  if find "${ARTIFACT_DIR}" -type f -iname '*cookie*' -print -quit 2>/dev/null | grep -q .; then
    printf 'E2E_CLEANUP_ERROR: cookie artifact was retained\n' >&2
    credential_status=failed
    exit_code=1
  fi
  printf 'status=%s\nquery_token_marker=absent\nauth_cookie_marker=absent\nkey_prefix=absent\n' "${credential_status}" >"${CREDENTIAL_SCAN}"
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

free_port() {
  node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(String(address.port));
  server.close();
});
NODE
}

start_server() {
  local log_path="$1"
  local require_atomic="${2:-1}"
  PORT="$(free_port)"
  BASE_URL="http://127.0.0.1:${PORT}"
  TOKEN=""
  rm -f "${log_path}"
  TOKEN_PIPE="${ARTIFACT_DIR}/.e2e-token.$$"
  rm -f "${TOKEN_PIPE}"
  mkfifo "${TOKEN_PIPE}"
  node - "${DSH_BIN}" "${PROFILE}" "${PORT}" "${log_path}" "${TOKEN_PIPE}" <<'NODE' &
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [dshPath, profile, port, logPath, controlPath] = process.argv.slice(2);
const log = fs.createWriteStream(logPath, { flags: 'w' });
const env = { ...process.env };
delete env.DSH_PROFILE;
env.NODE_DEBUG = 'module';
let recent = '';
let tokenSent = false;
function redact(text) {
  return text
    .replace(/[?&]token=[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/dsh-auth=[^;\s]+/g, '[redacted-auth]')
    .replace(/k_[A-Za-z0-9_-]{20,}/g, '[redacted-key]');
}
function consume(chunk) {
  const text = String(chunk);
  recent = (recent + text).slice(-8192);
  if (!tokenSent) {
    const match = recent.match(/[?&]token=([A-Za-z0-9_-]+)/);
    if (match) {
      tokenSent = true;
      const control = fs.createWriteStream(controlPath);
      control.end(`E2E_TOKEN:${match[1]}\n`);
    }
  }
  log.write(redact(text));
}
const child = spawn(dshPath, ['--profile', profile, '--host', '127.0.0.1', '--port', port, '--no-open'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', consume);
child.stderr.on('data', consume);
child.on('error', (error) => {
  log.write(redact(`${error.stack || error}\n`));
});
function stop(signal) {
  if (!child.killed) child.kill(signal);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('exit', (code, signal) => {
  log.end(() => process.exit(code ?? (signal ? 1 : 0)));
});
NODE
  SERVER_PID="$!"
  local control_line=""
  exec 9<>"${TOKEN_PIPE}"
  for _ in $(seq 1 960); do
    if IFS= read -r -t 1 control_line <&9; then
      if [[ "${control_line}" == E2E_TOKEN:* ]]; then
        TOKEN="${control_line#E2E_TOKEN:}"
        break
      fi
    fi
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      tail -n 80 "${log_path}" >&2 || true
      exec 9>&-
      rm -f "${TOKEN_PIPE}"
      TOKEN_PIPE=""
      fail "DSH exited before emitting launch token"
    fi
  done
  exec 9>&-
  rm -f "${TOKEN_PIPE}"
  TOKEN_PIPE=""

  for _ in $(seq 1 960); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      tail -n 80 "${log_path}" >&2 || true
      fail "DSH exited before becoming ready"
    fi
    # TOKEN is delivered through the in-memory wrapper channel.
    if [[ -n "${TOKEN}" ]]; then
      readiness="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "${BASE_URL}/" || true)"
       if [[ "${readiness}" == "200" || "${readiness}" == "401" || "${readiness}" == "403" ]]; then
        break
      fi
    fi
    sleep 0.25
  done

  [[ -n "${TOKEN}" ]] || fail "launch token was not emitted"
  readiness="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/" || true)"
  [[ "${readiness}" == "200" || "${readiness}" == "401" || "${readiness}" == "403" ]] || fail "DSH did not become reachable (HTTP ${readiness})"

  if [[ "${require_atomic}" == "1" ]]; then
    if grep -Fq 'wuyou-agent: dsh-atomic-write loaded via ' "${log_path}"; then
      grep -Fm1 'wuyou-agent: dsh-atomic-write loaded via ' "${log_path}"
    elif grep -Eq 'load ".*/@deepseek-ai/dsh-atomic-write/lib/index\.js"' "${log_path}"; then
      grep -Em1 'load ".*/@deepseek-ai/dsh-atomic-write/lib/index\.js"' "${log_path}"
      printf 'E2E_NOTE: Cordis buffers info logs; NODE_DEBUG confirms the resolved runtime module path.\n'
    else
      fail "no positive dsh-atomic-write runtime load evidence in ${log_path}"
    fi
  fi

  if grep -Eiq 'wuyou-agent:.*(did not activate|failed to load|activation failed)' "${log_path}"; then
    grep -Ei 'wuyou-agent:.*(did not activate|failed to load|activation failed)' "${log_path}" >&2 || true
    fail "plugin activation failure found in startup log"
  fi
  assert_no_dsh_mount_errors "${log_path}" "${log_path}"
}

assert_http_not_forbidden() {
  local status="$1"
  local body_path="${2:-}"
  [[ "${status}" != "403" ]] || fail "received HTTP 403; stopping immediately"
  if [[ -n "${body_path}" ]] && [[ -f "${body_path}" ]] && grep -Eiq 'quota|额度' "${body_path}"; then
    fail "quota exhaustion response received; stopping immediately"
  fi
}

assert_status() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  local body_path="${4:-}"
  assert_http_not_forbidden "${actual}" "${body_path}"
  if [[ "${actual}" != "${expected}" ]]; then
    if [[ -n "${body_path}" ]] && [[ -f "${body_path}" ]]; then
      printf '%s response: ' "${label}" >&2
      tr '\n' ' ' <"${body_path}" >&2
      printf '\n' >&2
    fi
    fail "${label}: expected HTTP ${expected}, got ${actual}"
  fi
}

exchange_token_and_fetch_state() {
  local state_path="$1"
  local unauth_status auth_status state_status
  rm -f "${COOKIE_JAR}" "${state_path}"
  unauth_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/plugins/dsh-wuyou-agent/api/state")"
  [[ "${unauth_status}" == "401" || "${unauth_status}" == "403" ]] || fail "unauthenticated state expected 401/403, got ${unauth_status}"
  [[ "${unauth_status}" != "403" ]] || printf 'E2E_NOTE: unauthenticated browser fence returned 403 as allowed.\n'

  auth_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -c "${COOKIE_JAR}" "${BASE_URL}/?token=${TOKEN}")"
  assert_http_not_forbidden "${auth_status}"
  [[ "${auth_status}" == "303" || "${auth_status}" == "200" ]] || fail "launch-token exchange expected 303/200, got ${auth_status}"

  state_status="$(curl -sS --max-time 10 -o "${state_path}" -w '%{http_code}' -b "${COOKIE_JAR}" "${BASE_URL}/plugins/dsh-wuyou-agent/api/state")"
  assert_status "${state_status}" "200" "authenticated state" "${state_path}"
  printf 'E2E_AUTH unauth=%s token=REDACTED authenticated=%s state=%s\n' "${unauth_status}" "${auth_status}" "${state_status}"
}

assert_clean_profile_patch() {
  local dirty_rows
  dirty_rows="$(grep -nE '^- id: (wuyou-agent|webServer)$' "${PATCH_PATH}" || true)"
  if [[ -n "${dirty_rows}" ]]; then
    printf 'E2E_FAIL:dirty-profile\n%s\n' "${dirty_rows}" >&2
    exit 1
  fi
}

bundle_contrast() {
  cp "${PACKAGE_PATH}" "${BUNDLE_PACKAGE_BACKUP}"
  node - "${PACKAGE_PATH}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const packagePath = process.argv[2];
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const bundles = pkg.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) throw new Error('clean profile has no dsh.profile.bundles array');
const next = bundles.filter((item) => item !== '@nanmicoder/dsh-wuyou-agent');
if (next.length === bundles.length) throw new Error('plugin bundle was not present before removal contrast');
pkg.dsh.profile.bundles = next;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`E2E_BUNDLE removed=${bundles.length - next.length} before=${bundles.length} after=${next.length}`);
NODE
  stop_server
  assert_clean_profile_patch
  start_server "${LOG_BUNDLE_REMOVED}" 0
  local removed_status
  removed_status="$(curl -sS --max-time 10 -o "${BUNDLE_REMOVED_RESPONSE}" -w '%{http_code}' \
    "${BASE_URL}/plugins/dsh-wuyou-agent/api/state" || true)"
  redact_file "${BUNDLE_REMOVED_RESPONSE}"
  assert_http_not_forbidden "${removed_status}" "${BUNDLE_REMOVED_RESPONSE}"
  if [[ "${removed_status}" != "404" && "${removed_status}" != "000" ]]; then
    fail "bundle removal expected unavailable state route, got HTTP ${removed_status}"
  fi
  stop_server
  cp "${BUNDLE_PACKAGE_BACKUP}" "${PACKAGE_PATH}"
  BUNDLE_RESTORED=1
  assert_clean_profile_patch
  start_server "${LOG_BUNDLE_RESTORED}" 1
  exchange_token_and_fetch_state "${BUNDLE_RESTORED_STATE}"
  cat >"${BUNDLE_CONTRAST}" <<JSON
{"removedStatus":"${removed_status}","removedExpected":["404","000"],"restoredStatus":"200","bundle":"@nanmicoder/dsh-wuyou-agent"}
JSON
  redact_file "${BUNDLE_CONTRAST}"
  printf 'E2E_BUNDLE_CONTRAST removed=%s restored=200 route_recovered=1\n' "${removed_status}"
}

mkdir -p "${ARTIFACT_DIR}"
rm -f "${LOG_FIRST}" "${LOG_RESTART}" "${LOG_RESTART_AFTER_SPAWN}" "${LOG_BUNDLE_REMOVED}" "${LOG_BUNDLE_RESTORED}" \
  "${COOKIE_JAR}" "${STATE_BEFORE}" "${STATE_AFTER}" "${STATE_RESTART}" "${STATE_RESTART_AFTER_SPAWN}" \
  "${BUNDLE_RESTORED_STATE}" "${BUNDLE_REMOVED_RESPONSE}" "${BUNDLE_CONTRAST}" \
  "${BUNDLE_PACKAGE_BACKUP}" "${BUNDLE_DUMP}" "${INSTALL_PACKAGE}" "${R6_NEGATIVE_LOG}" \
  "${CREATE_RESPONSE}" "${TESTER_RESAVE_RESPONSE}" "${POST_WRITE_RESAVE_RESPONSE}" \
  "${ROLE_CLEAR_RESPONSE}" "${EFFORT_CLEAR_RESPONSE}" "${INVALID_PROVIDER_RESPONSE}" \
  "${FORK_CONVERT_RESPONSE}" "${ACP_CONVERT_RESPONSE}" "${ACP_EDIT_RESPONSE}" "${ACP_CREATE_RESPONSE}" "${ACP_BACK_TO_SPAWN_RESPONSE}" "${ACP_READONLY_RESPONSE}" "${STALE_RESPONSE}" \
  "${INVALID_INPUT_RESPONSE}" "${DUPLICATE_ID_RESPONSE}" "${BROWSER_RESULT}" \
  "${BROWSER_SCREENSHOT}" "${BROWSER_SCREENSHOT_MOBILE}" "${PATCH_BACKUP}" "${PATCH_INITIAL}" \
  "${PATCH_AFTER_CREATE}" "${ACP_BEFORE_EDIT_PATCH}" "${PATCH_AFTER_MUTATIONS}" "${PATCH_DIFF}" \
  "${MEMBER_ADD_RESPONSE}" "${MEMBER_UPDATE_RESPONSE}" "${MEMBER_REMOVE_RESPONSE}" \
  "${MEMBER_REMOVE_HELPER_RESPONSE}" "${MEMBER_REMOVE_CODER_RESPONSE}" "${LAST_MEMBER_RESPONSE}" \
  "${PRODUCTION_HASHES}" "${ATOMIC_WRITE_SOURCE}" "${FILE_MODE}" "${CREDENTIAL_SCAN}"
prove_dsh_mount_detector_rejects_bad_log

[[ "${PROFILE}" == "wuyou-test" ]] || fail "E2E refuses to run outside wuyou-test"
[[ -x "${DSH_BIN}" ]] || fail "DSH binary is not executable: ${DSH_BIN}"
DSH_ACTUAL_VERSION="$("${DSH_BIN}" --version 2>/dev/null | tail -1)"
[[ "${DSH_ACTUAL_VERSION}" == "${DSH_EXPECTED_VERSION}" ]] || fail "DSH ${DSH_BIN} is ${DSH_ACTUAL_VERSION}, expected ${DSH_EXPECTED_VERSION} (set DSH_BIN / DSH_EXPECTED_VERSION)"
printf 'E2E_DSH version=%s bin=%s\n' "${DSH_ACTUAL_VERSION}" "${DSH_BIN}"
[[ -f "${PATCH_PATH}" ]] || fail "isolated patch missing: ${PATCH_PATH}"
[[ -f "${PATCH_TEMPLATE}" ]] || fail "clean patch template missing: ${PATCH_TEMPLATE}"
[[ -f "${PACKAGE_PATH}" ]] || fail "isolated package missing: ${PACKAGE_PATH}"
[[ -f "${WEB_PATCH}" && -f "${WEB_PACKAGE}" ]] || fail "production hash baselines are unavailable"

WEB_PATCH_BEFORE="$(sha256 "${WEB_PATCH}")"
WEB_PACKAGE_BEFORE="$(sha256 "${WEB_PACKAGE}")"
WEB_PATCH_MODE_BEFORE="$(file_mode "${WEB_PATCH}")"
WEB_PACKAGE_MODE_BEFORE="$(file_mode "${WEB_PACKAGE}")"
printf 'web.cordis.patch.before=%s\nweb.cordis.patch.mode.before=%s\nweb.package.json.before=%s\nweb.package.json.mode.before=%s\n' \
  "${WEB_PATCH_BEFORE}" "${WEB_PATCH_MODE_BEFORE}" "${WEB_PACKAGE_BEFORE}" "${WEB_PACKAGE_MODE_BEFORE}" >"${PRODUCTION_HASHES}"
cp "${PATCH_PATH}" "${PATCH_BACKUP}"
cp "${PATCH_TEMPLATE}" "${PATCH_PATH}"
chmod 600 "${PATCH_PATH}"
INITIAL_FILE_MODE="$(assert_mode_600 "${PATCH_PATH}" "initial fixture")"
cp "${PATCH_PATH}" "${PATCH_INITIAL}"
assert_clean_profile_patch


installed_target=""
if [[ -e "${INSTALLED_PLUGIN}" ]]; then
  installed_target="$(node -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "${INSTALLED_PLUGIN}")"
fi
if [[ "${installed_target}" != "${ROOT_DIR}" ]]; then
  env -u DSH_PROFILE "${DSH_BIN}" plugin --profile "${PROFILE}" add -w "${ROOT_DIR}"
  installed_target="$(node -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "${INSTALLED_PLUGIN}")"
fi
[[ "${installed_target}" == "${ROOT_DIR}" ]] || fail "installed workspace plugin does not resolve to the repository"
[[ "$(sha256 "${ROOT_DIR}/lib/index.js")" == "$(sha256 "${INSTALLED_PLUGIN}/lib/index.js")" ]] || fail "installed lib/index.js differs from repository build"
[[ "$(sha256 "${ROOT_DIR}/lib/client.js")" == "$(sha256 "${INSTALLED_PLUGIN}/lib/client.js")" ]] || fail "installed lib/client.js differs from repository build"
printf 'E2E_INSTALL target=%s lib_sha=%s client_sha=%s\n' "${installed_target}" "$(sha256 "${ROOT_DIR}/lib/index.js")" "$(sha256 "${ROOT_DIR}/lib/client.js")"
env -u DSH_PROFILE "${DSH_BIN}" plugin --profile "${PROFILE}" add -w "@deepseek-ai/dsh-subagent-acp@${ACP_PACKAGE_VERSION}"
ACP_INSTALLED_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${PROFILE_DIR}/node_modules/@deepseek-ai/dsh-subagent-acp/package.json")"
[[ "${ACP_INSTALLED_VERSION}" == "${ACP_PACKAGE_VERSION}" ]] || fail "isolated ACP package version mismatch: expected ${ACP_PACKAGE_VERSION}, got ${ACP_INSTALLED_VERSION}"
printf 'E2E_INSTALL_ACP package=@deepseek-ai/dsh-subagent-acp version=%s\n' "${ACP_INSTALLED_VERSION}"
cp "${PACKAGE_PATH}" "${INSTALL_PACKAGE}"
env -u DSH_PROFILE "${DSH_BIN}" --profile "${PROFILE}" --dump-config >"${BUNDLE_DUMP}" 2>&1
if ! grep -Fq '# == @nanmicoder/dsh-wuyou-agent' "${BUNDLE_DUMP}" || ! grep -Eq '^- id: wuyou-agent$' "${BUNDLE_DUMP}"; then
  fail "composed config does not include the installed wuyou-agent bundle"
fi

node --input-type=module - "${PATCH_PATH}" "${ROOT_DIR}/lib/index.js" <<'NODE'
import { readFileSync } from 'node:fs';
const [patchPath, modulePath] = process.argv.slice(2);
const api = await import(new URL(`file://${modulePath}`));
const text = readFileSync(patchPath, 'utf8');
const subagents = api.listSubagents(text);
const members = api.listMembers(text, 'standard-acp');
if (!subagents.some((item) => item.config?.provider === 'spawn')) {
  throw new Error('isolated scaffold must contain at least one spawn subagent');
}
if (members.length < 3) throw new Error(`isolated scaffold must contain at least three agent-teams members, got ${members.length}`);
const tester = members.find((item) => item.name === 'tester');
if (!tester || typeof tester.role !== 'string' || tester.role.length < 101) {
  throw new Error('isolated scaffold tester role is missing or not deliberately long');
}
if (!members.some((item) => item.provider && item.model)) {
  throw new Error('isolated scaffold must contain a provider/model member');
}
console.log(`E2E_SCAFFOLD subagents=${subagents.length} members=${members.length}`);
NODE

assert_clean_profile_patch
start_server "${LOG_FIRST}"
exchange_token_and_fetch_state "${STATE_BEFORE}"

node - "${STATE_BEFORE}" "${DSH_BIN}" "${ATOMIC_WRITE_SOURCE}" <<'NODE'
const {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { dirname, isAbsolute, join } = require('node:path');

const [statePath, dshPath, outputPath] = process.argv.slice(2);

function fail(reason, details = {}) {
  console.error(`E2E_FAIL:atomic-write-source ${reason}`);
  if (Object.keys(details).length) console.error(JSON.stringify(details));
  process.exit(1);
}

function packageRootFrom(filePath, packageName) {
  let current = statSync(filePath).isDirectory() ? filePath : dirname(filePath);
  while (current !== dirname(current)) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (!packageName || packageJson.name === packageName) return { path: current, packageJson };
      } catch {
        // Continue toward the filesystem root when an unrelated package is malformed.
      }
    }
    current = dirname(current);
  }
  return null;
}

function isWithin(root, candidate) {
  const relative = require('node:path').relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !isAbsolute(relative));
}

try {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const atomic = state.diagnostics?.atomicWrite;
  if (atomic?.loaded !== true) fail('loaded-false', { atomic });
  if (typeof atomic.resolvedPath !== 'string' || typeof atomic.anchor !== 'string') {
    fail('diagnostics-missing-paths', { atomic });
  }

  const dshRealPath = realpathSync(dshPath);
  const dshPackage = packageRootFrom(dshRealPath, '@deepseek-ai/dsh');
  if (!dshPackage) fail('dsh-package-not-found', { dshRealPath });
  const runtimeNodeModules = dirname(dirname(dshPackage.path));
  const expectedPackagePath = process.env.E2E_EXPECTED_ATOMIC_WRITE_PATH
    ?? join(runtimeNodeModules, '@deepseek-ai', 'dsh-atomic-write');
  if (!existsSync(expectedPackagePath)) {
    fail('runtime-atomic-write-not-found', { dshRealPath, runtimeNodeModules, expectedPackagePath });
  }
  const expectedRealPath = realpathSync(expectedPackagePath);
  const resolvedRealPath = realpathSync(atomic.resolvedPath);
  const resolvedPackage = packageRootFrom(resolvedRealPath, '@deepseek-ai/dsh-atomic-write');
  if (!resolvedPackage || !isWithin(expectedRealPath, resolvedRealPath)) {
    fail('resolved-path-outside-runtime-package', {
      expectedRealPath,
      resolvedRealPath,
      resolvedPackage: resolvedPackage?.path,
    });
  }
  if (realpathSync(resolvedPackage.path) !== expectedRealPath) {
    fail('resolved-package-mismatch', {
      expectedRealPath,
      resolvedPackage: realpathSync(resolvedPackage.path),
    });
  }
  const expectedVersion = JSON.parse(readFileSync(join(expectedRealPath, 'package.json'), 'utf8')).version;
  const resolvedVersion = resolvedPackage.packageJson.version;
  if (!expectedVersion || expectedVersion !== resolvedVersion) {
    fail('version-mismatch', { expectedVersion, resolvedVersion, expectedRealPath, resolvedRealPath });
  }

  const evidence = {
    anchor: atomic.anchor,
    resolvedPath: resolvedRealPath,
    expectedPath: expectedRealPath,
    dshRealPath,
    runtimeNodeModules,
    dshVersion: dshPackage.packageJson.version,
    expectedVersion,
    resolvedVersion,
  };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), 'utf8');
  console.log(`E2E_ATOMIC_WRITE_SOURCE anchor=${atomic.anchor} resolvedPath=${resolvedRealPath} version=${expectedVersion}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
NODE

bundle_contrast

python3 - "${BASE_URL}/?token=${TOKEN}" "${BROWSER_RESULT}" "${BROWSER_SCREENSHOT}" "${BROWSER_SCREENSHOT_MOBILE}" <<'PY'
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

url, output_path, screenshot_path, mobile_screenshot_path = sys.argv[1:5]

def select_workspace(page):
    notice = page.get_by_role("dialog", name="Internal Testing Notice", exact=True)
    try:
        notice.first.wait_for(state="visible", timeout=2_000)
        notice.get_by_role("button", name="Continue", exact=True).click()
        page.wait_for_timeout(500)
    except Exception:
        pass
    workspace = page.get_by_text("dsh-agents-config-panel", exact=True)
    for attempt in range(60):
        if workspace.count() and workspace.first.is_visible():
            workspace.first.click()
            for _ in range(20):
                if not page.locator('[role="presentation"]:visible').count():
                    break
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)
            return
        workspaces = page.get_by_text("Workspaces", exact=True)
        choose_workspace = page.get_by_role("button", name="Choose workspace", exact=True)
        if choose_workspace.count() and choose_workspace.first.is_visible() and attempt in (0, 10):
            choose_workspace.first.click()
        elif workspaces.count() and attempt in (0, 10):
            workspaces.first.click()
        page.wait_for_timeout(500)
    raise RuntimeError(f"isolated workspace entry missing; body={page.locator('body').inner_text()[:2000]}")

HELP_NAME = "Background Mode 说明"

def open_subagent_edit(page, tool_name):
    """v2.10: open 编辑 for one row of the Subagent tools table (not the ACP table)."""
    table = page.locator('[data-panel="subagents"] table').filter(has=page.get_by_role("columnheader", name="工具名", exact=True))
    row = table.locator("tbody tr").filter(has=page.get_by_role("cell", name=tool_name, exact=True))
    row.get_by_role("button", name="编辑", exact=True).click()
    # By its own accessible name, so the host settings dialog around it never matches.
    dialog = page.get_by_role("dialog", name="编辑 Subagent 工具", exact=True)
    dialog.wait_for(state="visible", timeout=30_000)
    return dialog

def help_geometry(page):
    """v2.10: where the open Background Mode bubble is, and whether anything covers it."""
    return page.evaluate("""(name) => {
      const button = document.querySelector(`button[aria-label="${name}"]`);
      const region = button && document.getElementById(button.getAttribute('aria-controls'));
      const bubble = region?.querySelector('[data-help-bubble]');
      const dialog = button?.closest('[role="dialog"]');
      if (!button || !bubble || !dialog) return null;
      const b = button.getBoundingClientRect(), r = bubble.getBoundingClientRect();
      const side = r.top >= b.bottom ? 'below' : r.bottom <= b.top ? 'above' : 'overlap';
      const inset = 12;
      const points = [[r.left + inset, r.top + inset], [r.right - inset, r.top + inset], [r.left + inset, r.bottom - inset],
        [r.right - inset, r.bottom - inset], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
      return {
        side, gap: Math.round(side === 'below' ? r.top - b.bottom : b.top - r.bottom),
        inViewport: r.left >= 7.5 && r.top >= 7.5 && r.right <= innerWidth - 7.5 && r.bottom <= innerHeight - 7.5,
        onTop: points.every(([x, y]) => bubble.contains(document.elementFromPoint(x, y))),
        width: Math.round(r.width), viewport: innerWidth,
        dialogScroll: [dialog.scrollHeight, dialog.scrollTop],
        expanded: button.getAttribute('aria-expanded'),
        current: [...bubble.querySelectorAll('[data-current-mode]')].map((n) => n.dataset.currentMode),
        text: bubble.textContent,
      };
    }""", HELP_NAME)

def open_help(page, dialog, current, extra_text=()):
    """v2.10: click the "?" and check the bubble: placed at the button, fully visible, nothing resized."""
    before = page.evaluate("""(name) => {
      const dialog = document.querySelector(`button[aria-label="${name}"]`).closest('[role="dialog"]');
      return [dialog.scrollHeight, dialog.scrollTop];
    }""", HELP_NAME)
    dialog.get_by_role("button", name=HELP_NAME, exact=True).click()
    page.locator("[data-help-bubble]").wait_for(state="visible", timeout=30_000)
    geo = help_geometry(page)
    required = ("one-shot", "continuable", "默认在前台等子代理完成", "默认在后台运行", "send_message", *extra_text)
    if (not geo or geo["side"] == "overlap" or geo["gap"] != 6 or not geo["inViewport"] or not geo["onTop"]
            or geo["expanded"] != "true" or geo["current"] != [current] or geo["dialogScroll"] != before
            or any(t not in geo["text"] for t in required)):
        raise RuntimeError(f"v2.10 Background Mode help bubble: geometry={ {k: v for k, v in (geo or {}).items() if k != 'text'} } "
                           f"dialog_scroll_before={before} missing={[t for t in required if t not in (geo or {}).get('text', '')]}")
    return geo

with sync_playwright() as playwright:
    # Headless Chromium hides scrollbars by default (0px); keep the theme's real
    # 5px scrollbar so V29 sees the width it takes, as a user's browser does.
    browser = playwright.chromium.launch(headless=True, ignore_default_args=["--hide-scrollbars"])
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector("body", timeout=30_000)
        rpc = page.evaluate(
            """
            async () => {
              const call = async (endpoint) => {
                const rpcId = crypto.randomUUID();
                const response = await fetch(`/api/${endpoint}`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    type: 'client-request', rpcId, method: endpoint, payload: { args: {} },
                  }),
                });
                return { status: response.status, body: await response.json() };
              };
              return {
                providers: await call('llm/listProviders'),
                catalog: await call('session/modelCatalog'),
              };
            }
            """
        )
        select_workspace(page)
        page.wait_for_timeout(1_000)
        page.get_by_role("button", name="Settings").click()
        page.get_by_text("无忧Subagent", exact=True).click()
        subagents = page.get_by_text("Subagent 工具管理", exact=True)
        subagents.first.wait_for(state="visible", timeout=30_000)
        subagents_count = subagents.count()
        page.get_by_role("heading", name="ACP 管理", exact=True).wait_for(state="visible", timeout=30_000)
        page.get_by_text("e2eacp", exact=True).first.wait_for(state="visible", timeout=30_000)
        for label in ("导出", "导入", "新建 ACP"):
            page.get_by_role("button", name=label, exact=True).first.wait_for(state="visible", timeout=30_000)
        page.screenshot(path=screenshot_path, full_page=True)
        # v2.4: 测试 on the first ACP row opens the result dialog (static checks only).
        page.get_by_role("button", name="测试", exact=True).first.click()
        test_dialog = page.locator('[role="dialog"]:not([data-shortcut-modal])').filter(has_text="测试 ACP：e2eacp")
        test_dialog.first.wait_for(state="visible", timeout=30_000)
        test_dialog.first.get_by_text("可执行文件", exact=True).wait_for(state="visible", timeout=30_000)
        test_dialog.first.get_by_role("button", name="握手测试", exact=True).wait_for(state="visible", timeout=30_000)
        test_dialog.first.press("Escape")
        test_dialog.first.wait_for(state="hidden", timeout=30_000)
        # v2.10: "?" next to Background Mode explains one-shot vs continuable; the select is unchanged.
        edit = open_subagent_edit(page, "subagent_e2e_fork")
        mode_select = edit.get_by_role("combobox", name="Background Mode", exact=True)
        if mode_select.locator("option").all_inner_texts() != ["continuable", "one-shot"] or mode_select.input_value() != "one-shot":
            raise RuntimeError(f"Background Mode select changed: {mode_select.locator('option').all_inner_texts()} value={mode_select.input_value()}")
        help_btn = edit.get_by_role("button", name=HELP_NAME, exact=True)
        fork_geo = open_help(page, edit, "one-shot")
        page.screenshot(path=screenshot_path.replace("browser-settings.png", "browser-background-mode-help.png"), full_page=True)
        page.keyboard.press("Escape")  # closes only the bubble
        page.locator("[data-help-bubble]").wait_for(state="detached", timeout=30_000)
        if not edit.is_visible() or help_btn.get_attribute("aria-expanded") != "false" or not help_btn.evaluate("b => document.activeElement === b"):
            raise RuntimeError("Escape must close only the help bubble and return focus to the ? button")
        open_help(page, edit, "one-shot")
        edit.get_by_text("编辑 Subagent 工具", exact=True).click(position={"x": 2, "y": 2})  # outside the bubble
        page.locator("[data-help-bubble]").wait_for(state="detached", timeout=30_000)
        if not edit.is_visible():
            raise RuntimeError("clicking outside the help bubble closed the dialog")
        mode_select.select_option("continuable")  # 当前 follows the drop-down
        open_help(page, edit, "continuable")
        page.keyboard.press("Escape")
        page.locator("[data-help-bubble]").wait_for(state="detached", timeout=30_000)
        page.keyboard.press("Escape")  # now the dialog; nothing saved
        edit.wait_for(state="hidden", timeout=30_000)
        acp_edit = open_subagent_edit(page, "subagent_acp")
        acp_edit.locator('[aria-label="Background Mode: one-shot (read-only)"]').wait_for(state="visible", timeout=30_000)
        open_help(page, acp_edit, "one-shot", ("当前 Provider 不支持 continuable，只能使用 one-shot",))
        page.keyboard.press("Escape")
        page.locator("[data-help-bubble]").wait_for(state="detached", timeout=30_000)
        page.keyboard.press("Escape")
        acp_edit.wait_for(state="hidden", timeout=30_000)
        print(f"E2E_BROWSER_V210 help_button=1 select_unchanged=1 bubble={fork_geo['side']} gap=6 in_viewport=1 on_top=1 "
              "dialog_not_resized=1 escape_closes_bubble_only=1 focus_back=1 outside_click_closes=1 current_follows_select=1 acp_readonly_note=1")
        page.get_by_text("无忧Teams", exact=True).click()
        members = page.get_by_text("团队成员管理", exact=True)
        members.first.wait_for(state="visible", timeout=30_000)
        members_count = members.count()
        # v2.5: the team profile is a select (even with one profile), in the row of
        # 新建成员, right-aligned, below the header buttons 刷新 / 关闭.
        picker = page.get_by_role("combobox", name="团队 profile")
        picker.wait_for(state="visible", timeout=30_000)
        if picker.input_value() != "standard-acp":
            raise RuntimeError(f"team profile select value={picker.input_value()}")
        create_box = page.get_by_role("button", name="新建成员", exact=True).bounding_box()
        refresh_box = page.get_by_role("button", name="刷新", exact=True).last.bounding_box()
        close_box = page.get_by_role("button", name="关闭", exact=True).last.bounding_box()
        picker_box = picker.bounding_box()
        # v2.7: the right-aligned group is [团队 profile ▾] [新建团队] [删除团队].
        new_team_box = page.get_by_role("button", name="新建团队", exact=True).bounding_box()
        delete_team_box = page.get_by_role("button", name="删除团队", exact=True).bounding_box()
        same_row = abs((picker_box["y"] + picker_box["height"] / 2) - (create_box["y"] + create_box["height"] / 2)) < 8
        right_of_create = picker_box["x"] > create_box["x"] + create_box["width"]
        below_header = picker_box["y"] > refresh_box["y"] + refresh_box["height"]
        right_aligned = (new_team_box["x"] > picker_box["x"] + picker_box["width"]
                         and delete_team_box["x"] > new_team_box["x"] + new_team_box["width"]
                         and abs((delete_team_box["x"] + delete_team_box["width"]) - (close_box["x"] + close_box["width"])) < 4)
        if not (same_row and right_of_create and below_header and right_aligned):
            raise RuntimeError(f"team profile picker layout: picker={picker_box} new_team={new_team_box} delete_team={delete_team_box} create={create_box} refresh={refresh_box} close={close_box}")
        page.screenshot(path=screenshot_path.replace("browser-settings.png", "browser-members.png"), full_page=True)
        print("E2E_BROWSER_V25 team_profile_select=standard-acp same_row=1 right_of_create=1 below_header=1 right_aligned=1")
        # v2.6: 新建团队 opens the new / clone dialog with one drop-down.
        page.get_by_role("button", name="新建团队", exact=True).click()
        team_dialog = page.locator('[role="dialog"]:not([data-shortcut-modal])').filter(has_text="从哪里开始")
        team_dialog.first.wait_for(state="visible", timeout=30_000)
        team_options = team_dialog.first.locator("select").first.locator("option").all_inner_texts()
        if team_options[:2] != ["新建空白团队", "克隆：standard-acp"]:
            raise RuntimeError(f"team dialog options={team_options}")
        team_dialog.first.press("Escape")
        team_dialog.first.wait_for(state="hidden", timeout=30_000)
        print("E2E_BROWSER_V26 team_dialog=1 options=新建空白团队,克隆：standard-acp")
        # v2.7: with one team 删除团队 is disabled; clone one, then delete it through the dialog.
        delete_btn = page.get_by_role("button", name="删除团队", exact=True)
        if delete_btn.is_enabled():
            raise RuntimeError("删除团队 must be disabled with a single team")
        page.get_by_role("button", name="新建团队", exact=True).click()
        team_dialog.first.wait_for(state="visible", timeout=30_000)
        team_dialog.first.locator("input").first.fill("e2e-ui-clone")
        team_dialog.first.get_by_role("button", name="克隆", exact=True).click()
        team_dialog.first.wait_for(state="hidden", timeout=30_000)
        page.get_by_text("已创建团队 'e2e-ui-clone'", exact=False).first.wait_for(state="visible", timeout=30_000)
        if page.get_by_role("combobox", name="团队 profile").input_value() != "e2e-ui-clone":
            raise RuntimeError("panel did not switch to the cloned team")
        # The success notice sits above the toolbar (54px) and the first switch clears it,
        # so close it first: otherwise whether frame 1 still sees it is a race (~8ms).
        members_panel = page.locator('[data-panel="members"]')
        members_panel.get_by_role("button", name="关闭提示", exact=True).click()
        members_panel.locator('[data-alert="success"]').wait_for(state="detached", timeout=30_000)
        # v2.8: switching teams must not move the toolbar or the table, toggle the
        # scrollbar, disable the picker or drop focus (was a 29px jump each way).
        page.evaluate("""() => {
          const w = window; w.__sw = { shifts: 0, cls: 0, frames: [] }; w.__swStop = false;
          new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { w.__sw.shifts++; w.__sw.cls += e.value; } })
            .observe({ type: 'layout-shift', buffered: false });
          const first = document.querySelector('[data-panel="members"]');
          const tick = () => {
            const bar = document.querySelector('[data-toolbar="members"]');
            const table = bar?.parentElement?.querySelector('table');
            const picker = document.getElementById('wuyou-team-profile');
            const panel = document.querySelector('[data-panel="members"]');
            const r = (el) => { const b = el?.getBoundingClientRect(); return b ? [Math.round(b.y), Math.round(b.width)] : null; };
            w.__sw.frames.push({ bar: r(bar), tableTop: r(table)?.[0], disabled: !!picker?.disabled, focus: document.activeElement === picker,
              // Diagnostics for a failure: success notice shown, same panel element, picker value, scroll offsets.
              diag: [!!panel?.querySelector('[data-alert="success"]'), panel === first, picker?.value, panel?.scrollTop, panel?.parentElement?.scrollTop].join('|') });
            if (!w.__swStop) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }""")
        switch_picker = page.get_by_role("combobox", name="团队 profile")
        for target in ("standard-acp", "e2e-ui-clone", "standard-acp", "e2e-ui-clone"):
            switch_picker.focus()
            switch_picker.select_option(target)
            page.wait_for_timeout(700)
        page.evaluate("window.__swStop = true")
        sw = page.evaluate("window.__sw")
        bars = {tuple(f["bar"]) for f in sw["frames"] if f["bar"]}
        tops = {f["tableTop"] for f in sw["frames"] if f["tableTop"] is not None}
        if len(bars) != 1 or len(tops) != 1 or any(f["disabled"] for f in sw["frames"]) or not sw["frames"][-1]["focus"] or sw["cls"] > 0.002:
            changes = [(i, f["bar"], f["diag"]) for i, f in enumerate(sw["frames"])
                       if i == 0 or (f["bar"], f["diag"]) != (sw["frames"][i - 1]["bar"], sw["frames"][i - 1]["diag"])]
            raise RuntimeError(f"team switch jitter: bar={bars} table_tops={tops} cls={sw['cls']:.4f} shifts={sw['shifts']} "
                               f"picker_disabled_frames={sum(f['disabled'] for f in sw['frames'])} focus_kept={sw['frames'][-1]['focus']} "
                               f"changes(frame,bar,notice|same_panel|value|scrollTop|outerScrollTop)={changes[:12]}")
        print(f"E2E_BROWSER_V28 switches=4 frames={len(sw['frames'])} toolbar_moved=0 table_top_moved=0 picker_disabled_frames=0 focus_kept=1 cls={sw['cls']:.4f}")
        # v2.9: grow the clone to 8 members (one with a very long name) so it overflows
        # the panel while standard-acp (3) does not. Switching between them must keep
        # every width constant and never overflow the host scroller outside the panel.
        long_name = "e2e-a-deliberately-long-member-name-for-ellipsis"
        grown = page.evaluate("""async (longName) => {
          const api = '/plugins/dsh-wuyou-agent/api';
          const teams = await (await fetch(`${api}/teams`)).json();
          const clone = teams.profiles['e2e-ui-clone'];
          const role = (i) => `第 ${i} 个加宽成员：这段角色描述故意写得很长，用来把成员表撑高到出现面板纵向滚动条，`
            + '并验证列宽不随成员名的长度变化；切换团队时，对话框里的元素都不能被挤压或左右移动。';
          const extra = [longName, 'e2e-wide-b', 'e2e-wide-c', 'e2e-wide-d', 'e2e-wide-e'].map((name, i) => ({ name, role: role(i + 1) }));
          const response = await fetch(`${api}/teams/import`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: teams.revision, overwrite: ['e2e-ui-clone'],
              teams: [{ name: 'e2e-ui-clone', profile: { ...clone, members: [...clone.members, ...extra] } }] }),
          });
          return { status: response.status, body: await response.json() };
        }""", long_name)
        if grown["status"] != 200 or grown["body"].get("importReport", {}).get("overwritten") != ["e2e-ui-clone"]:
            raise RuntimeError(f"v2.9 grow e2e-ui-clone: {grown}")
        page.get_by_role("button", name="刷新", exact=True).last.click()
        page.locator(f'th[scope="row"][title="{long_name}"]').wait_for(state="visible", timeout=30_000)
        page.evaluate("""() => {
          const w = window; w.__gut = { cls: 0, frames: [] }; w.__gutStop = false;
          new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) w.__gut.cls += e.value; })
            .observe({ type: 'layout-shift', buffered: false });
          const tick = () => {
            const panel = document.querySelector('[data-panel="members"]');
            const bar = panel?.querySelector('[data-toolbar="members"]');
            const table = panel?.querySelector('table');
            const width = (el) => (el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null);
            // Scrollers between the panel and its dialog: the host .options area must never overflow.
            const outer = [];
            const stop = panel?.closest('[role="dialog"]') ?? document.body;
            for (let n = panel?.parentElement; n && n !== stop; n = n.parentElement) {
              if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) outer.push(n.scrollHeight > n.clientHeight + 1);
            }
            w.__gut.frames.push({
              rows: panel ? panel.querySelectorAll('th[scope="row"]').length : 0,
              widths: [panel?.clientWidth ?? null, width(bar), width(table), ...[...(table?.querySelectorAll('thead th') ?? [])].map(width)].join(','),
              gutter: panel ? getComputedStyle(panel).scrollbarGutter : null,
              overflow: panel ? panel.scrollHeight > panel.clientHeight + 1 : null,
              outer,
            });
            if (!w.__gutStop) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }""")
        for target in ("standard-acp", "e2e-ui-clone", "standard-acp", "e2e-ui-clone", "standard-acp", "e2e-ui-clone"):
            switch_picker.select_option(target)
            page.wait_for_timeout(700)
        page.evaluate("window.__gutStop = true")
        gut = page.evaluate("window.__gut")
        frames = gut["frames"]
        widths = {f["widths"] for f in frames}
        rows = {f["rows"] for f in frames}
        overflows = {f["overflow"] for f in frames}
        outer_overflow = sum(1 for f in frames if any(f["outer"]))
        no_outer_scroller = sum(1 for f in frames if not f["outer"])
        gutters = {f["gutter"] for f in frames}
        if (len(widths) != 1 or not {3, 8} <= rows or overflows != {True, False} or outer_overflow
                or no_outer_scroller or gutters != {"stable"} or gut["cls"] > 0.002):
            raise RuntimeError(f"v2.9 scrollbar reservation: widths={widths} rows={rows} panel_overflow={overflows} "
                               f"outer_overflow_frames={outer_overflow} frames_without_outer_scroller={no_outer_scroller} "
                               f"gutter={gutters} cls={gut['cls']:.4f}")
        cell = page.evaluate("""(longName) => {
          const th = document.querySelector(`[data-panel="members"] th[scope="row"][title="${longName}"]`);
          return th && { text: th.textContent, clipped: th.scrollWidth > th.clientWidth, ellipsis: getComputedStyle(th).textOverflow };
        }""", long_name)
        if not cell or cell["text"] != long_name or not cell["clipped"] or cell["ellipsis"] != "ellipsis":
            raise RuntimeError(f"v2.9 long member name cell: {cell}")
        page.screenshot(path=screenshot_path.replace("browser-settings.png", "browser-members-scroll.png"), full_page=True)
        print(f"E2E_BROWSER_V29 switches=6 frames={len(frames)} rows=3,8 panel_overflow=both widths_constant=1 "
              f"outer_overflow_frames=0 gutter=stable long_name_ellipsis=1 cls={gut['cls']:.4f}")
        delete_btn.click()
        delete_dialog = page.locator('[role="dialog"]:not([data-shortcut-modal])').filter(has_text="删除团队：e2e-ui-clone")
        delete_dialog.first.wait_for(state="visible", timeout=30_000)
        confirm_btn = delete_dialog.first.get_by_role("button", name="确认删除", exact=True)
        box = delete_dialog.first.get_by_label("请输入 thinktwice 以确认删除")
        for typed in ("", "ThinkTwice"):
            box.fill(typed)
            if confirm_btn.is_enabled():
                raise RuntimeError(f"确认删除 enabled for {typed!r}")
        box.fill("thinktwice")
        if not confirm_btn.is_enabled():
            raise RuntimeError("确认删除 still disabled after typing thinktwice")
        page.screenshot(path=screenshot_path.replace("browser-settings.png", "browser-delete-team.png"), full_page=True)
        confirm_btn.click()
        delete_dialog.first.wait_for(state="hidden", timeout=30_000)
        page.get_by_text("已删除团队 'e2e-ui-clone'", exact=False).first.wait_for(state="visible", timeout=30_000)
        after = page.get_by_role("combobox", name="团队 profile")
        left = after.locator("option").all_inner_texts()
        if after.input_value() != "standard-acp" or left != ["standard-acp"]:
            raise RuntimeError(f"after delete: value={after.input_value()} options={left}")
        print("E2E_BROWSER_V27 single_team_delete_disabled=1 clone=e2e-ui-clone blocked_until_thinktwice=1 deleted=1 back_to=standard-acp")
        page.get_by_role("button", name="新建成员", exact=True).click()
        member_dialog = page.locator('[role="dialog"]:not([data-shortcut-modal])').filter(has_text="新建成员")
        member_dialog.first.wait_for(state="visible", timeout=30_000)
        role_box = member_dialog.first.locator("textarea")
        role_box.wait_for(state="visible", timeout=30_000)
        role_rows = role_box.get_attribute("rows")
        if role_rows != "3":
            raise RuntimeError(f"role textarea rows={role_rows}, expected 3")
        member_dialog.first.press("Escape")
        member_dialog.first.wait_for(state="hidden", timeout=30_000)
        escape_closed = True
        profile_picker = "select-single-profile"
        mobile_page = browser.new_page(viewport={"width": 390, "height": 844})
        mobile_page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        mobile_page.wait_for_selector("body", timeout=30_000)
        select_workspace(mobile_page)
        mobile_page.wait_for_timeout(1_000)
        mobile_page.get_by_role("button", name="Settings").click()
        mobile_page.get_by_text("无忧Subagent", exact=True).click()
        mobile_page.get_by_text("Subagent 工具管理", exact=True).first.wait_for(state="visible", timeout=30_000)
        mobile_edit = open_subagent_edit(mobile_page, "subagent_e2e_fork")
        mobile_geo = open_help(mobile_page, mobile_edit, "one-shot")
        mobile_page.keyboard.press("Escape")
        mobile_page.locator("[data-help-bubble]").wait_for(state="detached", timeout=30_000)
        mobile_page.keyboard.press("Escape")
        mobile_edit.wait_for(state="hidden", timeout=30_000)
        print(f"E2E_BROWSER_V210_MOBILE viewport={mobile_geo['viewport']} bubble_width={mobile_geo['width']} bubble={mobile_geo['side']} in_viewport=1 on_top=1")
        mobile_page.get_by_text("无忧Teams", exact=True).click()
        mobile_page.get_by_text("团队成员管理", exact=True).first.wait_for(state="visible", timeout=30_000)
        print("E2E_BROWSER_V23 labels=无忧Subagent,无忧Teams acp_section=1 import_export=1 role_textarea_rows=3 acp_test_dialog=1")
        mobile_page.screenshot(path=mobile_screenshot_path, full_page=True)
        result = {
            "rpc": rpc,
            "escapeClosed": escape_closed,
             "profilePicker": profile_picker,
             "panels": {
                "subagents": subagents_count,
                "members": members_count,
                                            },
            "moduleLoaderType": page.evaluate("typeof window.__ModuleLoader__"),
            "pageErrors": page_errors,
        }
        Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if rpc["providers"]["status"] != 200 or rpc["catalog"]["status"] != 200:
            raise RuntimeError(f"runtime RPC failed: {rpc}")
        if result["panels"]["subagents"] < 1 or result["panels"]["members"] < 1:
            raise RuntimeError(f"settings panels missing: {result['panels']}")
        if result["escapeClosed"] is not True or result["profilePicker"] != "select-single-profile":
            raise RuntimeError(f"modal/profile checks missing: {result}")
        if result["moduleLoaderType"] != "object":
            raise RuntimeError(f"window.__ModuleLoader__ is {result['moduleLoaderType']}")
        if page_errors:
            raise RuntimeError(f"browser page errors: {page_errors}")
        print("E2E_BROWSER panels=subagents,members moduleLoader=object screenshots=desktop,mobile escape=closed profile_picker=select-single-profile")
    finally:
        browser.close()
PY
redact_file "${BROWSER_RESULT}"

node - "${STATE_BEFORE}" "${BROWSER_RESULT}" <<'NODE'
const fs = require('node:fs');
const [statePath, browserPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const browser = JSON.parse(fs.readFileSync(browserPath, 'utf8'));
if (Object.keys(state.errors ?? {}).length) throw new Error(`plugin state errors: ${JSON.stringify(state.errors)}`);
if (state.diagnostics?.hostApi !== 2) throw new Error(`expected hostApi=2, got ${JSON.stringify(state.diagnostics)}`);
if (state.diagnostics?.subagentProvidersSource !== 'runtime') {
  throw new Error(`expected runtime provider source, got ${JSON.stringify(state.diagnostics)}`);
}
const providerNames = (state.subagentProviders ?? []).map((provider) => provider.name);
for (const required of ['spawn', 'fork', 'e2eacp', 'e2eacp2']) {
  if (!providerNames.includes(required)) throw new Error(`runtime provider ${required} missing: ${providerNames}`);
}
for (const name of ['e2eacp', 'e2eacp2']) {
  const provider = state.subagentProviders.find((item) => item.name === name);
  if (provider?.kind !== 'acp' || provider.capabilities?.continuable !== false) {
    throw new Error(`unexpected ACP capabilities for ${name}: ${JSON.stringify(provider)}`);
  }
}
const remoteProviders = browser.rpc.providers.body.result.value;
const remoteCatalog = browser.rpc.catalog.body.result.value;
const stateProviderIds = state.catalog.providers.map((item) => item.id).sort();
const remoteProviderIds = remoteProviders.map((item) => item.id).sort();
if (JSON.stringify(stateProviderIds) !== JSON.stringify(remoteProviderIds)) {
  throw new Error(`provider mismatch: plugin=${stateProviderIds} runtime=${remoteProviderIds}`);
}
const runtimeRoutes = new Set(remoteCatalog.groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`)));
for (const provider of state.catalog.providers) {
  for (const model of provider.models) {
    if (!runtimeRoutes.has(`${provider.id}/${model.id}`)) {
      throw new Error(`model mismatch: ${provider.id}/${model.id}`);
    }
  }
}
const spawn = state.subagents.find((item) => item.config?.provider === 'spawn');
if (!spawn) throw new Error('state did not parse the spawn scaffold');
if (!state.members.some((item) => item.name === 'tester')) throw new Error('state did not parse the agent-teams scaffold');
console.log(`E2E_CATALOG providers=${stateProviderIds.join(',')} runtimeModels=${runtimeRoutes.size}`);
NODE

PATCH_SHA_BEFORE="$(sha256 "${PATCH_PATH}")"
REVISION_BEFORE="$(node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(s.revision)' "${STATE_BEFORE}")"
[[ "${PATCH_SHA_BEFORE}" == "${REVISION_BEFORE}" ]] || fail "state revision does not match exact pre-write patch SHA"

INVALID_INPUT_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
INVALID_INPUT_STATUS="$(curl -sS --max-time 15 -o "${INVALID_INPUT_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' \
  --data '{"action":"create","input":{"toolName":"subagent_x","provider":"fork"}}' \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${INVALID_INPUT_STATUS}" "400" "missing expectedRevision" "${INVALID_INPUT_RESPONSE}"
node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.code!=="INVALID") throw new Error(`expected INVALID, got ${JSON.stringify(value)}`)' "${INVALID_INPUT_RESPONSE}"
[[ "$(sha256 "${PATCH_PATH}")" == "${INVALID_INPUT_HASH_BEFORE}" ]] || fail "missing expectedRevision request changed the patch"
printf 'E2E_INVALID_INPUT status=%s code=INVALID unchanged=1\n' "${INVALID_INPUT_STATUS}"

DUPLICATE_ID_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
DUPLICATE_ID_PAYLOAD="$(node - "${REVISION_BEFORE}" <<'NODE'
process.stdout.write(JSON.stringify({
  action: 'create',
  expectedRevision: process.argv[2],
  input: { toolName: 'subagent_control', provider: 'fork' },
}));
NODE
)"
DUPLICATE_ID_STATUS="$(curl -sS --max-time 15 -o "${DUPLICATE_ID_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${DUPLICATE_ID_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${DUPLICATE_ID_STATUS}" "409" "duplicate delegation id" "${DUPLICATE_ID_RESPONSE}"
node - "${DUPLICATE_ID_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = `id 'tool-subagent-control' ${String.fromCharCode(0x5df2, 0x5b58, 0x5728)}`;
if (value.code !== 'DUPLICATE' || value.message !== expected) {
  throw new Error(`expected DUPLICATE id message, got ${JSON.stringify(value)}`);
}
NODE
[[ "$(sha256 "${PATCH_PATH}")" == "${DUPLICATE_ID_HASH_BEFORE}" ]] || fail "duplicate delegation id request changed the patch"
printf 'E2E_DUPLICATE_ID status=%s code=DUPLICATE unchanged=1\n' "${DUPLICATE_ID_STATUS}"

TESTER_RESAVE_PAYLOAD="$(node - "${STATE_BEFORE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tester = state.members.find((member) => member.name === 'tester');
if (!tester) throw new Error('tester member missing from state');
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  profile: 'standard-acp',
  name: 'tester',
  patch: {
    role: tester.role,
    provider: tester.provider,
    model: tester.model,
    reasoning_effort: tester.reasoning_effort,
  },
}));
NODE
)"
TESTER_RESAVE_STATUS="$(curl -sS --max-time 15 -o "${TESTER_RESAVE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${TESTER_RESAVE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${TESTER_RESAVE_STATUS}" "200" "tester byte-identical resave" "${TESTER_RESAVE_RESPONSE}"
TESTER_RESAVE_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${TESTER_RESAVE_RESPONSE}")"
[[ "${TESTER_RESAVE_REVISION}" == "${REVISION_BEFORE}" ]] || fail "tester no-op resave changed the revision"
[[ "$(sha256 "${PATCH_PATH}")" == "${PATCH_SHA_BEFORE}" ]] || fail "tester no-op resave changed YAML bytes"
printf 'E2E_TESTER_RESAVE status=%s byte_identical=1\n' "${TESTER_RESAVE_STATUS}"

CREATE_PAYLOAD="$(node - "${STATE_BEFORE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const route = state.catalog.providers.flatMap((provider) => provider.models.map((model) => ({
  provider: provider.id,
  model: model.id,
  reasoningEffort: model.reasoningEfforts?.[0],
})))[0];
if (!route) throw new Error('no runtime-backed model route available for spawn E2E');
process.stdout.write(JSON.stringify({
  action: 'create',
  expectedRevision: state.revision,
  input: {
    toolName: 'subagent_e2e',
    provider: 'spawn',
    backgroundMode: 'one-shot',
    agentOptions: route,
  },
}));
NODE
)"

CREATE_STATUS="$(curl -sS --max-time 15 -o "${CREATE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${CREATE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${CREATE_STATUS}" "200" "spawn create" "${CREATE_RESPONSE}"
printf 'E2E_CREATE status=%s\n' "${CREATE_STATUS}"

cp "${PATCH_PATH}" "${PATCH_AFTER_CREATE}"
PATCH_SHA_AFTER="$(sha256 "${PATCH_PATH}")"
REVISION_AFTER="$(node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(s.revision)' "${CREATE_RESPONSE}")"
[[ "${PATCH_SHA_AFTER}" != "${PATCH_SHA_BEFORE}" ]] || fail "spawn create did not change the patch SHA"
[[ "${PATCH_SHA_AFTER}" == "${REVISION_AFTER}" ]] || fail "create response revision does not match exact patch SHA"
MODE_AFTER_WRITE="$(assert_mode_600 "${PATCH_PATH}" "after spawn create")"

POST_WRITE_RESAVE_PAYLOAD="$(node - "${CREATE_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tester = state.members.find((member) => member.name === 'tester');
if (!tester) throw new Error('tester member missing from post-write state');
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  profile: 'standard-acp',
  name: 'tester',
  patch: {
    role: tester.role,
    provider: tester.provider,
    model: tester.model,
    reasoning_effort: tester.reasoning_effort,
  },
}));
NODE
)"
POST_WRITE_RESAVE_STATUS="$(curl -sS --max-time 15 -o "${POST_WRITE_RESAVE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${POST_WRITE_RESAVE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${POST_WRITE_RESAVE_STATUS}" "200" "post-write tester resave" "${POST_WRITE_RESAVE_RESPONSE}"
POST_WRITE_RESAVE_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${POST_WRITE_RESAVE_RESPONSE}")"
[[ "${POST_WRITE_RESAVE_REVISION}" == "${REVISION_AFTER}" ]] || fail "post-write no-op resave changed the revision"
[[ "$(sha256 "${PATCH_PATH}")" == "${PATCH_SHA_AFTER}" ]] || fail "post-write no-op resave changed YAML bytes"
MODE_AFTER_RESAVE="$(assert_mode_600 "${PATCH_PATH}" "after post-write resave")"
node - "${FILE_MODE}" "${INITIAL_FILE_MODE}" "${MODE_AFTER_WRITE}" "${MODE_AFTER_RESAVE}" <<'NODE'
const fs = require('node:fs');
const [output, initial, afterWrite, afterResave] = process.argv.slice(2);
fs.writeFileSync(output, `${JSON.stringify({ path: 'wuyou-test/cordis.patch.yml', initial, afterWrite, afterResave })}\n`);
NODE
printf 'E2E_FILE_MODE initial=%s after_write=%s after_resave=%s\n' "${INITIAL_FILE_MODE}" "${MODE_AFTER_WRITE}" "${MODE_AFTER_RESAVE}"

node --input-type=module - "${PATCH_INITIAL}" "${PATCH_AFTER_CREATE}" "${ROOT_DIR}/lib/index.js" "${CREATE_RESPONSE}" <<'NODE'
import { readFileSync } from 'node:fs';
const [beforePath, afterPath, modulePath, responsePath] = process.argv.slice(2);
const api = await import(new URL(`file://${modulePath}`));
const before = readFileSync(beforePath, 'utf8');
const after = readFileSync(afterPath, 'utf8');
const response = JSON.parse(readFileSync(responsePath, 'utf8'));
const rows = api.listSubagents(after).filter((item) => item.config?.toolName === 'subagent_e2e');
if (rows.length !== 1) throw new Error(`expected one subagent_e2e row, got ${rows.length}`);
const created = response.subagents?.find((item) => item.config?.toolName === 'subagent_e2e');
if (!created || created.config?.provider !== 'spawn') throw new Error('create response did not contain the spawn row');
const route = created.config.agentOptions;
const catalogRoutes = new Set(response.catalog.providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`)));
if (!route || !catalogRoutes.has(`${route.provider}/${route.model}`) || !route.reasoningEffort) {
  throw new Error(`created spawn route is not catalog-backed: ${JSON.stringify(route)}`);
}
const document = api.parseYaml(after);
const sequence = api.findSubagentSequence(document);
const row = sequence.items.find((item) => api.scalarString(api.pairValue(item, 'id')) === 'tool-subagent-e2e');
const range = api.nodeRange(row);
if (!range) throw new Error('could not locate inserted subagent CST range');
const start = api.lineStart(after, range[0]);
const withoutInsertedRow = after.slice(0, start) + after.slice(range[1]);
if (withoutInsertedRow !== before) {
  throw new Error('create changed content outside the inserted delegation row');
}
console.log('E2E_DIFF only=delegation/tool-subagent-e2e');
NODE

FORK_CONVERT_PAYLOAD="$(node - "${CREATE_RESPONSE}" "${REVISION_AFTER}" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const route = response.catalog.providers.flatMap((provider) => provider.models.map((model) => ({
  provider: provider.id,
  model: model.id,
  reasoningEffort: model.reasoningEfforts?.[0],
})))[0];
if (!route) throw new Error('no catalog route for fork conversion');
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: process.argv[3],
  id: 'tool-subagent-e2e-fork',
  patch: { provider: 'spawn', agentOptions: route },
}));
NODE
)"
FORK_CONVERT_STATUS="$(curl -sS --max-time 15 -o "${FORK_CONVERT_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${FORK_CONVERT_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${FORK_CONVERT_STATUS}" "200" "fork to spawn conversion" "${FORK_CONVERT_RESPONSE}"
node -e 'const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const row=state.subagents.find((item)=>item.id==="tool-subagent-e2e-fork"); if(row?.config?.provider!=="spawn" || !row.config.agentOptions?.model) throw new Error(`fork conversion missing spawn route: ${JSON.stringify(row)}`)' "${FORK_CONVERT_RESPONSE}"
FORK_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${FORK_CONVERT_RESPONSE}")"
printf 'E2E_FORK_CONVERSION status=%s provider=spawn\n' "${FORK_CONVERT_STATUS}"

ACP_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
ACP_CONVERT_PAYLOAD="$(node - "${FORK_CONVERT_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const route = response.catalog.providers.flatMap((provider) => provider.models.map((model) => ({
  provider: provider.id,
  model: model.id,
  reasoningEffort: model.reasoningEfforts?.[0],
})))[0];
if (!route) throw new Error('no catalog route for ACP conversion');
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: response.revision,
  id: 'tool-subagent-e2e',
  patch: { provider: 'e2eacp', backgroundMode: 'one-shot', agentOptions: route },
}));
NODE
)"
ACP_CONVERT_STATUS="$(curl -sS --max-time 15 -o "${ACP_CONVERT_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${ACP_CONVERT_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${ACP_CONVERT_STATUS}" "200" "spawn to registered ACP conversion" "${ACP_CONVERT_RESPONSE}"
node - "${ACP_CONVERT_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-e2e');
if (!row || row.config?.provider !== 'e2eacp' || row.config?.backgroundMode !== 'one-shot') {
  throw new Error(`registered ACP conversion missing: ${JSON.stringify(row)}`);
}
if (row.config?.maxDepth !== 'provider-managed' || Object.prototype.hasOwnProperty.call(row.config, 'agentOptions')) {
  throw new Error(`ACP normalization retained incompatible keys: ${JSON.stringify(row.config)}`);
}
for (const key of ['modelSelectionSettings', 'persona', 'toolFilter']) {
  if (Object.prototype.hasOwnProperty.call(row.config, key)) throw new Error(`ACP row retained ${key}`);
}
NODE
ACP_CONVERT_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${ACP_CONVERT_RESPONSE}")"
cp "${PATCH_PATH}" "${ACP_BEFORE_EDIT_PATCH}"
printf 'E2E_ACP_CONVERT status=%s provider=e2eacp normalized=1\n' "${ACP_CONVERT_STATUS}"

ACP_EDIT_PAYLOAD="$(node - "${ACP_CONVERT_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: response.revision,
  id: 'tool-subagent-e2e',
  patch: { toolName: 'subagent_e2e_acp' },
}));
NODE
)"
ACP_EDIT_STATUS="$(curl -sS --max-time 15 -o "${ACP_EDIT_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${ACP_EDIT_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${ACP_EDIT_STATUS}" "200" "registered ACP edit" "${ACP_EDIT_RESPONSE}"
node - "${ACP_EDIT_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-e2e-acp');
if (!row || row.config?.provider !== 'e2eacp' || row.config?.toolName !== 'subagent_e2e_acp') {
  throw new Error(`registered ACP edit missing: ${JSON.stringify(row)}`);
}
NODE
node --input-type=module - "${ACP_BEFORE_EDIT_PATCH}" "${PATCH_PATH}" "${ROOT_DIR}/lib/index.js" <<'NODE'
import { readFileSync } from 'node:fs';
const [beforePath, afterPath, modulePath] = process.argv.slice(2);
const api = await import(new URL(`file://${modulePath}`));
function withoutRow(text, id) {
  const sequence = api.findSubagentSequence(api.parseYaml(text));
  const row = sequence.items.find((item) => api.scalarString(api.pairValue(item, 'id')) === id);
  if (!row) throw new Error(`missing row ${id}`);
  const range = api.nodeRange(row);
  if (!range) throw new Error(`missing row range ${id}`);
  const start = api.lineStart(text, range[0]);
  return text.slice(0, start) + text.slice(range[1]);
}
const before = readFileSync(beforePath, 'utf8');
const after = readFileSync(afterPath, 'utf8');
if (withoutRow(before, 'tool-subagent-e2e') !== withoutRow(after, 'tool-subagent-e2e-acp')) {
  throw new Error('registered ACP edit changed bytes outside its delegation row');
}
NODE
ACP_EDIT_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${ACP_EDIT_RESPONSE}")"
printf 'E2E_ACP_EDIT status=%s provider=e2eacp unrelated_bytes_preserved=1\n' "${ACP_EDIT_STATUS}"

ACP_CREATE_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"create",expectedRevision:process.argv[1],input:{toolName:"subagent_e2e_acp2",provider:"e2eacp2",backgroundMode:"one-shot"}}))' "${ACP_EDIT_REVISION}")"
ACP_CREATE_STATUS="$(curl -sS --max-time 15 -o "${ACP_CREATE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${ACP_CREATE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${ACP_CREATE_STATUS}" "200" "e2eacp2 create" "${ACP_CREATE_RESPONSE}"
node - "${ACP_CREATE_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-e2e-acp2');
if (!row || row.config?.provider !== 'e2eacp2' || row.config?.backgroundMode !== 'one-shot' || row.config?.maxDepth !== 'provider-managed') {
  throw new Error(`e2eacp2 row missing or unnormalized: ${JSON.stringify(row)}`);
}
NODE
printf 'E2E_ACP_CREATE status=%s provider=e2eacp2 maxDepth=provider-managed\n' "${ACP_CREATE_STATUS}"

ACP_READONLY_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
ACP_READONLY_PAYLOAD="$(node - "${ACP_CREATE_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  id: 'tool-subagent-codex',
  patch: { backgroundMode: 'one-shot' },
}));
NODE
)"
ACP_READONLY_STATUS="$(curl -sS --max-time 15 -o "${ACP_READONLY_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${ACP_READONLY_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${ACP_READONLY_STATUS}" "422" "unregistered provider update" "${ACP_READONLY_RESPONSE}"
node - "${ACP_READONLY_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑";
if (value.code !== 'READ_ONLY' || value.message !== expected) throw new Error(`expected READ_ONLY, got ${JSON.stringify(value)}`);
NODE
[[ "$(sha256 "${PATCH_PATH}")" == "${ACP_READONLY_HASH_BEFORE}" ]] || fail "unregistered provider request changed the patch"
printf 'E2E_ACP_READONLY status=%s code=READ_ONLY unchanged=1\n' "${ACP_READONLY_STATUS}"

ROLE_CLEAR_PAYLOAD="$(node - "${ACP_CREATE_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  profile: 'standard-acp',
  name: 'tester',
  patch: { role: null },
}));
NODE
)"
ROLE_CLEAR_STATUS="$(curl -sS --max-time 15 -o "${ROLE_CLEAR_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${ROLE_CLEAR_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${ROLE_CLEAR_STATUS}" "200" "member role null clear" "${ROLE_CLEAR_RESPONSE}"
node - "${ROLE_CLEAR_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const member = state.members.find((item) => item.name === 'tester');
if (!member || Object.prototype.hasOwnProperty.call(member, 'role')) {
  throw new Error(`member role was not cleared: ${JSON.stringify(member)}`);
}
NODE
ROLE_CLEAR_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${ROLE_CLEAR_RESPONSE}")"
printf 'E2E_CLEAR_ROLE status=%s member=tester role_absent=1\n' "${ROLE_CLEAR_STATUS}"

EFFORT_CLEAR_PAYLOAD="$(node - "${ROLE_CLEAR_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  id: 'tool-subagent-seed',
  patch: { agentOptions: { reasoningEffort: null } },
}));
NODE
)"
EFFORT_CLEAR_STATUS="$(curl -sS --max-time 15 -o "${EFFORT_CLEAR_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${EFFORT_CLEAR_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${EFFORT_CLEAR_STATUS}" "200" "spawn reasoningEffort null clear" "${EFFORT_CLEAR_RESPONSE}"
node - "${EFFORT_CLEAR_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-seed');
if (!row || Object.prototype.hasOwnProperty.call(row.config?.agentOptions ?? {}, 'reasoningEffort')) {
  throw new Error(`spawn reasoningEffort was not cleared: ${JSON.stringify(row)}`);
}
NODE
EFFORT_CLEAR_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${EFFORT_CLEAR_RESPONSE}")"
printf 'E2E_CLEAR_EFFORT status=%s subagent=tool-subagent-seed reasoningEffort_absent=1\n' "${EFFORT_CLEAR_STATUS}"

INVALID_PROVIDER_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
INVALID_PROVIDER_PAYLOAD="$(node - "${EFFORT_CLEAR_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  profile: 'standard-acp',
  name: 'coder',
  patch: { provider: null },
}));
NODE
)"
INVALID_PROVIDER_STATUS="$(curl -sS --max-time 15 -o "${INVALID_PROVIDER_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${INVALID_PROVIDER_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${INVALID_PROVIDER_STATUS}" "400" "member provider-only null clear" "${INVALID_PROVIDER_RESPONSE}"
node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.code!=="INVALID") throw new Error(`expected INVALID, got ${JSON.stringify(value)}`)' "${INVALID_PROVIDER_RESPONSE}"
[[ "$(sha256 "${PATCH_PATH}")" == "${INVALID_PROVIDER_HASH_BEFORE}" ]] || fail "provider-only null request changed the patch"
printf 'E2E_INVALID_PROVIDER status=%s code=INVALID unchanged=1\n' "${INVALID_PROVIDER_STATUS}"

STALE_HASH_BEFORE="$(sha256 "${PATCH_PATH}")"
STALE_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"update",expectedRevision:process.argv[1],id:"tool-subagent-e2e-acp",patch:{backgroundMode:"continuable"}}))' "${REVISION_BEFORE}")"
STALE_STATUS="$(curl -sS --max-time 15 -o "${STALE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${STALE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${STALE_STATUS}" "409" "stale revision" "${STALE_RESPONSE}"
node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.code!=="STALE_REVISION") throw new Error(`expected STALE_REVISION, got ${JSON.stringify(value)}`)' "${STALE_RESPONSE}"
[[ "$(sha256 "${PATCH_PATH}")" == "${STALE_HASH_BEFORE}" ]] || fail "stale request changed the patch"
printf 'E2E_STALE status=%s code=STALE_REVISION unchanged=%s\n' "${STALE_STATUS}" "${STALE_HASH_BEFORE}"

MEMBER_ADD_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"add",expectedRevision:process.argv[1],profile:"standard-acp",member:{name:"e2e-helper"}}))' "${EFFORT_CLEAR_REVISION}")"
MEMBER_ADD_STATUS="$(curl -sS --max-time 15 -o "${MEMBER_ADD_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${MEMBER_ADD_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${MEMBER_ADD_STATUS}" "200" "member add without role" "${MEMBER_ADD_RESPONSE}"
node -e 'const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const member=state.members.find((item)=>item.name==="e2e-helper"); if(!member || member.role!==undefined) throw new Error(`member add unexpectedly supplied role: ${JSON.stringify(member)}`)' "${MEMBER_ADD_RESPONSE}"
MEMBER_ADD_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${MEMBER_ADD_RESPONSE}")"

MEMBER_UPDATE_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"update",expectedRevision:process.argv[1],profile:"standard-acp",name:"e2e-helper",patch:{role:"E2E helper role filled after add"}}))' "${MEMBER_ADD_REVISION}")"
MEMBER_UPDATE_STATUS="$(curl -sS --max-time 15 -o "${MEMBER_UPDATE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${MEMBER_UPDATE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${MEMBER_UPDATE_STATUS}" "200" "member role update" "${MEMBER_UPDATE_RESPONSE}"
node -e 'const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const member=state.members.find((item)=>item.name==="e2e-helper"); if(member?.role!=="E2E helper role filled after add") throw new Error(`member role update missing: ${JSON.stringify(member)}`)' "${MEMBER_UPDATE_RESPONSE}"
MEMBER_UPDATE_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${MEMBER_UPDATE_RESPONSE}")"

MEMBER_REMOVE_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"remove",expectedRevision:process.argv[1],profile:"standard-acp",name:"tester"}))' "${MEMBER_UPDATE_REVISION}")"
MEMBER_REMOVE_STATUS="$(curl -sS --max-time 15 -o "${MEMBER_REMOVE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${MEMBER_REMOVE_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${MEMBER_REMOVE_STATUS}" "200" "member tester removal" "${MEMBER_REMOVE_RESPONSE}"
MEMBER_REMOVE_REVISION="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${MEMBER_REMOVE_RESPONSE}")"

trim_member() {
  local member_name="$1" response_path="$2" expected_revision="$3"
  local payload status
  payload="$(node -e 'process.stdout.write(JSON.stringify({action:"remove",expectedRevision:process.argv[1],profile:"standard-acp",name:process.argv[2]}))' "${expected_revision}" "${member_name}")"
  status="$(curl -sS --max-time 15 -o "${response_path}" -w '%{http_code}' -b "${COOKIE_JAR}" \
    -H 'content-type: application/json' --data "${payload}" \
    "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
  assert_status "${status}" "200" "trim member ${member_name}" "${response_path}"
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.members.some((item)=>item.name===process.argv[2])) throw new Error(`member was not removed: ${process.argv[2]}`)' "${response_path}" "${member_name}"
  node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "${response_path}"
}

MEMBER_TRIM_REVISION="$(trim_member helper "${MEMBER_REMOVE_HELPER_RESPONSE}" "${MEMBER_REMOVE_REVISION}")"
MEMBER_TRIM_REVISION="$(trim_member coder "${MEMBER_REMOVE_CODER_RESPONSE}" "${MEMBER_TRIM_REVISION}")"
cp "${PATCH_PATH}" "${PATCH_AFTER_MUTATIONS}"
diff_status=0
diff -u "${PATCH_INITIAL}" "${PATCH_AFTER_MUTATIONS}" >"${PATCH_DIFF}" || diff_status=$?
[[ "${diff_status}" -eq 0 || "${diff_status}" -eq 1 ]] || fail "could not generate YAML diff"

LAST_MEMBER_HASH="$(sha256 "${PATCH_PATH}")"
LAST_MEMBER_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({action:"remove",expectedRevision:process.argv[1],profile:"standard-acp",name:"e2e-helper"}))' "${MEMBER_TRIM_REVISION}")"
LAST_MEMBER_STATUS="$(curl -sS --max-time 15 -o "${LAST_MEMBER_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${LAST_MEMBER_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/members")"
assert_status "${LAST_MEMBER_STATUS}" "422" "last member guard" "${LAST_MEMBER_RESPONSE}"
node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.code!=="LAST_MEMBER") throw new Error(`expected LAST_MEMBER, got ${JSON.stringify(value)}`)' "${LAST_MEMBER_RESPONSE}"
[[ "$(sha256 "${PATCH_PATH}")" == "${LAST_MEMBER_HASH}" ]] || fail "LAST_MEMBER request changed the patch"
STATE_AFTER_STATUS="$(curl -sS --max-time 10 -o "${STATE_AFTER}" -w '%{http_code}' -b "${COOKIE_JAR}" "${BASE_URL}/plugins/dsh-wuyou-agent/api/state")"
assert_status "${STATE_AFTER_STATUS}" "200" "post-mutation state" "${STATE_AFTER}"
node -e 'const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(state.members.length!==1 || state.members[0]?.name!=="e2e-helper" || state.members[0]?.role!=="E2E helper role filled after add") throw new Error(`unexpected post-mutation members: ${JSON.stringify(state.members)}`)' "${STATE_AFTER}"
printf 'E2E_MEMBERS add_without_role=200 update_role=200 remove_tester=200 trim_to_one=200 last=422/LAST_MEMBER\n'

sleep 1
if grep -Eiq 'wuyou-agent:.*(did not activate|failed to load|activation failed)|YAMLParseError' "${LOG_FIRST}"; then
  grep -Ei 'wuyou-agent:.*(did not activate|failed to load|activation failed)|YAMLParseError' "${LOG_FIRST}" >&2 || true
  fail "activation or YAML error appeared after writes"
fi
printf 'E2E_RECONCILE no_activation_or_yaml_errors=1\n'

stop_server
assert_clean_profile_patch
start_server "${LOG_RESTART}"
exchange_token_and_fetch_state "${STATE_RESTART}"

if grep -Eiq '(mount|register|activation).*(maxDepth|agentOptions|continuable)|(maxDepth|agentOptions|continuable).*(mount|register|activation)' "${LOG_RESTART}"; then
  grep -Ei '(mount|register|activation).*(maxDepth|agentOptions|continuable)|(maxDepth|agentOptions|continuable).*(mount|register|activation)' "${LOG_RESTART}" >&2 || true
  fail "restart log contains a mount/registration error mentioning incompatible ACP fields"
fi
node - "${STATE_RESTART}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!state.subagents.some((item) => item.id === 'tool-subagent-e2e-acp' && item.config?.provider === 'e2eacp')) {
  throw new Error('registered e2eacp row was not loaded after DSH restart');
}
if (!state.subagents.some((item) => item.id === 'tool-subagent-e2e-acp2' && item.config?.provider === 'e2eacp2')) {
  throw new Error('registered e2eacp2 row was not loaded after DSH restart');
}
if (!state.members.some((item) => item.name === 'e2e-helper')) {
  throw new Error('e2e-helper was not loaded after DSH restart');
}
if (state.members.some((item) => item.name === 'tester')) {
  throw new Error('removed tester member reappeared after DSH restart');
}
if (!state.subagents.some((item) => item.id === 'tool-subagent-e2e-fork' && item.config?.provider === 'spawn')) {
  throw new Error('fork-to-spawn conversion was not loaded after DSH restart');
}
if (state.members.length !== 1 || state.members[0]?.name !== 'e2e-helper') {
  throw new Error(`unexpected members after DSH restart: ${JSON.stringify(state.members)}`);
}
console.log(`E2E_RESTART revision=${state.revision} acp=e2eacp,e2eacp2 tools=registered fork=spawn member=e2e-helper`);
NODE

BACK_TO_SPAWN_PAYLOAD="$(node - "${STATE_RESTART}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const route = state.catalog.providers.flatMap((provider) => provider.models.map((model) => ({
  provider: provider.id,
  model: model.id,
  reasoningEffort: model.reasoningEfforts?.[0],
})))[0];
if (!route) throw new Error('no catalog route for ACP-to-spawn conversion');
process.stdout.write(JSON.stringify({
  action: 'update',
  expectedRevision: state.revision,
  id: 'tool-subagent-e2e-acp2',
  patch: { provider: 'spawn', agentOptions: route },
}));
NODE
)"
BACK_TO_SPAWN_STATUS="$(curl -sS --max-time 15 -o "${ACP_BACK_TO_SPAWN_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" \
  -H 'content-type: application/json' --data "${BACK_TO_SPAWN_PAYLOAD}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents")"
assert_status "${BACK_TO_SPAWN_STATUS}" "200" "registered ACP back to spawn" "${ACP_BACK_TO_SPAWN_RESPONSE}"
node - "${ACP_BACK_TO_SPAWN_RESPONSE}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-e2e-acp2');
if (!row || row.config?.provider !== 'spawn' || !row.config?.agentOptions?.model) {
  throw new Error(`ACP-to-spawn conversion missing: ${JSON.stringify(row)}`);
}
NODE
printf 'E2E_ACP_BACK_TO_SPAWN status=%s provider=spawn\n' "${BACK_TO_SPAWN_STATUS}"

stop_server
assert_clean_profile_patch
start_server "${LOG_RESTART_AFTER_SPAWN}"
exchange_token_and_fetch_state "${STATE_RESTART_AFTER_SPAWN}"
node - "${STATE_RESTART_AFTER_SPAWN}" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = state.subagents.find((item) => item.id === 'tool-subagent-e2e-acp2');
if (!row || row.config?.provider !== 'spawn' || !row.config?.agentOptions?.model) {
  throw new Error(`ACP-to-spawn row was not loaded after restart: ${JSON.stringify(row)}`);
}
console.log(`E2E_R6_RESTART_AFTER_SPAWN provider=${row.config.provider} mount_check=passed`);
NODE

# ---------------------------------------------------------------------------
# v2.3: ACP registrations and Panel A bundle import against the real DSH.
# ---------------------------------------------------------------------------
ACP3_CREATE_RESPONSE="${ARTIFACT_DIR}/v23-acp-create-response.json"
ACP3_UPDATE_RESPONSE="${ARTIFACT_DIR}/v23-acp-update-response.json"
BUNDLE_IMPORT_RESPONSE="${ARTIFACT_DIR}/v23-bundle-import-response.json"
ACP3_IN_USE_RESPONSE="${ARTIFACT_DIR}/v23-acp-in-use-response.json"
STATE_V23_RESTART="${ARTIFACT_DIR}/v23-state-restart.json"
LOG_V23_RESTART="${ARTIFACT_DIR}/wuyou-v23-restart.log"
PATCH_V23="${ARTIFACT_DIR}/cordis.patch.after-v23.yml"

node - "${STATE_RESTART_AFTER_SPAWN}" "${PROFILE}" "${PATCH_PATH}" <<'NODE'
const fs = require('node:fs');
const [statePath, profile, patchPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const names = (state.acps ?? []).map((a) => a.config.providerName);
if (JSON.stringify(names) !== JSON.stringify(['e2eacp', 'e2eacp2'])) throw new Error(`state.acps: ${JSON.stringify(state.acps)}`);
if (state.dshProfile?.name !== profile || fs.realpathSync(state.dshProfile.patchPath) !== fs.realpathSync(patchPath)) {
  throw new Error(`state.dshProfile: ${JSON.stringify(state.dshProfile)}`);
}
const e2eacp = state.acps.find((a) => a.config.providerName === 'e2eacp');
if (!e2eacp.usedBy.includes('subagent_e2e_acp')) throw new Error(`e2eacp.usedBy: ${JSON.stringify(e2eacp.usedBy)}`);
console.log(`E2E_V23_STATE acps=${names.join(',')} dshProfile=${state.dshProfile.name}`);
NODE

v23_revision() {
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$1"
}

REV="$(v23_revision "${STATE_RESTART_AFTER_SPAWN}")"
STATUS="$(curl -sS --max-time 15 -o "${ACP3_CREATE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data "{\"expectedRevision\":\"${REV}\",\"action\":\"create\",\"input\":{\"providerName\":\"e2eacp3\",\"command\":\"/usr/bin/true\",\"args\":[\"acp\"],\"permission\":\"reject\",\"env\":{\"E2E_FLAG\":\"1\"}}}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps")"
assert_status "${STATUS}" "200" "v2.3 ACP create" "${ACP3_CREATE_RESPONSE}"

REV="$(v23_revision "${ACP3_CREATE_RESPONSE}")"
STATUS="$(curl -sS --max-time 15 -o "${ACP3_UPDATE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data "{\"expectedRevision\":\"${REV}\",\"action\":\"update\",\"id\":\"subagent-acp-e2eacp3\",\"patch\":{\"permission\":\"allow\"}}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps")"
assert_status "${STATUS}" "200" "v2.3 ACP update" "${ACP3_UPDATE_RESPONSE}"

# The bundle's ACP already exists (skipped) and its tool uses the not-yet-mounted e2eacp3.
REV="$(v23_revision "${ACP3_UPDATE_RESPONSE}")"
STATUS="$(curl -sS --max-time 15 -o "${BUNDLE_IMPORT_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data "{\"expectedRevision\":\"${REV}\",\"bundle\":{\"acps\":[{\"providerName\":\"e2eacp\",\"command\":\"/usr/bin/true\"}],\"subagents\":[{\"toolName\":\"subagent_e2e_acp3\",\"provider\":\"e2eacp3\",\"backgroundMode\":\"one-shot\"}]}}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/subagents/import")"
assert_status "${STATUS}" "200" "v2.3 bundle import" "${BUNDLE_IMPORT_RESPONSE}"
node - "${BUNDLE_IMPORT_RESPONSE}" <<'NODE'
const r = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const report = r.importReport;
if (JSON.stringify(report.created) !== JSON.stringify({ acps: [], subagents: ['subagent_e2e_acp3'] })) throw new Error(`created: ${JSON.stringify(report.created)}`);
if (report.skipped.length !== 1 || report.skipped[0].name !== 'e2eacp') throw new Error(`skipped: ${JSON.stringify(report.skipped)}`);
const row = r.subagents.find((s) => s.config.toolName === 'subagent_e2e_acp3');
if (row?.config.maxDepth !== 'provider-managed' || row.config.backgroundMode !== 'one-shot') throw new Error(`row: ${JSON.stringify(row)}`);
console.log('E2E_V23_IMPORT created=subagent_e2e_acp3 skipped=e2eacp');
NODE

REV="$(v23_revision "${BUNDLE_IMPORT_RESPONSE}")"
STATUS="$(curl -sS --max-time 15 -o "${ACP3_IN_USE_RESPONSE}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data "{\"expectedRevision\":\"${REV}\",\"action\":\"remove\",\"id\":\"subagent-acp-e2eacp3\"}" \
  "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps")"
assert_status "${STATUS}" "409" "v2.3 remove in-use ACP" "${ACP3_IN_USE_RESPONSE}"
grep -q '"IN_USE"' "${ACP3_IN_USE_RESPONSE}" || fail "v2.3 in-use remove did not return IN_USE"
cp "${PATCH_PATH}" "${PATCH_V23}"
printf 'E2E_V23_ACP create=200 update=200 in_use_remove=409\n'

# Restart: DSH itself must mount the ACP row this plugin wrote.
stop_server
assert_clean_profile_patch
start_server "${LOG_V23_RESTART}"
exchange_token_and_fetch_state "${STATE_V23_RESTART}"
assert_no_dsh_mount_errors "${LOG_V23_RESTART}" "v2.3 restart"
node - "${STATE_V23_RESTART}" <<'NODE'
const s = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (s.diagnostics.subagentProvidersSource !== 'runtime') throw new Error(`provider source: ${s.diagnostics.subagentProvidersSource}`);
const acp3 = s.subagentProviders.find((p) => p.name === 'e2eacp3');
if (!acp3 || acp3.kind !== 'acp' || acp3.source !== 'runtime') throw new Error(`e2eacp3 not mounted by DSH: ${JSON.stringify(s.subagentProviders)}`);
const row = s.acps.find((a) => a.config.providerName === 'e2eacp3');
if (row?.config.permission !== 'allow' || row.config.env.E2E_FLAG !== '1' || JSON.stringify(row.usedBy) !== '["subagent_e2e_acp3"]') {
  throw new Error(`e2eacp3 row: ${JSON.stringify(row)}`);
}
const tool = s.subagents.find((r) => r.config.toolName === 'subagent_e2e_acp3');
if (!tool?.editable) throw new Error(`subagent_e2e_acp3 not editable after restart: ${JSON.stringify(tool)}`);
console.log('E2E_V23_RESTART e2eacp3=runtime-registered tool=editable');
NODE

# v2.4: ACP test route against the real Host. e2eacp runs /usr/bin/true: the
# executable exists (static pass) but exits without answering initialize.
ACP_TEST_STATIC="${ARTIFACT_DIR}/v24-acp-test-static.json"
ACP_TEST_HANDSHAKE="${ARTIFACT_DIR}/v24-acp-test-handshake.json"
ACP_TEST_MISSING="${ARTIFACT_DIR}/v24-acp-test-missing.json"
STATUS="$(curl -sS --max-time 15 -o "${ACP_TEST_STATIC}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data '{"id":"subagent-acp-e2e"}' "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps/test")"
assert_status "${STATUS}" "200" "v2.4 ACP static test" "${ACP_TEST_STATIC}"
STATUS="$(curl -sS --max-time 40 -o "${ACP_TEST_HANDSHAKE}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data '{"id":"subagent-acp-e2e","handshake":true}' "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps/test")"
assert_status "${STATUS}" "200" "v2.4 ACP handshake test" "${ACP_TEST_HANDSHAKE}"
STATUS="$(curl -sS --max-time 15 -o "${ACP_TEST_MISSING}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' \
  --data '{"id":"subagent-acp-nope"}' "${BASE_URL}/plugins/dsh-wuyou-agent/api/acps/test")"
assert_status "${STATUS}" "404" "v2.4 ACP test unknown id" "${ACP_TEST_MISSING}"
node - "${ACP_TEST_STATIC}" "${ACP_TEST_HANDSHAKE}" <<'NODE'
const fs = require('node:fs');
const [st, hs] = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
const cmd = st.checks.find((c) => c.key === 'command');
if (!st.ok || st.handshake || cmd?.status !== 'pass' || st.resolvedCommand !== '/usr/bin/true') throw new Error(`static: ${JSON.stringify(st)}`);
const h = hs.checks.find((c) => c.key === 'handshake');
if (hs.ok || h?.status !== 'fail' || !h.detail.includes('退出')) throw new Error(`handshake: ${JSON.stringify(hs)}`);
console.log(`E2E_V24_ACP_TEST static=pass handshake=fail(${h.detail.split('。')[0]}) unknown=404`);
NODE

# v2.6: team profiles — list, clone, blank create, multi-team import with an
# explicit overwrite, then agent-teams' own validator on every written team.
TEAMS_BEFORE="${ARTIFACT_DIR}/v26-teams-before.json"
TEAM_CLONE="${ARTIFACT_DIR}/v26-team-clone.json"
TEAM_BLANK="${ARTIFACT_DIR}/v26-team-blank.json"
TEAMS_IMPORT="${ARTIFACT_DIR}/v26-teams-import.json"
TEAMS_AFTER="${ARTIFACT_DIR}/v26-teams-after.json"
teams_get() {
  local out="$1" status
  status="$(curl -sS --max-time 15 -o "${out}" -w '%{http_code}' -b "${COOKIE_JAR}" "${BASE_URL}/plugins/dsh-wuyou-agent/api/teams")"
  assert_status "${status}" "200" "v2.6 GET teams" "${out}"
}
team_post() {
  local path="$1" data="$2" out="$3" expected="$4" status
  status="$(curl -sS --max-time 15 -o "${out}" -w '%{http_code}' -b "${COOKIE_JAR}" -H 'content-type: application/json' --data "${data}" "${BASE_URL}/plugins/dsh-wuyou-agent/api/${path}")"
  assert_status "${status}" "${expected}" "v2.6 POST ${path}" "${out}"
}
teams_get "${TEAMS_BEFORE}"
REV="$(v23_revision "${TEAMS_BEFORE}")"
team_post teams "{\"expectedRevision\":\"${REV}\",\"action\":\"create\",\"name\":\"e2e-copy\",\"from\":\"standard-acp\"}" "${TEAM_CLONE}" 200
REV="$(v23_revision "${TEAM_CLONE}")"
team_post teams "{\"expectedRevision\":\"${REV}\",\"action\":\"create\",\"name\":\"e2e-blank\",\"firstMember\":\"solo\",\"description\":\"E2E blank team\"}" "${TEAM_BLANK}" 200
REV="$(v23_revision "${TEAM_BLANK}")"
team_post teams/import "{\"expectedRevision\":\"${REV}\",\"teams\":[{\"name\":\"standard-acp\",\"profile\":{\"members\":[{\"name\":\"nope\"}]}},{\"name\":\"e2e-copy\",\"profile\":{\"description\":\"overwritten\",\"taskPlanning\":\"captain\",\"members\":[{\"name\":\"a\"},{\"name\":\"b\"}]}},{\"name\":\"e2e-new\",\"profile\":{\"protocol\":\"line one\\nline two\\n\",\"members\":[{\"name\":\"n1\",\"role\":\"r1\\nr2\"}]}}],\"overwrite\":[\"e2e-copy\"]}" "${TEAMS_IMPORT}" 200
teams_get "${TEAMS_AFTER}"
AGENT_TEAMS_PROFILES_JS="${HOME}/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/profiles.js"
node --input-type=module - "${TEAMS_BEFORE}" "${TEAM_CLONE}" "${TEAMS_IMPORT}" "${TEAMS_AFTER}" "${AGENT_TEAMS_PROFILES_JS}" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [before, clone, imported, after] = process.argv.slice(2, 6).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
const validator = process.argv[6];
const fail = (m) => { throw new Error(m); };
if (JSON.stringify(Object.keys(before.profiles)) !== '["standard-acp"]') fail(`before: ${Object.keys(before.profiles)}`);
if (clone.profile !== 'e2e-copy' || JSON.stringify(clone.members) !== JSON.stringify(before.profiles['standard-acp'].members)) fail(`clone: ${JSON.stringify(clone.members)}`);
const r = imported.importReport;
if (JSON.stringify(r.created) !== '["e2e-new"]' || JSON.stringify(r.overwritten) !== '["e2e-copy"]' || r.skipped[0]?.name !== 'standard-acp') fail(`report: ${JSON.stringify(r)}`);
const p = after.profiles;
if (JSON.stringify(Object.keys(p)) !== '["standard-acp","e2e-copy","e2e-blank","e2e-new"]') fail(`after: ${Object.keys(p)}`);
if (JSON.stringify(p['standard-acp']) !== JSON.stringify(before.profiles['standard-acp'])) fail('standard-acp changed without overwrite');
if (p['e2e-copy'].description !== 'overwritten' || p['e2e-copy'].members.length !== 2) fail(`e2e-copy: ${JSON.stringify(p['e2e-copy'])}`);
if (p['e2e-new'].protocol !== 'line one\nline two\n' || p['e2e-new'].members[0].role !== 'r1\nr2') fail(`e2e-new: ${JSON.stringify(p['e2e-new'])}`);
let checked = 'skipped(agent-teams not installed in web profile)';
if (fs.existsSync(validator)) {
  const { resolveTeamProfile, formatProfilesForPrompt } = await import(pathToFileURL(validator).href);
  for (const name of Object.keys(p)) resolveTeamProfile(p, name, 8);
  if (!formatProfilesForPrompt(p).includes('e2e-new')) fail('formatProfilesForPrompt missing e2e-new');
  checked = `agent-teams resolveTeamProfile ok for ${Object.keys(p).length} teams`;
}
console.log(`E2E_V26_TEAMS clone=e2e-copy blank=e2e-blank import=created:e2e-new,overwritten:e2e-copy,skipped:standard-acp validator=${checked}`);
NODE

TEAM_REMOVE_REFUSED="${ARTIFACT_DIR}/v27-team-remove-refused.json"
TEAM_REMOVE="${ARTIFACT_DIR}/v27-team-remove.json"
TEAMS_FINAL="${ARTIFACT_DIR}/v27-teams-final.json"
REV="$(v23_revision "${TEAMS_AFTER}")"
team_post teams "{\"expectedRevision\":\"${REV}\",\"action\":\"remove\",\"name\":\"e2e-blank\",\"confirm\":\"ThinkTwice\"}" "${TEAM_REMOVE_REFUSED}" 400
team_post teams "{\"expectedRevision\":\"${REV}\",\"action\":\"remove\",\"name\":\"e2e-blank\",\"confirm\":\"thinktwice\"}" "${TEAM_REMOVE}" 200
teams_get "${TEAMS_FINAL}"
node --input-type=module - "${TEAM_REMOVE}" "${TEAMS_FINAL}" "${AGENT_TEAMS_PROFILES_JS}" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [removed, final] = process.argv.slice(2, 4).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
const names = Object.keys(final.profiles);
if (JSON.stringify(names) !== '["standard-acp","e2e-copy","e2e-new"]') throw new Error(`after remove: ${names}`);
if (JSON.stringify(removed.teamProfiles) !== JSON.stringify(names)) throw new Error(`state teamProfiles: ${removed.teamProfiles}`);
let checked = 'skipped';
if (fs.existsSync(process.argv[4])) {
  const { resolveTeamProfile } = await import(pathToFileURL(process.argv[4]).href);
  for (const n of names) resolveTeamProfile(final.profiles, n, 8);
  checked = `resolveTeamProfile ok for ${names.length}`;
}
console.log(`E2E_V27_TEAM_REMOVE wrong_word=400 removed=e2e-blank left=${names.join(',')} validator=${checked}`);
NODE
stop_server

restore_profile
for _ in $(seq 1 40); do
  if ! curl -fsS --max-time 1 "${BASE_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if curl -fsS --max-time 1 "${BASE_URL}/" >/dev/null 2>&1; then
  fail "test DSH port remained open after shutdown"
fi
[[ "$(sha256 "${WEB_PATCH}")" == "${WEB_PATCH_BEFORE}" ]] || fail "production cordis.patch.yml changed"
[[ "$(sha256 "${WEB_PACKAGE}")" == "${WEB_PACKAGE_BEFORE}" ]] || fail "production package.json changed"
printf 'E2E_CLEANUP port_closed=1 production_hashes_unchanged=1 profile_restored=1\n'
printf 'E2E_PASS profile=%s\n' "${PROFILE}"
