/**
 * Panel B: agent-teams members of the selected team profile
 * (React, reads the framework-free store).
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import type { MembersPanelStore } from './members-panel-store';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Select } from '../ui/Select';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { ImportPreviewModal } from '../ui/ImportPreviewModal';
import {
  DiagnosticsBanner,
  PanelHeader,
  StatusAlerts,
  formActionsStyle,
  tableStyles,
  writeDisabledTitle,
} from '../ui/PanelChrome';
import { isWriteBlocked } from '../ui/host-state';

export interface MembersPanelProps {
  store: MembersPanelStore;
  /** Closes the host settings dialog; passed by settings.section as `{ close }`. */
  close?: () => void;
}

/** Second-row fields, in contract §7 order. */
const MEMBER_DETAILS = [
  ['Provider', 'provider'],
  ['Model', 'model'],
  ['Reasoning Effort', 'reasoning_effort'],
] as const;

/**
 * Panel-local table styles (contract §7). The shared tableStyles.td sets
 * `overflowWrap: 'anywhere'`, which shredded member names; these cells
 * override it without touching PanelChrome.
 */
const cellBase: React.CSSProperties = {
  padding: '8px 8px 2px',
  fontSize: '13px',
  textAlign: 'left',
  verticalAlign: 'top',
  border: 'none',
};

