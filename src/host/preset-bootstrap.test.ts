import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSeq } from 'yaml';
import { listSubagents } from './subagent-manager.js';
import { computeRevision, findSubagentSequence, nodeJson, pairValue, parseYaml, scalarString } from './patch-io.js';
import {
  adaptStandardPreset,
  ensureStandardAcpPreset,
  presetInitNotice,
  readInstalledStandardPreset,
  seedStandardAcpPreset,
} from './preset-bootstrap.js';

const USER = `# Your patch layer for this dsh profile, applied after every bundle layer:
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: wuyou-agent
  disabled: false
`;

const FIXTURE = readFileSync(new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url), 'utf8');

const STANDARD_TEMPLATE = `# Agent preset standard
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: You are a coding agent powered by the {{model}} model.
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  backgroundMode: continuable
              - id: tool-bash
                name: '@deepseek-ai/dsh-tool-bash'
                disabled: !!js process.platform === 'win32'
`;

const DSH_BIN = '/opt/homebrew/bin/dsh';
const INSTALLED = existsSync(DSH_BIN)
  ? readInstalledStandardPreset([pathToFileURL(realpathSync(DSH_BIN)).href])
  : undefined;

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

function personaConfig(yaml: string): { suffix?: string; prefix?: string } {
  const root = parseYaml(yaml).contents;
  if (!isSeq(root)) throw new Error('root is not a sequence');
  for (const item of root.items) {
    const insert = pairValue(item, 'insert');
    if (!isSeq(insert)) continue;
    for (const entry of insert.items) {
      const plugins = pairValue(pairValue(entry, 'config'), 'plugins');
      if (!isSeq(plugins)) continue;
      for (const plugin of plugins.items) {
        if (scalarString(pairValue(plugin, 'id')) !== 'persona') continue;
        const config = nodeJson<{ suffix?: string; prefix?: string }>(pairValue(plugin, 'config'));
        return config ?? {};
      }
    }
  }
  throw new Error('persona row missing');
}

describe('adaptStandardPreset', () => {
  it('renames the shipped standard declaration and keeps delegation', () => {
    const adapted = adaptStandardPreset(STANDARD_TEMPLATE);
    expect(adapted).toContain('- id: preset-standard-acp');
    expect(adapted).toContain('id: standard-acp');
    expect(adapted).toContain('name: 标准模式 + ACP 委派');
    expect(adapted).toContain('外加两类 ACP 子 agent：claude-agent-acp 后端');
    expect(adapted).toContain('prefix: |-');
    expect(adapted).toContain('你是 orchestrator（技术负责人兼调度器），使用 {{model}} 模型。严禁亲自写大段代码，不跳过角色。');
    expect(adapted).toContain('suffix: Your working directory is {{cwd}}.');
    expect(adapted).not.toContain('You are a coding agent powered by the {{model}} model.');
    expect(adapted).not.toContain('id: preset-standard\n');
    expect(adapted).toContain('!!js process.platform === \'win32\'');
    expect(findSubagentSequence(parseYaml(adapted!))).toBeDefined();
    expect(personaConfig(adapted!).suffix).toBe('Your working directory is {{cwd}}.');
    expect(personaConfig(adapted!).prefix).toContain('严禁亲自写大段代码，不跳过角色。');
    expect(personaConfig(adapted!).prefix).toContain('并行两个会写同一文件的 cursor 角色');
    expect(personaConfig(adapted!).prefix?.startsWith('你是 orchestrator（技术负责人兼调度器）')).toBe(true);
  });

  it('returns null when the shipped header is not the one this plugin knows', () => {
    expect(adaptStandardPreset('- insert:\n    - id: preset-other\n')).toBeNull();
  });
});

