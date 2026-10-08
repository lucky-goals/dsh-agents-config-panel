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
  /**
   * Host-provided settings close (settings.section props). Kept for type
   * compatibility only: no 关闭 button is rendered.
   */
  close?: () => void;
  /** v2.2: download the panel's config as YAML; the button is hidden when absent. */
  onExport?: () => void;
  /** v2.2: a chosen .yaml/.yml file; the button is hidden when absent. */
  onImport?: (file: File) => void;
  /** v2.2: disables import (writes unavailable). */
  importDisabled?: boolean;
  importTitle?: string;
}

export function PanelHeader({ title, loading, onRefresh, children, onExport, onImport, importDisabled, importTitle }: PanelHeaderProps) {
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

/**
 * v2.9: root of each settings panel. It fills the host content area and
 * scrolls itself with the scrollbar space always reserved (the DSH theme
 * scrollbar is a classic 5px one). Before, the host area scrolled with
 * `overflow-y: auto` and no gutter, so whenever a team's rows crossed the
 * fold its scrollbar appeared and squeezed the whole panel 5px to the left.
 * Same pattern as DSH's own chat / conversation scrollers.
 */
export const panelRootStyle: React.CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  overflowY: 'auto',
  scrollbarGutter: 'stable',
  padding: '16px',
  color: 'var(--dsw-alias-label-primary)',
};

/** Takes no space: screen readers hear it, the layout never moves. */
const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * v2.8: always-mounted live region for "加载中...". Loading used to insert a
 * visible line above the table, pushing it down ~29px and back on every team
 * switch (and toggling the scrollbar). Visible loading text now lives only in
 * the table's empty row, which is there anyway.
 */
export function LoadingAnnouncer({ loading }: { loading: boolean }) {
  return <div role="status" aria-live="polite" style={visuallyHidden}>{loading ? '加载中...' : ''}</div>;
}

/** A table whose rows are being replaced: announced busy, dimmed only if it takes a while. */
export function busyTableStyle(busy: boolean): React.CSSProperties {
  return {
    ...tableStyles.table,
    opacity: busy ? 0.6 : 1,
    // Dim after 150ms, brighten at once: a fast switch shows no flash at all.
    transition: `opacity 120ms ease ${busy ? '150ms' : '0ms'}`,
  };
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

/**
 * Label/value list under a table row: the agent route of a team member
 * (Panel B) and of a spawn subagent tool (Panel A). 12px comes from the cell.
 */
export const agentDetailStyles = {
  dl: { display: 'flex', flexWrap: 'wrap', gap: '2px 16px', margin: 0 } as React.CSSProperties,
  pair: { display: 'flex', gap: '4px', whiteSpace: 'nowrap' } as React.CSSProperties,
  dt: { color: 'var(--dsw-alias-label-secondary)' } as React.CSSProperties,
  dd: { margin: 0, color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
};

/** Wrapping variant: a long value (e.g. a model id) breaks inside its <dd>. */
const wrapPair: React.CSSProperties = { ...agentDetailStyles.pair, whiteSpace: 'normal', minWidth: 0 };
const wrapDt: React.CSSProperties = { ...agentDetailStyles.dt, whiteSpace: 'nowrap' };
const wrapDd: React.CSSProperties = { ...agentDetailStyles.dd, minWidth: 0, overflowWrap: 'anywhere' };

export interface AgentDetailListProps {
  /** [label, value] in display order; an empty value shows '-'. */
  items: ReadonlyArray<readonly [label: string, value: unknown]>;
  /** Let values wrap inside their <dd> instead of keeping each pair on one line. */
  wrapValues?: boolean;
}

export function AgentDetailList({ items, wrapValues = false }: AgentDetailListProps) {
  const pair = wrapValues ? wrapPair : agentDetailStyles.pair;
  const dt = wrapValues ? wrapDt : agentDetailStyles.dt;
  const dd = wrapValues ? wrapDd : agentDetailStyles.dd;
  return (
    <dl style={agentDetailStyles.dl}>
      {items.map(([label, value]) => (
        <div key={label} style={pair}>
          <dt style={dt}>{label}</dt>
          <dd style={dd}>{String(value || '-')}</dd>
        </div>
      ))}
    </dl>
  );
}

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
