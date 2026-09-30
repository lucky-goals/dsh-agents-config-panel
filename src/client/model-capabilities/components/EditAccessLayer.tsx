/**
 * 编辑接入层 for a pi-ai provider (prototype layerAccess): ID (read-only),
 * 显示名, 协议, baseURL, 密钥环境变量名, 密钥 and 请求头.
 *
 * The plaintext secret never enters the snapshot (spec B1), so the input keeps
 * what is being typed locally and forwards every change to store.setSecret.
 */
import React, { useId, useState } from 'react';
import { API_OPTS, NS_PI } from '../types';
import type { HeaderPair, McSnapshot, ModelCapabilitiesStore } from '../types';
import { secretError } from '../validate';
import { mcStyles as s, sx } from '../styles';
import { Banners, Btn, ErrText, Hint, Section, TextField } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

/** Request-header rows shared by the access layer and the wizard. */
export function HeaderRows({
  list, scope, store, disabled,
}: {
  list: HeaderPair[];
  scope: 'access' | 'wizard';
  store: ModelCapabilitiesStore;
  disabled?: boolean;
}) {
  return (
    <>
      {list.map((h, i) => (
        <div key={i} style={s.row}>
          <input
            aria-label={`请求头名称 ${i + 1}`}
            placeholder="名称"
            value={h.k}
            disabled={disabled}
            onChange={(e) => store.headerEdit(scope, i, 'k', e.target.value)}
            style={sx(s.input, s.inputSm, s.mono, disabled && s.inputDisabled)}
          />
          <input
            aria-label={`请求头值 ${i + 1}`}
            placeholder="值"
            value={h.v}
            disabled={disabled}
            onChange={(e) => store.headerEdit(scope, i, 'v', e.target.value)}
            style={sx(s.input, s.inputSm, s.mono, disabled && s.inputDisabled)}
          />
          <Btn kind="ghost" disabled={disabled} aria-label={`删除第 ${i + 1} 行请求头`} onClick={() => store.headerDelete(scope, i)}>删除</Btn>
        </div>
      ))}
      <div><Btn disabled={disabled} onClick={() => store.headerAdd(scope)}>+ 添加请求头</Btn></div>
    </>
  );
}

/** 协议 select with the prototype's 「名称（id）」 option text. */
export function ApiSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div style={s.field}>
      <label htmlFor={id} style={s.label}>协议</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={sx(s.input, disabled && s.inputDisabled)}
      >
        {API_OPTS.map((o) => <option key={o.v} value={o.v}>{`${o.t}（${o.v}）`}</option>)}
      </select>
      <Hint>换协议不会改 ID。</Hint>
    </div>
  );
}

export function EditAccessLayer({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const edit = ui.edit;
  // Local echo of the typed secret only; the store holds the value (spec B1).
  const [secret, setSecret] = useState('');
  if (!edit || edit.kind !== 'access') return null;
  const rid = edit.route;
  const p = snap.draft.providers[rid];
  if (!p || p.ns !== NS_PI) return null;
  const re = snap.errors[rid]?.route ?? {};
  const lock = ui.readonly || ui.saving;
  const pending = !!snap.secretSet[rid];
  const secretErr = re.secret ?? (secret ? secretError(secret) : '');

  return (
    <>
      <Banners snap={snap} store={store} />
      <div style={s.row}><Btn kind="link" onClick={() => store.closeLayer()} data-mc="close-layer">← 返回提供方详情</Btn></div>
      <h2 style={s.h1}>编辑接入 <span style={s.mono}>{rid}</span></h2>
      <div style={s.grid2}>
        <TextField label="提供方 ID" value={rid} disabled mono hint="写入后不能修改。" />
        <TextField
          label="显示名"
          value={p.displayName ?? ''}
          placeholder="可留空"
          disabled={lock}
          onChange={(v) => store.setAccessField('displayName', v)}
        />
      </div>
      <ApiSelect value={p.api ?? ''} disabled={lock} onChange={(v) => store.setAccessField('api', v)} />
      <TextField
        label="baseURL"
        value={p.baseURL ?? ''}
        mono
        placeholder="https://…"
        error={re.baseURL}
        hint={p.baseURL ? undefined : '未填 baseURL。留空时不写这个字段。'}
        disabled={lock}
        onChange={(v) => store.setAccessField('baseURL', v)}
      />
      <div style={s.grid2}>
        <TextField
          label="密钥环境变量名"
          value={p.apiKeyEnv ?? ''}
          error={re.apiKeyEnv}
          mono
          disabled={lock}
          onChange={(v) => store.setAccessField('apiKeyEnv', v)}
        />
        <TextField
          label="密钥"
          type="password"
          value={secret}
          autoComplete="new-password"
          placeholder={pending && !secret ? '已填写，保存后写入' : p.credConfigured ? '已保存，留空则不更改' : '未配置'}
          error={secretErr || undefined}
          hint="只写入凭证库，不进配置。"
          disabled={lock || !p.credWritable}
          onChange={(v) => { setSecret(v); store.setSecret(v); }}
        />
      </div>
      <Section title="请求头">
        <HeaderRows list={p.headers ?? []} scope="access" store={store} disabled={lock} />
        {re.headers && <ErrText>{re.headers}</ErrText>}
      </Section>
    </>
  );
}
