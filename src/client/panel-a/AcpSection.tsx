/**
 * Panel A, v2.3: ACP provider registrations of the current DSH profile
 * (root `@deepseek-ai/dsh-subagent-acp` inserts), below the subagent table.
 * Presentational: state and actions come from the SubagentPanel store, which
 * owns the shared patch revision.
 */
import React from 'react';
import type { SubagentPanelState, SubagentPanelStore } from './subagent-panel-store';
import type { AcpProbeStatus } from '../shared/api-types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Select } from '../ui/Select';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { formActionsStyle, tableStyles } from '../ui/PanelChrome';

export interface AcpSectionProps {
  state: SubagentPanelState;
  store: SubagentPanelStore;
  busy: boolean;
  blocked: boolean;
  writeTitle?: string;
}

export const ACP_RESTART_NOTE = 'ACP 注册保存在当前 DSH profile 的 cordis.patch.yml，重启 DSH 后生效；新 ACP 重启后才会出现在上方 Provider 下拉中。';
export const ACP_OLD_HOST_NOTE = '当前 Host 版本不支持 ACP 管理，重启 DSH 后可用';
export const HANDSHAKE_NOTE = '握手测试会用这条 ACP 的命令、参数和 env 在本机启动进程，发送 ACP initialize，收到回应后立即结束进程；不创建会话、不调用模型。测试的是已保存的配置。';

const PERMISSION_OPTIONS = [
  { value: 'reject', label: 'reject（拒绝子 agent 的权限请求，默认）' },
  { value: 'allow', label: 'allow（自动批准子 agent 的权限请求）' },
];

const secondary: React.CSSProperties = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' };

