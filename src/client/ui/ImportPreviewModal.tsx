/**
 * Import preview (v2.2 / v2.3): what a file will add and what it will skip,
 * before anything is written. Used by both panels.
 */
import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Alert } from './Alert';
import { formActionsStyle } from './PanelChrome';

export interface ImportPreviewEntry {
  label: string;
  details?: string;
  /** Present: this entry is skipped for this reason. */
  skip?: string;
}

export interface ImportPreviewSection {
  title: string;
  entries: ImportPreviewEntry[];
}

export interface ImportPreviewModalProps {
  isOpen: boolean;
  title?: string;
  /** Shown above the lists, e.g. the source file and profile. */
  summary?: string;
  /** Shown as a warning (secrets, machine-specific paths). */
  warning?: string;
  sections: ImportPreviewSection[];
  busy: boolean;
  /** Write unavailable (atomic-write missing): confirm stays disabled. */
  blocked?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

const listStyle: React.CSSProperties = {
  maxHeight: '240px',
  overflowY: 'auto',
  margin: '6px 0 12px',
  padding: 0,
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '6px',
  fontSize: '13px',
};

const itemStyle = (skipped: boolean): React.CSSProperties => ({
  padding: '6px 10px',
  borderLeft: `3px solid ${skipped ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'}`,
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
});

const secondary: React.CSSProperties = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };

export function ImportPreviewModal({
  isOpen,
  title = '导入预览',
  summary,
  warning,
  sections,
  busy,
  blocked,
  error,
  onClose,
  onConfirm,
}: ImportPreviewModalProps) {
  const importable = sections.reduce((n, s) => n + s.entries.filter((e) => !e.skip).length, 0);
  const skipped = sections.reduce((n, s) => n + s.entries.filter((e) => e.skip).length, 0);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      {error && <Alert type="error">{error}</Alert>}
      {summary && <div style={{ ...secondary, marginBottom: '8px' }}>{summary}</div>}
      {warning && <Alert type="warning">{warning}</Alert>}
      <div style={{ fontSize: '13px', marginBottom: '8px' }}>
        将导入 {importable} 项，跳过 {skipped} 项。已存在的配置不会被覆盖。
      </div>

      {sections.map((section) => (
        <div key={section.title}>
          <div style={{ fontSize: '13px', fontWeight: 500 }}>
            {section.title}（{section.entries.length}）
          </div>
          {section.entries.length === 0 ? (
            <div style={{ ...secondary, margin: '4px 0 12px' }}>无</div>
          ) : (
            <ul style={listStyle}>
              {section.entries.map((entry, index) => (
                <li key={`${entry.label}-${index}`} style={itemStyle(!!entry.skip)}>
                  <div>
                    {entry.label}
                    <span style={{ ...secondary, marginLeft: '8px' }}>{entry.skip ? '跳过' : '导入'}</span>
                  </div>
                  {entry.details && <div style={secondary}>{entry.details}</div>}
                  {entry.skip && <div style={secondary}>原因：{entry.skip}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <div style={formActionsStyle}>
        <Button onClick={onClose} disabled={busy}>取消</Button>
        <Button onClick={onConfirm} disabled={busy || blocked || importable === 0} variant="primary">
          {busy ? '导入中...' : `确认导入（${importable}）`}
        </Button>
      </div>
    </Modal>
  );
}
