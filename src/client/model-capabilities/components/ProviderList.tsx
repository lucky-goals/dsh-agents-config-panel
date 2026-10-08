/**
 * Provider list (prototype viewList): title, LIST_DESC, 导出 / 导入 / 添加提供方, one card per
 * provider (custom ones in record order, DeepSeek last) and the read-only
 * default-model line.
 */
import React from 'react';
import { DS_ROUTE_ID, LIST_DESC, NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore, ProviderDraft } from '../types';
import { hasLegacy } from '../efforts';
import { mcStyles as s, sx } from '../styles';
import { ImportFileButton } from '../../ui/PanelChrome';
import { Btn, CredStatus, GateBtn, HOST_UNSUPPORTED_TEXT, SAVE_FIRST, Tag, TestBadge, apiName, isSaveGate, testGate } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export const DS_NAME = 'DeepSeek 官方';

/** Custom provider ids in record order, then the official one (spec B1). */
export function providerOrder(snap: McSnapshot): string[] {
  const ids = Object.keys(snap.draft.providers);
  const custom = ids.filter((id) => id !== DS_ROUTE_ID);
  return ids.includes(DS_ROUTE_ID) ? [...custom, DS_ROUTE_ID] : custom;
}

export function providerName(p: ProviderDraft): string {
  return p.ns === NS_PI ? p.displayName || p.id : DS_NAME;
}

/**
 * The default-model line names a provider of this config: a draft route, or
 * the official one while llm-deepseek is installed. A stale reference to a
 * provider that is not configured is not shown.
 */
function knownProvider(snap: McSnapshot, provider: string): boolean {
  if (snap.draft.providers[provider] && provider !== DS_ROUTE_ID) return true;
  return snap.hasDs && (provider === DS_ROUTE_ID || provider === 'deepseek');
}

function summaryOf(p: ProviderDraft): string {
  if (p.ns !== NS_PI) return `${p.thinking === 'enabled' ? `思考 ${p.reasoningEffort ?? ''}` : '不思考'} · 不可删除`;
  return hasLegacy(p) ? '有旧字段' : '已配置';
}

export const IMPORT_READONLY_TITLE = '只读模式，不能导入';
export const IMPORT_DIRTY_TITLE = '有未保存的修改或配置冲突，请先保存、放弃或重新加载后再导入';

/**
 * 导出 / 导入 state per R3 1.3: loading, loadError and saving disable both;
 * readonly or unsaved work / a conflict only disable 导入 (with a title).
 */
function ioState(snap: McSnapshot): { exportDisabled: boolean; importDisabled: boolean; importTitle?: string } {
  const { ui, ops } = snap;
  if (ui.loading || snap.loadError || ui.saving) return { exportDisabled: true, importDisabled: true };
  if (ui.readonly) return { exportDisabled: false, importDisabled: true, importTitle: IMPORT_READONLY_TITLE };
  if (ops.dirty > 0 || ui.conflict !== 'hidden') return { exportDisabled: false, importDisabled: true, importTitle: IMPORT_DIRTY_TITLE };
  return { exportDisabled: false, importDisabled: false };
}

/** Header row shared with the loading / load-error states: 导出 · 导入 · 添加提供方. */
export function ListHead({ snap, store, addDisabled, onAdd }: ComponentProps & { addDisabled: boolean; onAdd?: () => void }) {
  const io = ioState(snap);
  return (
    <div style={s.head}>
      <div style={s.headMain}>
        <h2 style={s.h1}>模型能力</h2>
        <p style={s.desc}>{LIST_DESC}</p>
      </div>
      <div style={s.headActions}>
        <Btn disabled={io.exportDisabled} onClick={() => store.exportConfig()} data-mc="export">导出</Btn>
        <ImportFileButton
          onFile={(f) => void store.importConfig(f)}
          disabled={io.importDisabled}
          title={io.importTitle}
        />
        <Btn kind="primary" disabled={addDisabled} onClick={onAdd} data-mc="add-provider">添加提供方</Btn>
      </div>
    </div>
  );
}

