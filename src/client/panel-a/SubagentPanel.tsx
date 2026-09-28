/**
 * Panel A: Subagent tool rows (React, reads the framework-free store).
 * v2.1: capability-driven form fields, ACP editable, hostApi<2 banner.
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import {
  isRowEditable,
  rowReadOnlyReason,
  suppressAgentOptions,
  supportsContinuable,
  type SubagentPanelStore,
} from './subagent-panel-store';
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
import { MSG } from '../ui/messages';

export interface SubagentPanelProps {
  store: SubagentPanelStore;
  /** Closes the host settings dialog; passed by settings.section as `{ close }`. */
  close?: () => void;
}

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '0 6px',
  marginLeft: '8px',
  fontSize: '11px',
  lineHeight: '18px',
  borderRadius: '4px',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  border: '1px solid var(--dsw-alias-border-l2)',
};

const readonlyTextStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--dsw-alias-label-secondary)',
  padding: '6px 0',
};

/** Contract §3 read-only text (a config literal, not translatable copy, so not in MSG). */
const MAX_DEPTH_PROVIDER_MANAGED = 'maxDepth：provider-managed';

/** Contract §9: plain secondary text, not an Alert. */
const oldHostNoticeStyle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-secondary)',
};

export function SubagentPanel({ store, close }: SubagentPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    void store.load();
  }, [store]);

  const blocked = isWriteBlocked(state.diagnostics);
  const busy = state.loading;
  const writeTitle = writeDisabledTitle(blocked);
  const { values, errors, mode } = state.form;
  const modalOpen = mode !== null || state.confirmDelete.id !== null;

  // v2.1: capabilities of the currently-selected provider. The same predicates
  // decide what submit sends, so the dialog never shows what will not be written.
  const caps = store.getProviderCapabilities(values.provider);
  const suppressAgentOpts = suppressAgentOptions(values.provider, caps);
  const canBeContinuable = supportsContinuable(caps);
  const providerManagedDepth = caps?.depthLimit === false;

  // provider → model → reasoningEffort cascade from the Host LLM catalog.
  const agentProviderOptions = state.catalog.providers.map((p) => ({ value: p.id, label: p.id }));
  const selectedAgentProvider = state.catalog.providers.find((p) => p.id === values.agentOptions.provider);
  const modelOptions = selectedAgentProvider?.models.map((m) => ({ value: m.id, label: m.id })) ?? [];
  const selectedModel = selectedAgentProvider?.models.find((m) => m.id === values.agentOptions.model);
  const effortOptions = selectedModel?.reasoningEfforts.map((e) => ({ value: e, label: e })) ?? [];

  const setAgentOptions = (patch: Partial<typeof values.agentOptions>) =>
    store.setField('agentOptions', { ...values.agentOptions, ...patch });

  // v2.1: provider drop-down options from state.subagentProviders.
  // If the current value is not in the list, add it with an "未注册" label.
  const providerOptionsFromState = state.subagentProviders.map((p) => ({ value: p.name, label: p.name }));
  const currentInList = state.subagentProviders.some((p) => p.name === values.provider);
  const providerSelectOptions = currentInList
    ? providerOptionsFromState
    : [...providerOptionsFromState, { value: values.provider, label: `${values.provider}（未注册）` }];

  return (
    <div style={{ padding: '16px', color: 'var(--dsw-alias-label-primary)' }}>
      <PanelHeader title="Subagent 工具管理" loading={busy} onRefresh={() => void store.load()} close={close} />

      {/* §9: only once a state has confirmed hostApi !== 2 (null = not loaded yet). */}
      {state.hostApiV2 === false && <p style={oldHostNoticeStyle}>{MSG.hostApiUpgradeRequired}</p>}

      <DiagnosticsBanner diagnostics={state.diagnostics} />
      {!modalOpen && (
        <StatusAlerts
          error={state.error}
          conflict={state.conflict}
          notice={state.notice}
          onDismiss={() => store.cancel()}
        />
      )}

      <Button onClick={() => store.openCreate()} disabled={busy || blocked} title={writeTitle}>
        新建 Subagent 工具
      </Button>

      {busy && (
        <div role="status" style={{ marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
          加载中...
        </div>
      )}

      <table style={tableStyles.table}>
        <thead>
          <tr>
            <th style={tableStyles.th}>工具名</th>
            <th style={tableStyles.th}>Provider</th>
            <th style={tableStyles.th}>Background Mode</th>
            <th style={tableStyles.th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((row) => {
            const config = row.config as Record<string, unknown>;
            const toolName = String(config.toolName ?? row.id);
            const editable = isRowEditable(state, row);
            const disabled = !editable || busy || blocked;
            const rowTitle = editable ? writeTitle : rowReadOnlyReason(state, row);
            return (
              <tr key={row.id}>
                <td style={tableStyles.td}>
                  {toolName}
                  {!editable && <span style={badgeStyle} data-readonly="true">只读</span>}
                </td>
                <td style={tableStyles.td}>{String(config.provider ?? '-')}</td>
                <td style={tableStyles.td}>{String(config.backgroundMode ?? '-')}</td>
                <td style={tableStyles.td}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button onClick={() => store.openEdit(row.id)} disabled={disabled} title={rowTitle}>
                      编辑
                    </Button>
                    <Button onClick={() => store.requestDelete(row.id)} disabled={disabled} title={rowTitle} variant="danger">
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
          {state.rows.length === 0 && !busy && (
            <tr>
              <td style={{ ...tableStyles.td, color: 'var(--dsw-alias-label-secondary)' }} colSpan={4}>
                暂无 subagent 工具
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Modal
        isOpen={mode !== null}
        onClose={() => store.cancel()}
        title={mode === 'create' ? '新建 Subagent 工具' : '编辑 Subagent 工具'}
      >
        {state.error && <Alert type="error">{state.error}</Alert>}
        {state.conflict && <Alert type="warning">{state.conflict}</Alert>}

        <FormField label="工具名 (toolName)" error={errors.toolName} hint="格式 subagent_xxx，只能用小写字母、数字和下划线">
          <Input
            value={values.toolName}
            onChange={(v) => store.setField('toolName', v)}
            placeholder="subagent_xxx"
            error={!!errors.toolName}
            disabled={busy}
          />
        </FormField>

        {/* v2.1: Provider drop-down comes from state.subagentProviders */}
        <FormField label="Provider" error={errors.provider}>
          <Select
            value={values.provider}
            onChange={(v) => store.setField('provider', v)}
            options={providerSelectOptions}
            disabled={busy}
          />
        </FormField>

        {/* agentOptions: shown when provider needs them (spawn-like) */}
        {!suppressAgentOpts && (
          <>
            <FormField label="Agent Provider" error={errors.agentOptions?.provider}>
              <Select
                value={values.agentOptions.provider}
                onChange={(v) => setAgentOptions({ provider: v, model: '', reasoningEffort: '' })}
                options={[{ value: '', label: '-- 选择 Provider --' }, ...agentProviderOptions]}
                error={!!errors.agentOptions?.provider}
                disabled={busy}
              />
            </FormField>
            <FormField label="Model" error={errors.agentOptions?.model}>
              <Select
                value={values.agentOptions.model}
                onChange={(v) => setAgentOptions({ model: v, reasoningEffort: '' })}
                options={[{ value: '', label: '-- 选择 Model --' }, ...modelOptions]}
                error={!!errors.agentOptions?.model}
                disabled={!values.agentOptions.provider || busy}
              />
            </FormField>
            <FormField label="Reasoning Effort">
              <Select
                value={values.agentOptions.reasoningEffort}
                onChange={(v) => setAgentOptions({ reasoningEffort: v })}
                options={[{ value: '', label: '-- 可选 --' }, ...effortOptions]}
                disabled={!values.agentOptions.model || busy}
              />
            </FormField>
          </>
        )}

        {/* Background Mode: read-only one-shot when provider has continuable=false */}
        <FormField label="Background Mode">
          {canBeContinuable ? (
            <Select
              value={values.backgroundMode}
              onChange={(v) => store.setField('backgroundMode', v as 'continuable' | 'one-shot')}
              options={[
                { value: 'continuable', label: 'continuable' },
                { value: 'one-shot', label: 'one-shot' },
              ]}
              disabled={busy}
            />
          ) : (
            <div style={readonlyTextStyle} aria-label="Background Mode: one-shot (read-only)">
              one-shot
            </div>
          )}
        </FormField>

        {/* §3: depthLimit === false → the Host writes maxDepth: provider-managed; not editable. */}
        {providerManagedDepth && (
          <div style={readonlyTextStyle} data-readonly="maxDepth">{MAX_DEPTH_PROVIDER_MANAGED}</div>
        )}

        <div style={formActionsStyle}>
          <Button onClick={() => store.cancel()} disabled={busy}>取消</Button>
          <Button onClick={() => void store.submit()} disabled={busy || blocked} title={writeTitle} variant="primary">
            {busy ? '保存中...' : '保存'}
          </Button>
        </div>
      </Modal>

      <Modal isOpen={state.confirmDelete.id !== null} onClose={() => store.cancel()} title="确认删除">
        {state.error && <Alert type="error">{state.error}</Alert>}
        <div style={{ marginBottom: '16px', fontSize: '13px' }}>
          确定要删除工具 "{state.confirmDelete.toolName}" 吗？
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
