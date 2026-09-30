import { isMap } from 'yaml';
import {
  applyFieldEdits,
  findSubagentSequence,
  guardMutation,
  indentationAt,
  lineStart,
  mapKeyColumn,
  nodeJson,
  nodeLineIndent,
  nodeRange,
  pairFor,
  pairValue,
  parseYaml,
  removePairEdit,
  replaceValueEdit,
  scalarString,
  sequenceTailInsertionOffset,
  setPairEdit,
  yamlValue,
  type FieldTextEdit,
} from './patch-io.js';
import { validateModelRoute, type ModelCatalog } from './catalog.js';
import type { MutationResult } from './types.js';
import type { SubagentInput, SubagentPatch, SubagentRow } from './subagent-manager-types.js';
import { resolveSubagentProviders, type SubagentProviderInfo } from './subagent-providers.js';

const SUBAGENT_NAME = '@deepseek-ai/dsh-tool-subagent';
const STRUCTURE_ERROR = '未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持';
const PROVIDER_MANAGED = 'provider-managed';

/** READ_ONLY text for a row whose provider is not registered (contract v2.1 §2). */
export function unregisteredReadOnlyReason(provider: string): string {
  return `provider '${provider}' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑`;
}

function error(code: Exclude<MutationResult, { ok: true }>['code'], message: string): MutationResult {
  return { ok: false, code, message };
}

function rowsFor(yamlText: string) {
  const document = parseYaml(yamlText);
  const sequence = findSubagentSequence(document);
  if (!sequence) throw new Error(STRUCTURE_ERROR);
  return { document, sequence };
}

function rowId(row: unknown): string {
  return scalarString(pairValue(row, 'id'));
}

function rowConfig(row: unknown): Record<string, unknown> {
  const config = nodeJson<Record<string, unknown>>(pairValue(row, 'config'));
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function rowIsDisabled(row: unknown): boolean {
  const value = nodeJson<unknown>(pairValue(row, 'disabled'));
  return value === true || value === 'true';
}

function rowName(row: unknown): string {
  return scalarString(pairValue(row, 'name'));
}

function providerOf(config: Record<string, unknown>): string {
  return typeof config.provider === 'string' ? config.provider : String(config.provider ?? '');
}

function findProvider(providers: readonly SubagentProviderInfo[], name: string): SubagentProviderInfo | undefined {
  return providers.find((provider) => provider.name === name);
}

function findRow(sequence: ReturnType<typeof findSubagentSequence>, id: string): unknown | undefined {
  return sequence?.items.find((row) => rowName(row) === SUBAGENT_NAME && rowId(row) === id);
}

function allSubagentRows(sequence: NonNullable<ReturnType<typeof findSubagentSequence>>) {
  return sequence.items.filter((row) => rowName(row) === SUBAGENT_NAME);
}

function toRows(
  sequence: NonNullable<ReturnType<typeof findSubagentSequence>>,
  providers: readonly SubagentProviderInfo[],
): SubagentRow[] {
  return allSubagentRows(sequence).map((row) => {
    const config = rowConfig(row);
    const provider = providerOf(config);
    const editable = findProvider(providers, provider) !== undefined;
    return {
      id: rowId(row),
      disabled: rowIsDisabled(row),
      editable,
      config,
      ...(editable ? {} : { readOnlyReason: unregisteredReadOnlyReason(provider) }),
    };
  });
}

function validToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && /^subagent(?:_[a-z0-9]+)*$/.test(toolName);
}

function idForToolName(toolName: string): string {
  // toolName is `subagent` or `subagent_<a>_<b>`; the bare name is the real
  // default row `tool-subagent`.
  const suffix = toolName === 'subagent'
    ? ''
    : toolName.startsWith('subagent_') ? toolName.slice('subagent_'.length) : toolName;
  return `tool-subagent${suffix ? `-${suffix.replaceAll('_', '-')}` : ''}`;
}

/** `key: value` line at `keyIndent`, value serialized without folding. */
function pairLine(field: string, key: string, value: unknown, keyIndent: string, prefix = keyIndent): string {
  const { text, block } = yamlValue(field, value, keyIndent);
  return `${prefix}${key}: ${text}${block ? '' : '\n'}`;
}

type AgentOptions = NonNullable<SubagentInput['agentOptions']>;