export function ProviderList({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui, ops, defaultModel } = snap;
  const order = providerOrder(snap);
  const hasCustom = order.some((id) => id !== DS_ROUTE_ID);
  const addDisabled = ui.readonly || ui.saving || !snap.hasPi;
  const add = () => store.openAddProvider();

  return (
    <>
      <ListHead snap={snap} store={store} addDisabled={addDisabled} onAdd={add} />
      {!hasCustom && (
        <div style={sx(s.card, s.empty)}>
          <p style={s.desc}>还没有自定义提供方。</p>
          <Btn kind="primary" disabled={addDisabled} onClick={add}>添加提供方</Btn>
        </div>
      )}
      {order.map((id) => {
        const p = snap.draft.providers[id];
        const pi = p.ns === NS_PI;
        const name = providerName(p);
        const n = p.models.length;
        const test = snap.test;
        const gate = testGate(snap, id);
        const batchLive = !!test?.batches[id] && !test.batches[id].done;
        // The card's reason line: Host without the route, or unsaved work.
        const whyLine = test?.hostUnsupported ? HOST_UNSUPPORTED_TEXT : isSaveGate(gate) ? SAVE_FIRST : null;
        const whyId = `mc-card-why-${id}`;
        const main = (
            <div style={s.pmain}>
              <div style={sx(s.pname, s.rowWrap, { gap: '6px' })}>
                <span>{name}</span>
                <Tag>{pi ? apiName(p.api) : '官方'}</Tag>
                {pi && p.displayName && <span style={sx(s.small, s.mono)}>{id}</span>}
                {ops.dirtySet.has(id) && <Tag>未保存</Tag>}
              </div>
              {pi && <div style={sx(s.purl, s.mono)}>{p.baseURL || '未填 baseURL'}</div>}
              <div style={s.pmeta}>
                <CredStatus configured={p.credConfigured} />
                <span aria-hidden="true">·</span>
                <span>{p.models.length} 个模型</span>
                <span aria-hidden="true">·</span>
                <span>{summaryOf(p)}</span>
                {test && <TestBadge snap={snap} route={id} />}
              </div>
            </div>
        );
        const enter = <Btn aria-label={`进入 ${name}`} data-mc-enter={id} disabled={ui.saving} onClick={() => store.enter(id)}>进入 →</Btn>;
        // Without a tester the card keeps its pre-R4a markup.
        if (!test) {
          return (
            <div key={id} style={sx(s.card, s.pcard)}>
              {main}
              {enter}
            </div>
          );
        }
        return (
          <div key={id} style={sx(s.card, s.pcardCol)}>
            <div style={s.pcardTop}>
              {main}
              <div style={s.pcardActs}>
                {n > 0 && (
                  <GateBtn
                    kind="ghost"
                    data-mc-test-all={id}
                    aria-label={`测试 ${name} 的全部 ${n} 个模型`}
                    aria-describedby={gate && whyLine ? whyId : undefined}
                    why={gate || (batchLive ? '正在测试，进入详情可停止' : null)}
                    title="对每个模型发 1 次真实请求"
                    onClick={() => store.testProvider(id)}
                  >
                    {batchLive && <span style={s.ring} aria-hidden="true" />}
                    {batchLive ? '测试中' : '测试全部'}
                  </GateBtn>
                )}
                {enter}
              </div>
            </div>
            {gate && whyLine && (
              <p id={whyId} style={s.pcardWhy}>
                <span style={s.dotWarn} aria-hidden="true" />
                {whyLine}
              </p>
            )}
          </div>
        );
      })}
      {defaultModel && defaultModel.provider && defaultModel.model && defaultModel.effort && knownProvider(snap, defaultModel.provider) && (
        <p style={s.readonlyLine}>默认模型（只读）：{`${defaultModel.provider} / ${defaultModel.model} · ${defaultModel.effort}`}</p>
      )}
    </>
  );
}
