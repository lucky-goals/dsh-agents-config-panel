/**
 * Provider detail (prototype viewDetail), without the model table (the panel
 * renders ModelTable right after it).
 *
 * pi-ai: header with 编辑接入 / 删除提供方, 提供方默认值 (默认输入, 路由默认档,
 * capacity defaults) and the legacy-field migration banner.
 * DeepSeek: no 编辑接入, no delete, no migration; 思考 switch + ds rail and
 * the capacity defaults.
 */
import React from 'react';
import { NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore, ProviderDraft } from '../types';
import { capWarn, routeCap } from '../capacity';
import { hasLegacy } from '../efforts';
import { mcStyles as s, sx } from '../styles';
import { CapacityField } from './CapacityField';
import { EffortRail, SingleRailHint } from './EffortRail';
import { InputChips } from './InputChips';
import { DS_NAME } from './ProviderList';
import { Banner, Btn, CredStatus, ErrText, Hint, Section, Switch, Tag, apiName, hintFor } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

/** Route-level 上下文窗口默认 / 最大输出默认 pair (detail and wizard share it). */
export function RouteCapFields({
  p, scope, store, disabled, errors,
}: {
  p: ProviderDraft;
  scope: 'r' | 'w';
  store: ModelCapabilitiesStore;
  disabled?: boolean;
  errors?: { cw?: string; mt?: string };
}) {
  const pi = p.ns === NS_PI;
  const c = routeCap(p);
  return (
    <div style={s.grid2}>
      <CapacityField scope={scope} side="cw" cap={c.cw} pi={pi} disabled={disabled} store={store} error={errors?.cw} />
      <CapacityField scope={scope} side="mt" cap={c.mt} pi={pi} disabled={disabled} store={store} error={errors?.mt} warn={capWarn(c, pi)} />
    </div>
  );
}

/** 默认输入 row: chips plus 恢复继承 / 单独设置 (detail, access layer). */
export function RouteDefaultInput({
  p, snap, store, disabled, showRuntimeNote,
}: {
  p: ProviderDraft;
  snap: McSnapshot;
  store: ModelCapabilitiesStore;
  disabled?: boolean;
  showRuntimeNote?: boolean;
}) {
  const explicit = !!p.defaultInput;
  return (
    <div style={s.field}>
      <span style={s.label}>默认输入</span>
      <div style={s.rowWrap}>
        <InputChips
          value={p.defaultInput ?? ['text']}
          inherited={!explicit}
          disabled={disabled}
          label="默认输入"
          onToggle={(k) => store.toggleInput('route', k)}
        />
        {explicit
          ? <Btn kind="link" disabled={disabled} onClick={() => store.setInputOverride('route', false)}>恢复继承</Btn>
          : <Btn kind="link" disabled={disabled} onClick={() => store.setInputOverride('route', true)}>单独设置</Btn>}
      </div>
      {hintFor(snap, 'route') && <p role="status" style={s.errtext}>{hintFor(snap, 'route')}</p>}
      {showRuntimeNote && !explicit && <Hint>未写入 defaultInput，运行默认：文本。</Hint>}
    </div>
  );
}

/** 路由默认档 single rail (detail, access layer). */
export function RouteDefaultRail({
  p, railKey, snap, store, disabled,
}: {
  p: ProviderDraft;
  railKey: string;
  snap: McSnapshot;
  store: ModelCapabilitiesStore;
  disabled?: boolean;
}) {
  return (
    <div style={s.field}>
      <span style={s.label}>路由默认档</span>
      <EffortRail
        railKey={railKey}
        mode="single"
        selected={p.reasoning ? [p.reasoning] : []}
        defaultLevel={p.reasoning}
        disabled={disabled}
        showAdv={!!snap.ui.showAdv[railKey]}
        onToggle={(l) => store.railToggle(railKey, l)}
        onClear={() => store.railClear(railKey)}
        onToggleAdv={() => store.toggleAdv(railKey)}
        label="路由默认档"
      />
      <SingleRailHint has={!!p.reasoning} />
    </div>
  );
}

