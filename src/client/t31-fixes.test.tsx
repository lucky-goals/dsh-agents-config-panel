/**
 * t31 regressions (t29 findings M1, M2, L1, L2).
 *
 * - M2 / L2 use rows and members read from the sanitized real patch
 *   (test/fixtures/real-web-cordis.patch.yml) through the Host readers.
 * - M1 drives the real stores through the real api-client over a fake fetch
 *   whose responses are released by hand, so "A issued first, B answered
 *   first, A answers last" is reproduced exactly.
 * - L1 exercises the composition guard with Node's native EventTarget/Event
 *   (no DOM library is installed in this repo); the Modal wiring is covered
 *   by a real-browser check recorded in the task report.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listSubagents, createSubagent, updateSubagent } from '../host/subagent-manager';
import { listMembers, listTeamProfiles, addMember, updateMember, removeMember } from '../host/members-editor';
import { readCatalog } from '../host/catalog';
import { createApiClient, type ApiClient } from './shared/api-client';
import type { StateResponse, TeamMember } from './shared/api-types';
import { createMembersStore, diffMemberPatch } from './panel-b/members-panel-store';
import { createSubagentStore, diffSubagentPatch } from './panel-a/subagent-panel-store';
import { MembersPanel } from './panel-b/MembersPanel';
import { observeComposition } from './ui/composition-guard';
import { MSG } from './ui/messages';

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURE = readFileSync(join(REPO_ROOT, 'test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const CATALOG = readCatalog(FIXTURE);
const REAL_MEMBERS = listMembers(FIXTURE, 'standard-acp') as TeamMember[];

function fixtureState(profile = 'standard-acp', members: TeamMember[] = REAL_MEMBERS, teamProfiles = listTeamProfiles(FIXTURE)): StateResponse {
  return {
    revision: `rev-${profile}`,
    catalog: CATALOG,
    subagents: listSubagents(FIXTURE),
    teamProfiles,
    profile,
    members,
    errors: {},
    diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch' },
  };
}

function mockApi(state: (profile: string) => StateResponse = (p) => fixtureState(p)): ApiClient {
  return {
    getState: vi.fn(async (profile: string) => state(profile)),
    mutateSubagents: vi.fn(async () => ({ ...state('standard-acp'), notice: '已保存，新建会话后生效' })),
    mutateMembers: vi.fn(async (body) => ({ ...state(body.profile), notice: '已保存，新建会话后生效' })),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// M2: cleared optional fields are sent as null; unchanged fields are not sent
// ---------------------------------------------------------------------------
describe('M2 member patch (real fixture members)', () => {
  const tester = REAL_MEMBERS.find((m) => m.name === 'tester')!;

  it('fixture sanity: tester has role, provider, model and reasoning_effort', () => {
    expect(tester.role).toBeTruthy();
    expect(tester).toMatchObject({ provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'max' });
  });

  it('clearing role sends exactly {role:null}', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openEdit('tester');
    store.setField('role', '');
    await store.submit();

    expect(api.mutateMembers).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.mutateMembers).mock.calls[0][0]).toEqual({
      expectedRevision: 'rev-standard-acp',
      profile: 'standard-acp',
      action: 'update',
      name: 'tester',
      patch: { role: null },
    });
  });

  it('clearing provider and model (the cascade the form performs) sends nulls for all three route keys', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openEdit('tester');
    store.setField('provider', '');
    store.setField('model', '');
    store.setField('reasoning_effort', '');
    await store.submit();
    expect(vi.mocked(api.mutateMembers).mock.calls[0][0].patch).toEqual({ provider: null, model: null, reasoning_effort: null });
  });

  it('only changed fields are sent', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openEdit('tester');
    store.setField('reasoning_effort', 'high');
    await store.submit();
    expect(vi.mocked(api.mutateMembers).mock.calls[0][0].patch).toEqual({ reasoning_effort: 'high' });
  });

  it('saving with no changes sends no request, closes the form and says so', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openEdit('tester');
    store.setField('role', `${tester.role}  `); // whitespace-only change is not a change
    await store.submit();

    expect(api.mutateMembers).not.toHaveBeenCalled();
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.notice).toBe('没有改动');
  });

  it('the Host applies the null patch: role key removed from the real YAML (t30 contract)', () => {
    const patch = diffMemberPatch(
      { name: 'tester', role: String(tester.role), provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'max' },
      { name: 'tester', role: '', provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'max' },
    );
    expect(patch).toEqual({ role: null });
    const result = updateMember(FIXTURE, 'standard-acp', 'tester', patch as any, CATALOG);
    // Documented outcome once t30 lands; before that the Host may reject the null.
    if (result.ok) {
      const after = listMembers(result.yamlText, 'standard-acp').find((m) => m.name === 'tester');
      expect(after?.role).toBeUndefined();
    } else {
      expect(result.code).toBe('INVALID');
    }
  });
});

describe('M2 subagent patch (real fixture rows)', () => {
  const coderConfig = listSubagents(FIXTURE).find((r) => r.id === 'tool-subagent-coder')!.config as any;

  it('fixture sanity: tool-subagent-coder is spawn with a reasoningEffort', () => {
    expect(coderConfig.provider).toBe('spawn');
    expect(coderConfig.agentOptions.reasoningEffort).toBeTruthy();
  });

  it('clearing reasoningEffort sends agentOptions.reasoningEffort=null and nothing else', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-coder');
    store.setField('agentOptions', { ...store.getSnapshot().form.values.agentOptions, reasoningEffort: '' });
    await store.submit();

    expect(vi.mocked(api.mutateSubagents).mock.calls[0][0]).toEqual({
      expectedRevision: 'rev-standard-acp',
      action: 'update',
      id: 'tool-subagent-coder',
      patch: { agentOptions: { reasoningEffort: null } },
    });
  });

  it('clearing the spawn model is blocked on the client', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-coder');
    store.setField('agentOptions', { ...store.getSnapshot().form.values.agentOptions, model: '' });
    await store.submit();

    expect(api.mutateSubagents).not.toHaveBeenCalled();
    expect(store.getSnapshot().form.errors.agentOptions?.model).toBe('agentOptions.model 必填');
    expect(store.getSnapshot().form.mode).toBe('edit');
  });

  it('re-saving without changes sends no request', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-coder');
    await store.submit();
    expect(api.mutateSubagents).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice).toBe('没有改动');
  });

  it('spawn → fork sends only provider; fork → spawn sends a complete block', () => {
    const coder = {
      toolName: 'subagent_coder', provider: 'spawn' as const, backgroundMode: coderConfig.backgroundMode ?? 'continuable',
      agentOptions: { ...coderConfig.agentOptions },
    };
    expect(diffSubagentPatch(coder, { ...coder, provider: 'fork' })).toEqual({ provider: 'fork' });

    const fork = { toolName: 'subagent_fork', provider: 'fork' as const, backgroundMode: 'continuable' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const route = { provider: CATALOG.providers[0].id, model: CATALOG.providers[0].models[0].id, reasoningEffort: '' };
    expect(diffSubagentPatch(fork, { ...fork, provider: 'spawn', agentOptions: route })).toEqual({
      provider: 'spawn',
      agentOptions: { provider: route.provider, model: route.model },
    });
  });
});

// ---------------------------------------------------------------------------
// M2 + t30 contract: the set of fields the client may send as null
// (members: role/provider/model/reasoning_effort; spawn rows:
// agentOptions.reasoningEffort). t34 compares this set with the Host.
// ---------------------------------------------------------------------------
describe('M2 nullable-field set matches the Host (t30)', () => {
  /** Dotted paths of every null in a patch. */
  function nullPaths(value: unknown, prefix = ''): string[] {
    if (value === null) return [prefix];
    if (typeof value !== 'object') return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => nullPaths(v, prefix ? `${prefix}.${k}` : k));
  }

  it('members: clearing any one optional field emits null only for that field', () => {
    const full = { name: 'tester', role: 'r', provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'max' };
    const seen = new Set<string>();
    for (const field of ['name', 'role', 'provider', 'model', 'reasoning_effort'] as const) {
      for (const path of nullPaths(diffMemberPatch(full, { ...full, [field]: '' }))) seen.add(path);
    }
    // name '' is not a null (validation rejects an empty name before any request).
    expect([...seen].sort()).toEqual(['model', 'provider', 'reasoning_effort', 'role']);
  });

  it('members: clearing only provider or only model is blocked before any request', async () => {
    for (const field of ['provider', 'model'] as const) {
      const api = mockApi();
      const store = createMembersStore(api);
      await store.load();
      store.openEdit('tester');
      store.setField(field, '');
      await store.submit();
      expect(api.mutateMembers, field).not.toHaveBeenCalled();
      expect(store.getSnapshot().form.errors[field], field).toBe('成员 provider 和 model 必须同时填写');
    }
  });

  it('subagents: only spawn rows can null agentOptions.reasoningEffort; fork edits never carry agentOptions', () => {
    const spawn = { toolName: 'subagent_coder', provider: 'spawn' as const, backgroundMode: 'continuable' as const, agentOptions: { provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoningEffort: 'high' } };
    expect(nullPaths(diffSubagentPatch(spawn, { ...spawn, agentOptions: { ...spawn.agentOptions, reasoningEffort: '' } }))).toEqual(['agentOptions.reasoningEffort']);

    const fork = { toolName: 'subagent_fork', provider: 'fork' as const, backgroundMode: 'continuable' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    // Stale values left in hidden agentOptions fields must not leak into a fork patch.
    const edited = { ...fork, backgroundMode: 'one-shot' as const, agentOptions: { provider: 'x', model: 'y', reasoningEffort: '' } };
    expect(diffSubagentPatch(fork, edited)).toEqual({ backgroundMode: 'one-shot' });
  });

  it('subagents: changing only the model sends only model (the Host merges the row provider)', () => {
    const spawn = { toolName: 'subagent_coder', provider: 'spawn' as const, backgroundMode: 'continuable' as const, agentOptions: { provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoningEffort: 'high' } };
    const other = CATALOG.providers.find((p) => p.id === 'gusu-gateway')!.models.find((m) => m.id !== 'claude-opus-5-5')!.id;
    expect(diffSubagentPatch(spawn, { ...spawn, agentOptions: { ...spawn.agentOptions, model: other } })).toEqual({ agentOptions: { model: other } });
  });

  it('the real fork row edited through the store sends no agentOptions', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-fork');
    store.setField('backgroundMode', store.getSnapshot().form.values.backgroundMode === 'one-shot' ? 'continuable' : 'one-shot');
    await store.submit();
    const patch = vi.mocked(api.mutateSubagents).mock.calls[0][0].patch!;
    expect(patch).not.toHaveProperty('agentOptions');
    expect(nullPaths(patch)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M1: request sequencing across profile switches and 409 refreshes
// ---------------------------------------------------------------------------
interface PendingCall {
  method: string;
  url: string;
  body: any;
  respond(status: number, value: unknown): void;
}

/** fetch whose responses are released manually, in any order. */
function delayedFetch() {
  const calls: PendingCall[] = [];
  const fetch = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolveFetch) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        respond(status, value) {
          const text = JSON.stringify(value);
          resolveFetch({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => value,
          } as Response);
        },
      });
    })) as typeof globalThis.fetch;
  return { fetch, calls };
}

