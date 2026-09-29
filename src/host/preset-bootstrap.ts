/**
 * Seed `preset-standard-acp` into the user patch when Panel A cannot find it.
 *
 * The panel only reads this profile's `cordis.patch.yml`. A fresh DSH profile
 * keeps the shipped `preset-standard` declaration in the `dsh-web-app` bundle,
 * so the user layer has no `preset-standard-acp` delegation group and the
 * panel reports an unsupported structure. Startup appends one declaration.
 * DSH has already composed config for this process, so the new preset is
 * mounted on the next restart.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isSeq, type Document, type YAMLSeq } from 'yaml';
import {
  applyFieldEdits,
  computeRevision,
  findSubagentSequence,
  indentationAt,
  nodeRange,
  pairValue,
  parseYaml,
  scalarString,
} from './patch-io.js';
import type { MutationError } from './types.js';

export const PRESET_ROW_ID = 'preset-standard-acp';
export const PRESET_ID = 'standard-acp';
const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset';
const REGISTRY_ID = 'agent-preset-registry';
const REGISTRY_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry';
const SHIPPED_ROW_ID = 'preset-standard';

const RESTART_NOTE = '请再重启一次 DSH，新会话才会挂载该预设';

/** Shown in the panel after this process writes the preset. */
export function presetInitNotice(source: 'standard' | 'minimal', defaultSet: boolean): string {
  if (source === 'standard' && defaultSet) {
    return `已初始化 preset-standard-acp，并将默认预设设为 standard-acp。${RESTART_NOTE}`;
  }
  if (source === 'standard') {
    return `已初始化 preset-standard-acp（未改已有的默认预设）。${RESTART_NOTE}`;
  }
  return `已初始化精简的 preset-standard-acp（未能按 standard 预设生成，未改默认预设）。${RESTART_NOTE}`;
}

/**
 * Delegation-only preset used when the installed standard declaration cannot
 * be cloned. It is not made the default: without the rest of the standard
 * tool list it is not a usable coding agent.
 */
const MINIMAL_PRESET = `# preset-standard-acp，由无忧 Agent 写入的精简 delegation 组（未能按 standard 预设生成）。
# 首次写入后需要再重启一次 DSH，新会话才会挂载这个预设。未改默认预设。
- insert:
    - id: ${PRESET_ROW_ID}
      name: '${PRESET_PACKAGE}'
      config:
        id: ${PRESET_ID}
        name: 标准模式 + ACP 委派
        description: 精简预设，仅包含 delegation 子代理组。
        order: 5
        plugins:
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent-list-agents
                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelectionSettings: true
                  backgroundMode: continuable
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
                  backgroundMode: continuable
              - id: tool-subagent-codex
                name: '@deepseek-ai/dsh-tool-subagent'
                disabled: true
                config:
                  provider: codex
                  toolName: subagent_codex
                  backgroundMode: one-shot
                  maxDepth: provider-managed
              - id: tool-subagent-claude-code
                name: '@deepseek-ai/dsh-tool-subagent'
                disabled: true
                config:
                  provider: claude-code
                  toolName: subagent_claude_code
                  backgroundMode: one-shot
                  maxDepth: provider-managed
`;

const REGISTRY_ENTRY = `# 无忧 Subagent 初始化 preset-standard-acp 时写入。用户层按 id 覆盖 registry 的 config，
# 因此这里只设置 default。界面里另选的预设仍然优先。
- id: ${REGISTRY_ID}
  name: '${REGISTRY_PACKAGE}'
  config:
    default: ${PRESET_ID}
`;

export interface SeedPresetInitialized {
  ok: true;
  yamlText: string;
  initialized: true;
  source: 'standard' | 'minimal';
  defaultSet: boolean;
}

export interface SeedPresetUnchanged {
  ok: true;
  yamlText: string;
  initialized: false;
}

export type SeedPresetResult = SeedPresetInitialized | SeedPresetUnchanged | MutationError;

export interface PresetPatchIO {
  readPatch(): Promise<string>;
  writePatchLocked(
    expectedRevision: string,
    transform: (current: string) => string | Promise<string>,
  ): Promise<string>;
}

export interface PresetInitLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function error(code: MutationError['code'], message: string): MutationError {
  return { ok: false, code, message };
}

function rootSequence(document: Document): YAMLSeq | undefined {
  const root = document.contents;
  return isSeq(root) ? root : undefined;
}

