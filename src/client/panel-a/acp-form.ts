/**
 * ACP registration form (v2.3): pure conversions between the dialog's text
 * fields and the `@deepseek-ai/dsh-subagent-acp` config. Args are one per
 * line; env is one KEY=VALUE per line.
 */
import type { AcpConfig, AcpPatch, AcpRow } from '../shared/api-types';

export interface AcpFormData {
  providerName: string;
  command: string;
  args: string;
  cwd: string;
  permission: 'allow' | 'reject';
  env: string;
}

export type AcpFormErrors = Partial<Record<keyof AcpFormData, string>>;

const PROVIDER_NAME = /^[a-z][a-z0-9_-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyAcpForm(): AcpFormData {
  // The package default is `reject`: the child cannot auto-approve its own tool calls.
  return { providerName: '', command: '', args: '', cwd: '', permission: 'reject', env: '' };
}

export function acpFormFromRow(row: AcpRow): AcpFormData {
  const { providerName, command, args, cwd, permission, env } = row.config;
  return {
    providerName,
    command,
    args: args.join('\n'),
    cwd: cwd ?? '',
    permission,
    env: Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'),
  };
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

export function parseArgs(text: string): string[] {
  return lines(text);
}

/** KEY=VALUE per line; the first `=` splits. Returns an error text on bad input. */
export function parseEnv(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const line of lines(text)) {
    const eq = line.indexOf('=');
    if (eq <= 0) return `'${line}' 不是 KEY=VALUE 格式`;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) return `变量名 '${key}' 不合法`;
    if (key in env) return `变量 '${key}' 重复`;
    env[key] = line.slice(eq + 1);
  }
  return env;
}

export function validateAcpForm(
  values: AcpFormData,
  mode: 'create' | 'edit',
  existing: readonly AcpRow[],
  reserved: readonly string[] = ['spawn', 'fork'],
): AcpFormErrors {
  const errors: AcpFormErrors = {};
  if (mode === 'create') {
    const name = values.providerName.trim();
    if (!name) errors.providerName = '请填写 ACP 名称';
    else if (!PROVIDER_NAME.test(name)) errors.providerName = '小写字母开头，只能包含小写字母、数字、- 和 _';
    else if (reserved.includes(name)) errors.providerName = `'${name}' 是内置 provider`;
    else if (existing.some((row) => row.config.providerName === name)) errors.providerName = `ACP '${name}' 已存在`;
  }
  if (!values.command.trim()) errors.command = '请填写可执行文件路径';
  const env = parseEnv(values.env);
  if (typeof env === 'string') errors.env = env;
  return errors;
}

/** Create payload; call only after validateAcpForm returned no errors. */
export function acpConfigFromForm(values: AcpFormData): AcpConfig {
  const cwd = values.cwd.trim();
  return {
    providerName: values.providerName.trim(),
    command: values.command.trim(),
    args: parseArgs(values.args),
    ...(cwd ? { cwd } : {}),
    permission: values.permission,
    env: parseEnv(values.env) as Record<string, string>,
  };
}

/** Changed fields only; a cleared cwd is `null`, cleared args/env are empty. */
export function diffAcpPatch(original: AcpFormData, values: AcpFormData): AcpPatch {
  const before = acpConfigFromForm(original);
  const after = acpConfigFromForm(values);
  const patch: AcpPatch = {};
  if (after.command !== before.command) patch.command = after.command;
  if (JSON.stringify(after.args) !== JSON.stringify(before.args)) patch.args = after.args;
  if ((after.cwd ?? null) !== (before.cwd ?? null)) patch.cwd = after.cwd ?? null;
  if (after.permission !== before.permission) patch.permission = after.permission;
  if (JSON.stringify(after.env) !== JSON.stringify(before.env)) patch.env = after.env;
  return patch;
}
