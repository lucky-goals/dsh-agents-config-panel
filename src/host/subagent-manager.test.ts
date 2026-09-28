import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSubagent,
  listSubagents,
  removeSubagent,
  updateSubagent,
} from './subagent-manager';
import { readCatalog } from './catalog';

const fixture = readFileSync(
  new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url),
  'utf8'
);
const catalog = readCatalog(fixture);

type MutationResult =
  | { ok: true; yamlText: string }
  | { ok: false; code: string; message: string };

function yamlText(result: MutationResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result.yamlText;
}

function findRequiredLine(text: string, pattern: RegExp): number {
  const index = text.search(pattern);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function replaceFirstFrom(
  text: string,
  startPattern: RegExp,
  oldValue: string,
  newValue: string
): string {
  const start = findRequiredLine(text, startPattern);
  const offset = text.indexOf(oldValue, start);
  expect(offset).toBeGreaterThanOrEqual(0);
  return `${text.slice(0, offset)}${newValue}${text.slice(offset + oldValue.length)}`;
}

function expectOnlyInsertionBeforePresetTail(original: string, changed: string): void {
  const marker = /^ *# ── remaining model-facing rows\b/m;
  const originalMarker = findRequiredLine(original, marker);
  const changedMarker = findRequiredLine(changed, marker);
  expect(changed.slice(0, changedMarker).startsWith(original.slice(0, originalMarker))).toBe(true);
  expect(`${changed.slice(0, originalMarker)}${changed.slice(changedMarker)}`).toBe(original);
}

describe('SubagentManager against the real patch shape', () => {
  it('lists every dsh-tool-subagent row and excludes other delegation names', () => {
    const rows = listSubagents(fixture);
    expect(rows.map((row) => row.id)).toEqual([
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-acp',
      'tool-subagent-cursor',
      'tool-subagent-explore',
      'tool-subagent-architect',
      'tool-subagent-reviewer',
      'tool-subagent-coder',
      'tool-subagent-tester',
      'tool-subagent-front-designer',
      'tool-subagent-research',
      'tool-subagent-codex',
      'tool-subagent-claude-code',
    ]);
    expect(rows.every((row) => row.config && typeof row.config === 'object')).toBe(true);
    expect(rows.find((row) => row.id === 'tool-subagent')?.editable).toBe(true);
    expect(rows.find((row) => row.id === 'tool-subagent-fork')?.editable).toBe(true);
    expect(rows.find((row) => row.id === 'tool-subagent-acp')).toMatchObject({
      editable: false,
      disabled: false,
      config: { provider: 'ccacp' },
    });
    expect(rows.find((row) => row.id === 'tool-subagent-cursor')?.editable).toBe(false);
    expect(rows.find((row) => row.id === 'tool-subagent-codex')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'codex' },
    });
    expect(rows.find((row) => row.id === 'tool-subagent-claude-code')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'claude-code' },
    });
    expect(rows.some((row) => row.id === 'tool-subagent-control')).toBe(false);
    expect(rows.some((row) => row.id === 'tool-subagent-list-agents')).toBe(false);
    expect(rows.some((row) => row.id === 'tool-workflow')).toBe(false);
    expect(rows.some((row) => row.id === 'tool-ralph')).toBe(false);
  });

  it('creates a spawn row, reads it back, and preserves every byte outside the insertion', () => {
    const result = createSubagent(
      fixture,
      {
        toolName: 'subagent_qa',
        provider: 'spawn',
        backgroundMode: 'continuable',
        agentOptions: {
          provider: 'gpt-gateway',
          model: 'gpt-6-luna',
          reasoningEffort: 'high',
        },
      },
      catalog
    );
    const changed = yamlText(result);
    expect(changed).toContain('id: tool-subagent-qa');
    expect(listSubagents(changed).find((row) => row.id === 'tool-subagent-qa')).toMatchObject({
      editable: true,
      config: {
        provider: 'spawn',
        toolName: 'subagent_qa',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'high' },
      },
    });
    expectOnlyInsertionBeforePresetTail(fixture, changed);
    expect(changed).toContain("disabled: !!js process.platform === 'win32'");
  });

  it('rejects duplicate names, invalid fork options, missing spawn model, and unknown models', () => {
    const duplicate = createSubagent(
      fixture,
      {
        toolName: 'subagent_coder',
        provider: 'spawn',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' },
      },
      catalog
    );
    expect(duplicate).toMatchObject({
      ok: false,
      code: 'DUPLICATE',
      message: "工具名 'subagent_coder' 已存在",
    });

    const forkWithOptions = createSubagent(
      fixture,
      {
        toolName: 'subagent_fork_qa',
        provider: 'fork',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' },
      } as never,
      catalog
    );
    expect(forkWithOptions).toMatchObject({ ok: false, code: 'INVALID' });

    const missingModel = createSubagent(
      fixture,
      {
        toolName: 'subagent_missing_model',
        provider: 'spawn',
        agentOptions: { provider: 'gpt-gateway' },
      } as never,
      catalog
    );
    expect(missingModel).toMatchObject({ ok: false, code: 'INVALID' });

    const unknownModel = createSubagent(
      fixture,
      {
        toolName: 'subagent_unknown_model',
        provider: 'spawn',
        agentOptions: { provider: 'gpt-gateway', model: 'does-not-exist' },
      },
      catalog
    );
    expect(unknownModel).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('keeps ACP rows read-only for both update and remove', () => {
    const patch = updateSubagent(
      fixture,
      'tool-subagent-acp',
      { backgroundMode: 'continuable' },
      catalog
    );
    expect(patch).toMatchObject({
      ok: false,
      code: 'READ_ONLY',
      message: 'ACP 后端的 subagent 工具为只读',
    });
    expect(patch.ok ? patch.yamlText : fixture).toBe(fixture);

    const removed = removeSubagent(fixture, 'tool-subagent-acp');
    expect(removed).toMatchObject({
      ok: false,
      code: 'READ_ONLY',
      message: 'ACP 后端的 subagent 工具为只读',
    });
  });

  it('updates only coder reasoningEffort and preserves all surrounding source bytes', () => {
    const result = updateSubagent(
      fixture,
      'tool-subagent-coder',
      {
        agentOptions: {
          provider: 'gpt-gateway',
          model: 'gpt-6-luna',
          reasoningEffort: 'high',
        },
      },
      catalog
    );
    const changed = yamlText(result);
    const expected = replaceFirstFrom(
      fixture,
      /^ *- id: tool-subagent-coder$/m,
      'reasoningEffort: max',
      'reasoningEffort: high'
    );
    expect(changed).toBe(expected);
    expect(listSubagents(changed).find((row) => row.id === 'tool-subagent-coder')?.config).toMatchObject({
      agentOptions: { reasoningEffort: 'high' },
    });
  });

  it('removes a spawn row without changing comments or unrelated bytes', () => {
    const result = removeSubagent(fixture, 'tool-subagent');
    const changed = yamlText(result);
    const start = findRequiredLine(fixture, /^ *- id: tool-subagent$/m);
    const followingComment = findRequiredLine(fixture, /^ *# Fork omits model selection\b/m);
    const deleteEnd = fixture.lastIndexOf('\n', followingComment - 2) + 1;
    expect(deleteEnd).toBeGreaterThan(start);
    expect(fixture.slice(deleteEnd, followingComment)).toBe('\n');
    expect(changed).toBe(`${fixture.slice(0, start)}${fixture.slice(deleteEnd)}`);
    expect(changed).not.toContain('id: tool-subagent\n');
    expect(changed).toContain('# Fork omits model selection');
    expect(changed).toContain('id: tool-subagent-coder');
    expect(changed).toContain("disabled: !!js process.platform === 'win32'");
  });

  it('switches spawn → fork by dropping only that row\'s agentOptions block', () => {
    const changed = yamlText(updateSubagent(fixture, 'tool-subagent-coder', { provider: 'fork' }, catalog));

    const rowStart = findRequiredLine(fixture, /^ *- id: tool-subagent-coder$/m);
    const providerAt = fixture.indexOf('provider: spawn', rowStart);
    const optionsBlock = [
      '                  agentOptions:\n',
      '                    provider: gpt-gateway\n',
      '                    model: gpt-6-luna\n',
      '                    reasoningEffort: max\n',
    ].join('');
    const optionsAt = fixture.indexOf(optionsBlock, rowStart);
    expect(optionsAt).toBeGreaterThan(providerAt);

    const expected = `${fixture.slice(0, providerAt)}provider: fork${
      fixture.slice(providerAt + 'provider: spawn'.length, optionsAt)
    }${fixture.slice(optionsAt + optionsBlock.length)}`;
    expect(changed).toBe(expected);
    // The commented-out alternative agentOptions right after the block survives.
    expect(changed).toContain('                #  agentOptions:\n                #    provider: deepseek-official');

    const row = listSubagents(changed).find((entry) => entry.id === 'tool-subagent-coder');
    expect(row?.config).toMatchObject({ provider: 'fork', toolName: 'subagent_coder', backgroundMode: 'continuable' });
    expect(row?.config).not.toHaveProperty('agentOptions');
  });

  it('still rejects spawn → fork when the patch explicitly carries agentOptions', () => {
    const result = updateSubagent(
      fixture,
      'tool-subagent-coder',
      { provider: 'fork', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
      catalog
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('B05: switches the real fork row to spawn with a correctly indented agentOptions block', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-fork',
      { provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } },
      catalog
    ));
    const row = listSubagents(changed).find((entry) => entry.id === 'tool-subagent-fork');
    expect(row?.config).toMatchObject({
      provider: 'spawn',
      agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
    });

    // Exact source: the block is appended after backgroundMode at the config
    // key column, children two deeper; the blank line and comments after the
    // row are untouched.
    const rowStart = findRequiredLine(fixture, /^ *- id: tool-subagent-fork$/m);
    const tail = '                  backgroundMode: continuable\n';
    const tailEnd = fixture.indexOf(tail, rowStart) + tail.length;
    const block = [
      '                  agentOptions:\n',
      '                    provider: gpt-gateway\n',
      '                    model: gpt-6-luna\n',
      '                    reasoningEffort: max\n',
    ].join('');
    const providerAt = fixture.indexOf('provider: fork', rowStart);
    const expected = `${fixture.slice(0, providerAt)}provider: spawn${
      fixture.slice(providerAt + 'provider: fork'.length, tailEnd)
    }${block}${fixture.slice(tailEnd)}`;
    expect(changed).toBe(expected);

    const others = (text: string) => listSubagents(text).filter((entry) => entry.id !== 'tool-subagent-fork');
    expect(others(changed)).toEqual(others(fixture));
  });

  it('B02: re-saving every editable real row with its current fields is a byte-identical no-op', () => {
    const editable = listSubagents(fixture).filter((entry) => entry.editable);
    // Includes the default row whose toolName is the bare `subagent`.
    expect(editable.map((entry) => entry.id)).toContain('tool-subagent');
    for (const row of editable) {
      const { toolName, provider, backgroundMode, agentOptions } = row.config as any;
      const result = updateSubagent(fixture, row.id, { toolName, provider, backgroundMode, agentOptions }, catalog);
      expect(yamlText(result), row.id).toBe(fixture);
    }
  });

  it('maps the bare toolName `subagent` to id tool-subagent (not tool-subagent-subagent)', () => {
    const result = createSubagent(fixture, { toolName: 'subagent', provider: 'fork' }, catalog);
    // The real default row already owns both the toolName and the id.
    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE', message: "工具名 'subagent' 已存在" });
  });

  it('never throws from the pure boundary: an unwritable field becomes INVALID naming it', () => {
    const result = updateSubagent(
      fixture,
      'tool-subagent-coder',
      { backgroundMode: (() => 1) as unknown as 'continuable' },
      catalog
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
    expect(result.ok ? '' : result.message).toMatch(/^字段 backgroundMode 无法写入：/);
  });

  describe('M2: null clears agentOptions.reasoningEffort', () => {
    const coderRow = (text: string) => listSubagents(text).find((entry) => entry.id === 'tool-subagent-coder')!;
    const others = (text: string) => listSubagents(text).filter((entry) => entry.id !== 'tool-subagent-coder');

    it('removes only the reasoningEffort line of tool-subagent-coder', () => {
      const result = updateSubagent(
        fixture,
        'tool-subagent-coder',
        { agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: null } } as any,
        catalog
      );
      const changed = yamlText(result);
      const rowStart = findRequiredLine(fixture, /^ *- id: tool-subagent-coder$/m);
      const line = '                    reasoningEffort: max\n';
      const at = fixture.indexOf(line, rowStart);
      expect(at).toBeGreaterThan(rowStart);
      expect(changed).toBe(`${fixture.slice(0, at)}${fixture.slice(at + line.length)}`);
      expect(coderRow(changed).config.agentOptions).toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna' });
      expect(others(changed)).toEqual(others(fixture));
    });

    it('accepts a reasoningEffort-only null patch (provider/model come from the row)', () => {
      const changed = yamlText(updateSubagent(
        fixture, 'tool-subagent-coder', { agentOptions: { reasoningEffort: null } } as any, catalog,
      ));
      expect(coderRow(changed).config.agentOptions).toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna' });
    });

    it('clearing an absent reasoningEffort is a byte-identical no-op', () => {
      const once = yamlText(updateSubagent(fixture, 'tool-subagent-coder', { agentOptions: { reasoningEffort: null } } as any, catalog));
      expect(yamlText(updateSubagent(once, 'tool-subagent-coder', { agentOptions: { reasoningEffort: null } } as any, catalog))).toBe(once);
    });

    for (const [label, patch, field] of [
      ['agentOptions.model', { agentOptions: { model: null } }, 'agentOptions.model'],
      ['agentOptions.provider', { agentOptions: { provider: null } }, 'agentOptions.provider'],
      ['toolName', { toolName: null }, 'toolName'],
      ['provider', { provider: null }, 'provider'],
      ['backgroundMode', { backgroundMode: null }, 'backgroundMode'],
    ] as const) {
      it(`rejects clearing ${label} on a spawn row`, () => {
        const result = updateSubagent(fixture, 'tool-subagent-coder', patch as any, catalog);
        expect(result).toEqual({ ok: false, code: 'INVALID', message: `字段 ${field} 不能清空` });
      });
    }
  });

  it('F22-ID: new ids are unique against every delegation row, not only subagent rows', () => {
    // The real delegation config holds these non-subagent rows.
    for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'workflow-ptc', 'tool-workflow', 'tool-ralph']) {
      expect(fixture, id).toMatch(new RegExp(`^ *- id: ${id}$`, 'm'));
    }
    for (const [toolName, id] of [
      ['subagent_control', 'tool-subagent-control'],
      ['subagent_list_agents', 'tool-subagent-list-agents'],
    ] as const) {
      const result = createSubagent(fixture, { toolName, provider: 'fork' }, catalog);
      expect(result, toolName).toEqual({ ok: false, code: 'DUPLICATE', message: `id '${id}' 已存在` });
    }
  });

  it('F22-ID: renaming a subagent onto a non-subagent row id is DUPLICATE', () => {
    const result = updateSubagent(fixture, 'tool-subagent-coder', { toolName: 'subagent_control' }, catalog);
    expect(result).toEqual({ ok: false, code: 'DUPLICATE', message: "id 'tool-subagent-control' 已存在" });
  });

  it('F22-ID: toolName uniqueness is still checked among subagent rows only', () => {
    // subagent_workflow maps to id tool-subagent-workflow, which no row has, and no
    // subagent row uses that toolName; the non-subagent `tool-workflow` row is irrelevant.
    const result = createSubagent(fixture, { toolName: 'subagent_workflow', provider: 'fork' }, catalog);
    expect(result).toMatchObject({ ok: true });
    expect(listSubagents(yamlText(result)).map((row) => row.id)).toContain('tool-subagent-workflow');
  });

  it('throws the contract STRUCTURE message when delegation is missing', () => {
    const malformed = '- id: foo\n  name: bar\n';
    expect(() => listSubagents(malformed)).toThrow(
      '未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持'
    );
  });
});
