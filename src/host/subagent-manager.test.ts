import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSubagent,
  listSubagents,
  moveSubagent,
  removeSubagent,
  updateSubagent,
} from './subagent-manager';
import { readCatalog } from './catalog';
import { resolveSubagentProviders } from './subagent-providers.js';
import {
  findSubagentSequence,
  lineStart,
  nodeRange,
  pairValue,
  parseYaml,
  scalarString,
} from './patch-io.js';

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

const patchProviders = resolveSubagentProviders(fixture, null);

function providerInfo(name: string): any {
  const provider = patchProviders.find((entry) => entry.name === name);
  expect(provider, `missing provider ${name}`).toBeDefined();
  return provider;
}

function targetRowBounds(text: string, id: string): [number, number] {
  const marker = new RegExp(`^([ \\t]*)- id: ${id}$`, 'm');
  const match = marker.exec(text);
  expect(match, `missing row ${id}`).not.toBeNull();
  const start = match!.index;
  const next = new RegExp(`^${match![1]}- id: `, 'm').exec(text.slice(start + match![0].length));
  return [start, next ? start + match![0].length + next.index : text.length];
}

function expectOnlyTargetRowChanged(original: string, changed: string, id: string): void {
  const [originalStart, originalEnd] = targetRowBounds(original, id);
  const [changedStart, changedEnd] = targetRowBounds(changed, id);
  expect(changed.slice(0, changedStart)).toBe(original.slice(0, originalStart));
  expect(changed.slice(changedEnd)).toBe(original.slice(originalEnd));
}

function rowConfig(text: string, id: string): Record<string, any> {
  const row = listSubagents(text).find((entry) => entry.id === id);
  expect(row, `missing row ${id}`).toBeDefined();
  return row!.config;
}

function resolvedMaxDepth(configured: unknown): unknown {
  if (configured === 'provider-managed') return undefined;
  if (configured !== undefined) return configured;
  return 1;
}

function assertMountable(config: Record<string, any>, provider: any): void {
  if (resolvedMaxDepth(config.maxDepth) !== undefined && !provider.capabilities.depthLimit) throw new Error('maxDepth');
  if (config.agentOptions !== undefined && !provider.capabilities.agentOptions) throw new Error('agentOptions');
  if (config.modelSelectionSettings === true && !provider.capabilities.agentOptions) throw new Error('modelSelectionSettings');
  if ((config.backgroundMode ?? 'one-shot') === 'continuable' && !provider.prepareContinuable) throw new Error('continuable');
}

