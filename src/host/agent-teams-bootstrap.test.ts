import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMembers, listTeamProfiles } from './members-editor.js';
import { isMap, isSeq } from 'yaml';
import { nodeJson, pairValue, parseYaml, scalarString } from './patch-io.js';
import {
  AGENT_TEAMS_PACKAGE,
  BASIC_TEAM_MEMBER,
  BASIC_TEAM_PROFILE,
  loadInstalledAgentTeams,
  readBundleAgentTeamsConfig,
  seedBasicTeamProfile,
} from './agent-teams-bootstrap.js';

const BUNDLE = `# bundle
- insert:
    - id: agent-teams
      name: '@nanmicoder/dsh-agent-teams'
      config:
        stateDir: .agent-teams
        memberProvider: spawn
`;

const USER = `# Your patch layer for this dsh profile, applied after every bundle layer:
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: wuyou-agent
  disabled: false
`;

const FIXTURE = readFileSync(new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url), 'utf8');

function bundleConfig() {
  const config = readBundleAgentTeamsConfig(BUNDLE);
  if (!config) throw new Error('bundle config missing');
  return config;
}

function pluginConfig(yamlText: string) {
  const root = parseYaml(yamlText).contents;
  if (!isSeq(root)) throw new Error('root is not a sequence');
  const plugin = root.items.find((item) => scalarString(pairValue(item, 'id')) === 'agent-teams');
  const config = pairValue(plugin, 'config');
  if (!isMap(config)) throw new Error('agent-teams config missing');
  return nodeJson<Record<string, unknown>>(config);
}

describe('seedBasicTeamProfile', () => {
  it('reads config from a bundle insert and appends a user-layer override', () => {
    expect(bundleConfig()).toEqual({ stateDir: '.agent-teams', memberProvider: 'spawn' });
    const seeded = seedBasicTeamProfile(USER, bundleConfig());
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.yamlText.startsWith(USER.trimEnd())).toBe(true);
    expect(seeded.yamlText).toContain("name: '@nanmicoder/dsh-agent-teams'");
    expect(seeded.yamlText).toContain('\n    stateDir: .agent-teams\n    memberProvider: spawn\n    profiles:\n');
    expect(listTeamProfiles(seeded.yamlText)).toEqual([BASIC_TEAM_PROFILE]);
    expect(listMembers(seeded.yamlText, BASIC_TEAM_PROFILE).map((member) => member.name)).toEqual([BASIC_TEAM_MEMBER]);
    expect(pluginConfig(seeded.yamlText)).toMatchObject({
      stateDir: '.agent-teams',
      memberProvider: 'spawn',
    });
    const again = seedBasicTeamProfile(seeded.yamlText, bundleConfig());
    expect(again).toEqual({ ok: true, yamlText: seeded.yamlText });
  });

  it('leaves a patch that already has team profiles byte-for-byte unchanged', () => {
    const seeded = seedBasicTeamProfile(FIXTURE, bundleConfig());
    expect(seeded).toEqual({ ok: true, yamlText: FIXTURE });
  });

  it('adds profiles onto an existing override and keeps bundle scalars that were omitted', () => {
    const partial = "- id: agent-teams\n  name: '@nanmicoder/dsh-agent-teams'\n  config:\n    memberModel: deepseek-v4\n";
    const seeded = seedBasicTeamProfile(partial, bundleConfig());
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.yamlText).toContain('memberModel: deepseek-v4');
    expect(seeded.yamlText).toContain('stateDir: .agent-teams');
    expect(seeded.yamlText).toContain('memberProvider: spawn');
    expect(listTeamProfiles(seeded.yamlText)).toEqual([BASIC_TEAM_PROFILE]);
  });
});

describe('loadInstalledAgentTeams', () => {
  it('reads the package installed in a profile directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wuyou-agent-teams-'));
    const pkg = join(dir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: AGENT_TEAMS_PACKAGE, version: '0.1.22-rc.1' }));
    writeFileSync(join(pkg, 'cordis.patch.yml'), BUNDLE);
    expect(loadInstalledAgentTeams(dir)).toEqual({
      version: '0.1.22-rc.1',
      config: { stateDir: '.agent-teams', memberProvider: 'spawn' },
    });
    expect(loadInstalledAgentTeams(join(dir, 'missing'))).toBeUndefined();
  });
});
