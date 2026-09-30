import React from 'react';
import { CAP_PRESETS, NS_PI } from '../types';
import type { BulkDraft, BulkPlan, McSnapshot, ModelCapabilitiesStore } from '../types';
import { bulkPlan, bulkSummary } from '../bulk';
import { abbr, canAbbr, parseCap } from '../capacity';
import { mcStyles as s, sx } from '../styles';
import { EffortRail } from './EffortRail';
import { InputChips } from './InputChips';
import { Banners, Btn, ErrText, Hint, RadioGroup, Section, hintFor } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export const BULK_NOTE = '只改你动过的项。未动的项保持每个模型现在的值。';
const COPY_LOCK = '正在从模型复制，这一组已锁定。';

function CapSide({ b, plan, side, label, lock, store }: {
  b: BulkDraft;
  plan: BulkPlan;
  side: 'cw' | 'mt';
  label: string;
  lock: boolean;
  store: ModelCapabilitiesStore;
}) {
  const mode = lock ? 'none' : b[side];
  const raw = side === 'cw' ? b.cwRaw : b.mtRaw;
  const rawKey = side === 'cw' ? 'cwRaw' : 'mtRaw';
  const n = parseCap(raw);
  const fmt = n === null;
  const err = plan.errs[side];
  return (
    <div style={s.field}>
      <span style={s.label}>{label}</span>
      <RadioGroup
        label={label}
        value={mode}
        disabled={lock}
        options={[{ v: 'none', t: '不修改' }, { v: 'set', t: '设置为' }, { v: 'clear', t: '清除' }]}
        onChange={(v) => store.patchBulk((v === 'none' ? { [side]: v, [rawKey]: '' } : { [side]: v }) as Partial<BulkDraft>)}
      />
      {mode === 'set' && (
        <>
          <div style={s.capline}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              aria-label={`${label}数值`}
              aria-invalid={fmt ? true : undefined}
              value={raw}
              onChange={(e) => store.patchBulk({ [rawKey]: e.target.value } as Partial<BulkDraft>)}
              style={sx(s.input, s.mono, s.capInput, fmt && s.inputInvalid)}
            />
            {typeof n === 'number' && canAbbr(n) && <span style={s.abbr} aria-hidden="true">= {abbr(n)}</span>}
          </div>
          <div role="group" aria-label={`${label}预设`} style={s.chips}>
            {CAP_PRESETS.map(([t, v]) => (
              <button
                key={t}
                type="button"
                aria-pressed={n === v}
                onClick={() => store.patchBulk({ [rawKey]: String(v) } as Partial<BulkDraft>)}
                style={sx(n === v ? s.chipOn : s.chip, s.chipSm)}
              >
                {t}
              </button>
            ))}
          </div>
          {err && <ErrText>{err}</ErrText>}
        </>
      )}
    </div>
  );
}

