#!/usr/bin/env bash
# Diagnose "panels stuck on 加载中" against a COPY of a real profile patch.
# Boots DSH on the isolated wuyou-test profile with that copy, opens both
# panels in headless Chromium, and prints every plugin API response, browser
# console error and page error. wuyou-test's patch is restored afterwards;
# the source patch is only read.
#
#   bash scripts/diagnose-panels.sh [path/to/cordis.patch.yml]
set -Eeuo pipefail
export PATH=${HOME}/.pyenv/shims:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${PATH:-}

SOURCE_PATCH="${1:-${HOME}/.dsh/profiles/web/cordis.patch.yml}"
DSH_BIN="${DSH_BIN:-/Users/jwyuan/.npm/_npx/4f4f47d9854f3c73/node_modules/.bin/dsh}"
PROFILE=wuyou-test
PATCH="${HOME}/.dsh/profiles/${PROFILE}/cordis.patch.yml"
WORK="$(mktemp -d /tmp/wuyou-diagnose-XXXX)"
LOG="${WORK}/dsh.log"
SERVER_PID=""

cp -p "${PATCH}" "${WORK}/wuyou-test.patch.backup"
SOURCE_HASH="$(shasum -a 256 "${SOURCE_PATCH}" | awk '{print $1}')"
cleanup() {
  [[ -n "${SERVER_PID}" ]] && kill "${SERVER_PID}" 2>/dev/null && wait "${SERVER_PID}" 2>/dev/null || true
  cp -p "${WORK}/wuyou-test.patch.backup" "${PATCH}"
  [[ "$(shasum -a 256 "${SOURCE_PATCH}" | awk '{print $1}')" == "${SOURCE_HASH}" ]] || echo "DIAG_ERROR: source patch changed" >&2
  # The log holds this throwaway instance's launch token; keep only a redacted copy.
  sed -E 's/[?&]token=[A-Za-z0-9_-]+/[redacted-token]/g' "${LOG}" > "${LOG}.redacted" 2>/dev/null || true
  rm -f "${LOG}" "${WORK}/wuyou-test.patch.backup"
  echo "DIAG_CLEANUP restored=${PATCH} log=${LOG}.redacted"
}
trap cleanup EXIT

cp "${SOURCE_PATCH}" "${PATCH}"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
env -u DSH_PROFILE "${DSH_BIN}" --profile "${PROFILE}" --host 127.0.0.1 --port "${PORT}" --no-open >"${LOG}" 2>&1 &
SERVER_PID=$!
TOKEN=""
for _ in $(seq 1 240); do
  TOKEN="$(grep -oE '[?&]token=[A-Za-z0-9_-]+' "${LOG}" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [[ -n "${TOKEN}" ]] && break
  kill -0 "${SERVER_PID}" 2>/dev/null || { tail -40 "${LOG}"; exit 1; }
  sleep 0.25
done
[[ -n "${TOKEN}" ]] || { echo "DIAG_FAIL no token"; exit 1; }
echo "DIAG_DSH version=$("${DSH_BIN}" --version) port=${PORT}"

python3 - "http://127.0.0.1:${PORT}/?token=${TOKEN}" "${WORK}" <<'PY'
import re, sys, time
from playwright.sync_api import sync_playwright
url, work = sys.argv[1:3]
events = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("console", lambda m: m.type in ("error", "warning") and events.append(f"console.{m.type}: {m.text[:400]}"))
    page.on("pageerror", lambda e: events.append(f"pageerror: {str(e)[:600]}"))
    page.on("requestfailed", lambda r: "dsh-wuyou-agent" in r.url and events.append(f"requestfailed: {r.url.split('?')[0]} {r.failure}"))
    def on_response(r):
        if "dsh-wuyou-agent" in r.url:
            events.append(f"response: {r.request.method} {r.url.split('/api/')[-1]} -> {r.status}")
    page.on("response", on_response)
    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
    # Same entry steps as scripts/e2e-isolated-profile.sh select_workspace().
    try:
        dialog = page.get_by_role("dialog", name=re.compile(r"Internal Testing Notice|内部测试"))
        dialog.first.wait_for(state="visible", timeout=3_000)
        dialog.get_by_role("button", name=re.compile(r"^(Continue|继续)$")).first.click()
    except Exception:
        pass
    ws = page.get_by_text("dsh-agents-config-panel", exact=True)
    for attempt in range(60):
        if ws.count() and ws.first.is_visible():
            ws.first.click()
            for _ in range(20):
                if not page.locator('[role="presentation"]:visible').count():
                    break
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)
            break
        choose = page.get_by_role("button", name="Choose workspace", exact=True)
        if choose.count() and choose.first.is_visible() and attempt in (0, 10):
            choose.first.click()
        page.wait_for_timeout(500)
    page.wait_for_timeout(1000)
    try:
        page.get_by_role("button", name=re.compile(r"^(Settings|设置)$")).first.click(timeout=15_000)
    except Exception:
        page.screenshot(path=f"{work}/entry.png", full_page=True)
        print("DIAG_FAIL settings button; screenshot", f"{work}/entry.png")
        for e in events:
            print("DIAG_EVENT", e)
        raise
    for label, title in (("无忧Subagent", "Subagent 工具管理"), ("无忧Teams", "团队成员管理")):
        page.get_by_text(label, exact=True).click()
        page.get_by_text(title, exact=True).first.wait_for(state="visible", timeout=30_000)
        deadline = time.time() + 12
        while time.time() < deadline and page.get_by_text("加载中...", exact=True).count() > 0:
            page.wait_for_timeout(250)
        stuck = page.get_by_text("加载中...", exact=True).count() > 0
        alerts = [t.strip()[:200] for t in page.locator('[role="alert"], [role="status"]').all_inner_texts() if t.strip()]
        rows = page.locator("tbody").count()
        print(f"DIAG_PANEL {label} stuck_loading={int(stuck)} tbody={rows} alerts={alerts}")
        page.screenshot(path=f"{work}/{label}.png", full_page=True)
    browser.close()
for e in events:
    print("DIAG_EVENT", e)
PY
grep -iE "wuyou-agent|agent-teams.*(error|fail)|YAMLParseError|Error:" "${LOG}" | grep -v "token=" | head -20 | sed 's/^/DIAG_LOG /'