function entryId(node: unknown): string {
  return scalarString(pairValue(node, 'id'));
}

function walkEntries(root: YAMLSeq, visit: (node: unknown) => void): void {
  for (const item of root.items) {
    visit(item);
    const insert = pairValue(item, 'insert');
    if (!isSeq(insert)) continue;
    for (const entry of insert.items) visit(entry);
  }
}

function hasId(root: YAMLSeq, id: string): boolean {
  let found = false;
  walkEntries(root, (node) => {
    if (entryId(node) === id) found = true;
  });
  return found;
}

/**
 * Turn the shipped `presets/standard.patch.yml` into a `preset-standard-acp`
 * declaration. Returns null when the file does not have the expected header,
 * so the caller can fall back to the minimal delegation group.
 */
export function adaptStandardPreset(source: string): string | null {
  let text = source.replace(/\r\n/g, '\n');
  const rowMarker = `- id: ${SHIPPED_ROW_ID}\n`;
  const rowAt = text.indexOf(rowMarker);
  if (rowAt < 0) return null;
  text = `${text.slice(0, rowAt)}- id: ${PRESET_ROW_ID}\n${text.slice(rowAt + rowMarker.length)}`;
  const idBlock = '        id: standard\n        order: 1\n';
  if (!text.includes(idBlock)) return null;
  text = text.replace(
    idBlock,
    [
      `        id: ${PRESET_ID}`,
      '        name: 标准模式 + ACP 委派',
      '        description: 按已安装的 standard 预设初始化，供无忧 Subagent 管理 delegation 子代理。',
      '        order: 5',
      '',
    ].join('\n'),
  );
  const bodyAt = text.indexOf('- insert:\n');
  if (bodyAt < 0) return null;
  const header = [
    '# preset-standard-acp，由无忧 Agent 按已安装的 standard 预设初始化。',
    '# 首次写入后需要再重启一次 DSH，新会话才会挂载这个预设。',
    '',
  ].join('\n');
  text = `${header}${text.slice(bodyAt)}`;
  if (!text.endsWith('\n')) text += '\n';
  try {
    if (!findSubagentSequence(parseYaml(text))) return null;
  } catch {
    return null;
  }
  return text;
}

