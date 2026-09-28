/**
 * Multi-line text input drawn with --dsw-alias-* tokens (v2.2).
 *
 * Opens `rows` lines tall; the user can drag it taller up to `maxRows`
 * lines (vertical resize only), after which the content scrolls.
 */
import React from 'react';
import { fieldStyle } from './field-style';

export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  id?: string;
  /** Initial and minimum height in lines (default 3). */
  rows?: number;
  /** Maximum drag height in lines (default 6). */
  maxRows?: number;
  'aria-describedby'?: string;
}

// fieldStyle: lineHeight 20px, padding 6px top/bottom, 1px border, border-box.
const LINE_HEIGHT = 20;
const FRAME = 6 * 2 + 1 * 2;

/** Border-box height of `lines` text lines. */
export function textareaHeight(lines: number): number {
  return lines * LINE_HEIGHT + FRAME;
}

export function Textarea({ value, onChange, placeholder, disabled, error, id, rows = 3, maxRows = 6, ...aria }: TextareaProps) {
  const style: React.CSSProperties = {
    ...fieldStyle(error),
    display: 'block',
    fontFamily: 'inherit',
    lineHeight: `${LINE_HEIGHT}px`,
    height: `${textareaHeight(rows)}px`,
    minHeight: `${textareaHeight(rows)}px`,
    maxHeight: `${textareaHeight(Math.max(rows, maxRows))}px`,
    resize: 'vertical',
    overflowY: 'auto',
  };

  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      aria-invalid={error || undefined}
      aria-describedby={aria['aria-describedby']}
      style={style}
    />
  );
}
