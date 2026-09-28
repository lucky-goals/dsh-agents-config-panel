/**
 * Render tests for both React panels (react-dom/server renderToString).
 *
 * Row data comes from the sanitized real patch
 * test/fixtures/real-web-cordis.patch.yml through the Host readers
 * (listSubagents / listMembers / listTeamProfiles / readCatalog), and is fed
 * to the real framework-free stores through a fake ApiClient. No provider,
 * model, row or member here is invented.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listSubagents } from '../host/subagent-manager';
import { resolveSubagentProviders } from '../host/subagent-providers';
import { listMembers, listTeamProfiles } from '../host/members-editor';
import { readCatalog } from '../host/catalog';
import { listAcps } from '../host/acp-manager';
import { SubagentPanel } from './panel-a/SubagentPanel';
import { MembersPanel } from './panel-b/MembersPanel';
import { createSubagentStore } from './panel-a/subagent-panel-store';
import { createMembersStore } from './panel-b/members-panel-store';
import { SECTIONS, apply } from './index';
import { PanelHeader } from './ui/PanelChrome';
import { nextFocusTarget } from './ui/focus-trap';
import type { ApiClient } from './shared/api-client';
import type { StateDiagnostics, StateResponse, TeamMember } from './shared/api-types';
import { CATALOG_FROM_PATCH_MESSAGE, WRITE_UNAVAILABLE_MESSAGE } from './ui/host-state';

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURE = readFileSync(join(REPO_ROOT, 'test/fixtures/real-web-cordis.patch.yml'), 'utf8');

const HEALTHY: StateDiagnostics = {
  atomicWrite: { loaded: true, anchor: 'file:///plugin/lib/index.js', resolvedPath: '/profile/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js' },
  catalogSource: 'runtime',
  hostApi: 2,
  subagentProvidersSource: 'patch',
};

const BLOCKED: StateDiagnostics = {
  atomicWrite: { loaded: false, tried: ['file:///plugin/lib/index.js', 'file:///profile/package.json'] },
  catalogSource: 'patch',
  catalogErrors: ['llm service unavailable'],
  hostApi: 2,
  subagentProvidersSource: 'patch',
};

/** GET state as the Host would build it from the fixture for one team profile. */
function fixtureState(profile = 'standard-acp', diagnostics: StateDiagnostics = HEALTHY): StateResponse {
  return {
    revision: 'fixture-rev',
    catalog: readCatalog(FIXTURE),
    // No runtime subagents service: the Host falls back to the patch (v2.1 §1).
    subagents: listSubagents(FIXTURE),
    subagentProviders: resolveSubagentProviders(FIXTURE, null),
    teamProfiles: listTeamProfiles(FIXTURE),
    profile,
    members: listMembers(FIXTURE, profile) as TeamMember[],
    acps: listAcps(FIXTURE),
    dshProfile: { name: 'desktop', patchPath: '/profiles/desktop/cordis.patch.yml' },
    errors: {},
    diagnostics,
  };
}

function fixtureApi(state: (profile: string) => StateResponse = (p) => fixtureState(p)): ApiClient {
  return {
    getState: vi.fn(async (profile: string) => state(profile)),
    mutateSubagents: vi.fn(),
    mutateMembers: vi.fn(async (body) => ({ ...state(body.profile), notice: '已保存，新建会话后生效' })),
    mutateAcps: vi.fn(),
    importSubagentBundle: vi.fn(),
  };
}

/** Cells of the table row whose first cell starts with `firstCell`. */
function rowHtml(html: string, firstCell: string): string | undefined {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1])
    .find((row) => new RegExp(`^<td[^>]*>${firstCell}(<|$)`).test(row));
}

/** Text of each tbody row's first cell. */
function firstColumn(html: string): string[] {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  return [...tbody.matchAll(/<tr><td[^>]*>([^<]*)/g)].map((m) => m[1]);
}

/** Panel B (v2.1 two-row layout): member names from each tbody's row header, in order. */
function memberNames(html: string): string[] {
  return [...html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
}

/** Panel B: the whole <tbody> of one member. */
function memberGroup(html: string, name: string): string | undefined {
  return [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)]
    .map((m) => m[1])
    .find((body) => new RegExp(`<th scope="row"[^>]*>${name}</th>`).test(body));
}

/** Opening-tag attributes of <button> elements whose text contains `label`. */
function buttonTags(html: string, label: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((m) => m[2].includes(label))
    .map((m) => m[1]);
}

