import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, isMap, isSeq, Scalar, stringify } from 'yaml';
import type { Document, YAMLMap, YAMLSeq, Node } from 'yaml';

/**
 * Compute the optimistic-lock revision for the exact YAML source text.
 */
export function computeRevision(yamlText: string): string {
  return createHash('sha256').update(yamlText, 'utf8').digest('hex');
}

/** Parse YAML while retaining the source ranges attached to every CST node. */
export function parseYaml(yamlText: string): Document {
  const document = parseDocument(yamlText);
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  return document;
}

export function pairValue(node: unknown, key: string): Node | undefined {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => scalarString(item.key) === key);
  return pair?.value as Node | undefined;
}

export function pairFor(node: unknown, key: string): { key: Node; value: Node } | undefined {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => scalarString(item.key) === key);
  return pair as { key: Node; value: Node } | undefined;
}

export function scalarString(node: unknown): string {
  if (node instanceof Scalar) return String(node.value);
  if (node && typeof node === 'object' && 'value' in node) {
    return String((node as { value: unknown }).value);
  }
  return String(node ?? '');
}

export function nodeJson<T = unknown>(node: unknown): T | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof (node as { toJSON?: () => unknown }).toJSON === 'function') {
    return (node as { toJSON: () => T }).toJSON();
  }
  return node as T;
}

export function nodeRange(node: unknown): [number, number] | undefined {
  const range = (node as { range?: unknown } | undefined)?.range;
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    return undefined;
  }
  return [range[0], range[1]];
}

export function lineStart(text: string, offset: number): number {
  const newline = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

export function indentationAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  const match = text.slice(start, offset).match(/^[ \t]*/);
  return match?.[0] ?? '';
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Apply non-overlapping source edits and parse the result before returning it.
 * Descending offsets make every edit independent of changes before it.
 */
export function applyTextEdits(yamlText: string, edits: TextEdit[]): string {
  // Several zero-width insertions at one offset (appending keys to a map) are
  // applied last-first so the output keeps their given order.
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      if (b.edit.start !== a.edit.start) return b.edit.start - a.edit.start;
      const bothInserts = a.edit.start === a.edit.end && b.edit.start === b.edit.end;
      return bothInserts ? b.index - a.index : a.index - b.index;
    })
    .map(({ edit }) => edit);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    if (ordered[index].start < ordered[index + 1].end) {
      throw new Error('Overlapping YAML source edits');
    }
  }

  let result = yamlText;
  for (const edit of ordered) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  parseYaml(result);
  return result;
}

function mapWithId(node: unknown, id: string): YAMLMap | undefined {
  if (!isMap(node)) return undefined;
  return scalarString(pairValue(node, 'id')) === id ? node : undefined;
}

function findInsertContaining(root: YAMLSeq, id: string): YAMLMap | undefined {
  for (const item of root.items) {
    const insert = pairValue(item, 'insert');
    if (!isSeq(insert)) continue;
    const match = insert.items.map((entry) => mapWithId(entry, id)).find(Boolean);
    if (match) return match;
  }
  return undefined;
}

/** Locate the real delegation config sequence used by Panel A. */
export function findSubagentSequence(document: Document): YAMLSeq | undefined {
  const root = document.contents;
  if (!isSeq(root)) return undefined;
  const preset = findInsertContaining(root, 'preset-standard-acp');
  const presetConfig = pairValue(preset, 'config');
  const plugins = pairValue(presetConfig, 'plugins');
  if (!isSeq(plugins)) return undefined;
  const delegation = plugins.items.find((entry) => {
    return scalarString(pairValue(entry, 'id')) === 'delegation' &&
      scalarString(pairValue(entry, 'name')) === 'cordis:group';
  });
  const config = pairValue(delegation, 'config');
  return isSeq(config) ? config : undefined;
}

/** Locate the root agent-teams plugin config used by Panel B. */
export function findAgentTeamsConfig(document: Document): YAMLMap | undefined {
  const root = document.contents;
  if (!isSeq(root)) return undefined;
  const plugin = root.items.find((entry) => scalarString(pairValue(entry, 'id')) === 'agent-teams');
  const config = pairValue(plugin, 'config');
  return isMap(config) ? config : undefined;
}

