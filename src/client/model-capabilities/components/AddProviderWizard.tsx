/**
 * 添加提供方 wizard (prototype viewWizard): 1 协议 → 2 接入 → 3 模型.
 * No 「获取模型」 (spec B3); an empty model list is allowed.
 *
 * Wizard validation comes from wizardErrors(w, draft): the snapshot's errors
 * cover the draft providers only, not the wizard draft.
 */
import React, { useEffect, useRef, useState } from 'react';
import { API_OPTS, NS_PI } from '../types';
import type { McSnapshot, ModelCapabilitiesStore, ProviderDraft, WizardDraft } from '../types';
import { deriveEnv } from '../efforts';
import { idWarn, secretError, wizardErrors } from '../validate';
import { mcStyles as s, sx } from '../styles';
import { HeaderRows } from './EditAccessLayer';
import { EffortRail, SingleRailHint } from './EffortRail';
import { InputChips } from './InputChips';
import { RouteCapFields } from './ProviderDetail';
import { Btn, ErrText, Hint, Section, TextField, hintFor } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

const STEPS = ['协议', '接入', '模型'] as const;

/** The wizard's capacity pair seen as a pi-ai provider, so routeCap applies unchanged. */
function wizardRoute(w: WizardDraft): ProviderDraft {
  return { id: w.id.trim(), ns: NS_PI, models: [], extra: {}, credConfigured: false, credWritable: true, ...w.cap };
}