/** The <option> React SSR marks as selected inside a select matched by `selectAttr`. */
function selectedOption(html: string, selectAttr: RegExp): string | undefined {
  const select = [...html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)].find((m) => selectAttr.test(m[1]));
  return select?.[2].match(/<option[^>]*value="([^"]*)"[^>]*selected=""/)?.[1];
}

/** Depth-first search of a rendered element tree for a <Button> with the given text. */
function findButton(node: unknown, text: string): React.ReactElement | undefined {
  if (!React.isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findButton(child, text);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  const props = node.props as { children?: unknown; onClick?: unknown };
  if (props.children === text && typeof props.onClick === 'function') return node;
  return findButton(props.children, text);
}

describe('fixture sanity', () => {
  it('reads the real delegation rows and team members', () => {
    const state = fixtureState();
    expect(state.subagents).toHaveLength(13);
    expect(state.teamProfiles).toEqual(['standard-acp']);
    expect(state.catalog.providers.map((p) => p.id)).toEqual(['gusu-gateway', 'gpt-gateway']);
  });
});

describe('SubagentPanel render (real fixture)', () => {
  it('patch fallback registers the real ACP providers (t40 resolveSubagentProviders)', () => {
    expect(resolveSubagentProviders(FIXTURE, null).map((p) => p.name)).toEqual([
      'spawn', 'fork', 'ccacp', 'cursoracp', 'kiroopsuacp', 'kirogptacp',
    ]);
  });

  it('v2.1: registered ACP rows are editable, unregistered codex/claude-code rows stay read-only', async () => {
    const store = createSubagentStore(fixtureApi());
    await store.load();
    const html = renderToString(<SubagentPanel store={store} />);

    // All 13 real toolNames, in patch order.
    expect(firstColumn(html).map((cell) => cell.trim())).toEqual(
      listSubagents(FIXTURE).map((row) => String(row.config.toolName)),
    );

    // ccacp / cursoracp rows: registered through the patch fallback.
    for (const acp of ['subagent_acp', 'subagent_cursor', 'subagent_reviewer', 'subagent_explore', 'subagent_architect', 'subagent_research']) {
      const row = rowHtml(html, acp);
      expect(row, acp).toBeDefined();
      expect(row, acp).not.toContain('只读');
      for (const label of ['编辑', '删除']) {
        const [tag] = buttonTags(row!, label);
        expect(tag, `${acp} ${label}`).toBeDefined();
        expect(tag, `${acp} ${label}`).not.toContain('disabled');
      }
    }

    // codex / claude-code: provider not registered → read-only with the contract wording.
    for (const [toolName, provider] of [['subagent_codex', 'codex'], ['subagent_claude_code', 'claude-code']]) {
      const row = rowHtml(html, toolName);
      expect(row, toolName).toBeDefined();
      expect(row, toolName).toContain('只读');
      for (const tag of [...buttonTags(row!, '编辑'), ...buttonTags(row!, '删除')]) {
        expect(tag, toolName).toContain('disabled');
        expect(tag, toolName).toContain(`provider &#x27;${provider}&#x27; 未注册，此行只读。安装对应插件并重启 DSH 后再编辑`);
      }
    }
    expect(html).not.toContain('ACP 后端的 subagent 工具为只读');

    for (const editable of ['subagent_coder', 'subagent_tester', 'subagent_fork']) {
      const row = rowHtml(html, editable);
      expect(row, editable).toBeDefined();
      expect(row, editable).not.toContain('只读');
      const [edit] = buttonTags(row!, '编辑');
      expect(edit, editable).toBeDefined();
      expect(edit, editable).not.toContain('disabled');
    }
    expect(rowHtml(html, 'subagent_coder')).toContain('spawn');
  });

  it("prefills the edit form with tool-subagent-coder's real model route", async () => {
    const store = createSubagentStore(fixtureApi());
    await store.load();
    store.openEdit('tool-subagent-coder');
    const html = renderToString(<SubagentPanel store={store} />);

    const config = listSubagents(FIXTURE).find((row) => row.id === 'tool-subagent-coder')!.config as {
      agentOptions: { provider: string; model: string };
    };
    expect(html).toContain('role="dialog"');
    expect(html).toContain('value="subagent_coder"');
    expect(html).toContain(`value="${config.agentOptions.provider}" selected=""`);
    expect(html).toContain(`value="${config.agentOptions.model}" selected=""`);
  });

  it('shows the atomic-write warning and disables write buttons when loaded=false', async () => {
    const store = createSubagentStore(fixtureApi((p) => fixtureState(p, BLOCKED)));
    await store.load();
    const html = renderToString(<SubagentPanel store={store} />);

    expect(html).toContain(WRITE_UNAVAILABLE_MESSAGE);
    expect(html).toContain(CATALOG_FROM_PATCH_MESSAGE);
    for (const label of ['新建 Subagent 工具', '编辑', '删除']) {
      const tags = buttonTags(html, label);
      expect(tags.length, label).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, label).toContain('disabled');
    }
    expect(buttonTags(html, '刷新')[0]).not.toContain('disabled');
  });

  it('shows the Host message for 503 and 413 errors', async () => {
    for (const [code, message] of [
      ['DEPENDENCY_UNAVAILABLE', '缺少 @deepseek-ai/dsh-atomic-write，无法安全写入配置'],
      ['PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制'],
    ]) {
      const api = fixtureApi();
      vi.mocked(api.mutateSubagents).mockRejectedValue(Object.assign(new Error(message), { code }));
      const store = createSubagentStore(api);
      await store.load();
      store.requestDelete('tool-subagent-tester');
      await store.confirmDelete();
      expect(renderToString(<SubagentPanel store={store} />), code).toContain(message);
    }
  });
});

