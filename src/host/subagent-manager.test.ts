import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSubagent,
  listSubagents,
  removeSubagent,
  updateSubagent,
} from './subagent-manager';
import { readCatalog } from './catalog';
import { resolveSubagentProviders } from './subagent-providers.js';

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
