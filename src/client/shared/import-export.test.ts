import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listSubagents } from '../../host/subagent-manager';
import { listAcps } from '../../host/acp-manager';
import { resolveSubagentProviders } from '../../host/subagent-providers';
import type { AcpRow, SubagentRow } from './api-types';
import { listTeamProfileConfigs } from '../../host/teams-editor';
import {
  exportTeams,
  parseTeamsFile,
  previewTeamsImport,
  teamsExportFilename,
  teamsImportRequest,
  exportSubagentBundle,
  importableBundle,
  parseSubagentBundle,
  previewSubagentImport,
  subagentExportFilename,
} from './import-export';

const FIXTURE = readFileSync(resolve(__dirname, '../../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const ACPS = listAcps(FIXTURE) as AcpRow[];
const ROWS = listSubagents(FIXTURE) as SubagentRow[];
const PROVIDERS = resolveSubagentProviders(FIXTURE, null).map((p) => p.name);
const DATE = new Date(2026, 0, 2, 3, 4, 5);

describe('Panel A bundle', () => {
  it('exports ACPs and subagents of the profile, and parses back to the same values', () => {
    const text = exportSubagentBundle(ACPS, ROWS, 'desktop', DATE);
    expect(text.startsWith('# 无忧Subagent 配置导出\n# 来源 DSH profile: desktop\n')).toBe(true);
    expect(text).toContain('env 可能含密钥');
    const bundle = parseSubagentBundle(text);
    expect(bundle.dshProfile).toBe('desktop');
    expect(bundle.acps).toEqual(ACPS.map((a) => a.config));
    expect(bundle.subagents.map((s) => s.toolName)).toEqual(ROWS.map((r) => r.config.toolName));
    const coder = bundle.subagents.find((s) => s.toolName === 'subagent_coder')!;
    expect(coder).toEqual({
      toolName: 'subagent_coder', provider: 'spawn', backgroundMode: 'continuable',
      agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
    });
    // Mount-only keys are not exported; the Host re-derives them on import.
    expect(text).not.toContain('maxDepth');
    expect(text).not.toContain('modelSelectionSettings');
  });

  it('re-importing into the same profile skips everything with a reason', () => {
    const bundle = parseSubagentBundle(exportSubagentBundle(ACPS, ROWS, 'desktop', DATE));
    const preview = previewSubagentImport(bundle, { acps: ACPS, rows: ROWS, providers: PROVIDERS });
    expect(preview.acps.every((p) => p.skip?.includes('已存在'))).toBe(true);
    expect(preview.subagents.every((p) => p.skip?.includes('已存在'))).toBe(true);
    expect(importableBundle(preview)).toEqual({ acps: [], subagents: [] });
  });

  it('into an empty profile: ACP-backed tools are importable because their ACP is in the file', () => {
    const bundle = parseSubagentBundle(exportSubagentBundle(ACPS, ROWS, 'desktop', DATE));
    const preview = previewSubagentImport(bundle, { acps: [], rows: [], providers: ['spawn', 'fork'] });
    expect(preview.acps.filter((p) => !p.skip)).toHaveLength(4);
    const skipped = preview.subagents.filter((p) => p.skip).map((p) => [p.item.toolName, p.skip]);
    // Only the rows whose provider no one registers (codex, claude-code) are skipped.
    expect(skipped.map(([name]) => name).sort()).toEqual(['subagent_claude_code', 'subagent_codex']);
    expect(skipped[0][1]).toContain('未注册');
  });

  it('accepts a v2.2 file (subagents only, with ids) and drops unknown keys', () => {
    const v22 = 'subagents:\n  - id: tool-subagent-x\n    provider: spawn\n    toolName: subagent_x\n    backgroundMode: one-shot\n    evil: 1\n';
    expect(parseSubagentBundle(v22)).toEqual({ acps: [], subagents: [{ toolName: 'subagent_x', provider: 'spawn', backgroundMode: 'one-shot' }] });
  });

  it.each([
    ['not: [valid', 'YAML 解析失败'],
    ['- a\n- b\n', '不是 YAML 映射'],
    ['foo: 1\n', '不是无忧Subagent 导出文件'],
    ['acps: {}\n', 'acps 必须是列表'],
  ])('rejects %j', (text, message) => {
    expect(() => parseSubagentBundle(text)).toThrow(message);
  });

  it('flags duplicates inside the file', () => {
    const acp = ACPS[0].config;
    const preview = previewSubagentImport(
      { acps: [{ ...acp, providerName: 'n1' }, { ...acp, providerName: 'n1' }], subagents: [] },
      { acps: [], rows: [], providers: [] },
    );
    expect(preview.acps.map((p) => p.skip)).toEqual([undefined, '文件中重复']);
  });

  it('file names carry the source DSH profile and a local timestamp', () => {
    expect(subagentExportFilename('web', DATE)).toBe('wuyou-subagents-web-20260102-030405.yaml');
    expect(subagentExportFilename('a/b c', DATE)).toBe('wuyou-subagents-a_b_c-20260102-030405.yaml');
  });
});

describe('Panel B teams file (v2.6: all team profiles)', () => {
  const standard = listTeamProfileConfigs(FIXTURE)['standard-acp'];
  const teams = { 'standard-acp': standard, review: { description: '审查', members: [{ name: 'reviewer', role: '第一行\n第二行' }] } };

  it('exports every team profile with its full config and parses back to the same values', () => {
    const text = exportTeams(teams, 'web', DATE);
    expect(text.startsWith('# 无忧Teams 配置导出\n# 来源 DSH profile: web\n# 团队 profile: standard-acp, review\n')).toBe(true);
    const parsed = parseTeamsFile(text);
    expect(parsed.sourceProfile).toBe('web');
    expect(parsed.teams).toEqual([
      { name: 'standard-acp', profile: standard, scope: 'full' },
      { name: 'review', profile: teams.review, scope: 'full' },
    ]);
    expect(teamsExportFilename('web', DATE)).toBe('wuyou-teams-web-20260102-030405.yaml');
  });

  it('reads a v2.2–v2.5 members file as one members-only team (keeps the other team fields on overwrite)', () => {
    const legacy = "kind: wuyou-members\nversion: 3\nprofile: standard-acp\nmembers:\n  - name: claude\n  - name: extra\n    role: 甲\n";
    expect(parseTeamsFile(legacy).teams).toEqual([{ name: 'standard-acp', profile: { members: [{ name: 'claude' }, { name: 'extra', role: '甲' }] }, scope: 'members' }]);
    expect(parseTeamsFile('members:\n  - name: a\n').teams[0].name).toBe('imported');
  });

  it.each([
    ['not: [valid', 'YAML 解析失败'],
    ['foo: 1\n', '不是无忧Teams 导出文件'],
    ['profiles: [a]\n', 'profiles 必须是映射'],
  ])('rejects %j', (text, message) => {
    expect(() => parseTeamsFile(text)).toThrow(message);
  });

  it('previews new / existing (overwrite needs a choice) / invalid teams with member counts and warnings', () => {
    const file = parseTeamsFile(exportTeams({
      'standard-acp': { members: [{ name: 'solo' }] },
      review: { members: [{ name: 'reviewer', provider: 'nope', model: 'x' }] },
      empty: { members: [] },
      'Bad Name': { members: [{ name: 'a' }] },
    }, 'web', DATE));
    const preview = previewTeamsImport(file, { 'standard-acp': standard }, ['gusu-gateway', 'gpt-gateway']);
    expect(preview.map((p) => [p.name, p.status, p.fileMembers, p.currentMembers ?? null])).toEqual([
      ['standard-acp', 'conflict', 1, 5],
      ['review', 'new', 1, null],
      ['empty', 'invalid', 0, null],
      ['Bad Name', 'invalid', 1, null],
    ]);
    expect(preview[1].warnings).toEqual(["成员 reviewer 的 provider 'nope' 不在本机模型目录中"]);
    expect(preview[2].reason).toContain('至少需要一个成员');
    expect(preview[3].reason).toContain('格式不合法');
  });

  it('the request sends new teams and conflicts; only the ticked conflicts are overwritten', () => {
    const file = parseTeamsFile(exportTeams({ 'standard-acp': standard, review: teams.review, empty: { members: [] } }, 'web', DATE));
    const preview = previewTeamsImport(file, { 'standard-acp': standard }, []);
    expect(teamsImportRequest(preview, new Set(), 'r1')).toEqual({
      expectedRevision: 'r1',
      teams: [
        { name: 'standard-acp', profile: standard, scope: 'full' },
        { name: 'review', profile: teams.review, scope: 'full' },
      ],
      overwrite: [],
    });
    expect(teamsImportRequest(preview, new Set(['standard-acp']), 'r1').overwrite).toEqual(['standard-acp']);
  });
});