describe('MembersPanel render (real fixture)', () => {
  it('lists the real standard-acp members', async () => {
    const api = fixtureApi();
    const store = createMembersStore(api);
    await store.load();
    const html = renderToString(<MembersPanel store={store} />);

    expect(memberNames(html)).toEqual(['claude', 'coder', 'tester', 'front-designer', 'generalist']);
    expect(api.getState).toHaveBeenCalledWith('standard-acp');
    expect(html).toMatch(/团队 profile：(<!-- -->)?standard-acp/);
    for (const member of listMembers(FIXTURE, 'standard-acp')) {
      if (member.model) expect(memberGroup(html, member.name), member.name).toContain(String(member.model));
    }
  });

  it('v2.1 §7: one tbody per member, two rows, three header columns', async () => {
    const store = createMembersStore(fixtureApi());
    await store.load();
    const html = renderToString(<MembersPanel store={store} />);
    const real = listMembers(FIXTURE, 'standard-acp');

    const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)![1];
    expect([...thead.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['成员名', '角色', '操作']);

    const bodies = [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]);
    expect(bodies).toHaveLength(real.length);
    for (const member of real) {
      const body = memberGroup(html, member.name)!;
      expect(body, member.name).toBeDefined();
      const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
      expect(rows, member.name).toHaveLength(2);
      // Row 1: name header (nowrap, min 9.5em), role (min 12em), actions rowSpan=2.
      expect(rows[0]).toMatch(/<th scope="row" style="[^"]*white-space:nowrap[^"]*min-width:9.5em/);
      expect(rows[0]).not.toContain('overflow-wrap:anywhere');
      expect(rows[0]).toMatch(/<td style="[^"]*min-width:12em[^"]*"/);
      // React SSR serialises rowSpan as lowercase `rowspan`.
      expect(rows[0]).toMatch(/<td rowspan="2"[^>]*>[\s\S]*编辑[\s\S]*删除/);
      // Row 2 (v2.3): colSpan=3, spanning the actions column too, with a labelled
      // Provider / Model / Reasoning Effort list and no focusable elements.
      expect(rows[1]).toMatch(/^<td colSpan="3"[^>]*><dl/);
      expect([...rows[1].matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1])).toEqual(['Provider', 'Model', 'Reasoning Effort']);
      const values = [...rows[1].matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1]);
      expect(values, member.name).toEqual([member.provider, member.model, member.reasoning_effort].map((v) => (v ? String(v) : '-')));
      expect(rows[1]).not.toMatch(/<(button|a|input|select)\b/);
    }
  });

  it('v2.1 §7: empty values show "-" and an empty list is a single colSpan=3 row', async () => {
    const store = createMembersStore(fixtureApi(() => ({ ...fixtureState(), members: [{ name: 'bare' }] })));
    await store.load();
    const body = memberGroup(renderToString(<MembersPanel store={store} />), 'bare')!;
    expect(body).toMatch(/min-width:12em[^"]*">-<\/td>/);
    expect([...body.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1])).toEqual(['-', '-', '-']);

    const empty = createMembersStore(fixtureApi(() => ({ ...fixtureState(), members: [] })));
    await empty.load();
    const html = renderToString(<MembersPanel store={empty} />);
    expect(memberNames(html)).toEqual([]);
    expect(html).toMatch(/<td[^>]*colSpan="3"[^>]*>暂无成员<\/td>/);
  });

  it('v2.1 §7: edit and delete buttons still drive the store', async () => {
    const api = fixtureApi();
    const store = createMembersStore(api);
    await store.load();
    // Each member group keeps exactly one enabled 编辑 and one enabled 删除 button.
    const html = renderToString(<MembersPanel store={store} />);
    for (const name of memberNames(html)) {
      const body = memberGroup(html, name)!;
      for (const label of ['编辑', '删除']) {
        const tags = buttonTags(body, label);
        expect(tags, `${name} ${label}`).toHaveLength(1);
        expect(tags[0], `${name} ${label}`).not.toContain('disabled');
        expect(tags[0], `${name} ${label}`).not.toContain('tabindex');
      }
    }
    // SSR cannot click; drive the store the way the buttons' onClick handlers do.
    store.openEdit('coder');
    expect(store.getSnapshot().form.editingName).toBe('coder');
    store.cancel();
    store.requestDelete('coder');
    await store.confirmDelete();
    expect(api.mutateMembers).toHaveBeenCalledWith(expect.objectContaining({ action: 'remove', name: 'coder' }));
  });

  it('defaults to standard-acp and switches profiles when the patch declares several', async () => {
    // The real fixture has only standard-acp; add a second profile made of the
    // real gpt-gateway members to exercise the picker.
    const real = listMembers(FIXTURE, 'standard-acp') as TeamMember[];
    const byProfile: Record<string, TeamMember[]> = {
      'gpt-only': real.filter((m) => m.provider === 'gpt-gateway'),
      'standard-acp': real,
    };
    const api = fixtureApi((profile) => ({
      ...fixtureState(),
      teamProfiles: Object.keys(byProfile), // 'gpt-only' sorts first
      profile,
      members: byProfile[profile] ?? [],
    }));
    const store = createMembersStore(api);
    await store.load();
    let html = renderToString(<MembersPanel store={store} />);
    expect(selectedOption(html, /aria-label="团队 profile"/)).toBe('standard-acp');

    await store.setProfile('gpt-only');
    html = renderToString(<MembersPanel store={store} />);
    expect(selectedOption(html, /aria-label="团队 profile"/)).toBe('gpt-only');
    expect(memberNames(html)).toEqual(['tester', 'generalist']);

    store.requestDelete('tester');
    await store.confirmDelete();
    expect(api.mutateMembers).toHaveBeenCalledWith(expect.objectContaining({ profile: 'gpt-only', action: 'remove', name: 'tester' }));
  });

  it('shows the warning banner and disables write buttons when atomic-write is not loaded', async () => {
    const store = createMembersStore(fixtureApi((p) => fixtureState(p, BLOCKED)));
    await store.load();
    const html = renderToString(<MembersPanel store={store} />);

    expect(html).toContain(WRITE_UNAVAILABLE_MESSAGE);
    for (const label of ['新建成员', '编辑', '删除']) {
      const tags = buttonTags(html, label);
      expect(tags.length, label).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, label).toContain('disabled');
    }
  });

  it('shows errors.members when the patch has no team profiles', async () => {
    const api = fixtureApi(() => ({
      ...fixtureState(),
      teamProfiles: [],
      members: [],
      errors: { members: '未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams' },
    }));
    const store = createMembersStore(api);
    await store.load();
    const html = renderToString(<MembersPanel store={store} />);

    expect(html).toContain('未找到 agent-teams 配置');
    expect(html).not.toContain('aria-label="团队 profile"');
    expect(buttonTags(html, '新建成员')[0]).toContain('disabled');
  });
});