/** Read `dsh-web-app/presets/standard.patch.yml` from the first anchor that can resolve it. */
export function readInstalledStandardPreset(anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor);
      const pkg = require.resolve('@deepseek-ai/dsh-web-app/package.json');
      return readFileSync(join(dirname(pkg), 'presets', 'standard.patch.yml'), 'utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

function presetBody(standardTemplate: string | undefined): { block: string; source: 'standard' | 'minimal' } {
  const adapted = standardTemplate ? adaptStandardPreset(standardTemplate) : null;
  if (adapted) return { block: adapted.trimEnd(), source: 'standard' };
  return { block: MINIMAL_PRESET.trimEnd(), source: 'minimal' };
}

function appendBlock(yamlText: string, block: string): string {
  const document = parseYaml(yamlText);
  if (document.contents == null) {
    const base = yamlText.length === 0 ? '' : yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`;
    const gap = base.trim() === '' || base.endsWith('\n\n') ? '' : '\n';
    return `${base}${gap}${block.endsWith('\n') ? block : `${block}\n`}`;
  }
  const root = rootSequence(document);
  if (!root) throw new Error('cordis.patch.yml 的根不是 YAML 序列');
  if ((root as { flow?: boolean }).flow) {
    if (root.items.length > 0) throw new Error('cordis.patch.yml 的根不是块格式的 YAML 序列');
    const range = nodeRange(root);
    if (!range) throw new Error('空的根序列缺少源码位置');
    return applyFieldEdits(
      yamlText,
      [{ start: range[0], end: range[1], text: block.trimEnd(), field: 'preset-standard-acp' }],
      'preset-standard-acp',
    );
  }
  if (root.items.length === 0) {
    const base = yamlText.endsWith('\n') || yamlText.length === 0 ? yamlText : `${yamlText}\n`;
    return `${base}${block.endsWith('\n') ? block : `${block}\n`}`;
  }
  const anchor = root.items.at(-1);
  const anchorRange = anchor ? nodeRange(anchor) : undefined;
  if (!anchorRange) throw new Error('根序列项缺少源码位置');
  const offset = anchorRange[1];
  const indent = indentationAt(yamlText, anchorRange[0]);
  const indented = indent
    ? block.split('\n').map((line) => (line.length === 0 ? '' : `${indent}${line}`)).join('\n')
    : block;
  const lead = offset > 0 && yamlText[offset - 1] !== '\n' ? '\n' : '';
  const text = `${lead}\n${indented.endsWith('\n') ? indented : `${indented}\n`}`;
  return applyFieldEdits(yamlText, [{ start: offset, end: offset, text, field: 'preset-standard-acp' }], 'preset-standard-acp');
}

/**
 * Append `preset-standard-acp` when its delegation group is missing.
 * A patch that already has the group is returned unchanged.
 */
export function seedStandardAcpPreset(yamlText: string, standardTemplate?: string): SeedPresetResult {
  let document: Document;
  try {
    document = parseYaml(yamlText.trim() === '' ? '[]\n' : yamlText);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return error('INVALID', `字段 preset-standard-acp 无法写入：${reason}`);
  }
  if (yamlText.trim() !== '' && findSubagentSequence(document)) {
    return { ok: true, yamlText, initialized: false };
  }
  const root = rootSequence(document);
  const notABlockSequence = root === undefined
    ? document.contents != null
    : (root as { flow?: boolean }).flow === true && root.items.length > 0;
  if (yamlText.trim() !== '' && notABlockSequence) {
    return error('STRUCTURE', 'cordis.patch.yml 的根不是块格式的 YAML 序列');
  }
  if (root && hasId(root, PRESET_ROW_ID)) {
    return error('STRUCTURE', 'preset-standard-acp 已存在但没有 delegation 组，未自动改写');
  }
  const built = presetBody(standardTemplate);
  const parts = [built.block];
  const defaultSet = built.source === 'standard' && !(root && hasId(root, REGISTRY_ID));
  if (defaultSet) parts.unshift(REGISTRY_ENTRY.trimEnd());
  const block = parts.join('\n\n');
  try {
    const next = yamlText.trim() === ''
      ? (block.endsWith('\n') ? block : `${block}\n`)
      : appendBlock(yamlText, block);
    if (!findSubagentSequence(parseYaml(next))) {
      return error('STRUCTURE', '写入 preset-standard-acp 后仍找不到 delegation 组');
    }
    return { ok: true, yamlText: next, initialized: true, source: built.source, defaultSet };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return error('INVALID', `字段 preset-standard-acp 无法写入：${reason}`);
  }
}

function errorCode(caught: unknown): string | undefined {
  if (!caught || typeof caught !== 'object' || !('code' in caught)) return undefined;
  const code = (caught as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const warned = new Set<string>();

function warnOnce(log: PresetInitLogger, message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.warn(`wuyou-agent: ${message}`);
}

/**
 * Write the preset when the patch does not have its delegation group.
 * Returns the text to serve (the file after a successful seed).
 */
export async function ensureStandardAcpPreset(
  io: PresetPatchIO,
  standardTemplate: string | undefined,
  log: PresetInitLogger,
): Promise<{ yamlText: string; notice: string | null }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await io.readPatch();
    const seeded = seedStandardAcpPreset(current, standardTemplate);
    if (!seeded.ok) {
      warnOnce(log, seeded.message);
      return { yamlText: current, notice: null };
    }
    if (!seeded.initialized) return { yamlText: current, notice: null };
    try {
      await io.writePatchLocked(computeRevision(current), (locked) => {
        const again = seedStandardAcpPreset(locked, standardTemplate);
        if (!again.ok) throw Object.assign(new Error(again.message), { code: again.code });
        return again.yamlText;
      });
      const notice = presetInitNotice(seeded.source, seeded.defaultSet);
      log.info(`wuyou-agent: ${notice}`);
      return { yamlText: seeded.yamlText, notice };
    } catch (caught) {
      if (errorCode(caught) === 'STALE_REVISION') continue;
      if (errorCode(caught) === 'DEPENDENCY_UNAVAILABLE') {
        log.error('wuyou-agent: 缺少 @deepseek-ai/dsh-atomic-write，无法初始化 preset-standard-acp');
        return { yamlText: current, notice: null };
      }
      throw caught;
    }
  }
  log.error('wuyou-agent: 初始化 preset-standard-acp 时配置被反复修改，已放弃');
  return { yamlText: await io.readPatch(), notice: null };
}