/** agentOptions block whose key sits at `keyIndent`. */
function agentOptionsSource(options: AgentOptions, keyIndent: string): string {
  const child = `${keyIndent}  `;
  let source = `${keyIndent}agentOptions:\n`;
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    if (options[key] !== undefined) source += pairLine(`agentOptions.${key}`, key, options[key], child);
  }
  return source;
}

/** Final (normalized) config keys this plugin writes for a new row. */
interface NewRowConfig {
  provider: string;
  toolName: string;
  backgroundMode: string;
  maxDepth?: string;
  agentOptions?: AgentOptions;
}

function subagentRowSource(config: NewRowConfig, indent: string): string {
  const child = `${indent}  `;
  const configIndent = `${indent}    `;
  let source = pairLine('toolName', 'id', idForToolName(config.toolName), child, `${indent}- `);
  source += `${child}name: '${SUBAGENT_NAME}'\n`;
  source += `${child}config:\n`;
  source += pairLine('provider', 'provider', config.provider, configIndent);
  source += pairLine('toolName', 'toolName', config.toolName, configIndent);
  source += pairLine('backgroundMode', 'backgroundMode', config.backgroundMode, configIndent);
  if (config.maxDepth !== undefined) source += pairLine('maxDepth', 'maxDepth', config.maxDepth, configIndent);
  if (config.agentOptions !== undefined) source += agentOptionsSource(config.agentOptions, configIndent);
  return source;
}

/** Mount rule of dsh-tool-subagent: an omitted maxDepth resolves to depth 1. */
function resolvedMaxDepth(configured: unknown): unknown {
  if (configured === PROVIDER_MANAGED) return undefined;
  if (configured !== undefined) return configured;
  return 1;
}

/**
 * Validate a normalized final config (contract v2.1 §6). spawn/fork keep their
 * v2.0 texts; any other provider that takes agentOptions gets the generic one.
 */
function validateFinalConfig(
  target: SubagentProviderInfo,
  config: Record<string, unknown>,
  catalog: ModelCatalog,
): string | null {
  const name = target.name;
  if (!validToolName(config.toolName)) return `工具名 '${String(config.toolName)}' 格式不合法`;

  const options = config.agentOptions as Partial<AgentOptions> | undefined;
  if (name === 'fork') {
    if (options !== undefined) return 'fork provider 不能配置 agentOptions';
  } else if (target.capabilities.agentOptions) {
    if (!options || typeof options !== 'object') {
      return name === 'spawn' ? 'spawn provider 必须配置 agentOptions' : `provider '${name}' 必须配置 agentOptions`;
    }
    if (typeof options.provider !== 'string' || options.provider.length === 0) return 'agentOptions.provider 必填';
    if (typeof options.model !== 'string' || options.model.length === 0) return 'agentOptions.model 必填';
    const route = validateModelRoute(catalog, options.provider, options.model, options.reasoningEffort);
    if (route) return route;
  }

  // Mount checks that normalization should already have satisfied.
  if ((config.backgroundMode ?? 'one-shot') === 'continuable' && !target.capabilities.continuable) {
    return `provider '${name}' 不支持 backgroundMode continuable`;
  }
  if (resolvedMaxDepth(config.maxDepth) !== undefined && !target.capabilities.depthLimit) {
    return `provider '${name}' 必须将 maxDepth 设为 provider-managed`;
  }
  if ((config.agentOptions !== undefined || config.modelSelectionSettings === true) && !target.capabilities.agentOptions) {
    return `provider '${name}' 不支持 agentOptions`;
  }
  return null;
}

export function listSubagents(yamlText: string, providers?: readonly SubagentProviderInfo[]): SubagentRow[] {
  const { sequence } = rowsFor(yamlText);
  return toRows(sequence, providers ?? resolveSubagentProviders(yamlText, null));
}

function locateRows(yamlText: string): NonNullable<ReturnType<typeof findSubagentSequence>> | MutationResult {
  try {
    return rowsFor(yamlText).sequence;
  } catch (caught) {
    if (caught instanceof Error && caught.message === STRUCTURE_ERROR) return error('STRUCTURE', STRUCTURE_ERROR);
    throw caught;
  }
}

function isResult(value: unknown): value is MutationResult {
  return typeof value === 'object' && value !== null && 'ok' in value && !('items' in value);
}

