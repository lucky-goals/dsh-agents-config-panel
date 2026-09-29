#!/usr/bin/env bash
# Measure the visual jitter of switching team profiles in 无忧Teams.
# Copies a WHOLE DSH profile (default: web) to a throwaway profile, boots it,
# opens 无忧Teams in Chromium and, while switching teams, records every frame:
# layout-shift entries (with the shifted nodes), panel / toolbar / table /
# dialog boxes, the scroll container, the 加载中 line and the focused element.
# The source profile is only read; the copy is deleted.
#
#   bash scripts/diagnose-team-switch.sh [source-profile] [delay-ms]
#   delay-ms: extra latency added to GET /state in the page (default 300)
#   DIAG_VIEWPORT=WxH (default 1440x900): pick a height at which only one of
#   the two teams overflows the settings content area.
set -Eeuo pipefail
export PATH=${HOME}/.pyenv/shims:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${PATH:-}

SOURCE="${1:-web}"
DELAY="${2:-300}"
DSH_BIN="${DSH_BIN:-/Users/jwyuan/.npm/_npx/4f4f47d9854f3c73/node_modules/.bin/dsh}"
SRC_DIR="${HOME}/.dsh/profiles/${SOURCE}"
COPY="wuyou-diag-$$"
COPY_DIR="${HOME}/.dsh/profiles/${COPY}"
WORK="$(mktemp -d /tmp/wuyou-jitter-XXXX)"
LOG="${WORK}/dsh.log"
SERVER_PID=""
SRC_HASH="$(cat "${SRC_DIR}/cordis.patch.yml" "${SRC_DIR}/package.json" | shasum -a 256 | awk '{print $1}')"

cleanup() {
  [[ -n "${SERVER_PID}" ]] && { kill "${SERVER_PID}" 2>/dev/null; wait "${SERVER_PID}" 2>/dev/null || true; }
  [[ "${COPY_DIR}" == "${HOME}/.dsh/profiles/wuyou-diag-"* ]] && rm -rf "${COPY_DIR}"
  [[ "$(cat "${SRC_DIR}/cordis.patch.yml" "${SRC_DIR}/package.json" | shasum -a 256 | awk '{print $1}')" == "${SRC_HASH}" ]] \
    || echo "DIAG_ERROR: source profile changed during the run" >&2
  rm -f "${LOG}"
  echo "DIAG_CLEANUP copy_removed=$([[ -d "${COPY_DIR}" ]] && echo 0 || echo 1) screenshots=${WORK}"
}
trap cleanup EXIT

cp -a "${SRC_DIR}" "${COPY_DIR}"
rm -rf "${COPY_DIR}/.plugin-manager"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
env -u DSH_PROFILE "${DSH_BIN}" --profile "${COPY}" --host 127.0.0.1 --port "${PORT}" --no-open >"${LOG}" 2>&1 &
SERVER_PID=$!
TOKEN=""
for _ in $(seq 1 1200); do
  TOKEN="$(grep -oE '[?&]token=[A-Za-z0-9_-]+' "${LOG}" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [[ -n "${TOKEN}" ]] && break
  kill -0 "${SERVER_PID}" 2>/dev/null || { tail -40 "${LOG}"; exit 1; }
  sleep 0.25
done

python3 - "http://127.0.0.1:${PORT}/?token=${TOKEN}" "${WORK}" "${DELAY}" "${DIAG_VIEWPORT:-1440x900}" <<'PY'
import json, re, sys
from playwright.sync_api import sync_playwright
url, work, delay = sys.argv[1], sys.argv[2], int(sys.argv[3])
vw, vh = (int(n) for n in sys.argv[4].split("x"))

