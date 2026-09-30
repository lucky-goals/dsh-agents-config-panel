import React from 'react';
import { NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { hasLegacy } from '../efforts';
import { mcStyles as s, sx } from '../styles';
import { EffortRail } from './EffortRail';
import { DS_NAME } from './ProviderList';
import { Banner, Btn, CredStatus, ErrText, Hint, Section, Switch, Tag, apiName } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export function ProviderDetail({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const rid = ui.route;
  const p = rid ? snap.draft.providers[rid] : undefined;
  if (!rid || !p) return null;
  const lock = ui.readonly || ui.saving;
  const re = snap.errors[rid]?.route ?? {};
  const back = <div><Btn kind="link" onClick={() => store.backToList()} data-mc="back-list">← 返回提供方</Btn></div>;

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
            </div>
            <div style={sx(s.small, s.mono, { marginTop: '2px' })}>{p.baseURL || '未填 baseURL'}</div>
            {re.apiKeyEnv && <ErrText>{re.apiKeyEnv}（在「编辑接入」里修改）</ErrText>}
          </div>
          <div style={s.row}>
            <Btn onClick={() => store.openAccess()}>编辑接入</Btn>
            <Btn kind="danger" disabled={lock} onClick={() => store.askDeleteProvider()}>删除提供方</Btn>
          </div>
        </div>
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
          <p style={s.desc}>官方提供方由「模型」页接入，这里改思考。接入本身不在这里改。</p>
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
    </>
  );
}