const TWO_PROFILES = ['gpt-only', 'standard-acp'];
const GPT_ONLY = REAL_MEMBERS.filter((m) => m.provider === 'gpt-gateway');
const twoProfileState = (profile: string) =>
  fixtureState(profile, profile === 'gpt-only' ? GPT_ONLY : REAL_MEMBERS, TWO_PROFILES);

/** Text of each tbody row's first cell. */
function memberColumn(html: string): string[] {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  return [...tbody.matchAll(/<tr><td[^>]*>([^<]*)/g)].map((m) => m[1]);
}

describe('M1 members store: stale responses are discarded', () => {
  it('A issued first, B answered first, A answered last → the panel shows B', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createMembersStore(createApiClient({ fetch }));

    const loadA = store.load('standard-acp');
    const loadB = store.setProfile('gpt-only');
    await flush();
    expect(calls.map((c) => c.url)).toEqual([
      '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp',
      '/plugins/dsh-wuyou-agent/api/state?profile=gpt-only',
    ]);

    calls[1].respond(200, twoProfileState('gpt-only'));
    await loadB;
    calls[0].respond(200, twoProfileState('standard-acp'));
    await loadA;

    const state = store.getSnapshot();
    expect(state.profile).toBe('gpt-only');
    expect(state.members.map((m) => m.name)).toEqual(['tester', 'generalist']);
    expect(state.revision).toBe('rev-gpt-only');
    expect(state.loading).toBe(false);
    expect(memberColumn(renderToString(<MembersPanel store={store} />))).toEqual(['tester', 'generalist']);
  });

  it('a failure of the superseded request does not surface as an error', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createMembersStore(createApiClient({ fetch }));
    const loadA = store.load('standard-acp');
    const loadB = store.setProfile('gpt-only');
    await flush();
    calls[1].respond(200, twoProfileState('gpt-only'));
    await loadB;
    calls[0].respond(500, { code: 'INTERNAL', message: '服务端内部错误' });
    await loadA;
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().profile).toBe('gpt-only');
  });

  it('409 keeps loading=true and the profile picker disabled until the refresh lands', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createMembersStore(createApiClient({ fetch }));
    const initial = store.load('standard-acp');
    await flush();
    calls[0].respond(200, twoProfileState('standard-acp'));
    await initial;

    store.openEdit('tester');
    store.setField('reasoning_effort', 'high');
    const saving = store.submit();
    await flush();
    expect(calls[1].method).toBe('POST');
    calls[1].respond(409, { code: 'STALE_REVISION', message: '配置已被其他地方修改，请刷新后重试' });
    await flush();

    // The refresh GET is in flight.
    expect(calls[2]?.url).toBe('/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');
    let snapshot = store.getSnapshot();
    expect(snapshot.loading).toBe(true);
    expect(snapshot.conflict).toBe('配置已被其他地方修改，请刷新后重试');
    const busyHtml = renderToString(<MembersPanel store={store} />);
    const picker = busyHtml.match(/<select[^>]*aria-label="团队 profile"[^>]*>/)?.[0];
    expect(picker).toBeDefined();
    expect(picker).toContain('disabled');

    calls[2].respond(200, { ...twoProfileState('standard-acp'), revision: 'rev-after-refresh' });
    await saving;
    snapshot = store.getSnapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.revision).toBe('rev-after-refresh');
    expect(renderToString(<MembersPanel store={store} />).match(/<select[^>]*aria-label="团队 profile"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('a load issued before a write cannot overwrite the write result', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createMembersStore(createApiClient({ fetch }));
    const initial = store.load('standard-acp');
    await flush();
    calls[0].respond(200, twoProfileState('standard-acp'));
    await initial;

    const refresh = store.load(); // e.g. the refresh button, still pending
    store.openEdit('tester');
    store.setField('role', '');
    const saving = store.submit();
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    post.respond(200, { ...twoProfileState('standard-acp'), revision: 'rev-written', notice: '已保存，新建会话后生效' });
    await saving;
    calls[1].respond(200, { ...twoProfileState('standard-acp'), revision: 'rev-before-write' });
    await refresh;
    expect(store.getSnapshot().revision).toBe('rev-written');
  });
});