PROBE = r"""
(() => {
  const w = window; w.__jit = { frames: [], shifts: [] };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      w.__jit.shifts.push({ t: Math.round(e.startTime), value: +e.value.toFixed(4), recent: e.hadRecentInput,
        nodes: (e.sources || []).map((s) => ({ node: s.node ? (s.node.id || s.node.getAttribute?.('data-toolbar') || s.node.tagName + '.' + (s.node.textContent || '').trim().slice(0, 24)) : '?',
          from: [Math.round(s.previousRect.y), Math.round(s.previousRect.height)], to: [Math.round(s.currentRect.y), Math.round(s.currentRect.height)] })) });
    }
  }).observe({ type: 'layout-shift', buffered: false });
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const scroller = (el) => { for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n; } return null; };
  const t0 = performance.now();
  const tick = () => {
    const bar = document.querySelector('[data-toolbar="members"]');
    const panel = bar?.parentElement;
    const table = panel?.querySelector('table');
    const dialog = bar?.closest('[role="dialog"]') ?? document.querySelector('[role="dialog"]');
    const sc = bar ? scroller(bar) : null;
    const scrollables = [];
    for (let n = panel; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY)) scrollables.push([n === panel ? 'panel' : (n.className || n.tagName).toString().slice(0, 18),
        n.scrollHeight > n.clientHeight ? 1 : 0, n.offsetWidth - n.clientWidth - (parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)), cs.scrollbarGutter]);
    }
    const heads = table ? [...table.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width)) : [];
    const loading = [...(panel?.querySelectorAll('[role="status"]') ?? [])].find((n) => /加载中/.test(n.textContent || ''));
    const a = document.activeElement;
    w.__jit.frames.push({ t: Math.round(performance.now() - t0), panel: box(panel), bar: box(bar), table: box(table), dialog: box(dialog),
      scroll: sc ? [sc.scrollTop, sc.scrollHeight, sc.clientHeight, sc.offsetWidth - sc.clientWidth] : null,
      loading: loading ? box(loading) : null,
      rows: panel?.querySelectorAll('tbody').length ?? 0,
      scrollables, heads,
      active: a ? (a.id || a.tagName + (a.getAttribute('aria-label') ? '[' + a.getAttribute('aria-label') + ']' : '')) : null,
      pickerDisabled: !!document.getElementById('wuyou-team-profile')?.disabled });
    if (!w.__jitStop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""

DELAY_FETCH = """
(() => {
  const orig = window.fetch;
  window.fetch = async (...args) => {
    const u = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (u.includes('/dsh-wuyou-agent/api/state') && window.__jitDelay > 0) await new Promise((r) => setTimeout(r, window.__jitDelay));
    return orig(...args);
  };
})();
"""

def summarize(label, data):
    frames, shifts = data["frames"], data["shifts"]
    def changes(key):
        out, prev = [], object()
        for f in frames:
            if f[key] != prev:
                out.append((f["t"], f[key])); prev = f[key]
        return out
    cls = sum(s["value"] for s in shifts if not s["recent"])
    print(f"DIAG_JITTER {label} frames={len(frames)} layout_shift_entries={len(shifts)} cls={cls:.4f}")
    for key in ("panel", "bar", "table", "heads", "scrollables", "dialog", "scroll", "loading", "rows", "active", "pickerDisabled"):
        ch = changes(key)
        print(f"DIAG_TRACK {label} {key} changes={len(ch) - 1} {json.dumps(ch[:8], ensure_ascii=False)}")
    for s in shifts[:12]:
        print(f"DIAG_SHIFT {label} {json.dumps(s, ensure_ascii=False)}")

with sync_playwright() as p:
    # Real scrollbars (Playwright hides them in headless by default).
    browser = p.chromium.launch(headless=True, ignore_default_args=["--hide-scrollbars"])
    page = browser.new_page(viewport={"width": vw, "height": vh})
    page.add_init_script(DELAY_FETCH)
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    try:
        d = page.get_by_role("dialog", name=re.compile(r"Internal Testing Notice|内部测试"))
        d.first.wait_for(state="visible", timeout=3_000)
        d.get_by_role("button", name=re.compile(r"^(Continue|继续)$")).first.click()
    except Exception:
        pass
    page.get_by_role("button", name=re.compile(r"^(Settings|设置)$")).first.click(timeout=60_000)
    page.get_by_text("无忧Teams", exact=True).click()
    picker = page.locator("#wuyou-team-profile")
    picker.wait_for(state="visible", timeout=30_000)
    page.wait_for_timeout(800)
    teams = picker.locator("option").all_inner_texts()
    print(f"DIAG_TEAMS {teams} current={picker.input_value()}")
    if len(teams) < 2:
        raise SystemExit("DIAG_FAIL need at least two teams to switch")
    for label, lag in (("fast", 0), (f"delay{delay}ms", delay)):
        page.evaluate(f"window.__jitDelay = {lag}; window.__jitStop = false;")
        page.evaluate(PROBE)
        page.wait_for_timeout(300)
        for target in (teams[1], teams[0]):
            picker.focus()
            picker.select_option(target)
            page.wait_for_timeout(lag + 900)
        page.evaluate("window.__jitStop = true")
        page.wait_for_timeout(100)
        summarize(label, page.evaluate("window.__jit"))
    page.screenshot(path=f"{work}/after-switch.png", full_page=False)
    browser.close()
PY
