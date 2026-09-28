/**
 * Native select drawn with --dsw-alias-* tokens.
 */
import React from 'react';
import { fieldStyle } from './field-style';

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  error?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  /** Style override, e.g. auto width for inline toolbars. */
  style?: React.CSSProperties;
}

export function Select({ value, onChange, options, disabled, error, id, style, ...aria }: SelectProps) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={error || undefined}
      aria-label={aria['aria-label']}
      aria-describedby={aria['aria-describedby']}
      style={{ ...fieldStyle(error), ...style }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