export function ProviderDetail({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const rid = ui.route;
  const p = rid ? snap.draft.providers[rid] : undefined;
  if (!rid || !p) return null;
  const lock = ui.readonly || ui.saving;
  const re = snap.errors[rid]?.route ?? {};
  const back = <div><Btn kind="link" onClick={() => store.backToList()} data-mc="back-list">← 返回提供方</Btn></div>;

  if (p.ns === NS_PI) {
    const rk = `r:${rid}:detail`;
    return (
      <>
        {back}
        <div style={s.head}>
          <div style={s.headMain}>
            <h2 style={sx(s.h1, s.mono)}>{rid}</h2>
            <p style={s.desc}>ID 写入后不能修改。它是配置键，也是密钥环境变量名的词干。</p>
            <div style={sx(s.small, s.rowWrap, { marginTop: '4px' })}>
              <Tag>{apiName(p.api)}</Tag>
              <CredStatus configured={p.credConfigured} />
              {p.displayName && <span>· 显示名 {p.displayName}</span>}
            </div>
            <div style={sx(s.small, s.mono, { marginTop: '2px' })}>{p.baseURL || '未填 baseURL'}</div>
          </div>
          <div style={s.row}>
            <Btn onClick={() => store.openAccess()}>编辑接入</Btn>
            <Btn kind="danger" disabled={lock} onClick={() => store.askDeleteProvider()}>删除提供方</Btn>
          </div>
        </div>
        <Section title="提供方默认值">
          <RouteDefaultInput p={p} snap={snap} store={store} disabled={lock} showRuntimeNote />
          <RouteDefaultRail p={p} railKey={rk} snap={snap} store={store} disabled={lock} />
          <RouteCapFields
            p={p}
            scope="r"
            store={store}
            disabled={lock}
            errors={{ cw: re.defaultContextWindow, mt: re.defaultMaxTokens }}
          />
          {re.apiKeyEnv && <ErrText>{re.apiKeyEnv}（在「编辑接入」里修改）</ErrText>}
        </Section>
        {hasLegacy(p) && (
          <Banner actions={<Btn kind="link" disabled={lock} onClick={() => store.migrate()}>迁移为 input</Btn>}>
            这些模型写了 inputModalities。自定义提供方不认这个字段，会忽略。已有 input 时以 input 为准。
          </Banner>
        )}
      </>
    );
  }

  // DeepSeek official: fixed UI id, never an op path (spec B1).
  const off = p.thinking !== 'enabled';
  const dsKey = 'ds';
  return (
    <>
      {back}
      <div style={s.head}>
        <div style={s.headMain}>
          <h2 style={sx(s.h1, s.rowWrap, { gap: '6px' })}>{DS_NAME} <Tag>官方</Tag></h2>
          <p style={s.desc}>官方提供方由「模型」页接入，这里改思考、输入类型和容量。接入本身不在这里改。</p>
          <div style={sx(s.small, s.row, { marginTop: '4px' })}><CredStatus configured={p.credConfigured} /></div>
        </div>
      </div>
      <Section title="思考" titleAddon={<Switch on={!off} label={off ? '已关闭' : '已开启'} disabled={lock} onClick={() => store.toggleDsThinking()} />}>
        <EffortRail
          railKey={dsKey}
          mode="ds"
          selected={p.reasoningEffort ? [p.reasoningEffort] : []}
          disabled={lock}
          isDisabled={(l) => off && l !== 'off'}
          showAdv={false}
          onToggle={(l) => store.railToggle(dsKey, l)}
          onToggleAdv={() => store.toggleAdv(dsKey)}
          label="思考档位"
        />
        <Hint>{off ? '关闭思考时只能是 off。' : '四档单选，所有模型共用。'}</Hint>
      </Section>
      <Section title="提供方默认值">
        <RouteCapFields
          p={p}
          scope="r"
          store={store}
          disabled={lock}
          errors={{ cw: re.defaultContextWindow, mt: re.maxTokens ?? re.defaultMaxTokens }}
        />
      </Section>
    </>
  );
}
