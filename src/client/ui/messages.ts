/**
 * Client-side validation and status copy (zh-CN).
 *
 * Entries that mean the same thing as a Host error are copied verbatim from
 * docs/requirements.md B2 or from the Host pure functions
 * (src/host/subagent-manager.ts, src/host/members-editor.ts), so the user
 * sees one wording whichever side catches the problem.
 */

// Same text as the Host (requirements B2 / Host pure functions).
export const MSG = {
  toolNameDuplicate: (toolName: string) => `工具名 '${toolName}' 已存在`,
  toolNameFormat: (toolName: string) => `工具名 '${toolName}' 格式不合法`,
  subagentNotFound: (id: string) => `未找到 subagent '${id}'`,
  readOnly: 'ACP 后端的 subagent 工具为只读',
  agentProviderRequired: 'agentOptions.provider 必填',
  agentModelRequired: 'agentOptions.model 必填',
  memberDuplicate: (name: string) => `成员 '${name}' 已存在`,
  memberNameFormat: (name: string) => `成员名 '${name}' 格式不合法`,
  memberNotFound: (name: string) => `未找到成员 '${name}'`,
  memberRouteBothOrNeither: '成员 provider 和 model 必须同时填写',
  lastMember: '团队至少需要保留一个成员',

  // Client-only wording (no Host equivalent).
  toolNameRequired: '请填写工具名',
  memberNameRequired: '请填写成员名',
  noChanges: '没有改动',
  loadSubagentsFailed: '加载 subagent 工具失败',
  loadMembersFailed: '加载团队成员失败',
  saveFailed: '保存失败',
  deleteFailed: '删除失败',
} as const;