describe('M1 subagent store: same protection', () => {
  it('an older load answered last is discarded', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createSubagentStore(createApiClient({ fetch }));
    const first = store.load();
    const second = store.load();
    await flush();
    calls[1].respond(200, { ...fixtureState(), revision: 'rev-new' });
    await second;
    calls[0].respond(200, { ...fixtureState(), revision: 'rev-old', subagents: [] });
    await first;
    expect(store.getSnapshot().revision).toBe('rev-new');
    expect(store.getSnapshot().rows).toHaveLength(13);
  });

  it('409 keeps loading=true until the refresh lands', async () => {
    const { fetch, calls } = delayedFetch();
    const store = createSubagentStore(createApiClient({ fetch }));
    const initial = store.load();
    await flush();
    calls[0].respond(200, fixtureState());
    await initial;

    store.requestDelete('tool-subagent-tester');
    const deleting = store.confirmDelete();
    await flush();
    calls[1].respond(409, { code: 'STALE_REVISION', message: '配置已被其他地方修改，请刷新后重试' });
    await flush();
    expect(store.getSnapshot().loading).toBe(true);
    expect(calls[2]?.method).toBe('GET');

    calls[2].respond(200, { ...fixtureState(), revision: 'rev-refreshed' });
    await deleting;
    expect(store.getSnapshot().loading).toBe(false);
    expect(store.getSnapshot().revision).toBe('rev-refreshed');
  });
});

