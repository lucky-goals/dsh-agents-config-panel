import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from './patch-io.js';
import { readCatalog } from './catalog.js';
import { listSubagents } from './subagent-manager.js';
import { resolveSubagentProviders } from './subagent-providers.js';
import { listAcps, createAcp, updateAcp, removeAcp, importSubagentBundle } from './acp-manager.js';

const FIXTURE = readFileSync(resolve(__dirname, '../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const CATALOG = readCatalog(FIXTURE);

function ok(result: ReturnType<typeof createAcp>): string {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.yamlText;
}

describe('listAcps (real fixture)', () => {
  it('reads every root-insert @deepseek-ai/dsh-subagent-acp row with its real config', () => {
    const rows = listAcps(FIXTURE);
    expect(rows.map((r) => [r.id, r.config.providerName])).toEqual([
      ['subagent-acp', 'ccacp'],
      ['subagent-acp-cursor', 'cursoracp'],
      ['subagent-acp-kiro', 'kiroopsuacp'],
      ['subagent-acp-kiro-gpt', 'kirogptacp'],
    ]);
    const cc = rows[0].config;
    expect(cc.command).toBe('/opt/example/bin/claude-agent-acp');
    expect(cc.args).toEqual([]);
    expect(cc.permission).toBe('allow');
    expect(cc.env).toEqual({ ANTHROPIC_MODEL: 'claude-opus-5', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' });
    expect(rows[1].config.args).toEqual(['--trust', 'acp']);
    expect(rows[2].config.args).toEqual(['acp', '--trust-all-tools', '--model', 'claude-opus-5', '--effort', 'xhigh', '--agent', 'kiro_default']);
  });

  it('usedBy lists the subagent tools whose provider is this ACP', () => {
    const rows = listAcps(FIXTURE);
    const expected = (provider: string) =>
      listSubagents(FIXTURE).filter((r) => r.config.provider === provider).map((r) => String(r.config.toolName));
    for (const row of rows) expect(row.usedBy, row.id).toEqual(expected(row.config.providerName));
    expect(rows[0].usedBy.length).toBeGreaterThan(0);
  });
});

const NEW_ACP = { providerName: 'geminiacp', command: '/opt/example/bin/gemini', args: ['--experimental-acp'], permission: 'reject' as const, env: {} };

describe('createAcp / removeAcp', () => {
  it('appends a new root insert after the last ACP row; everything else is byte-identical', () => {
    const text = ok(createAcp(FIXTURE, NEW_ACP));
    const anchor = FIXTURE.indexOf('- id: ui-settings-general');
    const added = text.length - FIXTURE.length;
    expect(text.slice(0, anchor)).toBe(FIXTURE.slice(0, anchor));
    expect(text.slice(anchor + added)).toBe(FIXTURE.slice(anchor));
    expect(text.slice(anchor, anchor + added)).toBe(
      [
        '- insert:',
        '    - id: subagent-acp-geminiacp',
        "      name: '@deepseek-ai/dsh-subagent-acp'",
        '      config:',
        '        providerName: geminiacp',
        '        command: /opt/example/bin/gemini',
        '        args: [ --experimental-acp ]',
        '        permission: reject',
        '',
        '',
      ].join('\n'),
    );
    expect(listAcps(text).at(-1)).toMatchObject({ id: 'subagent-acp-geminiacp', config: NEW_ACP, usedBy: [] });
    expect(resolveSubagentProviders(text, null).map((p) => p.name)).toContain('geminiacp');
  });

  it('create then remove restores the original bytes', () => {
    const created = ok(createAcp(FIXTURE, { ...NEW_ACP, env: { GEMINI_MODEL: 'gemini-3' }, cwd: '/tmp' }));
    expect(ok(removeAcp(created, 'subagent-acp-geminiacp'))).toBe(FIXTURE);
  });

  it('works on a patch with no ACP rows (appends at the root tail)', () => {
    const base = '- id: tool-bash\n  name: "@deepseek-ai/dsh-tool-bash"\n';
    const text = ok(createAcp(base, NEW_ACP));
    expect(listAcps(text).map((r) => r.config.providerName)).toEqual(['geminiacp']);
    expect(text.startsWith(base)).toBe(true);
    expect(ok(removeAcp(text, 'subagent-acp-geminiacp'))).toBe(base);
  });

  it.each([
    [{ ...NEW_ACP, providerName: 'ccacp' }, 'DUPLICATE'],
    [{ ...NEW_ACP, providerName: 'spawn' }, 'INVALID'],
    [{ ...NEW_ACP, providerName: 'Bad Name' }, 'INVALID'],
    [{ ...NEW_ACP, command: '' }, 'INVALID'],
    [{ ...NEW_ACP, args: ['ok', 1] }, 'INVALID'],
    [{ ...NEW_ACP, env: { 'BAD KEY': 'x' } }, 'INVALID'],
    [{ ...NEW_ACP, permission: 'maybe' }, 'INVALID'],
    [{ ...NEW_ACP, cwd: '' }, 'INVALID'],
  ])('rejects %j with %s and does not write', (input, code) => {
    const result = createAcp(FIXTURE, input as any);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe(code);
  });

  it('refuses to remove an ACP that subagent tools still use (IN_USE), and 404s an unknown id', () => {
    const inUse = removeAcp(FIXTURE, 'subagent-acp');
    expect(inUse).toMatchObject({ ok: false, code: 'IN_USE' });
    expect(!inUse.ok && inUse.message).toContain('subagent_acp');
    expect(removeAcp(FIXTURE, 'nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('updateAcp', () => {
  it('changes only the edited value; comments and other rows stay byte-identical', () => {
    const text = ok(updateAcp(FIXTURE, 'subagent-acp-cursor', { permission: 'reject' }));
    const before = FIXTURE.split('\n');
    const after = text.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(changed).toEqual([['        permission: allow', '        permission: reject']]);
  });

  it('replaces a commented block args list with a flow list on the key line', () => {
    const text = ok(updateAcp(FIXTURE, 'subagent-acp-kiro', { args: ['acp', '--trust-all-tools'] }));
    expect(listAcps(text).find((r) => r.id === 'subagent-acp-kiro')!.config.args).toEqual(['acp', '--trust-all-tools']);
    expect(text).toContain('        args: [ acp, --trust-all-tools ]\n        permission: allow');
    // The kiro-gpt row's identical block list is untouched.
    expect(listAcps(text).find((r) => r.id === 'subagent-acp-kiro-gpt')!.config.args).toHaveLength(8);
    parseYaml(text);
  });

  it('sets, then clears env and cwd (cleared keys are removed, not written empty)', () => {
    const withEnv = ok(updateAcp(FIXTURE, 'subagent-acp-cursor', { env: { CURSOR_MODE: 'fast' }, cwd: '/work' }));
    expect(listAcps(withEnv)[1].config).toMatchObject({ env: { CURSOR_MODE: 'fast' }, cwd: '/work' });
    expect(ok(updateAcp(withEnv, 'subagent-acp-cursor', { env: {}, cwd: null }))).toBe(FIXTURE);
  });

  it('an unchanged patch is a byte-identical no-op', () => {
    const current = listAcps(FIXTURE)[0].config;
    expect(ok(updateAcp(FIXTURE, 'subagent-acp', { command: current.command, env: current.env, permission: current.permission }))).toBe(FIXTURE);
  });

  it('never renames providerName (subagent rows reference it) and validates values', () => {
    expect(updateAcp(FIXTURE, 'subagent-acp', { providerName: 'x' } as any)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(updateAcp(FIXTURE, 'subagent-acp', { command: '' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(updateAcp(FIXTURE, 'missing', { command: '/x' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('importSubagentBundle', () => {
  it('writes new ACPs and the subagents that use them in one pass; skips existing ones with a reason', () => {
    const result = importSubagentBundle(FIXTURE, {
      acps: [NEW_ACP, { ...NEW_ACP, providerName: 'ccacp' }],
      subagents: [
        { toolName: 'subagent_gemini', provider: 'geminiacp', backgroundMode: 'one-shot' },
        { toolName: 'subagent_coder', provider: 'spawn', backgroundMode: 'continuable', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        { toolName: 'subagent_ghost', provider: 'no-such-provider', backgroundMode: 'one-shot' },
      ],
    }, CATALOG, resolveSubagentProviders(FIXTURE, null));
    if (!result.ok) throw new Error(result.message);

    expect(result.report.created).toEqual({ acps: ['geminiacp'], subagents: ['subagent_gemini'] });
    expect(result.report.skipped.map((s) => [s.kind, s.name])).toEqual([
      ['acp', 'ccacp'],
      ['subagent', 'subagent_coder'],
      ['subagent', 'subagent_ghost'],
    ]);
    expect(result.report.skipped[0].reason).toContain('已存在');
    expect(result.report.skipped[2].reason).toContain('未注册');

    const gemini = listSubagents(result.yamlText).find((r) => r.config.toolName === 'subagent_gemini')!;
    expect(gemini.config).toMatchObject({ provider: 'geminiacp', backgroundMode: 'one-shot', maxDepth: 'provider-managed' });
    expect(listAcps(result.yamlText).at(-1)!.usedBy).toEqual(['subagent_gemini']);
  });

  it('an all-duplicate bundle leaves the file byte-identical', () => {
    const acp = listAcps(FIXTURE)[0].config;
    const result = importSubagentBundle(FIXTURE, { acps: [acp], subagents: [] }, CATALOG, resolveSubagentProviders(FIXTURE, null));
    expect(result).toMatchObject({ ok: true, yamlText: FIXTURE });
  });
});