export function createSubagent(
  yamlText: string,
  input: SubagentInput,
  catalog: ModelCatalog,
  providers?: readonly SubagentProviderInfo[],
): MutationResult {
  return guardMutation('input', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;

    if (input.toolName !== undefined && !validToolName(input.toolName)) {
      return error('INVALID', `工具名 '${String(input.toolName)}' 格式不合法`);
    }
    const directory = providers ?? resolveSubagentProviders(yamlText, null);
    const name = String(input.provider ?? '');
    const target = findProvider(directory, name);
    if (!target) return error('INVALID', `provider '${name}' 未注册`);

    // Normalize to the target's capabilities (contract v2.1 §5). fork keeps
    // its v2.0 rule: an explicit agentOptions is rejected, not dropped.
    const allowOptions = target.capabilities.agentOptions && name !== 'fork';
    const config: NewRowConfig = {
      provider: name,
      toolName: input.toolName,
      backgroundMode: target.capabilities.continuable
        ? (input.backgroundMode ?? 'continuable')
        : 'one-shot',
      ...(target.capabilities.depthLimit ? {} : { maxDepth: PROVIDER_MANAGED }),
    };
    if (name === 'fork' && input.agentOptions !== undefined) {
      return error('INVALID', 'fork provider 不能配置 agentOptions');
    }
    if (allowOptions && input.agentOptions !== undefined) {
      const { provider, model, reasoningEffort } = input.agentOptions;
      config.agentOptions = { provider, model, ...(reasoningEffort != null ? { reasoningEffort } : {}) } as AgentOptions;
    }
    const validation = validateFinalConfig(target, config as unknown as Record<string, unknown>, catalog);
    if (validation) return error('INVALID', validation);

    const existing = allSubagentRows(sequence);
    if (existing.some((row) => rowConfig(row).toolName === input.toolName)) {
      return error('DUPLICATE', `工具名 '${input.toolName}' 已存在`);
    }
    // ids share one cordis group with non-subagent rows (tool-subagent-control,
    // workflow-ptc, ...), so they must be unique across the whole sequence.
    const id = idForToolName(input.toolName);
    if (sequence.items.some((row) => rowId(row) === id)) return error('DUPLICATE', `id '${id}' 已存在`);

    const offset = sequenceTailInsertionOffset(yamlText, sequence);
    const indent = existing.length > 0
      ? nodeLineIndent(yamlText, existing[existing.length - 1])
      : indentationAt(yamlText, offset);
    const lead = offset > 0 && yamlText[offset - 1] !== '\n' ? '\n' : '';
    const inserted = `${lead}${subagentRowSource(config, indent)}`;
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start: offset, end: offset, text: inserted, field: 'input' }], 'input') };
  });
}

/** First field of an update patch set to null that may not be cleared. */
function unclearableNull(patch: SubagentPatch): string | undefined {
  for (const key of ['toolName', 'provider', 'backgroundMode', 'agentOptions'] as const) {
    if (patch[key] === null) return key;
  }
  const options = patch.agentOptions;
  if (options) {
    for (const key of ['provider', 'model'] as const) {
      if (options[key] === null) return `agentOptions.${key}`;
    }
  }
  return undefined;
}

