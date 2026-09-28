import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listSubagents } from '../../host/subagent-manager';
import { listMembers } from '../../host/members-editor';
import { listAcps } from '../../host/acp-manager';
import { resolveSubagentProviders } from '../../host/subagent-providers';
import type { AcpRow, SubagentRow, TeamMember } from './api-types';
import {
  exportMembers,
  exportSubagentBundle,
  importableBundle,
  membersExportFilename,
  parseMembersFile,
  parseSubagentBundle,
  previewMembersImport,
  previewSubagentImport,
  subagentExportFilename,
} from './import-export';

const FIXTURE = readFileSync(resolve(__dirname, '../../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const ACPS = listAcps(FIXTURE) as AcpRow[];
const ROWS = listSubagents(FIXTURE) as SubagentRow[];
const PROVIDERS = resolveSubagentProviders(FIXTURE, null).map((p) => p.name);
const MEMBERS = listMembers(FIXTURE, 'standard-acp') as TeamMember[];
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
    expect(membersExportFilename('standard-acp', DATE)).toBe('wuyou-members-standard-acp-20260102-030405.yaml');
  });
});

describe('Panel B members file', () => {
  it('round-trips the real members, including multi-line roles', () => {
    const members = [...MEMBERS, { name: 'multi', role: '第一行\n第二行' }];
    expect(parseMembersFile(exportMembers(members, 'standard-acp', DATE))).toEqual(members);
  });

  it('previews: existing, duplicate and unknown-provider members are skipped', () => {
    const preview = previewMembersImport(
      [{ name: 'claude' }, { name: 'new-one' }, { name: 'new-one' }, { name: 'x', provider: 'nope' }],
      MEMBERS,
      ['gusu-gateway', 'gpt-gateway'],
    );
    expect(preview.map((p) => p.skip ?? 'ok')).toEqual(["成员 'claude' 已存在", 'ok', '文件中重复', "provider 'nope' 不在模型目录中"]);
  });
});