function mountProvider(name: string): any {
  const info = providerInfo(name);
  return { capabilities: info.capabilities, prepareContinuable: info.capabilities.continuable };
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
      editable: true,
      disabled: false,
      config: { provider: 'ccacp' },
    });
    expect(rows.find((row) => row.id === 'tool-subagent-cursor')?.editable).toBe(true);
    expect(rows.find((row) => row.id === 'tool-subagent-codex')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'codex' },
      readOnlyReason: "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
    });
    expect(rows.find((row) => row.id === 'tool-subagent-claude-code')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'claude-code' },
      readOnlyReason: "provider 'claude-code' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
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

  it('keeps unregistered provider rows read-only for both update and remove', () => {
    const patch = updateSubagent(
      fixture,
      'tool-subagent-codex',
      { provider: 'spawn' },
      catalog,
      resolveSubagentProviders(fixture, null)
    );
    expect(patch).toMatchObject({
      ok: false,
      code: 'READ_ONLY',
      message: "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
    });
    expect(patch.ok ? patch.yamlText : fixture).toBe(fixture);

    const removed = removeSubagent(
      fixture,
      'tool-subagent-codex',
      resolveSubagentProviders(fixture, null)
    );
    expect(removed).toMatchObject({
      ok: false,
      code: 'READ_ONLY',
      message: "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
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

  it.each([
    ['spawn → ccacp', 'ccacp'],
    ['spawn → cursoracp', 'cursoracp'],
  ])('normalizes %s to an ACP-mountable target row', (_label, targetProvider) => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-coder',
      { provider: targetProvider } as any,
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-coder');

    expect(config).toMatchObject({
      provider: targetProvider,
      toolName: 'subagent_coder',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    });
    expect(config).not.toHaveProperty('agentOptions');
    expect(config).not.toHaveProperty('modelSelectionSettings');
    expect(config).not.toHaveProperty('persona');
    expect(config).not.toHaveProperty('toolFilter');
    assertMountable(config, mountProvider(targetProvider));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent-coder');
  });

  it('keeps the spawn → fork normalization regression mountable', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-coder',
      { provider: 'fork' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-coder');

    expect(config).toMatchObject({
      provider: 'fork',
      toolName: 'subagent_coder',
      backgroundMode: 'continuable',
    });
    expect(config).not.toHaveProperty('agentOptions');
    assertMountable(config, mountProvider('fork'));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent-coder');
  });

  it('drops modelSelectionSettings when the default spawn row switches to cursoracp', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent',
      { provider: 'cursoracp' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent');

    expect(config).toMatchObject({
      provider: 'cursoracp',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    });
    expect(config).not.toHaveProperty('agentOptions');
    expect(config).not.toHaveProperty('modelSelectionSettings');
    expect(config).not.toHaveProperty('persona');
    expect(config).not.toHaveProperty('toolFilter');
    assertMountable(config, mountProvider('cursoracp'));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent');
  });

  it('normalizes fork → ccacp and preserves only target-row bytes', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-fork',
      { provider: 'ccacp' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-fork');

    expect(config).toMatchObject({
      provider: 'ccacp',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    });
    expect(config).not.toHaveProperty('agentOptions');
    expect(config).not.toHaveProperty('persona');
    expect(config).not.toHaveProperty('toolFilter');
    assertMountable(config, mountProvider('ccacp'));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent-fork');
  });

  it('normalizes ccacp → fork by removing maxDepth and agentOptions', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-acp',
      { provider: 'fork', backgroundMode: 'continuable' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-acp');

    expect(config).toMatchObject({
      provider: 'fork',
      backgroundMode: 'continuable',
    });
    expect(config).not.toHaveProperty('maxDepth');
    expect(config).not.toHaveProperty('agentOptions');
    assertMountable(config, mountProvider('fork'));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent-acp');
  });

  it('preserves one-shot when ccacp → fork omits backgroundMode', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-acp',
      { provider: 'fork' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-acp');

    expect(config).toMatchObject({
      provider: 'fork',
      backgroundMode: 'one-shot',
    });
    expect(config).not.toHaveProperty('maxDepth');
    expect(config).not.toHaveProperty('agentOptions');
    assertMountable(config, mountProvider('fork'));
  });

  it('normalizes ccacp → spawn with supplied agentOptions and no maxDepth key', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-acp',
      {
        provider: 'spawn',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'high' },
      },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-acp');

    expect(config).toMatchObject({
      provider: 'spawn',
      backgroundMode: 'one-shot',
      agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'high' },
    });
    expect(config).not.toHaveProperty('maxDepth');
    assertMountable(config, mountProvider('spawn'));
    expectOnlyTargetRowChanged(fixture, changed, 'tool-subagent-acp');
  });

  it.each([
    ['ccacp → cursoracp', 'ccacp', 'cursoracp'],
    ['cursoracp → ccacp', 'cursoracp', 'ccacp'],
  ])('changes only provider for an ACP ↔ ACP switch (%s)', (_label, from, to) => {
    const source = from === 'ccacp' ? fixture : replaceFirstFrom(
      fixture,
      /^ *- id: tool-subagent-acp$/m,
      'provider: ccacp',
      'provider: cursoracp',
    );
    const changed = yamlText(updateSubagent(
      source,
      'tool-subagent-acp',
      { provider: to },
      catalog,
      patchProviders,
    ));
    const rowStart = findRequiredLine(source, /^ *- id: tool-subagent-acp$/m);
    const providerAt = source.indexOf(`provider: ${from}`, rowStart);
    expect(providerAt).toBeGreaterThan(rowStart);
    const expected = `${source.slice(0, providerAt)}provider: ${to}${source.slice(providerAt + `provider: ${from}`.length)}`;

    expect(changed).toBe(expected);
    expect(rowConfig(changed, 'tool-subagent-acp')).toEqual({
      provider: to,
      toolName: 'subagent_acp',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    });
    assertMountable(rowConfig(changed, 'tool-subagent-acp'), mountProvider(to));
  });

  it('keeps a real ACP row byte-identical when its effective values do not change', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-acp',
      { provider: 'ccacp', toolName: 'subagent_acp', backgroundMode: 'one-shot' },
      catalog,
      patchProviders,
    ));
    expect(changed).toBe(fixture);
  });

  it('changes only backgroundMode for a real spawn row', () => {
    const changed = yamlText(updateSubagent(
      fixture,
      'tool-subagent-coder',
      { backgroundMode: 'one-shot' },
      catalog,
      patchProviders,
    ));
    const rowStart = findRequiredLine(fixture, /^ *- id: tool-subagent-coder$/m);
    const backgroundAt = fixture.indexOf('backgroundMode: continuable', rowStart);
    expect(backgroundAt).toBeGreaterThan(rowStart);
    const expected = `${fixture.slice(0, backgroundAt)}backgroundMode: one-shot${fixture.slice(backgroundAt + 'backgroundMode: continuable'.length)}`;

    expect(changed).toBe(expected);
    assertMountable(rowConfig(changed, 'tool-subagent-coder'), mountProvider('spawn'));
  });

  it('removes persona and toolFilter before switching a spawn row to ACP', () => {
    const augmented = replaceFirstFrom(
      fixture,
      /^ *- id: tool-subagent-coder$/m,
      '                    reasoningEffort: max\n',
      '                    reasoningEffort: max\n                  persona: temporary persona\n                  toolFilter:\n                    - subagent\n',
    );
    const changed = yamlText(updateSubagent(
      augmented,
      'tool-subagent-coder',
      { provider: 'ccacp' },
      catalog,
      patchProviders,
    ));
    const config = rowConfig(changed, 'tool-subagent-coder');

    expect(config).toMatchObject({ provider: 'ccacp', backgroundMode: 'one-shot', maxDepth: 'provider-managed' });
    expect(config).not.toHaveProperty('agentOptions');
    expect(config).not.toHaveProperty('persona');
    expect(config).not.toHaveProperty('toolFilter');
    assertMountable(config, mountProvider('ccacp'));
    expectOnlyTargetRowChanged(augmented, changed, 'tool-subagent-coder');
  });

  it('rejects an update to an unknown provider without changing the fixture', () => {
    const result = updateSubagent(
      fixture,
      'tool-subagent-coder',
      { provider: 'codex' },
      catalog,
      patchProviders,
    );
    expect(result).toEqual({ ok: false, code: 'INVALID', message: "provider 'codex' 未注册" });
  });

  it('allows removing a known ACP row and changes no neighboring bytes', () => {
    const start = findRequiredLine(fixture, /^ *- id: tool-subagent-cursor$/m);
    const followingComment = findRequiredLine(fixture, /^ *# ── Specialized subagent tools\b/m);
    const end = fixture.lastIndexOf('\n', followingComment - 2) + 1;
    const result = removeSubagent(fixture, 'tool-subagent-cursor', patchProviders);
    const changed = yamlText(result);

    expect(changed).toBe(`${fixture.slice(0, start)}${fixture.slice(end)}`);
    expect(listSubagents(changed).some((row) => row.id === 'tool-subagent-cursor')).toBe(false);
  });

  it('creates a normalized ACP row with the exact v2.1 key set and order', () => {
    const changed = yamlText(createSubagent(
      fixture,
      {
        toolName: 'subagent_new_acp',
        provider: 'ccacp',
        backgroundMode: 'continuable',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' },
      } as any,
      catalog,
      patchProviders,
    ));
    const row = listSubagents(changed).find((entry) => entry.id === 'tool-subagent-new-acp');
    expect(row).toBeDefined();
    expect(row!.config).toEqual({
      provider: 'ccacp',
      toolName: 'subagent_new_acp',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    });
    expect(row!.config).not.toHaveProperty('disabled');
    expect(row!.config).not.toHaveProperty('persona');
    expect(row!.config).not.toHaveProperty('toolFilter');
    assertMountable(row!.config, mountProvider('ccacp'));
    expectOnlyInsertionBeforePresetTail(fixture, changed);
  });

  it('retains one-argument listSubagents compatibility while exposing known ACP rows as editable', () => {
    const rows = listSubagents(fixture);
    expect(rows.find((row) => row.id === 'tool-subagent-acp')).toMatchObject({
      editable: true,
      config: { provider: 'ccacp' },
    });
    expect(rows.find((row) => row.id === 'tool-subagent-codex')).toMatchObject({
      editable: false,
      readOnlyReason: "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
    });
  });
});