export function updateSubagent(
  yamlText: string,
  id: string,
  patch: SubagentPatch,
  catalog: ModelCatalog,
  providers?: readonly SubagentProviderInfo[],
): MutationResult {
  const patchKeys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
  return guardMutation(patchKeys.join(', ') || 'patch', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;
    const row = findRow(sequence, id);
    if (!row) return error('NOT_FOUND', `未找到 subagent '${id}'`);
    const current = rowConfig(row);
    const directory = providers ?? resolveSubagentProviders(yamlText, null);
    const currentName = providerOf(current);
    if (!findProvider(directory, currentName)) {
      return error('READ_ONLY', unregisteredReadOnlyReason(currentName));
    }

    // Only agentOptions.reasoningEffort may be cleared with null.
    const blockedNull = unclearableNull(patch);
    if (blockedNull !== undefined) return error('INVALID', `字段 ${blockedNull} 不能清空`);
    const clearEffort = patch.agentOptions?.reasoningEffort === null;
    const patchOptions = patch.agentOptions ?? undefined;

    const targetName = patch.provider != null ? String(patch.provider) : currentName;
    const target = findProvider(directory, targetName);
    if (!target) return error('INVALID', `provider '${targetName}' 未注册`);
    if (patch.toolName != null && !validToolName(patch.toolName)) {
      return error('INVALID', `工具名 '${String(patch.toolName)}' 格式不合法`);
    }

    // ---- Normalize the merged row to the target's capabilities (§4). ----
    const providerChanged = targetName !== currentName;
    const toFork = targetName === 'fork';
    const inProcessSource = currentName === 'spawn' || currentName === 'fork';
    const allowOptions = target.capabilities.agentOptions && !toFork;
    // fork keeps its v2.0 rule: explicit agentOptions on (or into) fork from an
    // in-process row is rejected; from any other provider it is dropped.
    if (toFork && patchOptions !== undefined && (!providerChanged || inProcessSource)) {
      return error('INVALID', 'fork provider 不能配置 agentOptions');
    }

    const final: Record<string, unknown> = { ...current };
    if (patch.toolName != null) final.toolName = patch.toolName;
    final.provider = targetName;

    // agentOptions: merge while allowed; otherwise it must not survive.
    let finalOptions: Record<string, unknown> | undefined;
    if (allowOptions) {
      const base = (current.agentOptions && typeof current.agentOptions === 'object')
        ? { ...(current.agentOptions as Record<string, unknown>) }
        : undefined;
      if (patchOptions !== undefined || base !== undefined) {
        finalOptions = { ...(base ?? {}) };
        for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
          const value = patchOptions?.[key];
          if (value !== undefined && value !== null) finalOptions[key] = value;
        }
        if (clearEffort) delete finalOptions.reasoningEffort;
      }
    }
    if (finalOptions === undefined) delete final.agentOptions;
    else final.agentOptions = finalOptions;

    // backgroundMode: keep a legal value; a non-continuable target is one-shot.
    // Raw value: an unserializable one must reach yamlValue and fail as INVALID.
    const requestedMode = patch.backgroundMode != null ? (patch.backgroundMode as unknown) : undefined;
    if (!target.capabilities.continuable) {
      // Written as one-shot whenever the key is set or requested; an existing
      // one-shot line compares equal and stays byte-identical.
      if (current.backgroundMode !== undefined || requestedMode !== undefined) final.backgroundMode = 'one-shot';
    } else if (requestedMode !== undefined) {
      final.backgroundMode = requestedMode;
    }

    // maxDepth: provider-managed without depthLimit; drop that marker with it.
    if (!target.capabilities.depthLimit) final.maxDepth = PROVIDER_MANAGED;
    else if (current.maxDepth === PROVIDER_MANAGED) delete final.maxDepth;

    if (!target.capabilities.agentOptions) delete final.modelSelectionSettings;
    if (!target.capabilities.persona) delete final.persona;
    if (!target.capabilities.toolFilter) delete final.toolFilter;

    const validation = validateFinalConfig(target, final, catalog);
    if (validation) return error('INVALID', validation);

    const currentRows = allSubagentRows(sequence);
    if (patch.toolName != null) {
      if (currentRows.some((other) => other !== row && rowConfig(other).toolName === patch.toolName)) {
        return error('DUPLICATE', `工具名 '${patch.toolName}' 已存在`);
      }
      // Unique against every delegation row, not only subagent rows (F22-ID).
      const nextId = idForToolName(patch.toolName);
      if (sequence.items.some((other) => other !== row && rowId(other) === nextId)) {
        return error('DUPLICATE', `id '${nextId}' 已存在`);
      }
    }

    // ---- Edit only the keys whose final value differs from the row. ----
    // Unchanged values produce no edit: re-saving a row is a byte-identical no-op.
    const edits: FieldTextEdit[] = [];
    const push = (edit: FieldTextEdit | undefined) => {
      if (edit) edits.push(edit);
    };
    const configNode = pairValue(row, 'config');
    if (!isMap(configNode)) return error('STRUCTURE', STRUCTURE_ERROR);

    const rowIdPair = pairFor(row, 'id');
    if (patch.toolName != null && rowIdPair?.value) {
      push(replaceValueEdit(yamlText, 'toolName', rowIdPair.value, mapKeyColumn(yamlText, row), idForToolName(patch.toolName)));
    }
    for (const key of ['toolName', 'provider', 'backgroundMode', 'maxDepth'] as const) {
      if (final[key] === undefined) {
        if (current[key] !== undefined) push(removePairEdit(yamlText, configNode, key));
      } else if (final[key] !== current[key] || pairFor(configNode, key) === undefined) {
        push(setPairEdit(yamlText, configNode, key, final[key]));
      }
    }
    for (const key of ['modelSelectionSettings', 'persona', 'toolFilter'] as const) {
      if (final[key] === undefined && current[key] !== undefined) push(removePairEdit(yamlText, configNode, key));
    }

    const optionsNode = pairValue(configNode, 'agentOptions');
    if (finalOptions === undefined) {
      if (pairFor(configNode, 'agentOptions') !== undefined) {
        push(removePairEdit(yamlText, configNode, 'agentOptions', providerChanged ? 'provider' : 'agentOptions'));
      }
    } else if (isMap(optionsNode)) {
      for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
        const value = patchOptions?.[key];
        if (value !== undefined && value !== null) push(setPairEdit(yamlText, optionsNode, key, value, `agentOptions.${key}`));
      }
      if (clearEffort) push(removePairEdit(yamlText, optionsNode, 'reasoningEffort', 'agentOptions.reasoningEffort'));
    } else if (optionsNode === undefined) {
      // The row has no agentOptions yet (fork/ACP → spawn): append a fresh
      // block at the config key column (a cleared effort is simply not written).
      const range = nodeRange(configNode);
      if (!range) return error('STRUCTURE', STRUCTURE_ERROR);
      const lead = range[1] > 0 && yamlText[range[1] - 1] !== '\n' ? '\n' : '';
      const text = `${lead}${agentOptionsSource(finalOptions as AgentOptions, mapKeyColumn(yamlText, configNode))}`;
      edits.push({ start: range[1], end: range[1], text, field: 'agentOptions' });
    } else {
      return error('STRUCTURE', STRUCTURE_ERROR);
    }

    if (edits.length === 0) return { ok: true, yamlText };
    return { ok: true, yamlText: applyFieldEdits(yamlText, edits, patchKeys.join(', ') || 'patch') };
  });
}

