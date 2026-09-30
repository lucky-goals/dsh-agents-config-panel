/**
 * One capacity side (上下文窗口 or 最大输出), prototype capControl() plus the
 * hint copy of modelCapSection()/routeCapFields().
 *
 * Inherited: disabled input showing the fallback, 「继承中」 and 「单独设置」.
 * Explicit: editable raw text, 「= 缩写」, four presets (aria-pressed) and
 * 「恢复继承」. Blur hands normalisation to store.blurCap.
 */
import React, { useId } from 'react';
import { CAP_PRESETS, DS_RUNTIME_CW, DS_RUNTIME_MT, RUNTIME_CW, RUNTIME_MT } from '../types';
import type { CapSide, CapSideKey, CapScope, ModelCapabilitiesStore } from '../types';
import { abbr, canAbbr } from '../capacity';
import { mcStyles as s, sx } from '../styles';
import { Btn, ErrText, Hint, Tag } from './shared';

export interface CapacityFieldProps {
  scope: CapScope;
  side: CapSideKey;
  cap: CapSide;
  pi: boolean;
  disabled?: boolean;
  store: ModelCapabilitiesStore;
  error?: string;
  warn?: string;
}

const EXPLICIT_NOTE = '这是模型显式值。保存后目录和提供方默认都不会覆盖它。';
const srcName = (src: CapSide['src']) => (src === 'route' ? '提供方默认' : '运行默认');

function labelOf(scope: CapScope, side: CapSideKey): string {
  if (scope === 'm') return side === 'cw' ? '上下文窗口' : '最大输出';
  return side === 'cw' ? '上下文窗口默认' : '最大输出默认';
}

function hintsOf(scope: CapScope, side: CapSideKey, cap: CapSide, pi: boolean): string[] {
  if (scope === 'm') {
    if (side === 'cw') return cap.explicit ? [EXPLICIT_NOTE] : [`当前回退：${srcName(cap.src)} ${cap.fallback}。`];
    if (cap.explicit) return pi ? ['显式写入后，这个值会成为该模型每次请求的默认输出上限。', EXPLICIT_NOTE] : [EXPLICIT_NOTE];
    return [`${pi ? '继承时只作为能力上限，不会成为请求的默认输出上限。' : '留空则使用提供方的 maxTokens。'}当前回退：${srcName(cap.src)} ${cap.fallback}。`];
  }
  const rt = pi ? { cw: RUNTIME_CW, mt: RUNTIME_MT } : { cw: DS_RUNTIME_CW, mt: DS_RUNTIME_MT };
  if (side === 'cw') return [`模型没单独写上下文窗口时回退到这里。运行默认 ${rt.cw}。`];
  const out = [pi
    ? `模型没单独写最大输出时，这里只是能力上限，不会变成请求默认。运行默认 ${rt.mt}。`
    : `模型没单独写最大输出时，用这个值。运行默认 ${rt.mt}。`];
  if (!pi) out.push('配置字段名是 maxTokens，不是 defaultMaxTokens。');
  return out;
}

export function CapacityField({ scope, side, cap, pi, disabled, store, error, warn }: CapacityFieldProps): JSX.Element | null {
  const id = useId();
  const label = labelOf(scope, side);
  const exp = cap.explicit;
  const n = typeof cap.parsed === 'number' ? cap.parsed : null;
  const hints = [...hintsOf(scope, side, cap, pi), warn ?? ''].filter(Boolean);

  return (
    <div style={s.field}>
      <label htmlFor={id} style={s.label}>{label}</label>
      <div style={s.capline}>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={exp ? cap.raw : String(cap.fallback)}
          disabled={!exp || disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => store.setCap(scope, side, e.target.value)}
          onBlur={() => { if (exp) store.blurCap(scope, side); }}
          style={sx(s.input, s.mono, s.capInput, error && s.inputInvalid, (!exp || disabled) && s.inputDisabled)}
        />
        {exp ? (
          <>
            {n != null && canAbbr(n) && <span style={s.abbr} aria-hidden="true">= {abbr(n)}</span>}
            <Btn kind="link" disabled={disabled} onClick={() => store.capInherit(scope, side)}>恢复继承</Btn>
          </>
        ) : (
          <>
            <Tag>继承中</Tag>
            <Btn kind="link" disabled={disabled} onClick={() => store.capExplicit(scope, side)}>单独设置</Btn>
          </>
        )}
      </div>
      {exp && (
        <div role="group" aria-label={`${label}预设`} style={sx(s.chips, { marginTop: '2px' })}>
          {CAP_PRESETS.map(([t, v]) => (
            <button
              key={t}
              type="button"
              aria-pressed={n === v}
              disabled={disabled}
              onClick={() => store.setCap(scope, side, String(v))}
              style={sx(n === v ? s.chipOn : s.chip, s.chipSm, disabled && s.disabled)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {error && <ErrText id={`${id}-e`}>{error}</ErrText>}
      {hints.map((t) => <Hint key={t}>{t}</Hint>)}
    </div>
  );
}
