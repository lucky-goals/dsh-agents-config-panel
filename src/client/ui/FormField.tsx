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
  /** Rendered after the label on the same row, outside <label> (v2.10: a HelpTip). */
  labelAddon?: React.ReactNode;
  children: React.ReactElement;
}

const labelRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' };

export function FormField({ label, error, hint, labelAddon, children }: FormFieldProps) {
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
      {labelAddon ? (
        <div style={labelRowStyle}>
          <label htmlFor={id} style={{ ...labelStyle, marginBottom: 0 }}>{label}</label>
          {labelAddon}
        </div>
      ) : (
        <label htmlFor={id} style={labelStyle}>{label}</label>
      )}
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
