/**
 * Text input drawn with --dsw-alias-* tokens.
 */
import React from 'react';
import { fieldStyle } from './field-style';

export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

export function Input({ value, onChange, placeholder, disabled, error, id, ...aria }: InputProps) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={error || undefined}
      aria-describedby={aria['aria-describedby']}
      style={fieldStyle(error)}
    />
  );
}
