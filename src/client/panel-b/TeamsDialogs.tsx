/**
 * Panel B, v2.6: the new / clone team dialog and the multi-team import
 * dialog. Presentational: state and actions come from the members store.
 */
import React from 'react';
import { TEAM_DELETE_CONFIRMATION, type MembersPanelState, type MembersPanelStore } from './members-panel-store';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { formActionsStyle } from '../ui/PanelChrome';
import { fieldStyle } from '../ui/field-style';

export const NEW_TEAM_OPTION = '';
export const OVERWRITE_WARNING = '覆盖会用文件里的内容整体替换该团队现有的描述、协议和全部成员，原配置无法在面板里找回。覆盖前建议先导出当前全部团队作为备份。';

const secondary: React.CSSProperties = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };

interface DialogProps {
  state: MembersPanelState;
  store: MembersPanelStore;
  busy: boolean;
  blocked: boolean;
  writeTitle?: string;
}

export function TeamCreateDialog({ state, store, busy, blocked, writeTitle }: DialogProps) {
  const form = state.teamCreate;
  const cloning = form.from !== NEW_TEAM_OPTION;
  // One drop-down: a new blank team, then every existing team as a clone source.
  const options = [
    { value: NEW_TEAM_OPTION, label: '新建空白团队' },
    ...state.teamProfiles.map((p) => ({ value: p, label: `克隆：${p}` })),
  ];
  return (
    <Modal isOpen={form.open} onClose={() => store.closeCreateTeam()} title="新建团队">
      {state.error && <Alert type="error">{state.error}</Alert>}
      {state.conflict && <Alert type="warning">{state.conflict}</Alert>}

      <FormField label="从哪里开始">
        <Select value={form.from} onChange={(v) => store.setTeamField('from', v)} options={options} disabled={busy} />
      </FormField>

      <FormField label="团队名 (profile)" error={form.errors.name} hint="小写字母或数字开头，只能包含小写字母、数字、.、_、-；用于 /agent-teams --profile <名称>">
        <Input
          value={form.name}
          onChange={(v) => store.setTeamField('name', v)}
          placeholder={cloning ? `${form.from}-copy` : 'my-team'}
          error={!!form.errors.name}
          disabled={busy}
        />
      </FormField>

      {cloning ? (
        <p style={{ ...secondary, margin: '0 0 12px' }}>
          将原样复制团队「{form.from}」的描述、协议、任务规划和全部成员（包括配置文件里的注释），之后可以在新团队里单独修改。
        </p>
      ) : (
        <>
          <FormField label="描述 (description，可选)">
            <Input value={form.description} onChange={(v) => store.setTeamField('description', v)} disabled={busy} />
          </FormField>
          <FormField label="第一个成员名" error={form.errors.firstMember} hint="agent-teams 要求团队至少有一个成员；创建后可继续添加或修改">
            <Input
              value={form.firstMember}
              onChange={(v) => store.setTeamField('firstMember', v)}
              placeholder="member-name"
              error={!!form.errors.firstMember}
              disabled={busy}
            />
          </FormField>
        </>
      )}

      <div style={formActionsStyle}>
        <Button onClick={() => store.closeCreateTeam()} disabled={busy}>取消</Button>
        <Button onClick={() => void store.submitTeam()} disabled={busy || blocked} title={writeTitle} variant="primary">
          {busy ? '创建中...' : cloning ? '克隆' : '创建'}
        </Button>
      </div>
    </Modal>
  );
}

const STATUS: Record<'new' | 'conflict' | 'invalid', { text: string; color: string }> = {
  new: { text: '新增', color: 'var(--dsw-alias-state-success-primary)' },
  conflict: { text: '已存在', color: 'var(--dsw-alias-state-warn-primary)' },
  invalid: { text: '跳过', color: 'var(--dsw-alias-label-secondary)' },
};

