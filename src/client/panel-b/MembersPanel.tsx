/**
 * Panel B: agent-teams members of the selected team profile
 * (React, reads the framework-free store).
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import type { MembersPanelStore } from './members-panel-store';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
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
  const modalOpen = mode !== null || state.confirmDelete.name !== null;
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
      <PanelHeader title="团队成员管理" loading={busy} onRefresh={() => void store.load()} close={close}>
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

      <table style={tableStyles.table}>
        <thead>
          <tr>
            <th style={tableStyles.th}>成员名</th>
            <th style={tableStyles.th}>角色</th>
            <th style={tableStyles.th}>Provider</th>
            <th style={tableStyles.th}>Model</th>
            <th style={tableStyles.th}>Reasoning Effort</th>
            <th style={tableStyles.th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.members.map((member) => (
            <tr key={member.name}>
              <td style={tableStyles.td}>{member.name}</td>
              <td style={tableStyles.td}>{member.role || '-'}</td>
              <td style={tableStyles.td}>{member.provider || '-'}</td>
              <td style={tableStyles.td}>{member.model || '-'}</td>
              <td style={tableStyles.td}>{member.reasoning_effort || '-'}</td>
              <td style={tableStyles.td}>
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
          ))}
          {state.members.length === 0 && !busy && (
            <tr>
              <td style={{ ...tableStyles.td, color: 'var(--dsw-alias-label-secondary)' }} colSpan={6}>
                暂无成员
              </td>
            </tr>
          )}
        </tbody>
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

        <FormField label="角色 (role)" error={errors.role}>
          <Input
            value={values.role}
            onChange={(v) => store.setField('role', v)}
            placeholder="可选"
            error={!!errors.role}
            disabled={busy}
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
    </div>
  );
}
