/**
 * Form field wrapper: associates the label and error text with its single
 * Input/Select child through generated ids.
 */
import React, { useId } from 'react';

export interface FormFieldProps {
  label: string;
  error?: string;
  /** Muted helper text under the control. */
  hint?: string;
  children: React.ReactElement;
}

export function FormField({ label, error, hint, children }: FormFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    marginBottom: '6px',
    color: 'var(--dsw-alias-label-primary)',
  };
  const subStyle: React.CSSProperties = {
    marginTop: '4px',
    fontSize: '12px',
    lineHeight: '18px',
  };

  return (
    <div style={{ marginBottom: '14px' }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {React.cloneElement(children, { id, 'aria-describedby': describedBy })}
      {error ? (
        <div id={`${id}-error`} style={{ ...subStyle, color: 'var(--dsw-alias-state-error-primary)' }}>
          {error}
        </div>
      ) : hint ? (
        <div id={`${id}-hint`} style={{ ...subStyle, color: 'var(--dsw-alias-label-secondary)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
