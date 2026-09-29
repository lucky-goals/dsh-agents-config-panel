import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { listMembers, listTeamProfiles } from './members-editor.js';
import { createTeamProfile, importTeamProfiles, listTeamProfileConfigs, MAX_TEAM_PROFILES, removeTeamProfile } from './teams-editor.js';

const FIXTURE = readFileSync(resolve(__dirname, '../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const TAIL = '  value:\n  op: add\n  path:\n';

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${(result as any).code}: ${(result as any).message}`);
  return result as Extract<T, { ok: true }>;
}

/** The whole agent-teams profiles map as plain data. */
function profilesOf(text: string): Record<string, any> {
  const root = parseDocument(text).toJS({ maxAliasCount: -1 }) as any[];
  return root.find((item) => item?.id === 'agent-teams').config.profiles;
}

/** Bytes outside [from, to) of `after` equal `before` outside the same edit. */
function onlyInserted(before: string, after: string, at: number): string {
  expect(after.slice(0, at)).toBe(before.slice(0, at));
  const added = after.length - before.length;
  expect(after.slice(at + added)).toBe(before.slice(at));
  return after.slice(at, at + added);
}

describe('listTeamProfileConfigs (real fixture)', () => {
  it('returns every team profile with its full config, in file order', () => {
    const teams = listTeamProfileConfigs(FIXTURE);
    expect(Object.keys(teams)).toEqual(['standard-acp']);
    expect(teams['standard-acp']).toEqual(profilesOf(FIXTURE)['standard-acp']);
    expect(teams['standard-acp'].members.map((m: any) => m.name)).toEqual(['claude', 'coder', 'tester', 'front-designer', 'generalist']);
    expect(teams['standard-acp'].protocol).toContain('subagent_explore');
  });
});

describe('createTeamProfile', () => {
  it('clone: copies the source profile text verbatim under the new key; nothing else changes', () => {
    const text = ok(createTeamProfile(FIXTURE, { name: 'standard-acp-copy', from: 'standard-acp' })).yamlText;
    const at = FIXTURE.indexOf(TAIL);
    const inserted = onlyInserted(FIXTURE, text, at);
    const sourceStart = FIXTURE.indexOf('      standard-acp:\n');
    expect(inserted).toBe(FIXTURE.slice(sourceStart, at).replace('      standard-acp:', '      standard-acp-copy:'));
    expect(listTeamProfiles(text)).toEqual(['standard-acp', 'standard-acp-copy']);
    expect(profilesOf(text)['standard-acp-copy']).toEqual(profilesOf(FIXTURE)['standard-acp']);
  });

  it('new: a minimal valid profile with one member (agent-teams requires at least one)', () => {
    const text = ok(createTeamProfile(FIXTURE, { name: 'review', description: '代码审查小组', firstMember: 'reviewer' })).yamlText;
    const inserted = onlyInserted(FIXTURE, text, FIXTURE.indexOf(TAIL));
    expect(inserted).toBe('      review:\n        description: 代码审查小组\n        members:\n          - name: reviewer\n');
    expect(listMembers(text, 'review')).toEqual([{ name: 'reviewer' }]);
    // Without a description, only the member is written.
    const bare = ok(createTeamProfile(FIXTURE, { name: 'solo', firstMember: 'worker' })).yamlText;
    expect(profilesOf(bare).solo).toEqual({ members: [{ name: 'worker' }] });
  });

  it.each([
    [{ name: 'standard-acp', from: 'standard-acp' }, 'DUPLICATE'],
    [{ name: 'Bad Name', firstMember: 'a' }, 'INVALID'],
    [{ name: 'x', from: 'nope' }, 'NOT_FOUND'],
    [{ name: 'x' }, 'INVALID'],
    [{ name: 'x', firstMember: 'captain' }, 'INVALID'],
    [{ name: 'x', firstMember: 'Bad Name' }, 'INVALID'],
  ])('rejects %j with %s', (input, code) => {
    expect(createTeamProfile(FIXTURE, input as any)).toMatchObject({ ok: false, code });
  });

  it(`refuses to go past agent-teams' ${MAX_TEAM_PROFILES}-profile limit`, () => {
    let text = FIXTURE;
    for (let i = 1; i < MAX_TEAM_PROFILES; i += 1) text = ok(createTeamProfile(text, { name: `t${i}`, firstMember: 'm' })).yamlText;
    expect(listTeamProfiles(text)).toHaveLength(MAX_TEAM_PROFILES);
    const over = createTeamProfile(text, { name: 'one-more', firstMember: 'm' });
    expect(over).toMatchObject({ ok: false, code: 'INVALID' });
    expect(!over.ok && over.message).toContain('16');
  });
});

