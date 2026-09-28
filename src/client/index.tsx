/**
 * 无忧Agent插件 Client 入口
 *
 * React 实现，注册两个 settings.section（docs/requirements.md D2）：
 * - wuyou-subagents (Panel A)
 * - wuyou-members (Panel B)
 *
 * 团队 profile 不在这里指定：members store 初始为 standard-acp，
 * 首次 GET state 后按 teamProfiles 回落到第一个可用 profile，面板内可切换。
 */
import React from 'react';
import { createApiClient } from './shared/api-client';
import { createSubagentStore } from './panel-a/subagent-panel-store';
import { createMembersStore } from './panel-b/members-panel-store';
import { SubagentPanel } from './panel-a/SubagentPanel';
import { MembersPanel } from './panel-b/MembersPanel';

export const inject = ['slots'];

/**
 * Props the host composes for a settings.section component:
 * `renderSlot('settings.section', { close: onClose }, { only: active })`
 * (dsh-client-ui-settings-general SettingsPanel).
 */
export interface SectionProps {
  close?: () => void;
}

/** settings.section registration options, verbatim from requirements D2. */
export const SECTIONS = {
  subagents: { name: 'settings.section', id: 'wuyou-subagents', order: 100, label: '无忧Agent · Subagent' },
  members: { name: 'settings.section', id: 'wuyou-members', order: 101, label: '无忧Agent · 团队成员' },
} as const;

export function apply(ctx: any) {
  const api = createApiClient({ base: '/plugins/dsh-wuyou-agent/api' });
  const subagentStore = createSubagentStore(api);
  const membersStore = createMembersStore(api);

  // Forward the host props (including close) into each panel. The dispose
  // returned by register is owned by ctx through slots.inject.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(SECTIONS.subagents, (props: SectionProps) => (
      <SubagentPanel {...props} store={subagentStore} />
    )),
  );

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(SECTIONS.members, (props: SectionProps) => (
      <MembersPanel {...props} store={membersStore} />
    )),
  );
}

// Default export for DSH ModuleLoader
export default {
  inject,
  apply,
};
