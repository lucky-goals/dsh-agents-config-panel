/**
 * Status sub-row of one model in the model table (r4a-model-test.md 2.6,
 * prototype stripHTML). Spans track 2 to the end, under the model column.
 *
 * With a result it is a toggle for the detail row (full id + status line +
 * MM:SS + chevron); queued / running / cancelled are plain text. The right
 * button re-runs the test: 重测 / ↻ 重试 (transient) / 测试 (cancelled).
 * Static only (spec §0): running shows a static ring and a 100ms-refreshed timer.
 */
import React, { useEffect, useState } from 'react';
import type { ModelCapabilitiesStore, TestEntry } from '../types';
import { fmtClock, stateTone, stripAria, stripLine, type TestTone } from '../model-test';
import { mcStyles as s, sx } from '../styles';

export interface TestStatusRowProps {
  store: ModelCapabilitiesStore;
  route: string;
  modelId: string;
  /** Row index: ties the toggle to `mc-tdet-${index}`. */
  index: number;
  entry: TestEntry;
  open: boolean;
  /** Gate reason; the retest button is aria-disabled with it as title. */
  why: string | null;
}

const LBL: Record<TestTone, React.CSSProperties> = {
  success: s.stripLblOk,
  error: s.stripLblFail,
  warn: s.stripLblWarn,
  muted: s.stripLblMuted,
};

/** Local clock for the running timer; the first frame (and SSR) is startedAt → 0.0. */
function useRunningNow(entry: TestEntry): number | undefined {
  const running = entry.state === 'running';
  const [now, setNow] = useState<number | undefined>(entry.startedAt);
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running, entry.startedAt]);
  return running ? now ?? entry.startedAt : undefined;
}

function Glyph({ entry }: { entry: TestEntry }) {
  switch (entry.state) {
    case 'ok': return <span style={s.dotOk} aria-hidden="true" />;
    case 'fail': return <span style={s.dotBad} aria-hidden="true" />;
    case 'transient': return <span style={s.reico} aria-hidden="true">↻</span>;
    case 'queued': return <span style={s.dotHollow} aria-hidden="true" />;
    case 'running': return <span style={s.ring} aria-hidden="true" />;
    default: return null;
  }
}

/** stripLine() split into its bold label and the rest, as in the prototype. */
function Line({ entry, now, clock }: { entry: TestEntry; now?: number; clock?: string }) {
  const text = stripLine(entry, now ?? entry.startedAt);
  const cut = text.indexOf(' · ');
  const head = cut < 0 ? text : text.slice(0, cut);
  const rest = cut < 0 ? '' : text.slice(cut + 3);
  return (
    <span style={s.stripLine}>
      <Glyph entry={entry} />
      <span style={LBL[stateTone(entry.state)]}>{head}</span>
      {rest && <span aria-hidden="true">·</span>}
      {rest && <span style={sx(s.stripRest, entry.state !== 'ok' && entry.result && s.mono)}>{rest}</span>}
      {clock && <span aria-hidden="true">·</span>}
      {clock && <span style={s.stripClock}>{clock}</span>}
    </span>
  );
}

export function TestStatusRow({ store, route, modelId, index, entry, open, why }: TestStatusRowProps): JSX.Element {
  const now = useRunningNow(entry);
  const st = entry.state;
  const hasResult = !!entry.result && (st === 'ok' || st === 'fail' || st === 'transient');
  const busy = st === 'queued' || st === 'running';
  const transient = st === 'transient';
  const verb = transient ? '重试' : st === 'cancelled' ? '测试' : '重测';
  const fullId = <span style={s.stripId}>{modelId}</span>;

  return (
    <div role="row" data-mc-strip={modelId} data-mc-state={st} style={s.strip}>
      <div role="cell" style={s.stripCell}>
        {hasResult ? (
          <button
            type="button"
            data-mc-detail={modelId}
            aria-expanded={open}
            aria-controls={`mc-tdet-${index}`}
            aria-label={stripAria(modelId, entry, open)}
            title={modelId}
            onClick={() => store.toggleTestDetail(route, modelId)}
            style={sx(s.stripToggle, open && s.stripToggleOpen)}
          >
            {fullId}
            <span style={s.stripLine}>
              <Line entry={entry} clock={entry.at !== undefined ? fmtClock(entry.at).slice(3) : undefined} />
              <span style={s.chev} aria-hidden="true">{open ? '▴' : '▾'}</span>
            </span>
          </button>
        ) : (
          <div style={s.stripPlain}>
            {fullId}
            <Line entry={entry} now={now} />
          </div>
        )}
      </div>
      {!busy && (
        <button
          type="button"
          data-mc-retest={modelId}
          aria-label={`${verb} ${modelId}`}
          aria-disabled={why ? 'true' : undefined}
          title={why || '再发 1 次真实请求'}
          onClick={() => store.testModel(route, modelId)}
          style={sx(s.xbtn, transient && !why && s.xbtnRetry, why && s.disabled)}
        >
          {transient ? '↻ 重试' : verb}
        </button>
      )}
    </div>
  );
}
