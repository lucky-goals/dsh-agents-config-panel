/**
 * Model table of the provider detail (prototype tableHTML + the selection bar).
 *
 * CSS grid + ARIA (captain ruling 5): role=table / row / columnheader / cell;
 * every row is `gridTemplateColumns: subgrid` on the table's six tracks.
 */
import React from 'react';
import { NS_PI } from '../types';
import type { CapSide, McSnapshot, ModelCapabilitiesStore, ModelDraft, TestEntry } from '../types';
import { abbr, modelCap } from '../capacity';
import { effortSummary, inputSummary } from '../efforts';
import { testKey } from '../model-test';
import { mcStyles as s, sx } from '../styles';
import { BatchProgress } from './BatchProgress';
import { Btn, GateBtn, isSaveGate, testGate } from './shared';
import { TestDetail } from './TestDetail';
import { TestStatusRow } from './TestStatusRow';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

const cut = (t: string) => (t.length > 8 ? `${t.slice(0, 8)}…` : t);

function CapCell({ m }: { m: ModelDraft }) {
  const c = modelCap(m);
  const side = (x: CapSide) => (x.parsed === null
    ? <span style={s.capBad}>{cut(x.raw)}</span>
    : typeof x.parsed === 'number'
      ? <span style={s.capEx}>{abbr(x.parsed)}</span>
      : <span style={s.capInh}>未设置</span>);
  const desc = (name: string, x: CapSide) => (x.parsed === null
    ? `${name}格式错误：${x.raw}`
    : typeof x.parsed === 'number' ? `${name} ${x.parsed}` : `${name}未设置`);
  const lbl = `${desc('上下文', c.cw)}；${desc('输出', c.mt)}`;
  return (
    <span role="cell" aria-label={lbl} title={lbl} style={s.capCell}>
      {side(c.cw)}
      <span style={s.capSlash} aria-hidden="true"> / </span>
      {side(c.mt)}
    </span>
  );
}

/**
 * 28px ▷ test button of the ops column (↻ after a transient failure). Gated or
 * busy it stays clickable with aria-disabled; the store explains a gate.
 */
function TestButton({
  store, route, id, entry, gate, gateDesc,
}: {
  store: ModelCapabilitiesStore;
  route: string;
  id: string;
  entry: TestEntry | undefined;
  gate: string | null;
  gateDesc?: string;
}) {
  const st = entry?.state;
  const transient = st === 'transient';
  const busy = st === 'queued' || st === 'running';
  const verb = transient ? '重试' : !st || st === 'cancelled' ? '测试' : '重测';
  const why = gate || (busy ? (st === 'queued' ? '排队中' : '测试中') : null);
  return (
    <button
      type="button"
      data-mc-test={id}
      aria-label={`${verb} ${id}`}
      aria-disabled={why ? 'true' : undefined}
      aria-describedby={gate ? gateDesc : undefined}
      title={why || `${verb}：发 1 次真实请求（maxTokens 32，最低推理档）`}
      onClick={() => store.testModel(route, id)}
      style={sx(s.testIcon, transient && !gate && s.testIconRetry, why && s.disabled)}
    >
      <span aria-hidden="true">{transient ? '↻' : '▷'}</span>
    </button>
  );
}