const memberTable = {
  nameHead: { ...tableStyles.th, minWidth: '9.5em' } as React.CSSProperties,
  /** Separator between members; the two rows of one member share no line. */
  group: { borderBottom: '1px solid var(--dsw-alias-border-l1)' } as React.CSSProperties,
  name: {
    ...cellBase,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    minWidth: '9.5em',
    overflowWrap: 'normal',
    color: 'var(--dsw-alias-label-primary)',
  } as React.CSSProperties,
  role: {
    ...cellBase,
    minWidth: '12em',
    // v2.2: roles may be multi-line; keep the author's line breaks.
    whiteSpace: 'pre-line',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
  actions: { ...cellBase, padding: '8px', whiteSpace: 'nowrap' } as React.CSSProperties,
  details: { ...cellBase, padding: '2px 8px 8px', fontSize: '12px' } as React.CSSProperties,
  dl: { display: 'flex', flexWrap: 'wrap', gap: '2px 16px', margin: 0 } as React.CSSProperties,
  pair: { display: 'flex', gap: '4px', whiteSpace: 'nowrap' } as React.CSSProperties,
  dt: { color: 'var(--dsw-alias-label-secondary)' } as React.CSSProperties,
  dd: { margin: 0, color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
};

export function MembersPanel({ store, close }: MembersPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    // No argument: the store starts at standard-acp and falls back to the
    // first team profile the Host reports.
    void store.load();
  }, [store]);

  const blocked = isWriteBlocked(state.diagnostics);
  const busy = state.loading;
  const writeTitle = writeDisabledTitle(blocked);
  const { values, errors, mode } = state.form;
  const modalOpen = mode !== null || state.confirmDelete.name !== null || state.importPreview !== null;
  const hasProfiles = state.teamProfiles.length > 0;

  // provider → model → reasoning_effort cascade from the Host catalog.
  const providerOptions = state.catalog.providers.map((p) => ({ value: p.id, label: p.id }));
  const selectedProvider = state.catalog.providers.find((p) => p.id === values.provider);
  const modelOptions = selectedProvider?.models.map((m) => ({ value: m.id, label: m.id })) ?? [];
  const selectedModel = selectedProvider?.models.find((m) => m.id === values.model);
  const effortOptions = selectedModel?.reasoningEfforts.map((e) => ({ value: e, label: e })) ?? [];

  const profilePicker = state.teamProfiles.length > 1 ? (
    <Select
      aria-label="团队 profile"
      value={state.profile}
      onChange={(v) => void store.setProfile(v)}
      options={state.teamProfiles.map((p) => ({ value: p, label: p }))}
      disabled={busy}
      style={{ width: 'auto', minWidth: '140px' }}
    />
  ) : hasProfiles ? (
    <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
      团队 profile：{state.profile}
    </span>
  ) : null;

  return (
    <div style={{ padding: '16px', color: 'var(--dsw-alias-label-primary)' }}>
      <PanelHeader
        title="团队成员管理"
        loading={busy}
        onRefresh={() => void store.load()}
        onExport={hasProfiles ? () => store.exportConfig() : undefined}
        onImport={hasProfiles ? (file) => void store.importConfig(file) : undefined}
        importDisabled={blocked}
        importTitle={writeTitle}
        close={close}
      >
        {profilePicker}
      </PanelHeader>
      <DiagnosticsBanner diagnostics={state.diagnostics} />
      {!modalOpen && (
        <StatusAlerts
          error={state.error}
          conflict={state.conflict}
          notice={state.notice}
          onDismiss={() => store.cancel()}
        />
      )}

      <Button onClick={() => store.openCreate()} disabled={busy || blocked || !hasProfiles} title={writeTitle}>
        新建成员
      </Button>

      {busy && (
        <div role="status" style={{ marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
          加载中...
        </div>
      )}

      {/* v2.1 §7: fixed two-row layout, one <tbody> per member. */}
      <table style={tableStyles.table}>
        <thead>
          <tr>
            <th scope="col" style={memberTable.nameHead}>成员名</th>
            <th scope="col" style={tableStyles.th}>角色</th>
            <th scope="col" style={tableStyles.th}>操作</th>
          </tr>
        </thead>
        {state.members.map((member) => (
          <tbody key={member.name} style={memberTable.group}>
            <tr>
              <th scope="row" style={memberTable.name}>{member.name}</th>
              <td style={memberTable.role}>{member.role || '-'}</td>
              <td rowSpan={2} style={memberTable.actions}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button onClick={() => store.openEdit(member.name)} disabled={busy || blocked} title={writeTitle}>
                    编辑
                  </Button>
                  <Button
                    onClick={() => store.requestDelete(member.name)}
                    disabled={busy || blocked}
                    title={writeTitle}
                    variant="danger"
                  >
                    删除
                  </Button>
                </div>
              </td>
            </tr>
            <tr>
              <td colSpan={3} style={memberTable.details}>
                <dl style={memberTable.dl}>
                  {MEMBER_DETAILS.map(([label, key]) => (
                    <div key={key} style={memberTable.pair}>
                      <dt style={memberTable.dt}>{label}</dt>
                      <dd style={memberTable.dd}>{String(member[key] || '-')}</dd>
                    </div>
                  ))}
                </dl>
              </td>
            </tr>
          </tbody>
        ))}
        {state.members.length === 0 && !busy && (
          <tbody>
            <tr>
              <td style={{ ...tableStyles.td, color: 'var(--dsw-alias-label-secondary)' }} colSpan={3}>
                暂无成员
              </td>
            </tr>
          </tbody>
        )}
      </table>

      <Modal isOpen={mode !== null} onClose={() => store.cancel()} title={mode === 'add' ? '新建成员' : '编辑成员'}>
        {state.error && <Alert type="error">{state.error}</Alert>}
        {state.conflict && <Alert type="warning">{state.conflict}</Alert>}

        <FormField label="成员名 (name)" error={errors.name} hint="小写字母开头，只能用小写字母、数字和连字符">
          <Input
            value={values.name}
            onChange={(v) => store.setField('name', v)}
            placeholder="member-name"
            error={!!errors.name}
            disabled={busy || mode === 'edit'}
          />
        </FormField>

        <FormField label="角色 (role)" error={errors.role} hint="可选，支持多行；可拖动右下角调整高度">
          <Textarea
            value={values.role}
            onChange={(v) => store.setField('role', v)}
            placeholder="可选"
            error={!!errors.role}
            disabled={busy}
            rows={3}
            maxRows={6}
          />
        </FormField>

        <FormField label="Provider (可选)" error={errors.provider}>
          <Select
            value={values.provider}
            onChange={(v) => {
              store.setField('provider', v);
              store.setField('model', '');
              store.setField('reasoning_effort', '');
            }}
            options={[{ value: '', label: '-- 不指定 --' }, ...providerOptions]}
            error={!!errors.provider}
            disabled={busy}
          />
        </FormField>

        <FormField label="Model (可选)" error={errors.model}>
          <Select
            value={values.model}
            onChange={(v) => {
              store.setField('model', v);
              store.setField('reasoning_effort', '');
            }}
            options={[{ value: '', label: '-- 不指定 --' }, ...modelOptions]}
            error={!!errors.model}
            disabled={!values.provider || busy}
          />
        </FormField>

        <FormField label="Reasoning Effort (可选)">
          <Select
            value={values.reasoning_effort}
            onChange={(v) => store.setField('reasoning_effort', v)}
            options={[{ value: '', label: '-- 不指定 --' }, ...effortOptions]}
            disabled={!values.model || busy}
          />
        </FormField>

        <div style={formActionsStyle}>
          <Button onClick={() => store.cancel()} disabled={busy}>取消</Button>
          <Button onClick={() => void store.submit()} disabled={busy || blocked} title={writeTitle} variant="primary">
            {busy ? '保存中...' : '保存'}
          </Button>
        </div>
      </Modal>

      <Modal isOpen={state.confirmDelete.name !== null} onClose={() => store.cancel()} title="确认删除">
        {state.error && <Alert type="error">{state.error}</Alert>}
        <div style={{ marginBottom: '16px', fontSize: '13px' }}>
          确定要从团队 profile “{state.profile}” 删除成员 “{state.confirmDelete.name}” 吗？
        </div>
        <div style={formActionsStyle}>
          <Button onClick={() => store.cancel()} disabled={busy}>取消</Button>
          <Button onClick={() => void store.confirmDelete()} disabled={busy || blocked} title={writeTitle} variant="danger">
            {busy ? '删除中...' : '确认删除'}
          </Button>
        </div>
      </Modal>

      {state.importPreview && (
        <ImportPreviewModal
          isOpen
          summary={`文件：${state.importPreview.fileName}，导入到团队 profile：${state.profile}`}
          sections={[{
            title: '成员',
            entries: state.importPreview.members.map(({ item, skip }) => ({
              label: item.name || '(无成员名)',
              details: [
                item.role && `角色：${String(item.role).split('\n')[0]}`,
                item.provider && `${item.provider}/${item.model ?? '-'}`,
                item.reasoning_effort && `Reasoning Effort: ${item.reasoning_effort}`,
              ].filter(Boolean).join('，'),
              skip,
            })),
          }]}
          busy={busy}
          blocked={blocked}
          error={state.error}
          onClose={() => store.cancelImport()}
          onConfirm={() => void store.confirmImport()}
        />
      )}
    </div>
  );
}