function Steps({ step }: { step: number }) {
  return (
    <ol aria-label="步骤" style={s.steps}>
      {STEPS.map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && <li aria-hidden="true" style={s.step}><span style={s.stepLine} /></li>}
          <li aria-current={step === i + 1 ? 'step' : undefined} style={step === i + 1 ? s.stepCur : s.step}>
            <span style={step >= i + 1 ? s.stepNOn : s.stepN}>{i + 1}</span>
            {n}
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

export function AddProviderWizard({ snap, store }: ComponentProps): JSX.Element | null {
  const w = snap.ui.wizard;
  const body = useRef<HTMLDivElement>(null);
  const [secret, setSecret] = useState('');
  const step = w?.step;

  // Each step starts on its first control, as in the prototype.
  useEffect(() => {
    const el = body.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])');
    el?.focus();
  }, [step]);

  if (!w) return null;
  const e = wizardErrors(w, snap.draft);
  const lock = snap.ui.saving;
  const patch = (x: Partial<WizardDraft>) => store.wizardPatch(x);

  let content: React.ReactNode;
  if (w.step === 1) {
    content = (
      <>
        <fieldset style={s.fieldset}>
          <legend style={sx(s.h2, { marginBottom: '8px' })}>选择协议</legend>
          {API_OPTS.map((o) => (
            <label key={o.v} style={sx(s.card, s.optcard, w.api === o.v && s.optcardSel)}>
              <input
                type="radio"
                name="mc-wiz-api"
                value={o.v}
                checked={w.api === o.v}
                disabled={lock}
                onChange={() => patch({ api: o.v })}
                style={sx(s.checkInput, { marginTop: '4px' })}
              />
              <span>
                <span style={sx(s.h2, { display: 'block' })}>{o.t}</span>
                <span style={sx(s.small, s.mono)}>{o.v}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div style={s.row}>
          <span style={s.spacer} />
          <Btn kind="primary" disabled={!w.api || lock} onClick={() => store.wizardNext()}>下一步</Btn>
        </div>
      </>
    );
  } else if (w.step === 2) {
    const showIdErr = w.id !== '' || w.tried2;
    const id = w.id.trim();
    const envHint = w.envTouched
      ? (w.env.trim() ? undefined : `留空时用 ${id ? deriveEnv(id) : '由 ID 生成的名字'}。`)
      : '随 ID 自动生成，可改。';
    const sErr = secret ? secretError(secret) : '';
    content = (
      <>
        <TextField
          label="提供方 ID"
          value={w.id}
          error={showIdErr ? e.id : undefined}
          mono
          placeholder="例如 my-gateway"
          hint="小写字母、数字和连字符。保存后不能修改。"
          disabled={lock}
          onChange={(v) => patch(w.envTouched ? { id: v } : { id: v, env: v.trim() ? deriveEnv(v.trim()) : '' })}
        />
        <label style={s.check}>
          <input type="checkbox" checked={w.ack} disabled={lock} onChange={(ev) => patch({ ack: ev.target.checked })} style={s.checkInput} />
          我知道保存后不能改这个 ID
        </label>
        <TextField label="显示名（可选）" value={w.displayName} placeholder="可留空" disabled={lock} onChange={(v) => patch({ displayName: v })} />
        <TextField label="baseURL" value={w.baseURL} mono placeholder="https://…" disabled={lock} onChange={(v) => patch({ baseURL: v })} />
        <div style={s.grid2}>
          <TextField
            label="密钥环境变量名"
            value={w.env}
            mono
            hint={envHint}
            disabled={lock}
            onChange={(v) => patch({ env: v, envTouched: true })}
          />
          <TextField
            label="密钥"
            type="password"
            value={secret}
            autoComplete="new-password"
            placeholder="留空则暂不写入凭证"
            error={sErr || undefined}
            disabled={lock}
            onChange={(v) => { setSecret(v); store.setWizardSecret(v); }}
          />
        </div>
        <div>
          <Btn
            kind="link"
            aria-expanded={w.headersOpen}
            disabled={lock}
            onClick={() => patch(!w.headersOpen && !w.headers.length
              ? { headersOpen: true, headers: [{ k: '', v: '' }] }
              : { headersOpen: !w.headersOpen })}
          >
            {w.headersOpen ? '收起高级' : '高级：请求头'}
          </Btn>
        </div>
        {w.headersOpen && <Section><HeaderRows list={w.headers} scope="wizard" store={store} disabled={lock} /></Section>}
        <div style={s.row}>
          <Btn disabled={lock} onClick={() => store.wizardPrev()}>上一步</Btn>
          <span style={s.spacer} />
          <Btn kind="primary" disabled={!!e.id || !w.ack || !!sErr || lock} onClick={() => store.wizardNext()}>下一步</Btn>
        </div>
      </>
    );
  } else {
    const mw = w.models.map((x) => idWarn(x.trim())).find(Boolean);
    const route = wizardRoute(w);
    content = (
      <>
        <Section title="模型" titleAddon={<Btn disabled={lock} onClick={() => patch({ models: [...w.models, ''] })}>手动添加</Btn>}>
          {w.models.map((x, i) => (
            <div key={i} style={s.row}>
              <input
                aria-label={`模型 ID ${i + 1}`}
                placeholder="模型 ID"
                value={x}
                disabled={lock}
                onChange={(ev) => patch({ models: w.models.map((y, j) => (j === i ? ev.target.value : y)) })}
                style={sx(s.input, s.inputSm, s.mono)}
              />
              <Btn kind="ghost" disabled={lock} aria-label={`移除第 ${i + 1} 个模型`} onClick={() => patch({ models: w.models.filter((_, j) => j !== i) })}>移除</Btn>
            </div>
          ))}
          {mw && !e.models && <Hint style={{ margin: 0 }}>{mw}</Hint>}
          {!w.models.length && <Hint style={{ margin: 0 }}>可以先不加模型，之后在提供方详情里添加。</Hint>}
          {e.models && <ErrText>{e.models}</ErrText>}
        </Section>
        <Section title="默认值">
          <div style={s.field}>
            <span style={s.label}>默认输入</span>
            <div style={s.rowWrap}>
              <InputChips
                value={w.defaultInput ?? ['text']}
                inherited={!w.defaultInput}
                disabled={lock}
                label="默认输入"
                onToggle={(k) => store.toggleInput('wizard', k)}
              />
              {w.defaultInput
                ? <Btn kind="link" disabled={lock} onClick={() => store.setInputOverride('wizard', false)}>恢复继承</Btn>
                : <Btn kind="link" disabled={lock} onClick={() => store.setInputOverride('wizard', true)}>单独设置</Btn>}
            </div>
            {hintFor(snap, 'wizard') && <p role="status" style={s.errtext}>{hintFor(snap, 'wizard')}</p>}
          </div>
          <div style={s.field}>
            <span style={s.label}>路由默认档</span>
            <EffortRail
              railKey="wiz"
              mode="single"
              selected={w.reasoning ? [w.reasoning] : []}
              defaultLevel={w.reasoning ?? undefined}
              disabled={lock}
              showAdv={!!snap.ui.showAdv.wiz}
              onToggle={(l) => store.railToggle('wiz', l)}
              onClear={() => store.railClear('wiz')}
              onToggleAdv={() => store.toggleAdv('wiz')}
              label="路由默认档"
            />
            <SingleRailHint has={!!w.reasoning} />
          </div>
          <RouteCapFields p={route} scope="w" store={store} disabled={lock} errors={{ cw: e.cw, mt: e.mt }} />
        </Section>
        <div style={s.row}>
          <Btn disabled={lock} onClick={() => store.wizardPrev()}>上一步</Btn>
          <span style={s.spacer} />
          <Btn kind="primary" disabled={!!(e.models || e.cw || e.mt) || lock} onClick={() => store.wizardFinish()}>完成添加</Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <div><Btn kind="link" onClick={() => store.wizardCancel()} data-mc="wiz-cancel">← 取消添加</Btn></div>
      <h2 style={s.h1}>添加提供方</h2>
      <Steps step={w.step} />
      <div ref={body} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>{content}</div>
    </>
  );
}
