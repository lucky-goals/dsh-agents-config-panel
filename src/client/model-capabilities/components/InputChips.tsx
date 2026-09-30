/**
 * 输入类型 chips (prototype chipsHTML). Explicit chips are toggle buttons with
 * aria-pressed; inherited chips read 「继承 · …」, carry aria-disabled and a
 * dashed outline, and still report the click so the store can show its hint.
 */
import React from 'react';
import type { InputModality } from '../types';
import { mcStyles as s, sx } from '../styles';

export interface InputChipsProps {
  value: InputModality[];
  inherited: boolean;
  disabled?: boolean;
  onToggle: (modality: InputModality) => void;
  hint?: string;
  label: string;
}

const MODS: ReadonlyArray<readonly [InputModality, string]> = [['text', '文本'], ['image', '图片']];

export function InputChips({ value, inherited, disabled, onToggle, hint, label }: InputChipsProps): JSX.Element | null {
  return (
    <>
      <div role="group" aria-label={label} style={s.chips}>
        {MODS.map(([k, t]) => {
          const on = value.includes(k);
          if (inherited) {
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                aria-disabled="true"
                disabled={disabled}
                onClick={() => onToggle(k)}
                style={sx(s.chipInherit, !on && { opacity: 0.5 }, disabled && s.disabled)}
              >
                继承 · {t}
              </button>
            );
          }
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
      {hint && <p role="status" style={s.errtext}>{hint}</p>}
    </>
  );
}
