/**
 * Alert / notification banner.
 * Colors use only --dsw-alias-* tokens declared by @deepseek-ai/dsh-client-ui-theme,
 * tinted with color-mix the same way the built-in settings sections do.
 */
import React from 'react';

export interface AlertProps {
  type: 'error' | 'success' | 'warning' | 'info';
  children: React.ReactNode;
  onClose?: () => void;
}

const TONE: Record<AlertProps['type'], string> = {
  error: 'var(--dsw-alias-state-error-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warning: 'var(--dsw-alias-state-warn-primary)',
  info: 'var(--dsw-alias-label-secondary)',
};

export function Alert({ type, children, onClose }: AlertProps) {
  const tone = TONE[type];
  const style: React.CSSProperties = {
    padding: '10px 14px',
    borderRadius: '6px',
    fontSize: '13px',
    lineHeight: '20px',
    marginBottom: '12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '12px',
    color: 'var(--dsw-alias-label-primary)',
    background: type === 'info'
      ? 'var(--dsw-alias-bg-layer-2)'
      : `color-mix(in srgb, ${tone} 10%, var(--dsw-alias-bg-layer-1))`,
    border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
    overflowWrap: 'anywhere',
  };

  const closeButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: '20px',
    padding: 0,
    color: 'var(--dsw-alias-label-secondary)',
  };

  // Errors and warnings interrupt; success/info are polite status updates.
  const role = type === 'error' || type === 'warning' ? 'alert' : 'status';

  return (
    <div role={role} data-alert={type} style={style}>
      <div>{children}</div>
      {onClose && (
        <button type="button" aria-label="关闭提示" style={closeButtonStyle} onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}