// ---------------------------------------------------------------------------
// K16 (v2.12): moving a subagent row up or down.
//
// The byte spans below are contract §2.1 transcribed: a row spans from its own
// `- id` line start to `node.range[1]` (the value end), collapsed onto the next
// row's line start when the two overlap. The fixture has exactly two such
// overlaps (architect → reviewer and reviewer → coder): both value ends reach
// 14 bytes into the next row's line, i.e. into its indentation, which the
// collapse leaves with the row that follows.
// ---------------------------------------------------------------------------

const MOVE_SUBAGENT_NAME = '@deepseek-ai/dsh-tool-subagent';

interface RowSpan {
  id: string;
  /** `lineStart(range[0])`: the row's own `- id` line start, indentation included. */
  start: number;
  /** `range[1]` before the §2.1 collapse. */
  valueEnd: number;
  /** Value end collapsed onto the next row's line start when they overlap. */
  end: number;
}

/** §2.1 byte spans of every dsh-tool-subagent row, in file order. */
function rowSpans(text: string, label: string): RowSpan[] {
  const sequence = findSubagentSequence(parseYaml(text));
  expect(sequence, label).toBeDefined();
  const raw = sequence!.items
    .filter((row) => scalarString(pairValue(row, 'name')) === MOVE_SUBAGENT_NAME)
    .map((row) => {
      const range = nodeRange(row);
      expect(range, label).toBeDefined();
      return {
        id: scalarString(pairValue(row, 'id')),
        start: lineStart(text, range![0]),
        valueEnd: range![1],
      };
    });
  return raw.map((row, index) => {
    const next = raw[index + 1];
    return { ...row, end: next !== undefined && next.start < row.valueEnd ? next.start : row.valueEnd };
  });
}