describe('importTeamProfiles', () => {
  const standard = () => profilesOf(FIXTURE)['standard-acp'];

  it('creates new teams and skips existing ones unless they are listed for overwrite', () => {
    const result = ok(importTeamProfiles(FIXTURE, [
      { name: 'standard-acp', profile: { members: [{ name: 'only' }] } },
      { name: 'review', profile: { description: '审查', taskPlanning: 'captain', protocol: '第一行\n第二行\n', members: [{ name: 'reviewer', role: '审查代码' }] } },
    ], []));
    expect(result.report).toEqual({
      created: ['review'],
      overwritten: [],
      skipped: [{ name: 'standard-acp', reason: "团队 'standard-acp' 已存在，未选择覆盖" }],
    });
    expect(profilesOf(result.yamlText)['standard-acp']).toEqual(standard());
    expect(profilesOf(result.yamlText).review).toEqual({ description: '审查', taskPlanning: 'captain', protocol: '第一行\n第二行\n', members: [{ name: 'reviewer', role: '审查代码' }] });
    expect(result.yamlText).toContain('        protocol: |\n          第一行\n          第二行\n');
  });

  it('overwrite replaces the whole existing profile; text outside it is byte-identical', () => {
    const replacement = { description: '新的', members: [{ name: 'solo', provider: 'gpt-gateway', model: 'gpt-6-luna' }] };
    const result = ok(importTeamProfiles(FIXTURE, [{ name: 'standard-acp', profile: replacement }], ['standard-acp']));
    expect(result.report.overwritten).toEqual(['standard-acp']);
    expect(profilesOf(result.yamlText)).toEqual({ 'standard-acp': replacement });
    const start = FIXTURE.indexOf('      standard-acp:\n');
    const end = FIXTURE.indexOf(TAIL);
    expect(result.yamlText.slice(0, start)).toBe(FIXTURE.slice(0, start));
    expect(result.yamlText.endsWith(FIXTURE.slice(end))).toBe(true);
  });

  it('a members-only entry (v2.2–v2.5 file) replaces only members and keeps description/protocol', () => {
    const result = ok(importTeamProfiles(FIXTURE, [{ name: 'standard-acp', profile: { members: [{ name: 'solo' }] }, scope: 'members' }], ['standard-acp']));
    expect(profilesOf(result.yamlText)['standard-acp']).toEqual({ ...standard(), members: [{ name: 'solo' }] });
  });

  it('re-importing an export of the same profiles with overwrite is a semantic no-op', () => {
    const result = ok(importTeamProfiles(FIXTURE, [{ name: 'standard-acp', profile: standard() }], ['standard-acp']));
    expect(profilesOf(result.yamlText)).toEqual(profilesOf(FIXTURE));
  });

  it.each([
    [{ members: [] }, '至少需要一个成员'],
    [{ description: 'x' }, '至少需要一个成员'],
    [{ members: [{ name: 'captain' }] }, 'captain'],
    [{ members: [{ name: 'Coder' }, { name: 'coder' }] }, '重名'],
    [{ members: [{ name: 'a', provider: 'p' }] }, 'model'],
    [{ members: [{ name: 'a', color: 'red' }] }, 'color'],
    [{ members: [{ name: 'a' }], owner: 'me' }, 'owner'],
    [{ members: [{ name: 'a' }], taskPlanning: 'auto' }, 'taskPlanning'],
    [{ members: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}` })) }, 'maxMembers'],
  ])('skips an invalid profile %j with a reason mentioning %s', (profile, text) => {
    const result = ok(importTeamProfiles(FIXTURE, [{ name: 'bad', profile }], []));
    expect(result.yamlText).toBe(FIXTURE);
    expect(result.report.skipped[0].reason).toContain(text);
  });

  it('skips a bad team name and anything past the 16-profile limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `team-${i}`, profile: { members: [{ name: 'm' }] } }));
    const result = ok(importTeamProfiles(FIXTURE, [{ name: 'Bad Name', profile: { members: [{ name: 'm' }] } }, ...many], []));
    expect(result.report.created).toHaveLength(MAX_TEAM_PROFILES - 1);
    expect(listTeamProfiles(result.yamlText)).toHaveLength(MAX_TEAM_PROFILES);
    expect(result.report.skipped[0].reason).toContain('格式不合法');
    expect(result.report.skipped.at(-1)!.reason).toContain('16');
  });
});

describe('importTeamProfiles members-only into a profile without members', () => {
  it('appends the members pair', () => {
    const base = "- id: agent-teams\n  name: '@nanmicoder/dsh-agent-teams'\n  config:\n    profiles:\n      a:\n        description: x\n      b:\n        members:\n          - name: m\n";
    const result = importTeamProfiles(base, [{ name: 'a', profile: { members: [{ name: 'n' }] }, scope: 'members' }], ['a']);
    if (!result.ok) throw new Error(result.message);
    expect(result.yamlText).toBe("- id: agent-teams\n  name: '@nanmicoder/dsh-agent-teams'\n  config:\n    profiles:\n      a:\n        description: x\n        members:\n          - name: n\n      b:\n        members:\n          - name: m\n");
  });
});

describe('removeTeamProfile (v2.7)', () => {
  it('removes exactly the team block; create → remove restores the original bytes', () => {
    const cloned = ok(createTeamProfile(FIXTURE, { name: 'copy', from: 'standard-acp' })).yamlText;
    expect(ok(removeTeamProfile(cloned, 'copy')).yamlText).toBe(FIXTURE);
    const blank = ok(createTeamProfile(FIXTURE, { name: 'solo', firstMember: 'm', description: 'x' })).yamlText;
    expect(ok(removeTeamProfile(blank, 'solo')).yamlText).toBe(FIXTURE);
  });

  it('removing the first of two teams keeps the other byte-identical and the rest of the file unchanged', () => {
    const two = ok(createTeamProfile(FIXTURE, { name: 'solo', firstMember: 'm' })).yamlText;
    const text = ok(removeTeamProfile(two, 'standard-acp')).yamlText;
    expect(listTeamProfiles(text)).toEqual(['solo']);
    const start = FIXTURE.indexOf('      standard-acp:\n');
    expect(text.slice(0, start)).toBe(FIXTURE.slice(0, start));
    expect(text.slice(start)).toBe('      solo:\n        members:\n          - name: m\n' + TAIL + FIXTURE.slice(FIXTURE.indexOf(TAIL) + TAIL.length));
  });

  it('refuses to remove the last team (agent-teams needs the profiles map) and unknown teams', () => {
    expect(removeTeamProfile(FIXTURE, 'standard-acp')).toMatchObject({ ok: false, code: 'LAST_TEAM' });
    expect(removeTeamProfile(FIXTURE, 'nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
