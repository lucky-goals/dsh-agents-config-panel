import React from 'react';
import type { InputModality } from '../types';
import { mcStyles as s, sx } from '../styles';

export interface InputChipsProps {
  value: InputModality[];
  disabled?: boolean;
  onToggle: (modality: InputModality) => void;
  hint?: string;
  label: string;
  /** Short status beside the chips (e.g. 未设置 while the key is absent). */
  note?: string;
}

const MODS: ReadonlyArray<readonly [InputModality, string]> = [['text', '文本'], ['image', '图片']];

export function InputChips({ value, disabled, onToggle, hint, label, note }: InputChipsProps): JSX.Element | null {
  const group = (
    <div role="group" aria-label={label} style={s.chips}>
      {MODS.map(([k, t]) => {
        const on = value.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(k)}
            style={sx(on ? s.chipOn : s.chip, disabled && s.disabled)}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
  return (
    <>
      {note ? <div style={s.rowWrap}>{group}<span style={s.small}>{note}</span></div> : group}
      {hint && <p role="status" style={s.errtext}>{hint}</p>}
    </>
  );
}
