#!/usr/bin/env bash
# Faithful "slow start / panels never load" repro: copy a WHOLE DSH profile
# (package.json, lockfile, node_modules, patch) to a throwaway profile, boot
# it on a free port, and time startup plus each plugin API call. The source
# profile is only read; the copy is deleted at the end.
#
#   bash scripts/diagnose-profile-copy.sh [source-profile-name]
set -Eeuo pipefail
export PATH=${HOME}/.pyenv/shims:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${PATH:-}

SOURCE="${1:-web}"
DSH_BIN="${DSH_BIN:-/Users/jwyuan/.npm/_npx/4f4f47d9854f3c73/node_modules/.bin/dsh}"
SRC_DIR="${HOME}/.dsh/profiles/${SOURCE}"
COPY="wuyou-diag-$$"
COPY_DIR="${HOME}/.dsh/profiles/${COPY}"
WORK="$(mktemp -d /tmp/wuyou-diag-XXXX)"
LOG="${WORK}/dsh.log"
JAR="${WORK}/jar"
SERVER_PID=""
SRC_HASH="$(cat "${SRC_DIR}/cordis.patch.yml" "${SRC_DIR}/package.json" | shasum -a 256 | awk '{print $1}')"

cleanup() {
  [[ -n "${SERVER_PID}" ]] && { kill "${SERVER_PID}" 2>/dev/null; wait "${SERVER_PID}" 2>/dev/null || true; }
  [[ "${COPY_DIR}" == "${HOME}/.dsh/profiles/wuyou-diag-"* ]] && rm -rf "${COPY_DIR}"
  [[ "$(cat "${SRC_DIR}/cordis.patch.yml" "${SRC_DIR}/package.json" | shasum -a 256 | awk '{print $1}')" == "${SRC_HASH}" ]] \
    || echo "DIAG_ERROR: source profile changed during the run" >&2
  sed -E 's/[?&]token=[A-Za-z0-9_-]+/[redacted-token]/g' "${LOG}" > "${LOG}.redacted" 2>/dev/null || true
  rm -f "${LOG}" "${JAR}"
  echo "DIAG_CLEANUP copy_removed=$([[ -d "${COPY_DIR}" ]] && echo 0 || echo 1) log=${LOG}.redacted"
}
trap cleanup EXIT

cp -a "${SRC_DIR}" "${COPY_DIR}"
rm -rf "${COPY_DIR}/.plugin-manager"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
T0=$(node -e 'process.stdout.write(String(Date.now()))')
ms() { echo $(( $(node -e 'process.stdout.write(String(Date.now()))') - T0 )); }

env -u DSH_PROFILE "${DSH_BIN}" --profile "${COPY}" --host 127.0.0.1 --port "${PORT}" --no-open >"${LOG}" 2>&1 &
SERVER_PID=$!
TOKEN=""
for _ in $(seq 1 1200); do
  TOKEN="$(grep -oE '[?&]token=[A-Za-z0-9_-]+' "${LOG}" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [[ -n "${TOKEN}" ]] && break
  kill -0 "${SERVER_PID}" 2>/dev/null || { tail -40 "${LOG}"; exit 1; }
  sleep 0.25
done
echo "DIAG_START source=${SOURCE} token_after_ms=$(ms) dsh=$("${DSH_BIN}" --version)"
curl -sS -o /dev/null -c "${JAR}" --max-time 30 "http://127.0.0.1:${PORT}/?token=${TOKEN}"
echo "DIAG_AUTH after_ms=$(ms)"

api() {
  local path="$1" out code t
  out="$(curl -sS -b "${JAR}" --max-time 60 -o "${WORK}/body.json" -w '%{http_code} %{time_total}' "http://127.0.0.1:${PORT}/plugins/dsh-wuyou-agent/api/${path}" 2>&1 || true)"
  echo "DIAG_API ${path} -> ${out}s $(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=j.diagnostics||{};console.log(JSON.stringify({catalogSource:d.catalogSource,catalogErrors:(d.catalogErrors||[]).length,providersSource:d.subagentProvidersSource,teamProfiles:j.teamProfiles,members:(j.members||[]).length,errors:j.errors,code:j.code,message:j.message}))}catch(e){console.log("non-json")}' "${WORK}/body.json")"
}
for i in 1 2 3; do api "state?profile=standard-acp"; done
api "state?profile=default-team"
api "teams"
echo "DIAG_API_DONE after_ms=$(ms)"

