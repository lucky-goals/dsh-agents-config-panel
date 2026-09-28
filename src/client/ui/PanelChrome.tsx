/**
 * Shared panel chrome: header with refresh, the "takes effect in new session"
 * note, Host diagnostics banners and request status alerts.
 */
import React from 'react';
import type { StateDiagnostics } from '../shared/api-types';
import { Alert } from './Alert';
import { Button } from './Button';
import { CATALOG_FROM_PATCH_MESSAGE, WRITE_UNAVAILABLE_MESSAGE, isWriteBlocked } from './host-state';

export interface PanelHeaderProps {
  title: string;
  loading: boolean;
  onRefresh: () => void;
  /** Extra controls rendered next to the refresh button (e.g. a profile picker). */
  children?: React.ReactNode;
  /** Host-provided settings close (settings.section props); the button is hidden when absent. */
  close?: () => void;
  /** v2.2: download the panel's config as YAML; the button is hidden when absent. */
  onExport?: () => void;
  /** v2.2: a chosen .yaml/.yml file; the button is hidden when absent. */
  onImport?: (file: File) => void;
  /** v2.2: disables import (writes unavailable). */
  importDisabled?: boolean;
  importTitle?: string;
}

export function PanelHeader({ title, loading, onRefresh, children, close, onExport, onImport, importDisabled, importTitle }: PanelHeaderProps) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 500 }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {children}
          {onExport && <Button onClick={onExport} disabled={loading}>导出</Button>}
          {onImport && (
            <ImportFileButton onFile={onImport} disabled={loading || importDisabled} title={importTitle} />
          )}
          <Button onClick={onRefresh} disabled={loading}>刷新</Button>
          {close && <Button onClick={close}>关闭</Button>}
        </div>
      </div>
      <p style={{ margin: '6px 0 14px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
        保存后新建会话生效
      </p>
    </>
  );
}

export interface ImportFileButtonProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  title?: string;
  label?: string;
}

/**
 * "导入" button backed by a hidden file input (.yaml/.yml). A component of its
 * own so PanelHeader stays hook-free; the input is reset after each pick so
 * choosing the same file again still fires.
 */
export function ImportFileButton({ onFile, disabled, title, label = '导入' }: ImportFileButtonProps) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <Button onClick={() => input.current?.click()} disabled={disabled} title={title}>{label}</Button>
      <input
        ref={input}
        type="file"
        accept=".yaml,.yml,application/yaml,text/yaml"
        aria-label={`${label}配置文件`}
        tabIndex={-1}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/** Renders nothing when diagnostics are absent or healthy. */
export function DiagnosticsBanner({ diagnostics }: { diagnostics: StateDiagnostics | null }) {
  if (!diagnostics) return null;
  const blocked = isWriteBlocked(diagnostics);
  const tried = diagnostics.atomicWrite.tried ?? [];
  const catalogErrors = diagnostics.catalogErrors ?? [];

  return (
    <>
      {blocked && (
        <Alert type="warning">
          <div>{WRITE_UNAVAILABLE_MESSAGE}</div>
          {tried.length > 0 && (
            <details style={{ marginTop: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              <summary style={{ cursor: 'pointer' }}>已尝试的解析位置</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
                {tried.map((anchor) => <li key={anchor}>{anchor}</li>)}
              </ul>
            </details>
          )}
        </Alert>
      )}
      {diagnostics.catalogSource === 'patch' && (
        <Alert type="info">
          <div>{CATALOG_FROM_PATCH_MESSAGE}</div>
          {catalogErrors.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              {catalogErrors.map((message) => <li key={message}>{message}</li>)}
            </ul>
          )}
        </Alert>
      )}
    </>
  );
}

export interface StatusAlertsProps {
  error: string | null;
  conflict: string | null;
  notice: string | null;
  onDismiss: () => void;
}

/**
 * Error / stale-revision / saved alerts. Error text is shown as returned by
 * the Host (e.g. 503 DEPENDENCY_UNAVAILABLE, 413 PAYLOAD_TOO_LARGE messages).
 */
export function StatusAlerts({ error, conflict, notice, onDismiss }: StatusAlertsProps) {
  return (
    <>
      {error && <Alert type="error" onClose={onDismiss}>{error}</Alert>}
      {conflict && <Alert type="warning" onClose={onDismiss}>{conflict}</Alert>}
      {notice && <Alert type="success" onClose={onDismiss}>{notice}</Alert>}
    </>
  );
}

/** Table cell styles shared by both panels. */
export const tableStyles = {
  table: { width: '100%', borderCollapse: 'collapse', marginTop: '12px' } as React.CSSProperties,
  th: {
    textAlign: 'left',
    padding: '8px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  } as React.CSSProperties,
  td: {
    padding: '8px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    fontSize: '13px',
    verticalAlign: 'middle',
    overflowWrap: 'anywhere',
  } as React.CSSProperties,
};

export const formActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '16px',
};

/** Tooltip for write buttons disabled by missing atomic-write. */
export function writeDisabledTitle(blocked: boolean): string | undefined {
  return blocked ? WRITE_UNAVAILABLE_MESSAGE : undefined;
}