/** §2.1 swap of two adjacent rows: the two blocks trade places, the gap stays. */
function swappedText(text: string, earlierId: string, laterId: string): string {
  const spans = rowSpans(text, 'fixture');
  const index = spans.findIndex((span) => span.id === earlierId);
  const earlier = spans[index];
  const later = spans[index + 1];
  expect(earlier, earlierId).toBeDefined();
  if (later?.id !== laterId) throw new Error(`${earlierId} is followed by ${String(later?.id)}, not ${laterId}`);
  return text.slice(0, earlier.start)
    + text.slice(later.start, later.end)
    + text.slice(earlier.end, later.start)
    + text.slice(earlier.start, earlier.end)
    + text.slice(later.end);
}

function rowIds(text: string): string[] {
  return listSubagents(text).map((row) => row.id);
}

/** The id order after `first` traded places with the row below it. */
function idsAfterDownSwap(ids: readonly string[], first: string, second: string): string[] {
  const next = [...ids];
  const index = ids.indexOf(first);
  expect(index, first).toBeGreaterThanOrEqual(0);
  next[index] = second;
  next[index + 1] = first;
  return next;
}

function rowBlockStart(text: string, id: string): number {
  const at = text.indexOf(`- id: ${id}`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  return at - 14;
}

describe('K16 Subagent 排序 (v2.12): moveSubagent', () => {
  const fixtureIds = rowIds(fixture);

  it('starts from the 13 rows in patch order (the index the cases below rely on)', () => {
    expect(fixtureIds).toEqual([
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
  });

  const adjacentPairs = [
    ['fork ↔ acp', 'tool-subagent-fork', 'tool-subagent-acp'],
    ['explore ↔ architect', 'tool-subagent-explore', 'tool-subagent-architect'],
    ['architect ↔ reviewer', 'tool-subagent-architect', 'tool-subagent-reviewer'],
    ['codex ↔ claude-code', 'tool-subagent-codex', 'tool-subagent-claude-code'],
  ] as const;

  it.each(adjacentPairs)(
    '%s: down swaps the pair, then up restores the fixture byte for byte',
    (_pair, first, second) => {
      const down = yamlText(moveSubagent(fixture, first, 'down'));

      expect(down, 'a move must change bytes').not.toBe(fixture);
      expect(() => parseYaml(down)).not.toThrow();
      expect(down).toBe(swappedText(fixture, first, second));
      expect(rowIds(down)).toEqual(idsAfterDownSwap(fixtureIds, first, second));

      const up = yamlText(moveSubagent(down, first, 'up'));

      expect(() => parseYaml(up)).not.toThrow();
      expect(rowIds(up)).toEqual(fixtureIds);
      expect(up, 'down + up must be byte-identical to the fixture').toBe(fixture);
    },
  );

  it('fork down: the lead comment stays at its old offset and fork keeps every byte', () => {
    const spans = rowSpans(fixture, 'fixture');
    expect(spans[1].id).toBe('tool-subagent-fork');
    expect(spans[2].id).toBe('tool-subagent-acp');
    const fork = spans[1];
    const comment = '# Fork omits model selection';
    const commentAt = fixture.indexOf(comment);
    expect(commentAt).toBeGreaterThanOrEqual(0);
    expect(commentAt).toBeLessThan(fork.start);

    const changed = yamlText(moveSubagent(fixture, 'tool-subagent-fork', 'down'));
    const acpAt = changed.indexOf('- id: tool-subagent-acp');

    // The comment sits above `- id`, so it is not inside fork's span.
    expect(changed.indexOf(comment)).toBe(commentAt);
    expect(acpAt).toBeGreaterThan(changed.indexOf(comment));
    // ... it stays immediately above the row that took fork's slot.
    expect(changed.slice(commentAt, acpAt - 14)).toBe(fixture.slice(commentAt, fork.start));
    // Fork's own bytes moved as one block.
    const forkAt = rowBlockStart(changed, 'tool-subagent-fork');
    expect(changed.slice(forkAt, forkAt + (fork.end - fork.start))).toBe(fixture.slice(fork.start, fork.end));
  });

  it('explore down: the commented-out config/persona block stays in the gap between the rows', () => {
    const spans = rowSpans(fixture, 'fixture');
    expect(spans.map((span) => span.id).slice(4, 7)).toEqual([
      'tool-subagent-explore',
      'tool-subagent-architect',
      'tool-subagent-reviewer',
    ]);
    const explore = spans[4];
    const architect = spans[5];
    const gap = fixture.slice(explore.end, architect.start);
    expect(gap).toContain('# config:');
    expect(gap).toContain('#   persona: |');

    const changed = yamlText(moveSubagent(fixture, 'tool-subagent-explore', 'down'));
    const architectAt = changed.indexOf('- id: tool-subagent-architect');
    const exploreAt = changed.indexOf('- id: tool-subagent-explore');
    expect(architectAt).toBeGreaterThanOrEqual(0);
    expect(exploreAt).toBeGreaterThan(architectAt);

    // architect took explore's slot, the untouched gap follows it, explore follows the gap.
    const between = changed.slice(architectAt - 14, exploreAt - 14);
    expect(between).toBe(fixture.slice(architect.start, architect.end) + gap);
    expect(between).toContain('# config:');
    expect(between).toContain('#   persona: |');
    expect(between).toContain('#     禁止：改文件、装依赖、跑会写磁盘的命令、调用其他 subagent。');
  });

  it('architect down: the Reviewer comments travel with architect, the 14 spaces stay with reviewer', () => {
    const spans = rowSpans(fixture, 'fixture');
    expect(spans.map((span) => span.id).slice(5, 8)).toEqual([
      'tool-subagent-architect',
      'tool-subagent-reviewer',
      'tool-subagent-coder',
    ]);
    const architect = spans[5];
    const reviewer = spans[6];
    const coder = spans[7];

    // The two overlap in the fixture: each value end reaches into the next row's line.
    expect(architect.valueEnd).toBeGreaterThan(reviewer.start);
    expect(reviewer.valueEnd).toBeGreaterThan(coder.start);
    expect(architect.end).toBe(reviewer.start);
    expect(reviewer.end).toBe(coder.start);
    expect(fixture.slice(architect.start, architect.end))
      .toContain('# Reviewer: code review against contract');
    expect(fixture.slice(reviewer.start, reviewer.end))
      .toContain('# ccacp advertises persona:false — role instructions go in the task prompt');

    const changed = yamlText(moveSubagent(fixture, 'tool-subagent-architect', 'down'));
    const architectAt = changed.indexOf('- id: tool-subagent-architect');
    const reviewerAt = changed.indexOf('- id: tool-subagent-reviewer');
    const architectBlock = fixture.slice(architect.start, architect.end);
    const reviewerBlock = fixture.slice(reviewer.start, reviewer.end);

    // Reviewer moved up into architect's slot, architect follows immediately:
    // the collapsed spans swallow the gap, and nothing between them is left over.
    expect(reviewerAt).toBeLessThan(architectAt);
    expect(reviewerAt - 14).toBe(architect.start);
    expect(reviewerAt - 14 + reviewerBlock.length).toBe(architectAt - 14);
    expect(changed.slice(reviewerAt - 14, reviewerAt - 14 + reviewerBlock.length)).toBe(reviewerBlock);
    expect(changed.slice(architectAt - 14, architectAt - 14 + architectBlock.length)).toBe(architectBlock);
    expect(changed.slice(reviewerAt - 14, architectAt - 14)).not.toContain('# Reviewer:');
    expect(changed.slice(architectAt - 14, architectAt - 14 + architectBlock.length))
      .toContain('# Reviewer: code review against contract');
    // Each row keeps its own 14 spaces of indentation, and only its own.
    expect(changed.slice(reviewerAt - 14, reviewerAt)).toBe('              ');
    expect(changed.slice(architectAt - 14, architectAt)).toBe('              ');
    expect(changed[reviewerAt - 15]).toBe('\n');
    expect(changed[architectAt - 15]).toBe('\n');
  });

  it('codex down: both read-only rows keep their own disabled/provider bytes and stay read-only', () => {
    const spans = rowSpans(fixture, 'fixture');
    expect(spans.map((span) => span.id).slice(11)).toEqual(['tool-subagent-codex', 'tool-subagent-claude-code']);
    const codex = spans[11];
    const claude = spans[12];

    const changed = yamlText(moveSubagent(fixture, 'tool-subagent-codex', 'down'));
    const rows = listSubagents(changed);
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf('tool-subagent-claude-code')).toBeLessThan(ids.indexOf('tool-subagent-codex'));
    expect(rows.find((row) => row.id === 'tool-subagent-claude-code')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'claude-code', toolName: 'subagent_claude_code' },
    });
    expect(rows.find((row) => row.id === 'tool-subagent-codex')).toMatchObject({
      editable: false,
      disabled: true,
      config: { provider: 'codex', toolName: 'subagent_codex' },
    });

    const codexBlock = fixture.slice(codex.start, codex.end);
    const claudeBlock = fixture.slice(claude.start, claude.end);
    const claudeAt = rowBlockStart(changed, 'tool-subagent-claude-code');
    const codexAt = rowBlockStart(changed, 'tool-subagent-codex');
    expect(changed.slice(claudeAt, claudeAt + claudeBlock.length)).toBe(claudeBlock);
    expect(changed.slice(codexAt, codexAt + codexBlock.length)).toBe(codexBlock);
    // `disabled: true` belongs to each block, not to the pair as a whole.
    expect([...changed.slice(claudeAt, codexAt + codexBlock.length).matchAll(/disabled: true/g)]).toHaveLength(2);
    expect(changed.slice(claudeAt, claudeAt + claudeBlock.length)).toContain('provider: claude-code');
    expect(changed.slice(codexAt, codexAt + codexBlock.length)).toContain('provider: codex');
  });

  it('rejects the first row moving up and the last row moving down without returning text', () => {
    const first = moveSubagent(fixture, 'tool-subagent', 'up');
    expect(first).toEqual({ ok: false, code: 'INVALID', message: '已经是第一个 subagent，不能上移' });
    expect(first).not.toHaveProperty('yamlText');

    const last = moveSubagent(fixture, 'tool-subagent-claude-code', 'down');
    expect(last).toEqual({ ok: false, code: 'INVALID', message: '已经是最后一个 subagent，不能下移' });
    expect(last).not.toHaveProperty('yamlText');
  });

  it.each(['workflow-ptc', 'missing'])('NOT_FOUND for %s in both directions', (id) => {
    const expected = { ok: false, code: 'NOT_FOUND', message: `未找到 subagent '${id}'` };
    expect(moveSubagent(fixture, id, 'up')).toEqual(expected);
    expect(moveSubagent(fixture, id, 'down')).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// R3F: the two moveSubagent defects found while reviewing v2.12 (K16), plus
// the store regression the same review asked for. Every case below is red on
// the pre-fix implementation, and red for the reason named in its own title.
//
// Defect 1 — rowBlockEnd (subagent-manager.ts:496-501): a comment whose
// indentation is <= the row's key column is read as the end of that row's
// block, even when the same row's map continues right after the comment. The
// swap then parses, and even round-trips, but moves a key from one row to the
// other; when the receiving row already owns that key the swap is rejected as
// INVALID 「移动后的配置无法解析」 instead.
// Defect 2 — moveSubagent (subagent-manager.ts:520-540): a swapped last row
// sitting at EOF without a trailing newline either silently loses bytes (the
// blank line between the pair migrates to the end of the file) or is rejected
// with INVALID 「移动后的配置无法解析」.
//
// The patch below is the smallest shape `findSubagentSequence` accepts: root
// sequence → `insert` item → `id: preset-standard-acp` → `config.plugins` →
// `id: delegation` / `name: cordis:group` → `config` sequence.
// 14 spaces = a row's own `- id` indent, 16 = that row's key column.
// ---------------------------------------------------------------------------

describe('R3F Subagent 排序回归 (v2.12 review)', () => {
  const HEAD = [
    '- insert:',
    '    - id: preset-standard-acp',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        plugins:',
    '          - id: delegation',
    '            name: cordis:group',
    '            config:',
    '',
  ].join('\n');

  const ROW_A = [
    '              - id: a',
    "                name: '@deepseek-ai/dsh-tool-subagent'",
    '                config:',
    '                  provider: spawn',
    '                  toolName: a',
    '',
  ].join('\n');

  const ROW_B = [
    '              - id: b',
    "                name: '@deepseek-ai/dsh-tool-subagent'",
    '                config:',
    '                  provider: spawn',
    '                  toolName: b',
    '',
  ].join('\n');

  /** The bytes from `id`'s own `- id` line start to the next row (or EOF). */
  function rowBlock(text: string, id: string): string {
    const marker = `- id: ${id}\n`;
    const at = text.indexOf(marker);
    expect(at, id).toBeGreaterThanOrEqual(0);
    const from = text.lastIndexOf('\n', at) + 1;
    const rest = text.slice(at + marker.length);
    const next = rest.search(/^[ \t]*- id: /m);
    return text.slice(from, next < 0 ? text.length : at + marker.length + next);
  }

  /** `a` moved down, asserted to succeed; null after recording the failure. */
  function moveDown(text: string): string | null {
    const result = moveSubagent(text, 'a', 'down');
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    return result.ok ? result.yamlText : null;
  }

  /**
   * A move is a pure reorder: the order becomes b, a and every row object is
   * deeply equal to its pre-move self. No key may migrate between the rows.
   */
  function expectPureSwap(original: string, moved: string): void {
    const before = listSubagents(original);
    expect(before.map((row) => row.id), 'precondition').toEqual(['a', 'b']);

    const after = listSubagents(moved);
    expect(after.map((row) => row.id)).toEqual(['b', 'a']);
    expect(after[0]).toEqual(before[1]);
    expect(after[1]).toEqual(before[0]);
  }

  /** `up` from the moved text must return the original byte for byte. */
  function expectUpRoundTrip(original: string, moved: string): void {
    const up = moveSubagent(moved, 'a', 'up');
    expect(up.ok, up.ok ? '' : `${up.code}: ${up.message}`).toBe(true);
    if (up.ok) expect(up.yamlText).toBe(original);
  }

  it('finding 1 (a): `disabled` after a key-column comment stays with its own row', () => {
    const text = HEAD + ROW_A + '                # temporarily off\n                disabled: true\n' + ROW_B;

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expect(listSubagents(moved)).toMatchObject([
      { id: 'b', disabled: false },
      { id: 'a', disabled: true },
    ]);
    // The comment documents `disabled`, so it is inside a's block, not b's.
    expect(rowBlock(moved, 'a')).toContain('# temporarily off');
    expect(rowBlock(moved, 'b')).not.toContain('# temporarily off');

    expectUpRoundTrip(text, moved);
  });

  it('finding 1 (a2): the same defect one column shallower (14-space comment)', () => {
    const text = HEAD + ROW_A + '              # temporarily off\n                disabled: true\n' + ROW_B;

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expect(listSubagents(moved)).toMatchObject([
      { id: 'b', disabled: false },
      { id: 'a', disabled: true },
    ]);
    expect(rowBlock(moved, 'a')).toContain('# temporarily off');

    expectUpRoundTrip(text, moved);
  });

  it('finding 1 (b): a comment above `config:` does not make the move INVALID', () => {
    const text = HEAD
      + '              - id: a\n'
      + "                name: '@deepseek-ai/dsh-tool-subagent'\n"
      + '                # note\n'
      + '                config:\n'
      + '                  provider: spawn\n'
      + '                  toolName: a\n'
      + ROW_B;

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expectUpRoundTrip(text, moved);
  });

  it('finding 1 (c): a tab-indented comment inside `config:` does not make the move INVALID', () => {
    const text = HEAD
      + '              - id: a\n'
      + "                name: '@deepseek-ai/dsh-tool-subagent'\n"
      + '                config:\n'
      + '                  provider: spawn\n'
      + '\t\t# tab note\n'
      + '                  toolName: a\n'
      + ROW_B;

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expectUpRoundTrip(text, moved);
  });

  it('finding 1 (d): when both rows carry `disabled` each keeps its own value', () => {
    const text = HEAD + ROW_A
      + '                # temporarily off\n'
      + '                disabled: true\n'
      + '              - id: b\n'
      + "                name: '@deepseek-ai/dsh-tool-subagent'\n"
      + '                config:\n'
      + '                  provider: spawn\n'
      + '                  toolName: b\n'
      + '                disabled: false\n';

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expect(listSubagents(moved)).toMatchObject([
      { id: 'b', disabled: false },
      { id: 'a', disabled: true },
    ]);

    expectUpRoundTrip(text, moved);
  });

  it('finding 2 (c): blank line between the pair, last row at EOF with no newline', () => {
    const text = HEAD + ROW_A + '\n' + ROW_B.slice(0, -1);
    expect(text.endsWith('\n')).toBe(false);

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expectUpRoundTrip(text, moved);
  });

  it('finding 2 (c2): last row with a trailing comment and no final newline', () => {
    const text = HEAD + ROW_A + ROW_B.slice(0, -1) + '\n                  # config tail';
    expect(text.endsWith('\n')).toBe(false);

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expectUpRoundTrip(text, moved);
  });

  it('finding 2 (d2): CRLF file whose last row has no final newline', () => {
    const text = (HEAD + ROW_A + ROW_B.slice(0, -1)).replace(/\n/g, '\r\n');
    expect(text.endsWith('\r\n')).toBe(false);

    const moved = moveDown(text);
    if (moved === null) return;

    expectPureSwap(text, moved);
    expectUpRoundTrip(text, moved);
  });
});