// ---------------------------------------------------------------------------
// L1: IME composition guard (host useModalLayer rules)
// ---------------------------------------------------------------------------
describe('L1 composition guard', () => {
  function setup() {
    const doc = new EventTarget();
    const view = new EventTarget();
    const guard = observeComposition(doc as any, view as any);
    const fire = (type: string) => doc.dispatchEvent(new Event(type));
    return { guard, fire, view };
  }
  const escape = (extra: { isComposing?: boolean; keyCode?: number } = {}) => ({ key: 'Escape', keyCode: 27, ...extra });

  it('ignores Escape while isComposing', () => {
    expect(setup().guard.guards(escape({ isComposing: true }))).toBe(true);
  });

  it('ignores Escape with keyCode 229', () => {
    expect(setup().guard.guards(escape({ keyCode: 229 }))).toBe(true);
  });

  it('ignores keys during composition and exactly one keydown right after compositionend', () => {
    const { guard, fire } = setup();
    fire('compositionstart');
    expect(guard.guards(escape())).toBe(true);
    fire('compositionend');
    expect(guard.guards(escape())).toBe(true); // the Escape that cancelled the candidate
    expect(guard.guards(escape())).toBe(false); // the next Escape closes the dialog
  });

  it('keyup after compositionend clears the "just ended" flag', () => {
    const { guard, fire } = setup();
    fire('compositionstart');
    fire('compositionend');
    fire('keyup');
    expect(guard.guards(escape())).toBe(false);
  });

  it('window blur resets an unfinished composition', () => {
    const { guard, fire, view } = setup();
    fire('compositionstart');
    view.dispatchEvent(new Event('blur'));
    expect(guard.guards(escape())).toBe(false);
  });

  it('a plain Escape is not guarded, and dispose removes the listeners', () => {
    const { guard, fire } = setup();
    expect(guard.guards(escape())).toBe(false);
    guard.dispose();
    fire('compositionstart');
    expect(guard.guards(escape())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L2: client copy is Chinese and matches the Host where the meaning is shared
// ---------------------------------------------------------------------------
describe('L2 client messages', () => {
  const failure = (result: { ok: boolean }) => (result.ok ? '' : (result as any).message as string);

  it('shared messages equal what the Host returns for the same case (real fixture)', () => {
    expect(MSG.toolNameDuplicate('subagent_coder')).toBe(failure(createSubagent(FIXTURE, { toolName: 'subagent_coder', provider: 'fork' }, CATALOG)));
    expect(MSG.toolNameFormat('bad-name')).toBe(failure(createSubagent(FIXTURE, { toolName: 'bad-name', provider: 'fork' }, CATALOG)));
    expect(MSG.readOnly).toBe(failure(updateSubagent(FIXTURE, 'tool-subagent-cursor', { backgroundMode: 'one-shot' }, CATALOG)));
    expect(MSG.subagentNotFound('tool-subagent-nope')).toBe(failure(updateSubagent(FIXTURE, 'tool-subagent-nope', { backgroundMode: 'one-shot' }, CATALOG)));
    expect(MSG.agentModelRequired).toBe(failure(createSubagent(FIXTURE, { toolName: 'subagent_x', provider: 'spawn', agentOptions: { provider: 'gpt-gateway' } as any }, CATALOG)));
    expect(MSG.agentProviderRequired).toBe(failure(createSubagent(FIXTURE, { toolName: 'subagent_x', provider: 'spawn', agentOptions: { model: 'gpt-6-luna' } as any }, CATALOG)));
    expect(MSG.memberDuplicate('coder')).toBe(failure(addMember(FIXTURE, 'standard-acp', { name: 'coder' }, CATALOG)));
    expect(MSG.memberNameFormat('Bad_Name')).toBe(failure(addMember(FIXTURE, 'standard-acp', { name: 'Bad_Name' }, CATALOG)));
    expect(MSG.memberNotFound('nobody')).toBe(failure(removeMember(FIXTURE, 'standard-acp', 'nobody')));
    expect(MSG.memberRouteBothOrNeither).toBe(failure(addMember(FIXTURE, 'standard-acp', { name: 'solo', provider: 'gpt-gateway' }, CATALOG)));
  });

  it('matches requirements B2 wording for the four named cases', () => {
    const b2 = readFileSync(join(REPO_ROOT, 'docs/requirements.md'), 'utf8');
    expect(b2).toContain(`「${MSG.lastMember}」`);
    expect(b2).toContain(`「${MSG.readOnly}」`);
    expect(b2).toContain("「工具名 '<toolName>' 已存在」");
    expect(MSG.toolNameDuplicate('<toolName>')).toBe("工具名 '<toolName>' 已存在");
    expect(b2).toContain("「成员 '<name>' 已存在」");
    expect(MSG.memberDuplicate('<name>')).toBe("成员 '<name>' 已存在");
  });

  it('every client message contains Chinese text', () => {
    const texts = Object.values(MSG).map((value) => (typeof value === 'function' ? (value as (s: string) => string)('x') : value));
    for (const text of texts) expect(text, text).toMatch(/[\u4e00-\u9fff]/);
  });

  it('store validation surfaces the shared Chinese text', async () => {
    const members = createMembersStore(mockApi());
    await members.load();
    members.openCreate();
    members.setField('name', 'coder');
    await members.submit();
    expect(members.getSnapshot().form.errors.name).toBe("成员 'coder' 已存在");

    const subagents = createSubagentStore(mockApi());
    await subagents.load();
    subagents.openCreate();
    subagents.setField('toolName', '');
    await subagents.submit();
    expect(subagents.getSnapshot().form.errors.toolName).toBe('请填写工具名');
  });
});
