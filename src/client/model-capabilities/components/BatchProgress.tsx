/**
 * Batch test progress / summary of one provider (r4a-model-test.md 2.6,
 * prototype runPanelHTML), between the selection bar and the model table.
 * One segment per model, equal width, at least 4px; static, no motion.
 */
import React from 'react';
import type { McSnapshot, ModelCapabilitiesStore, TestState } from '../types';
import { batchStats, batchSub, batchTitle, progressText, segStates } from '../model-test';
import { mcStyles as s } from '../styles';
import { Btn } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore; route: string };

const SEG: Record<TestState, React.CSSProperties> = {
  queued: s.segQueued,
  running: s.segRunning,
  ok: s.segOk,
  fail: s.segFail,
  transient: s.segTransient,
  cancelled: s.segCancelled,
};

export function BatchProgress({ snap, store, route }: ComponentProps): JSX.Element | null {
  const t = snap.test;
  const b = t?.batches[route];
  if (!t || !b) return null;
  const st = batchStats(b, t.results);
  const live = !b.done;
  const valueText = `${progressText(st)}${st.cancelled ? `，已取消 ${st.cancelled}` : ''}`;
  const states = segStates(b, t.results);

  return (
    <div role="region" aria-label="批量测试" data-mc="batch" style={s.batch}>
      <div style={s.batchTop}>
        <div style={s.batchTt}>
          <div style={s.batchTtl}>
            {live && <span style={s.ring} aria-hidden="true" />}
            {batchTitle(b, st)}
          </div>
          <div style={s.batchSub}>{batchSub(b, st, b.endedAt ?? b.startedAt)}</div>
        </div>
        <div style={s.batchActs}>
          {live ? (
            <Btn
              data-mc="batch-stop"
              aria-disabled={b.stopped ? 'true' : undefined}
              title={b.stopped ? '正在停止，等待已发出的请求返回' : undefined}
              style={b.stopped ? s.disabled : undefined}
              onClick={() => { if (!b.stopped) store.stopBatch(route); }}
            >
              {b.stopped ? '停止中…' : '停止'}
            </Btn>
          ) : (
            <>
              {st.failed > 0 && (
                <Btn data-mc="batch-retry-failed" onClick={() => store.retryFailed(route)}>仅重试失败项（{st.failed}）</Btn>
              )}
              {st.cancelled > 0 && (
                <Btn data-mc="batch-retry-cancelled" onClick={() => store.retryCancelled(route)}>测试已取消的 {st.cancelled} 个</Btn>
              )}
              <Btn kind="icon" data-mc="batch-dismiss" aria-label="收起测试汇总" onClick={() => store.dismissBatch(route)}>✕</Btn>
            </>
          )}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="批量测试进度"
        aria-valuemin={0}
        aria-valuemax={st.total}
        aria-valuenow={st.done + st.cancelled}
        aria-valuetext={valueText}
        style={s.segs}
      >
        {states.map((state, i) => (
          <span key={b.keys[i]} data-seg={state} title={b.keys[i].slice(route.length + 1)} style={SEG[state]} />
        ))}
      </div>
      <div style={s.batchCounts}>
        <span style={s.batchCount}><span style={s.dotOk} aria-hidden="true" />可用 {st.ok}</span>
        <span style={s.batchCount}><span style={s.dotBad} aria-hidden="true" />失败 {st.fail}</span>
        <span style={s.batchCount}><span style={s.dotWarn} aria-hidden="true" />暂时失败 {st.transient}</span>
        {st.cancelled > 0 && <span style={s.batchCount}><span style={s.dotHollow} aria-hidden="true" />已取消 {st.cancelled}</span>}
        {live && <span style={s.batchCount}>进行中 {st.running} · 排队 {st.queued}</span>}
      </div>
      {!live && st.transient > 0 && <p style={s.batchNote}>暂时失败（被限流、超时、服务端错误等）通常稍后重试即可。</p>}
    </div>
  );
}
