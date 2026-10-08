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
import { TeamCreateDialog, TeamDeleteDialog, TeamsImportDialog } from './TeamsDialogs';
import { LAST_TEAM_MESSAGE } from './members-panel-store';
import {
  AgentDetailList,
  DiagnosticsBanner,
  LoadingAnnouncer,
  PanelHeader,
  panelRootStyle,
  busyTableStyle,
  StatusAlerts,
  formActionsStyle,
  tableStyles,
  writeDisabledTitle,
} from '../ui/PanelChrome';
import { isWriteBlocked } from '../ui/host-state';

export interface MembersPanelProps {
  store: MembersPanelStore;
  /** Passed by settings.section as `{ close }`; accepted for compatibility, no button is rendered. */
  close?: () => void;
}

const TEAM_PROFILE_SELECT_ID = 'wuyou-team-profile';

/** v2.5: 新建成员 on the left, the team profile picker on the right. */
const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
};

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
 *
 * v2.9: fixed columns (`table-layout: fixed` + <colgroup>). With auto layout
 * a longer member name widened the name column, the role column shrank, roles
 * wrapped onto more lines and the table grew — enough, for some teams, to cross
 * the fold and pop a scrollbar. Now the widths never depend on the content; a
 * name that does not fit is cut with an ellipsis and shown in full as a tooltip.
 */
const MEMBER_COLUMNS = { name: '30%', actions: '136px' } as const;
const cellBase: React.CSSProperties = {
  padding: '8px 8px 2px',
  fontSize: '13px',
  textAlign: 'left',
  verticalAlign: 'top',
  border: 'none',
};

const memberTable = {
  // Floor for very narrow settings panels (mobile): below it the panel scrolls
  // sideways instead of crushing name and role to zero width.
  table: { ...tableStyles.table, minWidth: '420px', tableLayout: 'fixed' } as React.CSSProperties,
  /** Separator between members; the two rows of one member share no line. */
  group: { borderBottom: '1px solid var(--dsw-alias-border-l1)' } as React.CSSProperties,
  name: {
    ...cellBase,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    overflowWrap: 'normal',
    color: 'var(--dsw-alias-label-primary)',
  } as React.CSSProperties,
  role: {
    ...cellBase,
    // v2.2: roles may be multi-line; keep the author's line breaks.
    whiteSpace: 'pre-line',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
  actions: { ...cellBase, padding: '8px', whiteSpace: 'nowrap' } as React.CSSProperties,
  /** Second row; its <dl> comes from the shared AgentDetailList. */
  details: { ...cellBase, padding: '2px 8px 8px', fontSize: '12px' } as React.CSSProperties,
};

export function MembersPanel({ store }: MembersPanelProps) {
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
  const modalOpen = mode !== null || state.confirmDelete.name !== null || state.teamImport !== null || state.teamCreate.open ||
    state.teamDelete.name !== null;
  const lastTeam = state.teamProfiles.length <= 1;
  const hasProfiles = state.teamProfiles.length > 0;

  // provider → model → reasoning_effort cascade from the Host catalog.
  const providerOptions = state.catalog.providers.map((p) => ({ value: p.id, label: p.id }));
  const selectedProvider = state.catalog.providers.find((p) => p.id === values.provider);
  const modelOptions = selectedProvider?.models.map((m) => ({ value: m.id, label: m.id })) ?? [];
  const selectedModel = selectedProvider?.models.find((m) => m.id === values.model);
  const effortOptions = selectedModel?.reasoningEfforts.map((e) => ({ value: e, label: e })) ?? [];

  // v2.5: always a drop-down (even with one team profile), next to 新建成员.
  // Choosing only switches which team profile this panel shows and edits;
  // agent-teams has no "active profile" setting — a team picks one at create.
  const profilePicker = hasProfiles ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <label htmlFor={TEAM_PROFILE_SELECT_ID} style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>
        团队 profile
      </label>
      <Select
        id={TEAM_PROFILE_SELECT_ID}
        aria-label="团队 profile"
        value={state.profile}
        onChange={(v) => void store.setProfile(v)}
        options={state.teamProfiles.map((p) => ({ value: p, label: p }))}
        disabled={state.writing}
        style={{ width: 'auto', minWidth: '140px' }}
      />
    </div>
  ) : null;

  return (
    <div data-panel="members" style={panelRootStyle}>
      <PanelHeader
        title="团队成员管理"
        loading={busy}
        onRefresh={() => void store.load()}
        onExport={hasProfiles ? () => void store.exportConfig() : undefined}
        onImport={hasProfiles ? (file) => void store.importConfig(file) : undefined}
        importDisabled={blocked}
        importTitle={writeTitle}
      />
      <DiagnosticsBanner diagnostics={state.diagnostics} />
      {!modalOpen && (
        <StatusAlerts
          error={state.error}
          conflict={state.conflict}
          notice={state.notice}
          onDismiss={() => store.cancel()}
        />
      )}

      <div data-toolbar="members" style={toolbarStyle}>
        <Button onClick={() => store.openCreate()} disabled={busy || blocked || !hasProfiles} title={writeTitle}>
          新建成员
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {profilePicker}
          {hasProfiles && (
            <Button onClick={() => store.openCreateTeam()} disabled={busy || blocked} title={writeTitle ?? '新建空白团队，或克隆已有团队'}>
              新建团队
            </Button>
          )}
          {hasProfiles && (
            <Button
              onClick={() => store.openDeleteTeam()}
              disabled={busy || blocked || lastTeam}
              title={lastTeam ? LAST_TEAM_MESSAGE : writeTitle ?? `删除团队「${state.profile}」`}
              variant="danger"
            >
              删除团队
            </Button>
          )}
        </div>
        {/* Test marker only; display:none keeps it out of the flex layout. */}
        <span data-toolbar-end="true" style={{ display: 'none' }} />
      </div>

      <LoadingAnnouncer loading={busy} />

      {/* v2.1 §7: fixed two-row layout, one <tbody> per member. */}
      <table style={{ ...busyTableStyle(busy && state.members.length > 0), ...memberTable.table }} aria-busy={busy && state.members.length > 0 ? true : undefined}>
        <colgroup><col style={{ width: MEMBER_COLUMNS.name }} /><col /><col style={{ width: MEMBER_COLUMNS.actions }} /></colgroup>
        <thead>
          <tr>
            <th scope="col" style={tableStyles.th}>成员名</th>
            <th scope="col" style={tableStyles.th}>角色</th>
            <th scope="col" style={tableStyles.th}>操作</th>
          </tr>
        </thead>
        {state.members.map((member) => (
          <tbody key={member.name} style={memberTable.group}>
            <tr>
              <th scope="row" style={memberTable.name} title={member.name}>{member.name}</th>
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
                <AgentDetailList items={MEMBER_DETAILS.map(([label, key]) => [label, member[key]] as const)} />
              </td>
            </tr>
          </tbody>
        ))}
        {state.members.length === 0 && (
          <tbody>
            <tr>
              <td style={{ ...tableStyles.td, color: 'var(--dsw-alias-label-secondary)' }} colSpan={3}>
                {busy ? '加载中...' : '暂无成员'}
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

      <TeamCreateDialog state={state} store={store} busy={busy} blocked={blocked} writeTitle={writeTitle} />
      <TeamsImportDialog state={state} store={store} busy={busy} blocked={blocked} writeTitle={writeTitle} />
      <TeamDeleteDialog state={state} store={store} busy={busy} blocked={blocked} writeTitle={writeTitle} />
    </div>
  );
}