export function ModelTable({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const rid = ui.route;
  const p = rid ? snap.draft.providers[rid] : undefined;
  if (!rid || !p) return null;
  const pi = p.ns === NS_PI;
  const sel = new Set(ui.sel[rid] ?? []);
  const nm = p.models.length;
  const nsel = sel.size;
  const all = nm > 0 && nsel === nm;
  const lock = ui.readonly || ui.saving;
  const modelErrs = snap.errors[rid]?.models ?? [];
  // R4a: every test control is absent without a tester (snap.test undefined).
  const test = snap.test;
  const gate = testGate(snap, rid);
  const batchLive = !!test?.batches[rid] && !test.batches[rid].done;
  const busyWhy = gate || (batchLive ? '正在批量测试，先等它完成或停止' : null);
  // The 「先保存再测试」 banner of ProviderDetail carries the reason text.
  const gateDesc = isSaveGate(gate) ? `mc-test-why-${rid}` : undefined;

  return (
    <>
      <div role="group" aria-label="模型选择" style={sx(s.seltool, test && { flexWrap: 'wrap', gap: '8px 12px' })}>
        <span role="status" style={s.selcount}>{nsel ? `已选 ${nsel} 个` : '模型'}</span>
        <Btn kind="link" disabled={!nm || nsel === nm} onClick={() => store.selectAll()}>全选</Btn>
        <Btn kind="link" disabled={!nsel} onClick={() => store.selectClear()}>清除</Btn>
        <span style={s.spacer} />
        {test && nm > 0 ? (
          <div style={s.selGrp}>
            <GateBtn
              data-mc="test-all"
              aria-label={`全部测试（${nm} 个模型）`}
              why={busyWhy}
              title={`对全部 ${nm} 个模型各发 1 次真实请求`}
              onClick={() => store.testAll()}
            >
              全部测试
            </GateBtn>
            <GateBtn
              data-mc="test-selected"
              why={busyWhy || (nsel ? null : '先勾选要测试的模型')}
              title="对勾选的模型各发 1 次真实请求"
              onClick={() => store.testSelected()}
            >
              测试所选（{nsel}）
            </GateBtn>
            <Btn disabled={!nm || lock} onClick={() => store.openBulk()} data-mc="bulk-toggle">批量设置</Btn>
          </div>
        ) : (
          <Btn disabled={!nm || lock} onClick={() => store.openBulk()} data-mc="bulk-toggle">批量设置</Btn>
        )}
      </div>

      {test && <BatchProgress snap={snap} store={store} route={rid} />}

      <div role="table" aria-label="模型列表" style={s.mtable}>
        <div role="row" style={s.mrowHdr}>
          <span role="columnheader" style={s.selcell}>
            <input
              type="checkbox"
              aria-label="全选模型"
              checked={all}
              disabled={!nm}
              onChange={(e) => (e.target.checked ? store.selectAll() : store.selectClear())}
              style={s.checkInput}
            />
          </span>
          <span role="columnheader" style={s.cell}>模型</span>
          <span role="columnheader" style={s.cell}>输入</span>
          <span role="columnheader" style={s.cell}>思考</span>
          <span role="columnheader" aria-label="上下文 / 输出" style={s.cell}>容量</span>
          <span role="columnheader" style={s.cell}><span style={s.srOnly}>操作</span></span>
        </div>

        {p.models.map((m, i) => {
          const errs = modelErrs[i] ?? {};
          const firstErr = Object.values(errs).find(Boolean);
          const think = pi ? effortSummary(m.reasoningEfforts) : (p.reasoningEffort ? `思考 ${p.reasoningEffort}` : '不思考');
          const name = m.id || '未命名模型';
          const key = m.id ? testKey(rid, m.id) : '';
          const entry = test && m.id ? test.results[key] : undefined;
          const open = !!entry?.result && test?.open === key;
          return (
            <React.Fragment key={i}>
            <div role="row" style={sx(s.mrow, entry && s.mrowStrip)}>
              <span role="cell" style={s.selcell}>
                <input
                  type="checkbox"
                  aria-label={`选择 ${name}`}
                  checked={sel.has(i)}
                  onChange={(e) => store.selectIndex(i, e.target.checked)}
                  style={s.checkInput}
                />
              </span>
              <span role="cell" style={s.cell}>
                <div style={sx(s.mid, s.mono)} title={m.id}>{m.id ? m.id : <span style={s.err}>未填 ID</span>}</div>
                {m.name && m.name !== m.id && <div style={s.mname} title={m.name}>{m.name}</div>}
                {firstErr && <div style={sx(s.errtext, { margin: 0 })}>{firstErr}</div>}
              </span>
              <span role="cell" style={sx(s.sum, pi && !m.input && { opacity: 0.8 })}>
                {inputSummary(p, m)}
                {pi && m.inputModalities && (
                  <span
                    role="img"
                    aria-label="旧字段 inputModalities，自定义提供方会忽略"
                    title="旧字段 inputModalities，自定义提供方会忽略"
                    style={s.tagOld}
                  >旧</span>
                )}
              </span>
              <span role="cell" title={think} style={s.think}>{think}</span>
              <CapCell m={m} />
              <span role="cell" style={s.ops}>
                {test && (m.id ? <TestButton store={store} route={rid} id={m.id} entry={entry} gate={gate} gateDesc={gateDesc} /> : <span style={s.opsSlot} aria-hidden="true" />)}
                <Btn aria-label={`编辑 ${m.id}`} onClick={() => store.openModel(i)}>编辑</Btn>
                {pi && (
                  <Btn
                    kind="icon"
                    data-mc-menu={i}
                    aria-haspopup="menu"
                    aria-expanded={ui.menuIdx === i}
                    aria-controls={ui.menuIdx === i ? 'mc-row-menu' : undefined}
                    aria-label={`更多操作：${m.id}`}
                    disabled={lock}
                    onClick={() => (ui.menuIdx === i ? store.closeMenu() : store.openMenu(i))}
                  >
                    ···
                  </Btn>
                )}
                {test && !pi && <span style={s.opsSlot} aria-hidden="true" />}
              </span>
            </div>
            {entry && (
              <TestStatusRow store={store} route={rid} modelId={m.id} index={i} entry={entry} open={open} why={gate} />
            )}
            {open && entry && <TestDetail store={store} route={rid} modelId={m.id} index={i} entry={entry} />}
            </React.Fragment>
          );
        })}

        {!nm && (
          <div role="row" style={s.mrow}>
            <span role="cell" />
            <span role="cell" style={sx(s.small, { gridColumn: '2 / -1' })}>还没有模型。</span>
          </div>
        )}

        {pi && (
          <div style={s.mfoot}>
            <Btn disabled={lock} onClick={() => store.addModel()} data-mc="add-model">+ 添加模型</Btn>
            <span style={s.spacer} />
            {ui.undo && ui.undo.route === rid && (
              <span role="status" style={s.toast}>
                已删除 {ui.undo.model.id || '未命名模型'}
                <Btn kind="link" disabled={lock} onClick={() => store.undoDelete()}>撤销</Btn>
              </span>
            )}
          </div>
        )}
      </div>
      {test && (
        <p style={s.footNote}>
          测试结果只保留在本次设置会话内，保存或刷新后清空，不写入配置。每次测试是一次真实请求：短提示、maxTokens 32、最低推理档、超时 20 秒，会产生少量费用。
        </p>
      )}
    </>
  );
}