export function findProfileNode(config: YAMLMap | undefined, profileName: string): YAMLMap | undefined {
  const profiles = pairValue(config, 'profiles');
  if (!isMap(profiles)) return undefined;
  const profile = pairValue(profiles, profileName);
  return isMap(profile) ? profile : undefined;
}

export function findMembersSequence(
  config: YAMLMap | undefined,
  profileName: string,
): YAMLSeq | undefined {
  return ((): YAMLSeq | undefined => {
    const profile = findProfileNode(config, profileName);
    const members = pairValue(profile, 'members');
    return isSeq(members) ? members : undefined;
  })();
}

/** Return the start of the first trailing line after a sequence range. */
export function sequenceTailInsertionOffset(text: string, sequence: YAMLSeq): number {
  const range = nodeRange(sequence);
  if (!range) throw new Error('Target YAML sequence has no source range');
  let offset = range[1];
  while (offset < text.length && (text[offset] === '\r' || text[offset] === '\n')) {
    offset += 1;
  }
  return offset;
}

export function nodeLineIndent(text: string, node: unknown): string {
  const range = nodeRange(node);
  if (!range) throw new Error('Target YAML node has no source range');
  return indentationAt(text, range[0]);
}

/**
 * Column (as leading spaces) of the keys of a block map: the key of its first
 * pair, measured from the start of that key's line. For a sequence-item map
 * (`- name: x`) this is the column after `- `, not the line's leading
 * whitespace, so appended keys line up with the existing ones.
 */
export function mapKeyColumn(text: string, map: unknown): string {
  const firstKey = isMap(map) ? map.items[0]?.key : undefined;
  const range = nodeRange(firstKey);
  if (!range) return nodeLineIndent(text, map);
  return ' '.repeat(range[0] - lineStart(text, range[0]));
}

/** A field whose value could not be serialized into valid YAML. */
export class FieldWriteError extends Error {
  constructor(readonly field: string, reason: string) {
    super(reason);
  }
}

/** Field-aware edit: `field` names the user field if the result fails to parse. */
export interface FieldTextEdit extends TextEdit {
  field?: string;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Serialize a mapping key; plain identifiers stay bare. */
export function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : stringify(key, { lineWidth: 0 }).trimEnd();
}

/**
 * Serialize one value for insertion right after `key: ` where the key sits at
 * `keyIndent`. Never folds long lines (lineWidth 0); block scalars have their
 * content re-indented two columns under the key and keep their trailing
 * newline (the caller replaces through the old value's line end). Collections
 * are written in flow style so they stay on the key's line.
 */
export function yamlValue(field: string, value: unknown, keyIndent: string): { text: string; block: boolean } {
  let raw: string;
  try {
    raw = isScalarLike(value)
      ? stringify(value, { lineWidth: 0 })
      : stringify(value, { lineWidth: 0, collectionStyle: 'flow' });
  } catch (caught) {
    throw new FieldWriteError(field, caught instanceof Error ? caught.message : String(caught));
  }
  const lines = raw.replace(/\n$/, '').split('\n');
  if (lines.length === 1) return { text: lines[0], block: false };
  if (!/^[|>]/.test(lines[0])) {
    throw new FieldWriteError(field, '序列化结果跨行且不是块标量');
  }
  const contentIndent = `${keyIndent}  `;
  const body = lines.slice(1).map((line) => (line.length === 0 ? '' : `${contentIndent}${line}`));
  return { text: `${lines[0]}\n${body.join('\n')}\n`, block: true };
}