export function removeSubagent(
  yamlText: string,
  id: string,
  providers?: readonly SubagentProviderInfo[],
): MutationResult {
  return guardMutation('id', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;
    const row = findRow(sequence, id);
    if (!row) return error('NOT_FOUND', `未找到 subagent '${id}'`);
    const provider = providerOf(rowConfig(row));
    const directory = providers ?? resolveSubagentProviders(yamlText, null);
    if (!findProvider(directory, provider)) return error('READ_ONLY', unregisteredReadOnlyReason(provider));
    const range = nodeRange(row);
    if (!range) return error('STRUCTURE', STRUCTURE_ERROR);
    const start = lineStart(yamlText, range[0]);
    // Collection ranges already include the row's final line ending, but not
    // the following blank line. Removing exactly the range preserves both sides.
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start, end: range[1], text: '', field: 'id' }], 'id') };
  });
}

/**
 * Return the movable block end for one row.  The first pass finds the last
 * actual key/value line covered by the YAML node range, so comments inside a
 * map never truncate that map.  The second pass adopts only deeper trailing
 * comments; a shallower comment is kept in the gap unless a following key
 * proves that the map continues after it.
 */
function rowBlockEnd(yamlText: string, row: unknown, nextStart: number): number {
  const range = nodeRange(row);
  if (!range) return nextStart;
  const start = lineStart(yamlText, range[0]);
  const configPair = pairFor(row, 'config');
  const anchor = configPair?.key ?? pairFor(row, 'id')?.key;
  const anchorRange = nodeRange(anchor);
  const keyColumn = anchorRange
    ? indentationAt(yamlText, anchorRange[0]).length + (configPair ? 0 : 2)
    : 0;

  const rangeEnd = Math.min(range[1], nextStart);
  let offset = start;
  let end = start;

  // `range[1]` is the value end, not necessarily the end of the last line
  // that belongs to the map.  Scan only that bounded region and ignore all
  // blank/comment lines when choosing the initial block end.
  while (offset < rangeEnd) {
    const newline = yamlText.indexOf('\n', offset);
    const physicalEnd = newline < 0 ? yamlText.length : newline;
    const stop = Math.min(physicalEnd, rangeEnd);
    const line = yamlText.slice(offset, stop);
    const contentEnd = line.endsWith('\r') ? stop - 1 : stop;
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      end = newline >= 0 && physicalEnd < rangeEnd ? physicalEnd + 1 : contentEnd;
    }

    if (newline < 0 || physicalEnd >= rangeEnd) break;
    offset = newline + 1;
  }

  // Continue after the last real key line.  A trailing newline is a gap byte,
  // so comments are scanned from the following line and adopted explicitly.
  offset = end;

  while (offset < nextStart) {
    const newline = yamlText.indexOf('\n', offset);
    const physicalEnd = newline < 0 ? yamlText.length : newline;
    const stop = Math.min(physicalEnd, nextStart);
    const line = yamlText.slice(offset, stop);
    const indent = /^[ \t]*/.exec(line)![0].length;
    const trimmed = line.trim();
    const afterLine = newline < 0 || physicalEnd >= nextStart ? nextStart : newline + 1;

    if (trimmed === '') {
      offset = afterLine;
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (indent > keyColumn) {
        end = Math.min(afterLine, nextStart);
        offset = afterLine;
        continue;
      }

      // A shallow comment may be interleaved inside the map.  Look ahead over
      // comments and blank lines; only a following map key keeps this comment
      // with the row.  Otherwise the comment belongs to the gap.
      let lookahead = afterLine;
      let continuationEnd: number | undefined;
      while (lookahead < nextStart) {
        const nextNewline = yamlText.indexOf('\n', lookahead);
        const nextPhysicalEnd = nextNewline < 0 ? yamlText.length : nextNewline;
        const nextStop = Math.min(nextPhysicalEnd, nextStart);
        const nextLine = yamlText.slice(lookahead, nextStop);
        const nextTrimmed = nextLine.trim();
        const nextIndent = /^[ \t]*/.exec(nextLine)![0].length;
        const nextAfterLine = nextNewline < 0 || nextPhysicalEnd >= nextStart
          ? nextStart
          : nextNewline + 1;

        if (nextTrimmed === '' || nextTrimmed.startsWith('#')) {
          lookahead = nextAfterLine;
          continue;
        }
        if (!nextTrimmed.startsWith('-') && nextIndent >= keyColumn) continuationEnd = nextAfterLine;
        break;
      }

      if (continuationEnd === undefined) break;
      end = continuationEnd;
      offset = continuationEnd;
      const continuationNewline = yamlText.indexOf('\n', offset);
      if (continuationNewline < 0 || continuationNewline >= nextStart) break;
      offset = continuationNewline + 1;
      continue;
    }

    // Any ordinary content here is outside the row unless it was accepted as
    // the map-key continuation in the look-ahead branch above.
    break;
  }

  return Math.min(end, nextStart);
}