/** v2.4 two-row ACP table: no line inside one ACP, one line between ACPs. */
const acpCell: React.CSSProperties = { padding: '8px 8px 2px', fontSize: '13px', textAlign: 'left', verticalAlign: 'middle', border: 'none' };
const acpTable = {
  group: { borderBottom: '1px solid var(--dsw-alias-border-l1)' } as React.CSSProperties,
  name: { ...acpCell, fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  cell: { ...acpCell, overflowWrap: 'break-word' } as React.CSSProperties,
  actions: { ...acpCell, whiteSpace: 'nowrap', width: '1%' } as React.CSSProperties,
  /** Second row: the whole command line, indented under the name. */
  command: { ...acpCell, padding: '2px 8px 8px 24px', display: 'table-cell' } as React.CSSProperties,
  code: { ...mono, marginLeft: '8px', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
};

const STATUS_TEXT: Record<AcpProbeStatus, string> = { pass: '通过', fail: '失败', warn: '注意', skip: '跳过' };
const STATUS_COLOR: Record<AcpProbeStatus, string> = {
  pass: 'var(--dsw-alias-state-success-primary)',
  fail: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  skip: 'var(--dsw-alias-label-secondary)',
};

/** Result of the ACP test (v2.4): one line per check, then agent facts and stderr. */
function AcpTestDialog({ state, store }: { state: SubagentPanelState; store: SubagentPanelStore }) {
  const { id, providerName, running, result, error } = state.acpTest;
  const commandFailed = result?.checks.some((c) => c.status === 'fail' && c.key !== 'handshake') ?? false;
  const agent = result?.agent;
  return (
    <Modal isOpen={id !== null} onClose={() => store.closeAcpTest()} title={`测试 ACP：${providerName ?? ''}`}>
      {error && <Alert type="error">{error}</Alert>}
      {running === 'static' && <div role="status" style={secondary}>检查中...</div>}
      {result && (
        <>
          <div role="status" style={{ fontSize: '13px', marginBottom: '8px' }}>
            {result.ok ? (result.handshake ? '全部通过：进程能启动并完成 ACP 握手' : '静态检查通过') : '有检查未通过'}
          </div>
          <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0 }}>
            {result.checks.map((c) => (
              <li key={c.key} style={{ display: 'flex', gap: '8px', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
                <span style={{ minWidth: '2.5em', fontWeight: 500, color: STATUS_COLOR[c.status] }}>{STATUS_TEXT[c.status]}</span>
                <span style={{ minWidth: '7em', whiteSpace: 'nowrap' }}>{c.label}</span>
                <span style={{ overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)' }}>{c.detail}</span>
              </li>
            ))}
          </ul>
          {agent && (
            <div style={{ ...secondary, marginBottom: '8px' }}>
              对方：{agent.title ?? agent.name ?? '（未报告名称）'}{agent.version ? ` ${agent.version}` : ''}
              {agent.protocolVersion !== undefined ? `，协议版本 ${agent.protocolVersion}` : ''}
              {agent.authMethods && agent.authMethods.length > 0 ? `，登录方式 ${agent.authMethods.join('、')}` : ''}
            </div>
          )}
          {result.stderrTail && (
            <details open={!result.ok} style={{ ...secondary, marginBottom: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>进程 stderr（末尾，已隐藏疑似密钥）</summary>
              <pre style={{ ...mono, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '160px', overflowY: 'auto', margin: '4px 0 0' }}>{result.stderrTail}</pre>
            </details>
          )}
        </>
      )}
      <p style={{ ...secondary, margin: '8px 0 0' }}>{HANDSHAKE_NOTE}</p>
      {running === 'handshake' && <div role="status" style={{ ...secondary, marginTop: '4px' }}>正在启动并握手（最多 20 秒）...</div>}
      <div style={formActionsStyle}>
        <Button onClick={() => store.closeAcpTest()}>关闭</Button>
        <Button onClick={() => void store.runAcpHandshake()} disabled={running !== null || !result || commandFailed} variant="primary">
          {result?.handshake ? '重新握手测试' : '握手测试'}
        </Button>
      </div>
    </Modal>
  );
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

export function AcpSection({ state, store, busy, blocked, writeTitle }: AcpSectionProps) {
  const { mode, values, errors } = state.acpForm;
  const profile = state.dshProfile;

  return (
    <section aria-labelledby="wuyou-acp-heading" style={{ marginTop: '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <h4 id="wuyou-acp-heading" style={{ margin: 0, fontSize: '14px', fontWeight: 500 }}>ACP 管理</h4>
        {profile && (
          <span style={secondary} title={profile.patchPath}>DSH profile：{profile.name}</span>
        )}
      </div>
      <p style={{ ...secondary, margin: '6px 0 12px' }}>
        {state.acpSupported === false ? ACP_OLD_HOST_NOTE : ACP_RESTART_NOTE}
      </p>

      {state.acpSupported !== false && (
        <>
          <Button onClick={() => store.openCreateAcp()} disabled={busy || blocked} title={writeTitle}>
            新建 ACP
          </Button>

          {/* v2.4: two rows per ACP — facts + actions, then the full command line
              across all columns, so no column is squeezed by a long path. */}
          <table style={tableStyles.table}>
            <thead>
              <tr>
                <th scope="col" style={tableStyles.th}>ACP 名称</th>
                <th scope="col" style={tableStyles.th}>权限</th>
                <th scope="col" style={tableStyles.th}>使用它的工具</th>
                <th scope="col" style={tableStyles.th}>操作</th>
              </tr>
            </thead>
            {state.acps.map((acp) => {
              const inUse = acp.usedBy.length > 0;
              const deleteTitle = inUse ? `仍被 ${acp.usedBy.join('、')} 使用，不能删除` : writeTitle;
              return (
                <tbody key={acp.id} style={acpTable.group}>
                  <tr>
                    <th scope="row" style={acpTable.name}>{acp.config.providerName}</th>
                    <td style={acpTable.cell}>{acp.config.permission}</td>
                    <td style={acpTable.cell}>{inUse ? acp.usedBy.join(', ') : '-'}</td>
                    <td style={acpTable.actions}>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <Button onClick={() => void store.testAcp(acp.id)} disabled={state.acpTest.running !== null} title="检查命令是否存在，可选择实际启动做 ACP 握手">
                          测试
                        </Button>
                        <Button onClick={() => store.openEditAcp(acp.id)} disabled={busy || blocked} title={writeTitle}>
                          编辑
                        </Button>
                        <Button
                          onClick={() => store.requestDeleteAcp(acp.id)}
                          disabled={busy || blocked || inUse}
                          title={deleteTitle}
                          variant="danger"
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4} style={acpTable.command}>
                      <span style={secondary}>命令</span>
                      <code style={acpTable.code}>{commandLine(acp.config.command, acp.config.args)}</code>
                    </td>
                  </tr>
                </tbody>
              );
            })}
            {state.acps.length === 0 && !busy && (
              <tbody>
                <tr>
                  <td style={{ ...tableStyles.td, color: 'var(--dsw-alias-label-secondary)' }} colSpan={4}>
                    暂无 ACP
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </>
      )}

      <Modal isOpen={mode !== null} onClose={() => store.cancel()} title={mode === 'create' ? '新建 ACP' : '编辑 ACP'}>
        {state.error && <Alert type="error">{state.error}</Alert>}
        {state.conflict && <Alert type="warning">{state.conflict}</Alert>}

        <FormField
          label="ACP 名称 (providerName)"
          error={errors.providerName}
          hint={mode === 'edit' ? 'subagent 工具按名称引用，创建后不能修改' : '小写字母开头，只能包含小写字母、数字、- 和 _'}
        >
          <Input
            value={values.providerName}
            onChange={(v) => store.setAcpField('providerName', v)}
            placeholder="myacp"
            error={!!errors.providerName}
            disabled={busy || mode === 'edit'}
          />
        </FormField>

        <FormField label="命令 (command)" error={errors.command} hint="子 ACP agent 的可执行文件，建议写绝对路径">
          <Input
            value={values.command}
            onChange={(v) => store.setAcpField('command', v)}
            placeholder="/usr/local/bin/agent"
            error={!!errors.command}
            disabled={busy}
          />
        </FormField>

        <FormField label="参数 (args，可选)" hint="每行一个参数">
          <Textarea
            value={values.args}
            onChange={(v) => store.setAcpField('args', v)}
            placeholder={'acp\n--trust-all-tools'}
            disabled={busy}
            rows={3}
            maxRows={6}
          />
        </FormField>

        <FormField label="工作目录 (cwd，可选)" hint="留空时继承发起委派的会话的工作目录">
          <Input value={values.cwd} onChange={(v) => store.setAcpField('cwd', v)} disabled={busy} />
        </FormField>

        <FormField label="权限 (permission)">
          <Select
            value={values.permission}
            onChange={(v) => store.setAcpField('permission', v as 'allow' | 'reject')}
            options={PERMISSION_OPTIONS}
            disabled={busy}
          />
        </FormField>

        <FormField label="环境变量 (env，可选)" error={errors.env} hint="每行一个 KEY=VALUE。会明文写入配置文件，并随导出文件带出">
          <Textarea
            value={values.env}
            onChange={(v) => store.setAcpField('env', v)}
            placeholder="ANTHROPIC_MODEL=claude-opus-5"
            error={!!errors.env}
            disabled={busy}
            rows={3}
            maxRows={6}
          />
        </FormField>

        <div style={formActionsStyle}>
          <Button onClick={() => store.cancel()} disabled={busy}>取消</Button>
          <Button onClick={() => void store.submitAcp()} disabled={busy || blocked} title={writeTitle} variant="primary">
            {busy ? '保存中...' : '保存'}
          </Button>
        </div>
      </Modal>

      <AcpTestDialog state={state} store={store} />

      <Modal isOpen={state.acpConfirmDelete.id !== null} onClose={() => store.cancel()} title="确认删除 ACP">
        {state.error && <Alert type="error">{state.error}</Alert>}
        <div style={{ marginBottom: '16px', fontSize: '13px' }}>
          确定要删除 ACP “{state.acpConfirmDelete.providerName}” 吗？重启 DSH 后该 provider 不再可用。
        </div>
        <div style={formActionsStyle}>
          <Button onClick={() => store.cancel()} disabled={busy}>取消</Button>
          <Button onClick={() => void store.confirmDeleteAcp()} disabled={busy || blocked} title={writeTitle} variant="danger">
            {busy ? '删除中...' : '确认删除'}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