function isScalarLike(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/**
 * Edit replacing `node` (an existing value) with `value`, or undefined when
 * the parsed values are already equal (no-op keeps the source byte-identical).
 */
export function replaceValueEdit(
  text: string,
  field: string,
  node: unknown,
  keyIndent: string,
  value: unknown,
): FieldTextEdit | undefined {
  if (isDeepStrictEqual(nodeJson(node), value)) return undefined;
  const range = nodeRange(node);
  if (!range) throw new FieldWriteError(field, '原值缺少源码位置');
  const { text: serialized, block } = yamlValue(field, value, keyIndent);
  let end = range[1];
  if (block) {
    // A block scalar must own the rest of its line; consume through the end
    // of the old value's last line.
    if (text[end - 1] !== '\n') {
      const newline = text.indexOf('\n', end);
      end = newline < 0 ? text.length : newline + 1;
    }
  } else if (text[end - 1] === '\n') {
    // Old value was a block scalar whose range includes its newline; keep one.
    return { start: range[0], end, text: `${serialized}\n`, field };
  }
  return { start: range[0], end, text: serialized, field };
}

/** Edit appending `key: value` to the end of block map `map`. */
export function appendPairEdit(text: string, map: unknown, key: string, value: unknown, field = key): FieldTextEdit {
  const range = nodeRange(map);
  if (!range) throw new FieldWriteError(field, '目标映射缺少源码位置');
  const indent = mapKeyColumn(text, map);
  const { text: serialized, block } = yamlValue(field, value, indent);
  const lead = range[1] > 0 && text[range[1] - 1] !== '\n' ? '\n' : '';
  return {
    start: range[1],
    end: range[1],
    text: `${lead}${indent}${yamlKey(key)}: ${serialized}${block ? '' : '\n'}`,
    field,
  };
}

/** Edit setting `key` in block map `map`: replace in place, append, or no-op. */
export function setPairEdit(text: string, map: unknown, key: string, value: unknown, field = key): FieldTextEdit | undefined {
  const pair = pairFor(map, key);
  if (pair?.value !== undefined && pair.value !== null) {
    return replaceValueEdit(text, field, pair.value, mapKeyColumn(text, map), value);
  }
  return appendPairEdit(text, map, key, value, field);
}

/**
 * Edit deleting `key` (key line through the end of its value, so a multi-line
 * or block value goes as a whole) from block map `map`; undefined when the key
 * is absent. Surrounding blank lines and comments are untouched. When the key
 * shares the `- ` line of a sequence item, only the span up to the next key is
 * removed so that key moves onto the dash line.
 */
export function removePairEdit(text: string, map: unknown, key: string, field = key): FieldTextEdit | undefined {
  if (!isMap(map)) return undefined;
  const index = map.items.findIndex((item) => scalarString(item.key) === key);
  if (index < 0) return undefined;
  const pair = map.items[index];
  const keyRange = nodeRange(pair.key);
  if (!keyRange) throw new FieldWriteError(field, '原键缺少源码位置');

  const start = lineStart(text, keyRange[0]);
  const lead = text.slice(start, keyRange[0]);
  if (!/^[ \t]*$/.test(lead)) {
    // `- key: v` on the item line: cut to the next key so it takes the dash.
    const nextKey = nodeRange(map.items[index + 1]?.key);
    if (!/^[ \t]*-[ \t]+$/.test(lead) || !nextKey) {
      throw new FieldWriteError(field, '该键所在行无法单独删除');
    }
    return { start: keyRange[0], end: nextKey[0], text: '', field };
  }

  const valueEnd = nodeRange(pair.value)?.[1] ?? keyRange[1];
  let end = valueEnd;
  if (end === 0 || text[end - 1] !== '\n') {
    const newline = text.indexOf('\n', end);
    end = newline < 0 ? text.length : newline + 1;
  }
  return { start, end, text: '', field };
}

/**
 * Apply field edits; if the result does not parse, report the first field
 * whose own edit breaks the document (falling back to `fallbackField`).
 */
export function applyFieldEdits(yamlText: string, edits: FieldTextEdit[], fallbackField: string): string {
  try {
    return applyTextEdits(yamlText, edits);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    for (const edit of edits) {
      try {
        applyTextEdits(yamlText, [edit]);
      } catch {
        throw new FieldWriteError(edit.field ?? fallbackField, reason);
      }
    }
    throw new FieldWriteError(fallbackField, reason);
  }
}

/** Mutation result shape shared by the pure editors. */
type GuardedResult = { ok: true; yamlText: string } | { ok: false; code: string; message: string };

/**
 * Run a pure mutation so that no exception crosses its boundary: field write
 * failures and any other unexpected error become INVALID naming the field.
 */
export function guardMutation<R extends GuardedResult>(fallbackField: string, run: () => R): R | { ok: false; code: 'INVALID'; message: string } {
  try {
    return run();
  } catch (caught) {
    const field = caught instanceof FieldWriteError ? caught.field : fallbackField;
    const reason = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, code: 'INVALID', message: `字段 ${field} 无法写入：${reason}` };
  }
}

export function isYamlMap(node: unknown): node is YAMLMap {
  return isMap(node);
}

export function isYamlSeq(node: unknown): node is YAMLSeq {
  return isSeq(node);
}
