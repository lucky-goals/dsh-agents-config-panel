import React from 'react';
import { DS_ROUTE_ID, NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { hasLegacy } from '../efforts';
import { timeoutSummary } from '../timeout';
import { mcStyles as s, sx } from '../styles';
import { EffortRail } from './EffortRail';
import { DS_NAME } from './ProviderList';
import { Banner, Btn, CredStatus, ErrText, Hint, Section, Switch, Tag, TestBadge, apiName, isSaveGate, testGate } from './shared';
import { TimeoutField, routeTimeoutProps } from './TimeoutField';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export function ProviderDetail({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const rid = ui.route;
  const p = rid ? snap.draft.providers[rid] : undefined;
  if (!rid || !p) return null;
  const lock = ui.readonly || ui.saving;
  const re = snap.errors[rid]?.route ?? {};
  const back = <div><Btn kind="link" onClick={() => store.backToList()} data-mc="back-list">← 返回提供方</Btn></div>;
  const summary = <span data-mc="timeout-summary">· {timeoutSummary(p)}</span>;

  // R4a gate banners (absent without a tester): unsaved work, else missing key.
  const gate = testGate(snap, rid);
  const testBanner = !snap.test ? null : isSaveGate(gate) ? (
    <Banner
      tone="warn"
      id={`mc-test-why-${rid}`}
      dataMc="test-gate"
      sub={gate === '先保存再测试：这个提供方还没保存'
        ? '这个提供方还没保存，Host 不认识它。保存后测试入口自动恢复。'
        : '这个提供方有未保存的改动，Host 只认已保存的配置。保存后测试入口自动恢复。'}
      actions={<Btn disabled={lock} onClick={() => void store.save()}>保存</Btn>}
    >
      先保存再测试
    </Banner>
  ) : !gate && !p.credConfigured ? (
    <Banner sub="仍然可以测试，但不会发出请求，结果会是「未配置 Key」。">还没有配置 API Key</Banner>
  ) : null;

  if (p.ns === NS_PI) {
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
              {summary}
              {snap.test && <TestBadge snap={snap} route={rid} />}
            </div>
            <div style={sx(s.small, s.mono, s.purl, { marginTop: '2px' })} title={p.baseURL || undefined}>{p.baseURL || '未填 baseURL'}</div>
            {re.apiKeyEnv && <ErrText>{re.apiKeyEnv}（在「编辑接入」里修改）</ErrText>}
          </div>
          <div style={s.row}>
            <Btn onClick={() => store.openAccess()}>编辑接入</Btn>
            <Btn kind="danger" disabled={lock} onClick={() => store.askDeleteProvider()}>删除提供方</Btn>
          </div>
        </div>
        {testBanner}
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
          <p style={s.desc}>官方提供方由「模型」页接入，这里改思考和超时。接入本身不在这里改。</p>
          <div style={sx(s.small, s.rowWrap, { marginTop: '4px' })}>
            <CredStatus configured={p.credConfigured} />
            {summary}
            {snap.test && <TestBadge snap={snap} route={rid} />}
          </div>
        </div>
      </div>
      {testBanner}
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
      <Section title="超时">
        <TimeoutField
          scope="ds"
          {...routeTimeoutProps(snap, DS_ROUTE_ID, p)}
          disabled={lock}
          onText={(v) => store.setTimeoutText(DS_ROUTE_ID, v)}
          onBlur={() => store.blurTimeout(DS_ROUTE_ID)}
          onPreset={(ms) => store.setTimeoutPreset(DS_ROUTE_ID, ms)}
          onReset={() => store.resetTimeout(DS_ROUTE_ID)}
        />
      </Section>
    </>
  );
}
