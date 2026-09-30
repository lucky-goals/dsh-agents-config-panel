import React, { useId } from 'react';
import { CAP_PRESETS } from '../types';
import type { CapSide, CapSideKey, ModelCapabilitiesStore } from '../types';
import { abbr, canAbbr } from '../capacity';
import { mcStyles as s, sx } from '../styles';
import { Btn, ErrText, Hint } from './shared';

export interface CapacityFieldProps {
  side: CapSideKey;
  cap: CapSide;
  pi: boolean;
  disabled?: boolean;
  store: ModelCapabilitiesStore;
  error?: string;
}

function labelOf(side: CapSideKey): string {
  return side === 'cw' ? '上下文窗口' : '最大输出';
}

export function CapacityField({ side, cap, pi, disabled, store, error }: CapacityFieldProps): JSX.Element | null {
  const id = useId();
  const label = labelOf(side);
  const n = typeof cap.parsed === 'number' ? cap.parsed : null;
  const value = cap.explicit ? cap.raw : '';
  return (
    <div style={s.field}>
      <label htmlFor={id} style={s.label}>{label}</label>
      <div style={s.capline}>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          placeholder="未设置"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => store.setCap(side, e.target.value)}
          onBlur={() => store.blurCap(side)}
          style={sx(s.input, s.mono, s.capInput, error && s.inputInvalid, disabled && s.inputDisabled)}
        />
        {n != null && canAbbr(n) && <span style={s.abbr} aria-hidden="true">= {abbr(n)}</span>}
        <Btn kind="link" disabled={disabled || !cap.explicit} onClick={() => store.capClear(side)}>清除</Btn>
      </div>
      <div role="group" aria-label={`${label}预设`} style={sx(s.chips, { marginTop: '2px' })}>
        {CAP_PRESETS.map(([t, v]) => (
          <button
            key={t}
            type="button"
            aria-pressed={n === v}
            disabled={disabled}
            onClick={() => store.setCap(side, String(v))}
            style={sx(n === v ? s.chipOn : s.chip, s.chipSm, disabled && s.disabled)}
          >
            {t}
          </button>
        ))}
      </div>
      {cap.explicit ? (
        <>
          <Hint>已设置。留空或点「清除」会删掉这个字段。</Hint>
          {pi && side === 'mt' && <Hint style={{ margin: 0 }}>显式写入后，这个值会成为该模型每次请求的默认输出上限。</Hint>}
        </>
      ) : (
        <Hint>未设置</Hint>
      )}
      {error && <ErrText id={`${id}-e`}>{error}</ErrText>}
    </div>
  );
}
