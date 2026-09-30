/**
 * Provider list (prototype viewList): title, LIST_DESC, 添加提供方, one card per
 * provider (custom ones in record order, DeepSeek last) and the read-only
 * default-model line.
 */
import React from 'react';
import { DS_ROUTE_ID, LIST_DESC, NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore, ProviderDraft } from '../types';
import { hasLegacy } from '../efforts';
import { mcStyles as s, sx } from '../styles';
import { Btn, CredStatus, Tag, apiName } from './shared';

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
  const def = p.reasoning ? `默认档 ${p.reasoning}` : '未设默认档';
  return hasLegacy(p) ? `有旧字段 · ${def}` : def;
}

/** Header row shared with the loading state. */
export function ListHead({ addDisabled, onAdd }: { addDisabled: boolean; onAdd?: () => void }) {
  return (
    <div style={s.head}>
      <div style={s.headMain}>
        <h2 style={s.h1}>模型能力</h2>
        <p style={s.desc}>{LIST_DESC}</p>
      </div>
      <Btn kind="primary" disabled={addDisabled} onClick={onAdd} data-mc="add-provider">添加提供方</Btn>
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
      <ListHead addDisabled={addDisabled} onAdd={add} />
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
        return (
          <div key={id} style={sx(s.card, s.pcard)}>
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
              </div>
            </div>
            <Btn aria-label={`进入 ${name}`} data-mc-enter={id} disabled={ui.saving} onClick={() => store.enter(id)}>进入 →</Btn>
          </div>
        );
      })}
      {defaultModel && defaultModel.provider && defaultModel.model && defaultModel.effort && knownProvider(snap, defaultModel.provider) && (
        <p style={s.readonlyLine}>默认模型（只读）：{`${defaultModel.provider} / ${defaultModel.model} · ${defaultModel.effort}`}</p>
      )}
    </>
  );
}
