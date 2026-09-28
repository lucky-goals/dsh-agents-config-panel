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

const SUBAGENT_NAME = '@deepseek-ai/dsh-tool-subagent';
const STRUCTURE_ERROR = '未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持';
const READ_ONLY_ERROR = 'ACP 后端的 subagent 工具为只读';

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

function isEditable(config: Record<string, unknown>): boolean {
  return config.provider === 'spawn' || config.provider === 'fork';
}

function findRow(sequence: ReturnType<typeof findSubagentSequence>, id: string): unknown | undefined {
  return sequence?.items.find((row) => rowName(row) === SUBAGENT_NAME && rowId(row) === id);
}

function allSubagentRows(sequence: NonNullable<ReturnType<typeof findSubagentSequence>>) {
  return sequence.items.filter((row) => rowName(row) === SUBAGENT_NAME);
}

function toRows(sequence: NonNullable<ReturnType<typeof findSubagentSequence>>): SubagentRow[] {
  return allSubagentRows(sequence).map((row) => {
    const config = rowConfig(row);
    return {
      id: rowId(row),
      disabled: rowIsDisabled(row),
      editable: isEditable(config),
      config,
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

/** agentOptions block whose key sits at `keyIndent`. */
function agentOptionsSource(options: NonNullable<SubagentInput['agentOptions']>, keyIndent: string): string {
  const child = `${keyIndent}  `;
  let source = `${keyIndent}agentOptions:\n`;
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    if (options[key] !== undefined) source += pairLine(`agentOptions.${key}`, key, options[key], child);
  }
  return source;
}

function subagentRowSource(input: SubagentInput, indent: string): string {
  const child = `${indent}  `;
  const configIndent = `${indent}    `;
  let source = pairLine('toolName', 'id', idForToolName(input.toolName), child, `${indent}- `);
  source += `${child}name: '${SUBAGENT_NAME}'\n`;
  source += `${child}config:\n`;
  source += pairLine('provider', 'provider', input.provider, configIndent);
  source += pairLine('toolName', 'toolName', input.toolName, configIndent);
  if (input.backgroundMode !== undefined) {
    source += pairLine('backgroundMode', 'backgroundMode', input.backgroundMode, configIndent);
  }
  if (input.agentOptions !== undefined) {
    source += agentOptionsSource(input.agentOptions, configIndent);
  }
  return source;
}

function validateSubagentInput(
  input: Partial<SubagentInput>,
  catalog: ModelCatalog,
  mergedConfig?: Record<string, unknown>,
): string | null {
  if (input.toolName !== undefined && !validToolName(input.toolName)) {
    return `工具名 '${String(input.toolName)}' 格式不合法`;
  }
  const provider = (input.provider ?? mergedConfig?.provider) as string | undefined;
  if (provider !== 'spawn' && provider !== 'fork') {
    return `provider '${String(provider ?? '')}' 不合法`;
  }
  const options = input.agentOptions ?? (mergedConfig?.agentOptions as SubagentInput['agentOptions'] | undefined);
  if (provider === 'fork') {
    if (options !== undefined) return 'fork provider 不能配置 agentOptions';
    return null;
  }
  if (!options || typeof options !== 'object') return 'spawn provider 必须配置 agentOptions';
  if (typeof options.provider !== 'string' || options.provider.length === 0) {
    return 'agentOptions.provider 必填';
  }
  if (typeof options.model !== 'string' || options.model.length === 0) {
    return 'agentOptions.model 必填';
  }
  return validateModelRoute(catalog, options.provider, options.model, options.reasoningEffort);
}

export function listSubagents(yamlText: string): SubagentRow[] {
  const { sequence } = rowsFor(yamlText);
  return toRows(sequence);
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
): MutationResult {
  return guardMutation('input', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;

    const validation = validateSubagentInput(input, catalog);
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
    const inserted = `${lead}${subagentRowSource(input, indent)}`;
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
): MutationResult {
  const patchKeys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
  return guardMutation(patchKeys.join(', ') || 'patch', () => {
    // Only agentOptions.reasoningEffort may be cleared with null.
    const blockedNull = unclearableNull(patch);
    if (blockedNull !== undefined) return error('INVALID', `字段 ${blockedNull} 不能清空`);
    const clearEffort = patch.agentOptions?.reasoningEffort === null;
    // From here on, the patch holds real values only (a cleared effort is absent).
    const values = (clearEffort
      ? { ...patch, agentOptions: { ...patch.agentOptions, reasoningEffort: undefined } }
      : patch) as Partial<SubagentInput>;

    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;
    const row = findRow(sequence, id);
    if (!row) return error('NOT_FOUND', `未找到 subagent '${id}'`);
    const current = rowConfig(row);
    if (!isEditable(current)) return error('READ_ONLY', READ_ONLY_ERROR);

    // spawn → fork without explicit agentOptions: the stale spawn options are
    // dropped (fork forbids them). An explicit patch.agentOptions still fails
    // validation below.
    const switchingToFork = values.provider === 'fork'
      && values.agentOptions === undefined
      && current.agentOptions !== undefined;
    const mergedOptions: Record<string, unknown> | undefined = values.agentOptions
      ? { ...(current.agentOptions as Record<string, unknown> | undefined), ...values.agentOptions }
      : current.agentOptions as Record<string, unknown> | undefined;
    // Validate the row as it will be after the clear.
    if (clearEffort && mergedOptions) delete mergedOptions.reasoningEffort;
    for (const key of ['provider', 'model'] as const) {
      if (mergedOptions && mergedOptions[key] === undefined) delete mergedOptions[key];
    }
    const merged: Record<string, unknown> = {
      ...current,
      ...(values as Record<string, unknown>),
      ...(values.agentOptions !== undefined ? { agentOptions: mergedOptions } : {}),
    };
    if (switchingToFork) delete merged.agentOptions;
    // Validate against the merged options so a partial agentOptions patch
    // (e.g. only clearing reasoningEffort) keeps the row's provider/model.
    const validation = validateSubagentInput(
      values.agentOptions !== undefined ? { ...values, agentOptions: mergedOptions as SubagentInput['agentOptions'] } : values,
      catalog,
      merged,
    );
    if (validation) return error('INVALID', validation);

    const currentRows = allSubagentRows(sequence);
    if (values.toolName !== undefined) {
      if (currentRows.some((other) => other !== row && rowConfig(other).toolName === values.toolName)) {
        return error('DUPLICATE', `工具名 '${values.toolName}' 已存在`);
      }
      // Unique against every delegation row, not only subagent rows (F22-ID).
      const nextId = idForToolName(values.toolName);
      if (sequence.items.some((other) => other !== row && rowId(other) === nextId)) {
        return error('DUPLICATE', `id '${nextId}' 已存在`);
      }
    }

    // Unchanged values and clears of absent keys produce no edit: re-saving a
    // row is a byte-identical no-op.
    const edits: FieldTextEdit[] = [];
    const push = (edit: FieldTextEdit | undefined) => {
      if (edit) edits.push(edit);
    };
    const rowIdPair = pairFor(row, 'id');
    if (values.toolName !== undefined && rowIdPair?.value) {
      push(replaceValueEdit(yamlText, 'toolName', rowIdPair.value, mapKeyColumn(yamlText, row), idForToolName(values.toolName)));
    }
    const configNode = pairValue(row, 'config');
    if (!isMap(configNode)) return error('STRUCTURE', STRUCTURE_ERROR);
    for (const key of ['toolName', 'provider', 'backgroundMode'] as const) {
      const value = values[key];
      if (value !== undefined) push(setPairEdit(yamlText, configNode, key, value));
    }
    if (switchingToFork) {
      // Drop only this row's `agentOptions:` block (key line through the end of
      // its value); following comments and sibling rows stay byte-identical.
      const optionsPair = pairFor(configNode, 'agentOptions');
      const valueRange = nodeRange(optionsPair?.value);
      const keyRange = nodeRange(optionsPair?.key);
      if (!optionsPair || !valueRange || !keyRange) return error('STRUCTURE', STRUCTURE_ERROR);
      const newline = yamlText.indexOf('\n', valueRange[1] - 1);
      const end = yamlText[valueRange[1] - 1] === '\n' || newline < 0 ? valueRange[1] : newline + 1;
      edits.push({ start: lineStart(yamlText, keyRange[0]), end, text: '', field: 'provider' });
    } else if (values.agentOptions !== undefined) {
      const optionsNode = pairValue(configNode, 'agentOptions');
      if (isMap(optionsNode)) {
        for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
          const value = values.agentOptions[key];
          if (value !== undefined) push(setPairEdit(yamlText, optionsNode, key, value, `agentOptions.${key}`));
        }
        if (clearEffort) push(removePairEdit(yamlText, optionsNode, 'reasoningEffort', 'agentOptions.reasoningEffort'));
      } else if (optionsNode === undefined) {
        // fork → spawn: the row has no agentOptions yet; append a fresh block at
        // the config key column (a cleared effort is simply not written).
        const range = nodeRange(configNode);
        if (!range) return error('STRUCTURE', STRUCTURE_ERROR);
        const lead = range[1] > 0 && yamlText[range[1] - 1] !== '\n' ? '\n' : '';
        const text = `${lead}${agentOptionsSource(values.agentOptions, mapKeyColumn(yamlText, configNode))}`;
        edits.push({ start: range[1], end: range[1], text, field: 'agentOptions' });
      } else {
        return error('STRUCTURE', STRUCTURE_ERROR);
      }
    }
    if (edits.length === 0) return { ok: true, yamlText };
    return { ok: true, yamlText: applyFieldEdits(yamlText, edits, patchKeys.join(', ') || 'patch') };
  });
}

export function removeSubagent(yamlText: string, id: string): MutationResult {
  return guardMutation('id', () => {
    const sequence = locateRows(yamlText);
    if (isResult(sequence)) return sequence;
    const row = findRow(sequence, id);
    if (!row) return error('NOT_FOUND', `未找到 subagent '${id}'`);
    const config = rowConfig(row);
    if (!isEditable(config)) return error('READ_ONLY', READ_ONLY_ERROR);
    const range = nodeRange(row);
    if (!range) return error('STRUCTURE', STRUCTURE_ERROR);
    const start = lineStart(yamlText, range[0]);
    // Collection ranges already include the row's final line ending, but not
    // the following blank line. Removing exactly the range preserves both sides.
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start, end: range[1], text: '', field: 'id' }], 'id') };
  });
}
