import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCatalog } from './catalog';
import {
  addMember,
  listMembers,
  listTeamProfiles,
  removeMember,
  updateMember,
} from './members-editor';

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

describe('MembersEditor against the real agent-teams shape', () => {
  it('lists the real standard-acp profile and preserves member order and fields', () => {
    expect(listTeamProfiles(fixture)).toEqual(['standard-acp']);
    const members = listMembers(fixture, 'standard-acp');
    expect(members.map((member) => member.name)).toEqual([
      'claude',
      'coder',
      'tester',
      'front-designer',
      'generalist',
    ]);
    expect(members.find((member) => member.name === 'coder')).toMatchObject({
      provider: 'gusu-gateway',
      model: 'claude-opus-5-5',
      reasoning_effort: 'high',
    });
    expect(members.find((member) => member.name === 'tester')).toMatchObject({
      provider: 'gpt-gateway',
      model: 'gpt-6-luna',
      reasoning_effort: 'max',
    });
    expect(members.find((member) => member.name === 'coder')?.role).toContain('attempt_id');
  });

  it('adds a member to standard-acp and reads it back', () => {
    const result = addMember(
      fixture,
      'standard-acp',
      {
        name: 'qa-reviewer',
        role: 'Fixture reviewer',
        provider: 'gpt-gateway',
        model: 'gpt-6-luna',
        reasoning_effort: 'high',
      },
      catalog
    );
    const changed = yamlText(result);
    expect(listMembers(changed, 'standard-acp').at(-1)).toEqual({
      name: 'qa-reviewer',
      role: 'Fixture reviewer',
      provider: 'gpt-gateway',
      model: 'gpt-6-luna',
      reasoning_effort: 'high',
    });
    expect(changed).toContain('  value:\n  op: add\n  path:\n- id: ui-theme');
  });

  it('rejects duplicate, malformed, invalid-route, and invalid-name members', () => {
    const duplicate = addMember(
      fixture,
      'standard-acp',
      { name: 'coder', role: 'duplicate' },
      catalog
    );
    expect(duplicate).toMatchObject({
      ok: false,
      code: 'DUPLICATE',
      message: "成员 'coder' 已存在",
    });

    const providerWithoutModel = addMember(
      fixture,
      'standard-acp',
      { name: 'qa-provider-only', provider: 'gpt-gateway' },
      catalog
    );
    expect(providerWithoutModel).toMatchObject({ ok: false, code: 'INVALID' });

    const unknownModel = addMember(
      fixture,
      'standard-acp',
      {
        name: 'qa-unknown-model',
        provider: 'gpt-gateway',
        model: 'does-not-exist',
      },
      catalog
    );
    expect(unknownModel).toMatchObject({ ok: false, code: 'INVALID' });

    const invalidName = addMember(
      fixture,
      'standard-acp',
      { name: 'Bad_Name' },
      catalog
    );
    expect(invalidName).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('updates only coder model while preserving roles, other members, and tail patch keys', () => {
    const result = updateMember(
      fixture,
      'standard-acp',
      'coder',
      { model: 'claude-sonnet-5' },
      catalog
    );
    const changed = yamlText(result);
    const expected = replaceFirstFrom(
      fixture,
      /^ *- name: coder$/m,
      'model: claude-opus-5-5',
      'model: claude-sonnet-5'
    );
    expect(changed).toBe(expected);
    expect(listMembers(changed, 'standard-acp').find((member) => member.name === 'coder')).toMatchObject({
      name: 'coder',
      model: 'claude-sonnet-5',
      role: expect.stringContaining('attempt_id'),
    });
    expect(changed).toContain('  value:\n  op: add\n  path:\n- id: ui-theme');
  });

  it('removes members until one remains, then returns LAST_MEMBER without writing', () => {
    let text = fixture;
    for (const name of ['claude', 'coder', 'tester', 'front-designer']) {
      text = yamlText(removeMember(text, 'standard-acp', name));
    }
    const remaining = listMembers(text, 'standard-acp');
    expect(remaining).toHaveLength(1);
    const lastResult = removeMember(text, 'standard-acp', remaining[0].name);
    expect(lastResult).toMatchObject({
      ok: false,
      code: 'LAST_MEMBER',
      message: '团队至少需要保留一个成员',
    });
    expect(lastResult.ok ? lastResult.yamlText : text).toBe(text);
  });

  it('B02: re-saving every real member with all current fields is a byte-identical no-op', () => {
    const members = listMembers(fixture, 'standard-acp');
    expect(members.map((member) => member.name)).toContain('tester');
    for (const member of members) {
      const result = updateMember(fixture, 'standard-acp', member.name, { ...member }, catalog);
      expect(result, member.name).toMatchObject({ ok: true });
      expect(yamlText(result), member.name).toBe(fixture);
    }
  });

  it('B02: a changed long role is written on one line and reads back exactly', () => {
    const role = `${'很长的角色说明'.repeat(20)}: 含冒号 #含井号 结尾`;
    const changed = yamlText(updateMember(fixture, 'standard-acp', 'tester', { role }, catalog));
    expect(listMembers(changed, 'standard-acp').find((member) => member.name === 'tester')?.role).toBe(role);
    // Everything outside tester's role value is untouched.
    const testerStart = findRequiredLine(fixture, /^ *- name: tester$/m);
    const nextMember = findRequiredLine(fixture, /^ *- name: front-designer$/m);
    expect(changed.slice(0, testerStart)).toBe(fixture.slice(0, testerStart));
    expect(changed.endsWith(fixture.slice(nextMember))).toBe(true);
  });

  it('B02: adds a member whose 300-character Chinese role contains ": " and " #"', () => {
    const role = `${'中'.repeat(140)}: 冒号后 #井号 ${'文'.repeat(150)}`;
    expect([...role].length).toBeGreaterThanOrEqual(300);
    const changed = yamlText(addMember(
      fixture,
      'standard-acp',
      { name: 'long-role', role, provider: 'gpt-gateway', model: 'gpt-6-luna' },
      catalog
    ));
    expect(listMembers(changed, 'standard-acp').find((member) => member.name === 'long-role')).toEqual({
      name: 'long-role',
      role,
      provider: 'gpt-gateway',
      model: 'gpt-6-luna',
    });
  });

  it('B02: multi-line roles are re-indented under the member keys', () => {
    const role = '第一行\n第二行: 带冒号\n  第三行保留前导空格';
    const changed = yamlText(updateMember(fixture, 'standard-acp', 'claude', { role }, catalog));
    expect(listMembers(changed, 'standard-acp').find((member) => member.name === 'claude')?.role).toBe(role);
    expect(listMembers(changed, 'standard-acp').map((member) => member.name)).toEqual(
      listMembers(fixture, 'standard-acp').map((member) => member.name)
    );
  });

  it('B03: add a member without role, then add role and reasoning_effort at the key column', () => {
    const added = yamlText(addMember(fixture, 'standard-acp', { name: 'bare' }, catalog));
    const withRole = yamlText(updateMember(added, 'standard-acp', 'bare', { role: '后补的角色' }, catalog));
    const withRoute = yamlText(updateMember(
      withRole,
      'standard-acp',
      'bare',
      { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'high' },
      catalog
    ));
    expect(listMembers(withRoute, 'standard-acp').find((member) => member.name === 'bare')).toEqual({
      name: 'bare',
      role: '后补的角色',
      provider: 'gpt-gateway',
      model: 'gpt-6-luna',
      reasoning_effort: 'high',
    });
    // New keys sit exactly under `name`, i.e. two columns right of the dash.
    const lines = withRoute.split('\n');
    const bareIndex = lines.findIndex((line) => /- name: bare$/.test(line));
    expect(bareIndex).toBeGreaterThanOrEqual(0);
    const keyColumn = lines[bareIndex].indexOf('name');
    const memberLines = lines.slice(bareIndex + 1, bareIndex + 5);
    // Appended keys follow patch insertion order; only their set and column matter.
    expect(memberLines.map((line) => line.trimStart().split(':')[0]).sort()).toEqual(
      ['model', 'provider', 'reasoning_effort', 'role']
    );
    for (const line of memberLines) {
      expect(line.length - line.trimStart().length, line).toBe(keyColumn);
    }
  });

  it('never throws from the pure boundary: an unwritable field becomes INVALID naming it', () => {
    const result = updateMember(fixture, 'standard-acp', 'tester', { role: (() => 1) as unknown as string }, catalog);
    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
    expect(result.ok ? '' : result.message).toMatch(/^字段 role 无法写入：/);
  });

  describe('M2: null clears an optional member field', () => {
    const others = (text: string) => listMembers(text, 'standard-acp').filter((member) => member.name !== 'coder');
    const tail = '  value:\n  op: add\n  path:\n- id: ui-theme';

    it('removes coder\'s whole multi-line role block and nothing else', () => {
      const changed = yamlText(updateMember(fixture, 'standard-acp', 'coder', { role: null } as any, catalog));

      // Exactly the two source lines of coder's folded plain role disappear.
      const start = findRequiredLine(fixture, /^ *role: 你是团队 coder。/m);
      const end = fixture.indexOf('\n', fixture.indexOf('报告。', start)) + 1;
      expect(fixture.slice(start, end).split('\n').filter(Boolean)).toHaveLength(2);
      expect(changed).toBe(`${fixture.slice(0, start)}${fixture.slice(end)}`);

      const coder = listMembers(changed, 'standard-acp').find((member) => member.name === 'coder')!;
      expect(coder).toEqual({ name: 'coder', provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoning_effort: 'high' });
      expect(others(changed)).toEqual(others(fixture));
      expect(changed).toContain(tail);
    });

    it('clears provider and model together', () => {
      const changed = yamlText(updateMember(fixture, 'standard-acp', 'coder', { provider: null, model: null } as any, catalog));
      const coder = listMembers(changed, 'standard-acp').find((member) => member.name === 'coder')!;
      expect(coder).not.toHaveProperty('provider');
      expect(coder).not.toHaveProperty('model');
      expect(coder.role).toContain('attempt_id');
      expect(others(changed)).toEqual(others(fixture));
    });

    it('clears reasoning_effort alone', () => {
      const changed = yamlText(updateMember(fixture, 'standard-acp', 'tester', { reasoning_effort: null } as any, catalog));
      expect(listMembers(changed, 'standard-acp').find((member) => member.name === 'tester')).not.toHaveProperty('reasoning_effort');
    });

    it('rejects clearing provider while keeping model', () => {
      const result = updateMember(fixture, 'standard-acp', 'coder', { provider: null } as any, catalog);
      expect(result).toMatchObject({ ok: false, code: 'INVALID', message: '成员 provider 和 model 必须同时填写' });
    });

    it('rejects clearing the required name', () => {
      const result = updateMember(fixture, 'standard-acp', 'coder', { name: null } as any, catalog);
      expect(result).toEqual({ ok: false, code: 'INVALID', message: '字段 name 不能清空' });
    });

    it('clearing an absent key is a byte-identical no-op', () => {
      const once = yamlText(updateMember(fixture, 'standard-acp', 'coder', { role: null } as any, catalog));
      expect(yamlText(updateMember(once, 'standard-acp', 'coder', { role: null } as any, catalog))).toBe(once);
    });

    it('clears a field written on the sequence item line without breaking the item', () => {
      const text = [
        '- id: agent-teams',
        '  config:',
        '    profiles:',
        '      p:',
        '        members:',
        '          - role: first',
        '            name: a',
        '          - name: b',
        '',
      ].join('\n');
      const changed = yamlText(updateMember(text, 'p', 'a', { role: null } as any, { providers: [] }));
      expect(changed).toBe(text.replace('          - role: first\n            name: a', '          - name: a'));
      expect(listMembers(changed, 'p')).toEqual([{ name: 'a' }, { name: 'b' }]);
    });
  });

  it('throws contract STRUCTURE errors for missing agent-teams and profiles', () => {
    const malformed = '- id: unrelated\n  name: plugin\n';
    expect(() => listTeamProfiles(malformed)).toThrow(
      '未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams'
    );
    expect(() => listMembers(fixture, 'missing-profile')).toThrow(
      "未找到团队 profile 'missing-profile'"
    );
  });
});