# Real browser: open both panels, record every plugin request with its timing,
# console / page errors, and which plugin client bundle the page received.
LOCAL_BUNDLE_HASH="$(shasum -a 256 "$(dirname "$0")/../lib/client.js" | cut -c1-16)"
python3 - "http://127.0.0.1:${PORT}/?token=${TOKEN}" "${WORK}" "${LOCAL_BUNDLE_HASH}" <<'PY'
import hashlib, re, sys, time
from playwright.sync_api import sync_playwright
url, work, local_hash = sys.argv[1:4]
events, started = [], {}
t0 = time.time()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("console", lambda m: m.type in ("error", "warning") and events.append(f"console.{m.type}: {m.text[:300]}"))
    page.on("pageerror", lambda e: events.append(f"pageerror: {str(e)[:500]}"))
    page.on("request", lambda r: "dsh-wuyou-agent" in r.url and started.__setitem__(r, time.time()))
    def on_response(r):
        if "dsh-wuyou-agent" not in r.url:
            return
        took = int((time.time() - started.get(r.request, time.time())) * 1000)
        if "client.js" in r.url:
            body = r.body()
            m = re.search(rb"window\.__ModuleLoader__\.load\(\{\s*id: '@nanmicoder/dsh-wuyou-agent'[\s\S]*?\n\}\);\n", body)
            served = hashlib.sha256(m.group(0)).hexdigest()[:16] if m else "not-found"
            events.append(f"bundle {r.status} {took}ms served_wuyou_hash={served} local={local_hash} has_new_team_ui={b'\xe6\x96\xb0\xe5\xbb\xba\xe5\x9b\xa2\xe9\x98\x9f' in body}")
        else:
            events.append(f"api {r.request.method} {r.url.split('/api/')[-1]} -> {r.status} {took}ms")
    page.on("response", on_response)
    page.on("requestfailed", lambda r: "dsh-wuyou-agent" in r.url and events.append(f"requestfailed {r.url.split('/api/')[-1]} {r.failure}"))
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    events.append(f"page domcontentloaded after {int((time.time()-t0)*1000)}ms")
    try:
        d = page.get_by_role("dialog", name=re.compile(r"Internal Testing Notice|内部测试"))
        d.first.wait_for(state="visible", timeout=3_000)
        d.get_by_role("button", name=re.compile(r"^(Continue|继续)$")).first.click()
    except Exception:
        pass
    settings = page.get_by_role("button", name=re.compile(r"^(Settings|设置)$")).first
    settings.wait_for(state="visible", timeout=60_000)
    events.append(f"settings button visible after {int((time.time()-t0)*1000)}ms")
    settings.click()
    for label, title in (("无忧Subagent", "Subagent 工具管理"), ("无忧Teams", "团队成员管理")):
        page.get_by_text(label, exact=True).click()
        page.get_by_text(title, exact=True).first.wait_for(state="visible", timeout=30_000)
        opened = time.time()
        while time.time() - opened < 20 and page.get_by_text("加载中...", exact=True).count() > 0:
            page.wait_for_timeout(200)
        stuck = page.get_by_text("加载中...", exact=True).count() > 0
        print(f"DIAG_PANEL {label} stuck_loading={int(stuck)} loaded_in_ms={int((time.time()-opened)*1000)} tbody={page.locator('tbody').count()}")
        page.screenshot(path=f"{work}/{label}.png", full_page=True)
    browser.close()
for e in events:
    print("DIAG_EVENT", e)
PY

# Same browser, N tabs of the same origin first (each holds the HMR
# EventSource), then the panels in one more tab. Chrome allows 6 HTTP/1.1
# connections per origin across all tabs, so this shows whether open tabs
# starve the plugin's /state request.
TABS="${DIAG_TABS:-8}"
python3 - "http://127.0.0.1:${PORT}/?token=${TOKEN}" "http://127.0.0.1:${PORT}/" "${TABS}" <<'PY'
import re, sys, time
from playwright.sync_api import sync_playwright
token_url, plain_url, tabs = sys.argv[1], sys.argv[2], int(sys.argv[3])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    first = ctx.new_page()
    first.goto(token_url, wait_until="domcontentloaded", timeout=60_000)
    idle = [first] + [ctx.new_page() for _ in range(tabs - 1)]
    for page in idle[1:]:
        page.goto(plain_url, wait_until="commit", timeout=60_000)
    time.sleep(3)
    page = ctx.new_page()
    t0 = time.time()
    pending = {}
    page.on("request", lambda r: "dsh-wuyou-agent/api" in r.url and pending.__setitem__(r.url, time.time()))
    def answered(r):
        if "dsh-wuyou-agent/api" in r.url:
            print(f"DIAG_TABS api {r.url.split('/api/')[-1]} -> {r.status} {int((time.time()-pending.pop(r.url, time.time()))*1000)}ms")
    page.on("response", answered)
    try:
        page.goto(plain_url, wait_until="domcontentloaded", timeout=45_000)
        print(f"DIAG_TABS tabs_open={tabs} extra_tab_domcontentloaded_ms={int((time.time()-t0)*1000)}")
        try:
            d = page.get_by_role("dialog", name=re.compile(r"Internal Testing Notice|内部测试"))
            d.first.wait_for(state="visible", timeout=3_000)
            d.get_by_role("button", name=re.compile(r"^(Continue|继续)$")).first.click()
        except Exception:
            pass
        page.get_by_role("button", name=re.compile(r"^(Settings|设置)$")).first.click(timeout=45_000)
        page.get_by_text("无忧Teams", exact=True).click(timeout=20_000)
        opened = time.time()
        while time.time() - opened < 25 and page.get_by_text("加载中...", exact=True).count() > 0:
            page.wait_for_timeout(250)
        print(f"DIAG_TABS panel stuck_loading={int(page.get_by_text('加载中...', exact=True).count() > 0)} waited_ms={int((time.time()-opened)*1000)} unanswered_api={[u.split('/api/')[-1] for u in pending]}")
    except Exception as e:
        print(f"DIAG_TABS extra tab blocked after {int((time.time()-t0)*1000)}ms: {type(e).__name__}: {str(e).splitlines()[0][:200]}")
    browser.close()
PY
grep -iE "wuyou-agent|agent-teams|subagent-acp|error|warn|slow|timeout" "${LOG}" | grep -v "token=" | cut -c1-240 | head -30 | sed 's/^/DIAG_LOG /'
