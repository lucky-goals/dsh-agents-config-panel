/**
 * Shared style for text inputs and selects (tokens from @deepseek-ai/dsh-client-ui-theme).
 */
import type React from 'react';

export function fieldStyle(error?: boolean): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    fontSize: '13px',
    lineHeight: '20px',
    borderRadius: '6px',
    border: error
      ? '1px solid var(--dsw-alias-state-error-primary)'
      : '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
  };
}