export function TeamsImportDialog({ state, store, busy, blocked, writeTitle }: DialogProps) {
  const preview = state.teamImport;
  if (!preview) return null;
  const creates = preview.teams.filter((t) => t.status === 'new').length;
  const conflicts = preview.teams.filter((t) => t.status === 'conflict');
  const overwrites = conflicts.filter((t) => preview.overwrite.has(t.name)).length;
  const total = creates + overwrites;
  return (
    <Modal isOpen onClose={() => store.cancelImport()} title="导入团队">
      {state.error && <Alert type="error">{state.error}</Alert>}
      <div style={{ ...secondary, marginBottom: '8px' }}>
        文件：{preview.fileName}{preview.sourceProfile ? `（来自 DSH profile ${preview.sourceProfile}）` : ''}，共 {preview.teams.length} 个团队
      </div>
      {conflicts.length > 0 && (
        <Alert type="warning">
          <div>{conflicts.length} 个团队已存在：勾选「覆盖」才会替换，不勾选则跳过。</div>
          <div style={{ marginTop: '4px' }}>{OVERWRITE_WARNING}</div>
          <div style={{ marginTop: '6px' }}>
            <Button onClick={() => void store.exportConfig()} disabled={busy}>先导出当前全部团队（备份）</Button>
          </div>
        </Alert>
      )}

      <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, maxHeight: '280px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px' }}>
        {preview.teams.map((team) => {
          const id = `wuyou-overwrite-${team.name}`;
          const style = STATUS[team.status];
          return (
            <li key={team.name} style={{ padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)', borderLeft: `3px solid ${style.color}`, fontSize: '13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span>
                  <span style={{ fontWeight: 500 }}>{team.name}</span>
                  <span style={{ ...secondary, marginLeft: '8px' }}>{style.text}</span>
                </span>
                {team.status === 'conflict' && (
                  <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', whiteSpace: 'nowrap' }}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={preview.overwrite.has(team.name)}
                      onChange={() => store.toggleTeamOverwrite(team.name)}
                      disabled={busy}
                    />
                    覆盖
                  </label>
                )}
              </div>
              <div style={secondary}>
                {team.status === 'conflict'
                  ? `现有 ${team.currentMembers} 个成员 → 文件 ${team.fileMembers} 个`
                  : `${team.fileMembers} 个成员`}
                {typeof team.profile.description === 'string' ? `，${team.profile.description}` : ''}
              </div>
              {team.reason && <div style={secondary}>原因：{team.reason}</div>}
              {team.warnings.map((w) => <div key={w} style={secondary}>注意：{w}</div>)}
            </li>
          );
        })}
      </ul>

      <div style={formActionsStyle}>
        <Button onClick={() => store.cancelImport()} disabled={busy}>取消</Button>
        <Button
          onClick={() => void store.confirmImport()}
          disabled={busy || blocked || total === 0}
          title={writeTitle}
          variant={overwrites > 0 ? 'danger' : 'primary'}
        >
          {busy ? '导入中...' : overwrites > 0 ? `确认导入（新增 ${creates}，覆盖 ${overwrites}）` : `确认导入（新增 ${creates}）`}
        </Button>
      </div>
    </Modal>
  );
}

const DELETE_INPUT_ID = 'wuyou-delete-team-confirm';

/** v2.7: delete the viewed team after the user types `thinktwice`. */
export function TeamDeleteDialog({ state, store, busy, blocked, writeTitle }: DialogProps) {
  const { name, confirm, error } = state.teamDelete;
  if (name === null) return null;
  const matches = confirm === TEAM_DELETE_CONFIRMATION;
  const memberCount = name === state.profile ? state.members.length : undefined;
  return (
    <Modal isOpen onClose={() => store.closeDeleteTeam()} title={`删除团队：${name}`}>
      {state.error && <Alert type="error">{state.error}</Alert>}
      <Alert type="warning">
        <div>
          将从 cordis.patch.yml 删除团队「{name}」的描述、协议、任务规划和全部{memberCount !== undefined ? ` ${memberCount} 个` : ''}成员。删除后在面板里无法撤销，只能用备份恢复。
        </div>
        <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
          <li>之后用 <code>/agent-teams --profile {name}</code> 或 profile={name} 新建团队会失败。</li>
          <li>协议或其他团队里写到「{name}」的地方需要自己改掉。</li>
          <li>已经创建的团队不受影响（agent-teams 在创建时保存了当时的配置）。</li>
        </ul>
        <div style={{ marginTop: '8px' }}>
          <Button onClick={() => void store.exportConfig()} disabled={busy}>先导出全部团队（备份）</Button>
        </div>
      </Alert>

      <label htmlFor={DELETE_INPUT_ID} style={{ display: 'block', fontSize: '13px', fontWeight: 500, margin: '12px 0 6px' }}>
        请输入 <code>{TEAM_DELETE_CONFIRMATION}</code> 以确认删除
      </label>
      <input
        id={DELETE_INPUT_ID}
        type="text"
        value={confirm}
        onChange={(e) => store.setDeleteConfirm(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={TEAM_DELETE_CONFIRMATION}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${DELETE_INPUT_ID}-error` : undefined}
        disabled={busy}
        style={fieldStyle(!!error)}
      />
      {error && (
        <div id={`${DELETE_INPUT_ID}-error`} role="alert" style={{ marginTop: '4px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }}>
          {error}
        </div>
      )}

      <div style={formActionsStyle}>
        <Button onClick={() => store.closeDeleteTeam()} disabled={busy}>取消</Button>
        <Button onClick={() => void store.submitDeleteTeam()} disabled={busy || blocked || !matches} title={writeTitle} variant="danger">
          {busy ? '删除中...' : '确认删除'}
        </Button>
      </div>
    </Modal>
  );
}
