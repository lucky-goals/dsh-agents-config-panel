/**
 * Expanded test detail of one model (r4a-model-test.md 2.6, prototype
 * detailHTML): a two-column <dl> spanning the whole table row, then the advice
 * line with 复制详情 and 收起. The message is already masked by the Host.
 */
import React from 'react';
import type { ModelCapabilitiesStore, TestEntry } from '../types';
import { adviceText, fmtClock, fmtMs, paramsText, verdictText } from '../model-test';
import { mcStyles as s, sx } from '../styles';
import { Btn } from './shared';

export interface TestDetailProps {
  store: ModelCapabilitiesStore;
  route: string;
  modelId: string;
  index: number;
  entry: TestEntry;
}

const SAMPLE_MAX = 80;

/** Back to the strip toggle after 收起 (the button goes away with the row). */
function focusToggle(table: Element | null, modelId: string): void {
  const toggles = table ? Array.from(table.querySelectorAll<HTMLElement>('[data-mc-detail]')) : [];
  toggles.find((el) => el.getAttribute('data-mc-detail') === modelId)?.focus();
}

export function TestDetail({ store, route, modelId, index, entry }: TestDetailProps): JSX.Element | null {
  const r = entry.result;
  if (!r) return null;
  const sampleLen = Array.from(r.sample).length;
  const testedAt = entry.at ?? Date.parse(r.testedAt);
  const row = (k: string, v: React.ReactNode, style?: React.CSSProperties) => (
    <>
      <dt style={s.tdt}>{k}</dt>
      <dd style={sx(s.tdd, style)}>{v}</dd>
    </>
  );

  const copy = () => {
    const text = store.copyTestDetail(route, modelId);
    if (text && typeof navigator !== 'undefined') void navigator.clipboard?.writeText(text).catch(() => {});
  };

  return (
    <div role="row" id={`mc-tdet-${index}`} data-mc-tdetail={modelId} style={s.tdetail}>
      <div role="cell" style={{ display: 'contents' }}>
        <dl style={s.tdl}>
          {row('模型', modelId, s.tddId)}
          {row('结果', verdictText(r))}
          {row('错误码', r.errorKind || '—', s.mono)}
          {row('HTTP 状态', r.status == null ? '—（未收到响应）' : r.status, s.mono)}
          {row('耗时', `总 ${fmtMs(r.latencyMs)} · 首 token ${fmtMs(r.firstTokenMs)}`, { fontVariantNumeric: 'tabular-nums' })}
          {row('测试时间', Number.isFinite(testedAt) ? fmtClock(testedAt) : '—', { fontVariantNumeric: 'tabular-nums' })}
          {row('样例回复', r.sample ? (
            <>
              <span style={s.tq}>{r.sample}</span>
              {sampleLen >= SAMPLE_MAX && <span style={s.small}> 前 80 字符</span>}
            </>
          ) : '—')}
          {row('message', r.message ? (
            <>
              {r.message}
              <span style={s.small}> （已脱敏）</span>
            </>
          ) : '—', s.mono)}
          {row('请求参数', paramsText(r, route), s.small)}
        </dl>
        <div style={s.tadvice}>
          <span style={s.tadviceTxt}>{adviceText(r)}</span>
          <Btn kind="link" data-mc="copy-detail" onClick={copy}>复制详情</Btn>
          <Btn
            data-mc="close-detail"
            onClick={(e) => {
              // The table outlives this row; look the toggle up once it re-renders.
              const table = e.currentTarget.closest('[role="table"]');
              store.toggleTestDetail(route, modelId);
              setTimeout(() => focusToggle(table, modelId), 0);
            }}
          >
            收起
          </Btn>
        </div>
      </div>
    </div>
  );
}
