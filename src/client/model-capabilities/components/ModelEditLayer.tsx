import React from 'react';
import { ALL_EFFORTS, NS_PI } from '../types';
import type { FieldErrors, McSnapshot, ModelCapabilitiesStore, ModelDraft, ProviderDraft, ReasoningMap } from '../types';
import { modelCap } from '../capacity';
import { resolvedInput } from '../efforts';
import { idWarn } from '../validate';
import { mcStyles as s, sx } from '../styles';
import { CapacityField } from './CapacityField';
import { EffortRail } from './EffortRail';
import { InputChips } from './InputChips';
import { Banners, Btn, ErrText, Hint, Section, Switch, TextField, hintFor } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

/** Known levels in canonical order (display only; the draft keeps its own order). */
const levelsOf = (eff: ReasoningMap) => ALL_EFFORTS.filter((l) => Object.prototype.hasOwnProperty.call(eff, l));

function CapSection({ p, m, e, store, disabled }: { p: ProviderDraft; m: ModelDraft; e: FieldErrors; store: ModelCapabilitiesStore; disabled: boolean }) {
  const pi = p.ns === NS_PI;
  const c = modelCap(m);
  return (
    <Section title="容量">
      <Hint style={{ margin: 0 }}>上下文窗口是请求与响应合计的 token 上限。</Hint>
      <div style={s.grid2}>
        <CapacityField side="cw" cap={c.cw} pi={pi} disabled={disabled} store={store} error={e.contextWindow} />
        <CapacityField side="mt" cap={c.mt} pi={pi} disabled={disabled} store={store} error={e.maxTokens} />
      </div>
    </Section>
  );
}

export function ModelEditLayer({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const edit = ui.edit;
  if (!edit || edit.kind !== 'model') return null;
  const p = snap.draft.providers[edit.route];
  const m = p?.models[edit.idx];
  if (!p || !m) return null;
  const pi = p.ns === NS_PI;
  const e: FieldErrors = snap.errors[edit.route]?.models?.[edit.idx] ?? {};
  const lock = ui.readonly || ui.saving;
  const chipHint = hintFor(snap, 'model');
  const ri = resolvedInput(p, m);

  const head = (
    <>
      <Banners snap={snap} store={store} />
      <div style={s.row}><Btn kind="link" onClick={() => store.closeLayer()} data-mc="close-layer">← 返回模型列表</Btn></div>
      <h2 style={s.h1}>编辑 <span style={s.mono}>{m.id || '新模型'}</span></h2>
    </>
  );

  if (!pi) {
    return (
      <>
        {head}
        <div style={s.grid2}>
          <TextField label="模型 ID" value={m.id} disabled mono />
          <TextField label="名称" value={m.name || m.id} disabled hint="官方模型的 ID 和名称由提供方给出。" />
        </div>
        <Section title="输入类型" titleAddon={ri.set ? <Btn kind="link" disabled={lock} onClick={() => store.clearInput()}>清除</Btn> : undefined}>
          <InputChips
            value={ri.v}
            disabled={lock}
            label="输入类型"
            note={ri.set ? undefined : '未设置'}
            hint={chipHint}
            onToggle={(k) => store.toggleInput('model', k)}
          />
        </Section>
        <p style={s.desc}>思考档位在提供方上统一设置。</p>
        <CapSection p={p} m={m} e={e} store={store} disabled={lock} />
      </>
    );
  }

  const w = idWarn(m.id);
  const eff = m.reasoningEfforts;
  const isObj = !!eff && typeof eff === 'object';
  const levels = isObj ? levelsOf(eff as ReasoningMap) : [];
  const railKey = `m:${edit.route}:${edit.idx}`;

  return (
    <>
      {head}
      <div style={s.grid2}>
        <TextField
          label="模型 ID"
          value={m.id}
          error={e.id}
          mono
          placeholder="例如 gpt-6-nova"
          hint={!e.id && w ? w : undefined}
          disabled={lock}
          onChange={(v) => store.setModelId(v)}
        />
        <TextField
          label="名称"
          value={m.name ?? ''}
          placeholder="可留空"
          hint="留空时界面显示 ID。"
          disabled={lock}
          onChange={(v) => store.setModelName(v)}
        />
      </div>

      <Section title="输入类型" titleAddon={ri.set ? <Btn kind="link" disabled={lock} onClick={() => store.clearInput()}>清除</Btn> : undefined}>
        <InputChips
          value={ri.v}
          disabled={lock}
          label="输入类型"
          note={ri.set ? undefined : '未设置'}
          hint={chipHint}
          onToggle={(k) => store.toggleInput('model', k)}
        />
        {m.inputModalities && (
          <Hint>{`配置里还有旧字段 inputModalities: [${m.inputModalities.join(', ')}]，自定义提供方会忽略它。可在模型列表上方「迁移为 input」。`}</Hint>
        )}
      </Section>

      <Section title="思考" titleAddon={<Switch on={!isObj} label="不思考" disabled={lock} onClick={() => store.toggleNoThink()} />}>
        {eff === undefined && <Hint style={{ margin: 0 }}>配置里还没有 reasoningEfforts。</Hint>}
        <div style={s.field}>
          <span style={s.label}>支持的档位</span>
          <EffortRail
            railKey={railKey}
            mode="multi"
            selected={levels}
            disabled={!isObj || lock}
            showAdv={!!ui.showAdv[railKey]}
            onToggle={(l) => store.railToggle(railKey, l)}
            onToggleAdv={() => store.toggleAdv(railKey)}
            label="支持的思考档位"
          />
          {e.efforts && <ErrText>{e.efforts}</ErrText>}
        </div>
        {isObj && levels.length > 0 && (
          <div style={s.field}>
            <span style={s.label}>线上拼写</span>
            <Hint style={{ margin: '0 0 4px' }}>发给提供方的实际字符串。</Hint>
            {levels.map((l) => {
              const v = (eff as ReasoningMap)[l];
              const isNull = v === null;
              const err = e[`spell_${l}`];
              return (
                <React.Fragment key={l}>
                  <div style={s.spell}>
                    <span style={s.spellLvl}>{l}</span>
                    <input
                      aria-label={`${l} 的线上拼写`}
                      value={isNull ? 'null' : v ?? ''}
                      disabled={isNull || lock}
                      aria-invalid={err ? true : undefined}
                      onChange={(ev) => store.setSpell(l, ev.target.value)}
                      style={sx(s.input, s.inputSm, s.mono, err && s.inputInvalid, (isNull || lock) && s.inputDisabled)}
                    />
                    <Btn disabled={v === l || lock} onClick={() => store.setSpell(l, l)}>与档名相同</Btn>
                    <Btn disabled={lock} onClick={() => store.setSpell(l, isNull ? l : null)}>{isNull ? '改为字符串' : '写成 null'}</Btn>
                  </div>
                  {err && <ErrText style={{ margin: '0 0 0 72px' }}>{err}</ErrText>}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </Section>

      <CapSection p={p} m={m} e={e} store={store} disabled={lock} />
    </>
  );
}