/** The v2.3 ACP <section> of Panel A. */
function acpSection(html: string): string {
  const start = html.indexOf('aria-labelledby="wuyou-acp-heading"');
  expect(start, 'ACP section').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

function textFile(name: string, text: string): File {
  return { name, size: text.length, text: async () => text } as unknown as File;
}

describe('v2.3 Panel A ACP section and import/export (real fixture)', () => {
  it('lists the real ACP registrations below the tools, with the bound DSH profile', async () => {
    const store = createSubagentStore(fixtureApi());
    await store.load();
    const html = renderToString(<SubagentPanel store={store} />);
    const section = acpSection(html);

    expect(html.indexOf('<table')).toBeLessThan(html.indexOf('aria-labelledby="wuyou-acp-heading"'));
    expect(section).toContain('DSH profile：<!-- -->desktop');
    expect(section).toContain('title="/profiles/desktop/cordis.patch.yml"');
    expect(section).toContain('/opt/example/bin/kiro-cli acp --trust-all-tools --model claude-opus-5 --effort xhigh --agent kiro_default');
  });

  it('v2.4: two rows per ACP — facts and actions, then the command across all 4 columns, indented', async () => {
    const store = createSubagentStore(fixtureApi());
    await store.load();
    const section = acpSection(renderToString(<SubagentPanel store={store} />));

    const thead = section.match(/<thead>([\s\S]*?)<\/thead>/)![1];
    expect([...thead.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['ACP 名称', '权限', '使用它的工具', '操作']);

    const bodies = [...section.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]);
    const acps = listAcps(FIXTURE);
    expect(bodies).toHaveLength(acps.length);
    acps.forEach((acp, i) => {
      const rows = [...bodies[i].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
      expect(rows, acp.id).toHaveLength(2);
      // Row 1: name header, permission, users, actions (测试 / 编辑 / 删除).
      expect(rows[0]).toMatch(new RegExp(`^<th scope="row"[^>]*>${acp.config.providerName}</th>`));
      expect(rows[0]).toContain(`>${acp.config.permission}</td>`);
      expect(rows[0]).toContain(acp.usedBy.length > 0 ? acp.usedBy.join(', ') : '>-<');
      for (const label of ['测试', '编辑', '删除']) expect(buttonTags(rows[0], label), `${acp.id} ${label}`).toHaveLength(1);
      expect(buttonTags(rows[0], '测试')[0]).not.toContain('disabled');
      const [del] = buttonTags(rows[0], '删除');
      if (acp.usedBy.length > 0) expect(del).toContain(`title="仍被 ${acp.usedBy.join('、')} 使用，不能删除"`);
      else expect(del).not.toContain('disabled');
      // Row 2: the whole command line, colSpan=4, indented, no command text in row 1.
      expect(rows[1]).toMatch(/^<td colSpan="4" style="[^"]*padding:2px 8px 8px 24px/);
      expect(rows[1]).toContain(`>${[acp.config.command, ...acp.config.args].join(' ')}</code>`);
      expect(rows[0]).not.toContain(acp.config.command);
    });
    expect(listAcps(FIXTURE).map((a) => a.usedBy.length > 0)).toEqual([true, true, false, false]);
  });

  it('v2.4: the test dialog lists each check, the agent facts and stderr; handshake is a separate step', async () => {
    const api = fixtureApi();
    const staticResult = {
      id: 'subagent-acp', providerName: 'ccacp', ok: true, handshake: false, durationMs: 3,
      checks: [
        { key: 'command', label: '可执行文件', status: 'pass', detail: '/opt/homebrew/bin/claude-agent-acp' },
        { key: 'interpreter', label: '解释器（#!）', status: 'pass', detail: 'node → /opt/homebrew/bin/node' },
        { key: 'cwd', label: '工作目录', status: 'skip', detail: '未配置：运行时使用发起委派的会话的工作目录' },
      ],
    };
    (api as any).testAcp = vi.fn(async ({ handshake }: { handshake?: boolean }) => handshake
      ? { ...staticResult, handshake: true, ok: false, checks: [...staticResult.checks, { key: 'handshake', label: 'ACP 握手', status: 'fail', detail: '进程在响应 initialize 前退出（exit code 1）。见下方 stderr' }], stderrTail: 'Error: not logged in' }
      : staticResult);
    const store = createSubagentStore(api);
    await store.load();

    await store.testAcp('subagent-acp');
    expect((api as any).testAcp).toHaveBeenCalledWith({ id: 'subagent-acp', handshake: false });
    let html = renderToString(<SubagentPanel store={store} />);
    expect(html).toContain('测试 ACP：ccacp');
    expect(html).toContain('静态检查通过');
    expect(html).toMatch(/>通过<\/span><span[^>]*>可执行文件<\/span><span[^>]*>\/opt\/homebrew\/bin\/claude-agent-acp</);
    expect(html).toContain('不创建会话、不调用模型');
    expect(buttonTags(html, '握手测试')[0]).not.toContain('disabled');

    await store.runAcpHandshake();
    expect((api as any).testAcp).toHaveBeenLastCalledWith({ id: 'subagent-acp', handshake: true });
    html = renderToString(<SubagentPanel store={store} />);
    expect(html).toContain('有检查未通过');
    expect(html).toContain('进程在响应 initialize 前退出（exit code 1）');
    expect(html).toMatch(/<details open=""[^>]*>[\s\S]*Error: not logged in/);
    expect(buttonTags(html, '重新握手测试')).toHaveLength(1);

    store.closeAcpTest();
    expect(renderToString(<SubagentPanel store={store} />)).not.toContain('测试 ACP：');
  });

  it('v2.4: a failed command check disables the handshake; an old Host explains the missing route', async () => {
    const api = fixtureApi();
    (api as any).testAcp = vi.fn(async () => ({
      id: 'subagent-acp', providerName: 'ccacp', ok: false, handshake: false, durationMs: 1,
      checks: [{ key: 'command', label: '可执行文件', status: 'fail', detail: '/opt/example/bin/claude-agent-acp 不存在' }],
    }));
    const store = createSubagentStore(api);
    await store.load();
    await store.testAcp('subagent-acp');
    const html = renderToString(<SubagentPanel store={store} />);
    expect(html).toMatch(/>失败<\/span>[\s\S]*不存在/);
    expect(buttonTags(html, '握手测试')[0]).toContain('disabled');

    (api as any).testAcp = vi.fn(async () => { throw Object.assign(new Error('请求失败（HTTP 404）'), { status: 404 }); });
    await store.testAcp('subagent-acp');
    expect(renderToString(<SubagentPanel store={store} />)).toContain('当前 Host 不支持 ACP 测试，重启 DSH 后可用');
  });

  it('header has 导出 and 导入; both panels disable 导入 (not 导出) when writes are unavailable', async () => {
    const ok = createSubagentStore(fixtureApi());
    await ok.load();
    const okHtml = renderToString(<SubagentPanel store={ok} />);
    expect(buttonTags(okHtml, '导出')[0]).not.toContain('disabled');
    expect(buttonTags(okHtml, '导入')[0]).not.toContain('disabled');
    expect(okHtml).toMatch(/<input[^>]*type="file"[^>]*accept=".yaml,.yml/);

    const blockedA = createSubagentStore(fixtureApi((p) => fixtureState(p, BLOCKED)));
    await blockedA.load();
    const blockedB = createMembersStore(fixtureApi((p) => fixtureState(p, BLOCKED)));
    await blockedB.load();
    for (const html of [renderToString(<SubagentPanel store={blockedA} />), renderToString(<MembersPanel store={blockedB} />)]) {
      expect(buttonTags(html, '导出')[0]).not.toContain('disabled');
      expect(buttonTags(html, '导入')[0]).toContain('disabled');
    }
    expect(buttonTags(acpSection(renderToString(<SubagentPanel store={blockedA} />)), '新建 ACP')[0]).toContain('disabled');
  });

  it('an old Host (no acps in state) shows the restart note instead of an empty table', async () => {
    const store = createSubagentStore(fixtureApi((p) => ({ ...fixtureState(p), acps: undefined, dshProfile: undefined })));
    await store.load();
    const section = acpSection(renderToString(<SubagentPanel store={store} />));
    expect(section).toContain('当前 Host 版本不支持 ACP 管理，重启 DSH 后可用');
    expect(section).not.toContain('<table');
    expect(buttonTags(section, '新建 ACP')).toHaveLength(0);
  });

  it('the ACP edit dialog is prefilled from the real kiro row; providerName is locked', async () => {
    const store = createSubagentStore(fixtureApi());
    await store.load();
    store.openEditAcp('subagent-acp-kiro');
    const html = renderToString(<SubagentPanel store={store} />);
    expect(html).toContain('编辑 ACP');
    const nameInput = html.match(/<input[^>]*value="kiroopsuacp"[^>]*>/)?.[0];
    expect(nameInput).toContain('disabled=""');
    expect(html).toContain('value="/opt/example/bin/kiro-cli"');
    expect(html).toContain('acp\n--trust-all-tools\n--model\nclaude-opus-5');
    expect(html).toContain('value="allow" selected=""');
  });

  it('the import preview names the source file/profile, the target profile, and each entry', async () => {
    const store = createSubagentStore(fixtureApi((p) => ({ ...fixtureState(p), acps: listAcps(FIXTURE).slice(1) })));
    await store.load();
    const { exportSubagentBundle } = await import('./shared/import-export');
    await store.importConfig(textFile('from-web.yaml', exportSubagentBundle(listAcps(FIXTURE), [], 'web')));
    const html = renderToString(<SubagentPanel store={store} />);
    expect(html).toContain('导入预览');
    expect(html).toContain('文件：from-web.yaml（来自 DSH profile web），导入到：desktop');
    expect(html).toContain('将导入 <!-- -->1<!-- --> 项，跳过 <!-- -->3<!-- --> 项');
    expect(html).toContain('原因：<!-- -->ACP &#x27;cursoracp&#x27; 已存在');
    expect(html).toContain('导入后请确认路径在本机存在');
    expect(buttonTags(html, '确认导入')[0]).not.toContain('disabled');
  });
});

describe('v2.2 Panel B role textarea and member import (real fixture)', () => {
  it('the role field is a 3-line textarea resizable up to 6 lines', async () => {
    const store = createMembersStore(fixtureApi());
    await store.load();
    store.openEdit('claude');
    const html = renderToString(<MembersPanel store={store} />);
    const textarea = html.match(/<textarea([^>]*)>/)?.[1];
    expect(textarea).toBeDefined();
    expect(textarea).toContain('rows="3"');
    expect(textarea).toMatch(/height:74px;min-height:74px;max-height:134px;resize:vertical/);
    const role = String(listMembers(FIXTURE, 'standard-acp').find((m) => m.name === 'claude')!.role);
    expect(html).toContain(`>${role}</textarea>`);
  });

  it('multi-line roles keep their line breaks in the table', async () => {
    const store = createMembersStore(fixtureApi(() => ({ ...fixtureState(), members: [{ name: 'multi', role: '第一行\n第二行' }] })));
    await store.load();
    const body = memberGroup(renderToString(<MembersPanel store={store} />), 'multi')!;
    expect(body).toMatch(/<td style="[^"]*white-space:pre-line[^"]*">第一行\n第二行<\/td>/);
  });

  it('imports members through a preview, chaining the revision of each add', async () => {
    const api = fixtureApi();
    let n = 0;
    vi.mocked(api.mutateMembers).mockImplementation(async (body) => ({ ...fixtureState(body.profile), revision: `rev-${++n}`, notice: '' }));
    const store = createMembersStore(api);
    await store.load();
    const { exportMembers } = await import('./shared/import-export');
    await store.importConfig(textFile('team.yaml', exportMembers([{ name: 'claude' }, { name: 'alpha', role: '甲\n乙' }, { name: 'beta' }], 'standard-acp')));

    const html = renderToString(<MembersPanel store={store} />);
    expect(html).toContain('文件：team.yaml，导入到团队 profile：standard-acp');
    expect(html).toContain('原因：<!-- -->成员 &#x27;claude&#x27; 已存在');

    await store.confirmImport();
    const calls = vi.mocked(api.mutateMembers).mock.calls.map(([body]) => [body.member?.name, body.expectedRevision]);
    expect(calls).toEqual([['alpha', 'fixture-rev'], ['beta', 'rev-1']]);
    expect(vi.mocked(api.mutateMembers).mock.calls[0][0].member).toEqual({ name: 'alpha', role: '甲\n乙' });
    expect(store.getSnapshot()).toMatchObject({ importPreview: null, revision: 'rev-2', notice: '已导入 2/2 个成员，新建会话后生效' });
  });

  it('a conflict mid-import stops and says how many were imported', async () => {
    const api = fixtureApi();
    vi.mocked(api.mutateMembers)
      .mockResolvedValueOnce({ ...fixtureState(), revision: 'rev-1', notice: '' })
      .mockRejectedValueOnce(Object.assign(new Error('配置已被其他地方修改，请刷新后重试'), { code: 'STALE_REVISION' }));
    const store = createMembersStore(api);
    await store.load();
    const { exportMembers } = await import('./shared/import-export');
    await store.importConfig(textFile('t.yaml', exportMembers([{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }], 'standard-acp')));
    await store.confirmImport();
    expect(vi.mocked(api.mutateMembers)).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().conflict).toBe('配置已被其他地方修改，请刷新后重试。已导入 1/3 个成员，其余未导入');
    expect(store.getSnapshot().importPreview).toBeNull();
  });
});

describe('settings.section registration', () => {
  function fakeCtx() {
    const registered: Array<{ options: Record<string, unknown>; component: (props: { close?: () => void }) => React.ReactElement }> = [];
    const disposers: Array<() => void> = [];
    const ctx = {
      slots: {
        inject: vi.fn((name: string, factory: () => () => void) => {
          expect(name).toBe('settings.section');
          disposers.push(factory());
        }),
        register: vi.fn((options: Record<string, unknown>, component: (props: { close?: () => void }) => React.ReactElement) => {
          registered.push({ options, component });
          return () => {};
        }),
      },
    };
    return { ctx, registered, disposers };
  }

  it('registers both sections with the D2 id/order and the v2.2 short labels', () => {
    expect(SECTIONS.subagents).toEqual({ name: 'settings.section', id: 'wuyou-subagents', order: 100, label: '无忧Subagent' });
    expect(SECTIONS.members).toEqual({ name: 'settings.section', id: 'wuyou-members', order: 101, label: '无忧Teams' });

    const { ctx, registered, disposers } = fakeCtx();
    apply(ctx);
    expect(registered.map((r) => r.options)).toEqual([SECTIONS.subagents, SECTIONS.members]);
    expect(disposers.every((d) => typeof d === 'function')).toBe(true);
  });

  it('forwards the host close prop into both panels', () => {
    const { ctx, registered } = fakeCtx();
    apply(ctx);
    for (const { options, component } of registered) {
      // SSR does not run effects, so no request is issued.
      const withClose = renderToString(component({ close: () => {} }));
      expect(buttonTags(withClose, '关闭'), String(options.id)).toHaveLength(1);
      const withoutClose = renderToString(component({}));
      expect(buttonTags(withoutClose, '关闭'), String(options.id)).toHaveLength(0);
    }
  });

  it('the header close button calls close', () => {
    const close = vi.fn();
    const tree = PanelHeader({ title: 't', loading: false, onRefresh: () => {}, close });
    const button = findButton(tree, '关闭');
    expect(button).toBeDefined();
    (button!.props as { onClick: () => void }).onClick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(findButton(PanelHeader({ title: 't', loading: false, onRefresh: () => {} }), '关闭')).toBeUndefined();
  });
});

describe('Modal focus order', () => {
  it('cycles forward and backward and enters from outside', () => {
    const items = ['name', 'role', 'cancel', 'save'];
    expect(nextFocusTarget(items, 'name', false)).toBe('role');
    expect(nextFocusTarget(items, 'save', false)).toBe('name');
    expect(nextFocusTarget(items, 'name', true)).toBe('save');
    expect(nextFocusTarget(items, 'cancel', true)).toBe('role');
    expect(nextFocusTarget(items, null, false)).toBe('name');
    expect(nextFocusTarget(items, 'outside', true)).toBe('save');
    expect(nextFocusTarget([], null, false)).toBeNull();
  });
});

describe('client source', () => {
  const sources = (() => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) files.push(path);
      }
    };
    walk(__dirname);
    return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  })();

  it("never hardcodes 'web' as a team profile", () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter(({ text }) => /['"`]web['"`]/.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it('uses only --dsw-alias-* tokens declared by the theme and no color literals in ui/', () => {
    // The theme is a host package; point DSH_CLIENT_UI_THEME_DIR at it (e.g. the
    // DSH checkout's node_modules) when it is not installed in this repo.
    const theme = process.env.DSH_CLIENT_UI_THEME_DIR ?? join(REPO_ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-theme');
    let declared: Set<string> | null = null;
    try {
      const walkTheme = (dir: string, out: string[]) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walkTheme(path, out);
          else if (/\.(css|js)$/.test(entry)) out.push(readFileSync(path, 'utf8'));
        }
        return out;
      };
      declared = new Set(walkTheme(theme, []).join('\n').match(/--dsw-alias-[a-z0-9-]+/g) ?? []);
    } catch {
      // Theme is a host package and may not be installed locally; the
      // colour-literal check below still runs.
    }
    const used = new Set(sources.flatMap(({ text }) => text.match(/--dsw-alias-[a-z0-9-]+/g) ?? []));
    if (declared) expect([...used].filter((token) => !declared!.has(token))).toEqual([]);

    const uiLiterals = sources
      .filter(({ file }) => file.includes(`${join('client', 'ui')}`))
      .filter(({ text }) => /rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/.test(text));
    expect(uiLiterals.map(({ file }) => file)).toEqual([]);
  });
});