export function BulkLayer({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui } = snap;
  const b = ui.bulk;
  const p = b ? snap.draft.providers[b.route] : undefined;
  if (!b || !p || !p.models.length) return null;
  const pi = p.ns === NS_PI;
  const plan = bulkPlan(p, b);
  const sum = bulkSummary(b, plan);
  const lock = plan.copy;
  const busy = ui.readonly || ui.saving;
  const nsel = b.selSnapshot.length;

  return (
    <>
      <div style={s.scroll}>
        <Banners snap={snap} store={store} />
        <div style={s.row}><Btn kind="link" onClick={() => store.closeBulk()} data-mc="bulk-close">← 返回模型列表</Btn></div>
        <div>
          <h2 style={s.h1}>批量设置</h2>
          <p style={s.desc}>{BULK_NOTE}</p>
        </div>

        <Section title="范围">
          <RadioGroup
            label="范围"
            value={b.scope}
            options={[
              { v: 'all', t: `所有模型（${p.models.length}）` },
              { v: 'sel', t: `已勾选（${nsel}）`, disabled: !nsel },
            ]}
            onChange={(v) => store.patchBulk({ scope: v })}
          />
        </Section>

        <Section title="输入类型">
          <RadioGroup
            label="输入类型"
            value={lock ? 'none' : b.inMode}
            disabled={lock}
            options={[
              { v: 'none' as const, t: '不修改' },
              { v: 'set' as const, t: '设置为' },
              { v: 'clear' as const, t: '清除' },
            ]}
            onChange={(v) => store.patchBulk(v === 'none' ? { inMode: v, inArr: ['text'] } : { inMode: v })}
          />
          {lock && <Hint style={{ margin: 0 }}>{COPY_LOCK}</Hint>}
          {!lock && b.inMode === 'set' && (
            <InputChips
              value={b.inArr}
              label="批量输入类型"
              hint={hintFor(snap, 'bulk')}
              onToggle={(k) => store.toggleInput('bulk', k)}
            />
          )}
        </Section>

        {pi && (
          <Section title="思考">
            <RadioGroup
              label="思考"
              value={lock ? 'none' : b.th}
              disabled={lock}
              options={[{ v: 'none', t: '不修改' }, { v: 'set', t: '设置档位' }, { v: 'off', t: '不思考' }]}
              onChange={(v) => store.patchBulk(v === 'none' ? { th: v, thSel: [] } : { th: v })}
            />
            {lock && <Hint style={{ margin: 0 }}>{COPY_LOCK}</Hint>}
            {!lock && b.th === 'set' && (
              <div style={s.field}>
                <span style={s.label}>支持的档位</span>
                <EffortRail
                  railKey="bulk"
                  mode="multi"
                  selected={b.thSel}
                  showAdv={!!ui.showAdv.bulk}
                  onToggle={(l) => store.railToggle('bulk', l)}
                  onToggleAdv={() => store.toggleAdv('bulk')}
                  label="批量设置的思考档位"
                />
                {plan.errs.th && <ErrText>{plan.errs.th}</ErrText>}
              </div>
            )}
          </Section>
        )}

        <Section title="容量">
          {lock && <Hint style={{ margin: 0 }}>{COPY_LOCK}</Hint>}
          <div style={s.grid2}>
            <CapSide b={b} plan={plan} side="cw" label="上下文窗口" lock={lock} store={store} />
            <CapSide b={b} plan={plan} side="mt" label="最大输出" lock={lock} store={store} />
          </div>
        </Section>

        {pi && (
          <Section title="从模型复制">
            <RadioGroup
              label="从模型复制"
              value={b.copy}
              options={[{ v: 'none', t: '不修改' }, { v: 'copy', t: '从模型复制' }]}
              onChange={(v) => store.patchBulk(v === 'copy'
                ? { copy: v, src: null, inMode: 'none', inArr: ['text'], th: 'none', thSel: [], cw: 'none', cwRaw: '', mt: 'none', mtRaw: '' }
                : { copy: v, src: null })}
            />
            {lock && (
              <>
                <Hint style={{ margin: 0 }}>复制输入、思考和容量。源未设置的项会在目标上清除；不复制 ID 和名称。</Hint>
                <SourcePicker b={b} names={p.models.map((m) => m.id || '未命名模型')} store={store} />
                {plan.errs.src && (b.src == null
                  ? <Hint style={{ margin: 0 }}>{plan.errs.src}</Hint>
                  : <ErrText style={{ margin: 0 }}>{plan.errs.src}</ErrText>)}
                <Hint style={{ margin: 0 }}>复制会一起覆盖输入、思考和容量。取消复制后才能分别设置。</Hint>
              </>
            )}
          </Section>
        )}
      </div>

      <div style={s.bulkfoot}>
        <p aria-live="polite" style={sum.err ? s.bsumErr : s.bsum}>{sum.t}</p>
        <Btn onClick={() => store.closeBulk()}>取消</Btn>
        <Btn kind="primary-sm" disabled={!sum.ok || busy} onClick={() => store.applyBulk()}>应用到 {plan.C} 个模型</Btn>
      </div>
    </>
  );
}

function SourcePicker({ b, names, store }: { b: BulkDraft; names: string[]; store: ModelCapabilitiesStore }) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label="源模型" style={s.bsrc}>
      {names.map((n, i) => (
        <label key={i} style={sx(s.check, s.mono)}>
          <input
            type="radio"
            name={name}
            value={i}
            checked={b.src === i}
            onChange={() => store.patchBulk({ src: i })}
            style={s.checkInput}
          />
          {n}
        </label>
      ))}
    </div>
  );
}