describe('seedStandardAcpPreset', () => {
  it('appends a cloned standard preset and points the registry default at it', () => {
    const seeded = seedStandardAcpPreset(USER, STANDARD_TEMPLATE);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok || !seeded.initialized) return;
    expect(seeded.source).toBe('standard');
    expect(seeded.defaultSet).toBe(true);
    expect(seeded.yamlText.startsWith(USER.trimEnd())).toBe(true);
    expect(seeded.yamlText).toContain('default: standard-acp');
    expect(seeded.yamlText).toContain("name: '@deepseek-ai/dsh-agent-preset'");
    expect(listSubagents(seeded.yamlText).map((row) => row.id)).toEqual(['tool-subagent']);
    const again = seedStandardAcpPreset(seeded.yamlText, STANDARD_TEMPLATE);
    expect(again).toEqual({ ok: true, yamlText: seeded.yamlText, initialized: false });
  });

  it('does not replace a registry default the profile already set', () => {
    const withRegistry = "- id: agent-preset-registry\n  name: '@deepseek-ai/dsh-agent-preset-registry'\n  config:\n    default: minimal\n";
    const seeded = seedStandardAcpPreset(withRegistry, STANDARD_TEMPLATE);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok || !seeded.initialized) return;
    expect(seeded.defaultSet).toBe(false);
    expect(seeded.yamlText).toContain('default: minimal');
    expect(seeded.yamlText.match(/default: standard-acp/g)).toBeNull();
  });

  it('leaves a patch that already has the delegation group byte-for-byte unchanged', () => {
    expect(seedStandardAcpPreset(FIXTURE, STANDARD_TEMPLATE)).toEqual({
      ok: true,
      yamlText: FIXTURE,
      initialized: false,
    });
  });

  it('does not append a second preset when the id exists without a delegation group', () => {
    const partial = `- insert:\n    - id: preset-standard-acp\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: standard-acp\n        plugins:\n          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n`;
    const seeded = seedStandardAcpPreset(partial, STANDARD_TEMPLATE);
    expect(seeded).toMatchObject({
      ok: false,
      code: 'STRUCTURE',
      message: 'preset-standard-acp 已存在但没有 delegation 组，未自动改写',
    });
  });

  it('writes a minimal delegation group when no standard template is available', () => {
    const seeded = seedStandardAcpPreset(USER);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok || !seeded.initialized) return;
    expect(seeded.source).toBe('minimal');
    expect(seeded.defaultSet).toBe(false);
    expect(seeded.yamlText).not.toContain('agent-preset-registry');
    expect(listSubagents(seeded.yamlText).map((row) => row.config.toolName)).toEqual([
      'subagent',
      'subagent_fork',
      'subagent_codex',
      'subagent_claude_code',
    ]);
  });

  it('replaces an empty flow sequence', () => {
    const seeded = seedStandardAcpPreset('[]\n', STANDARD_TEMPLATE);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.yamlText.startsWith('- id: agent-preset-registry') || seeded.yamlText.includes('- id: agent-preset-registry')).toBe(true);
    expect(seeded.yamlText).not.toContain('[]');
    expect(findSubagentSequence(parseYaml(seeded.yamlText))).toBeDefined();
  });
});

describe('ensureStandardAcpPreset', () => {
  it('writes once under the revision lock and is a no-op afterwards', async () => {
    let current = USER;
    const io = {
      async readPatch() {
        return current;
      },
      async writePatchLocked(expected: string, transform: (text: string) => string | Promise<string>) {
        if (computeRevision(current) !== expected) {
          const err = new Error('stale') as Error & { code: string };
          err.code = 'STALE_REVISION';
          throw err;
        }
        current = await transform(current);
        return computeRevision(current);
      },
    };
    const log = silentLog();
    const first = await ensureStandardAcpPreset(io, undefined, log);
    expect(first.notice).toBe(presetInitNotice('minimal', false));
    expect(current).toBe(first.yamlText);
    expect(listSubagents(current).length).toBeGreaterThan(0);
    const second = await ensureStandardAcpPreset(io, undefined, log);
    expect(second).toEqual({ yamlText: current, notice: null });
  });
});

describe('installed standard preset', () => {
  it.skipIf(!INSTALLED)('clones the dsh-web-app standard declaration', () => {
    const seeded = seedStandardAcpPreset(USER, INSTALLED);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok || !seeded.initialized) return;
    expect(seeded.source).toBe('standard');
    expect(seeded.defaultSet).toBe(true);
    expect(seeded.yamlText).toContain('!!js process.platform === \'win32\'');
    expect(seeded.yamlText).toContain('你是 orchestrator（技术负责人兼调度器），使用 {{model}} 模型。严禁亲自写大段代码，不跳过角色。');
    expect(seeded.yamlText).toContain('通过进程外 ACP 协议委派任务，子 agent 拥有独立的运行时、模型与工具。');
    const names = listSubagents(seeded.yamlText).map((row) => row.config.toolName);
    expect(names).toContain('subagent');
    expect(names).toContain('subagent_fork');
  });
});