export function moveSubagent(yamlText: string, id: string, direction: 'up' | 'down'): MutationResult {
  return guardMutation('id', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;

    const rows = allSubagentRows(sequence);
    const index = rows.findIndex((row) => rowId(row) === id);
    if (index < 0) return error('NOT_FOUND', `未找到 subagent '${id}'`);

    const target = direction === 'down' ? index + 1 : index - 1;
    if (target < 0) return error('INVALID', '已经是第一个 subagent，不能上移');
    if (target >= rows.length) return error('INVALID', '已经是最后一个 subagent，不能下移');

    const spans = rows.map((row, position) => {
      const range = nodeRange(row);
      if (!range) throw new Error(STRUCTURE_ERROR);
      const next = rows[position + 1];
      const nextStart = next ? lineStart(yamlText, nodeRange(next)![0]) : yamlText.length;
      return {
        start: lineStart(yamlText, range[0]),
        end: rowBlockEnd(yamlText, row, nextStart),
      };
    });

    const earlier = spans[Math.min(index, target)];
    const later = spans[Math.max(index, target)];
    const needsTemporaryFinalNewline = later.end === yamlText.length && !yamlText.endsWith('\n');
    const finalNewline = needsTemporaryFinalNewline
      ? (yamlText.includes('\r\n') ? '\r\n' : '\n')
      : '';
    const source = finalNewline ? yamlText + finalNewline : yamlText;
    const laterEnd = later.end + finalNewline.length;
    const swapped = source.slice(0, earlier.start)
      + source.slice(later.start, laterEnd)
      + source.slice(earlier.end, later.start)
      + source.slice(earlier.start, earlier.end)
      + source.slice(laterEnd);
    const result = finalNewline ? swapped.slice(0, -finalNewline.length) : swapped;

    try {
      parseYaml(result);
    } catch {
      return error('INVALID', '移动后的配置无法解析');
    }
    return { ok: true, yamlText: result };
  });
}
