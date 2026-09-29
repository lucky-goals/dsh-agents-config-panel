/**
 * Button drawn with --dsw-alias-* tokens from @deepseek-ai/dsh-client-ui-theme.
 */
import React from 'react';

export interface ButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  children: React.ReactNode;
  type?: 'button' | 'submit';
  /** Explains why the button is disabled (rendered as a native tooltip). */
  title?: string;
}

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  primary: {
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-foreground)',
    borderColor: 'var(--dsw-alias-button-primary-fill)',
  },
  secondary: {
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    borderColor: 'var(--dsw-alias-border-l2)',
  },
  danger: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
    borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)',
  },
};

export function Button({ onClick, disabled, variant = 'secondary', children, type = 'button', title }: ButtonProps) {
  const style: React.CSSProperties = {
    padding: '5px 12px',
    fontSize: '13px',
    lineHeight: '20px',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    // v2.8: dim after 150ms, undim at once, so a quick reload does not flash every button.
    transition: `opacity 120ms ease ${disabled ? '150ms' : '0ms'}`,
    whiteSpace: 'nowrap',
    ...VARIANTS[variant],
  };

  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} style={style}>
      {children}
    </button>
  );
}
