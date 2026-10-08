import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { AGENT_TEAMS_PACKAGE } from '../../src/host/agent-teams-bootstrap.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(THIS_DIR, '../..');

/** Name this plugin publishes under after the scope rename. */
const EXPECTED_NAME = '@luckygoals/dsh-wuyou-agent';
/**
 * Unrelated third-party dependency, declared first so the retired name below can be derived
 * from it instead of being spelled out here as a literal.
 */
const THIRD_PARTY_NAME = '@nanmicoder/dsh-agent-teams';
/**
 * Retired name of this plugin: same scope as the third party, different package.
 * It must not survive anywhere except the migration note in docs/INSTALL.md.
 */
const OLD_NAME = THIRD_PARTY_NAME.replace('dsh-agent-teams', 'dsh-wuyou-agent');

function readText(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

interface PackageManifest {
  name?: unknown;
  author?: unknown;
  repository?: { url?: unknown };
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(readText(relativePath)) as PackageManifest;
}

const pkg = readManifest('package.json');

interface PatchEntry {
  id?: unknown;
  name?: unknown;
}

interface PatchInsert {
  insert?: PatchEntry[];
}

function insertEntries(): PatchEntry[] {
  const documents = parse(readText('cordis.patch.yml')) as PatchInsert[] | null;
  return (documents ?? []).flatMap((document) => document.insert ?? []);
}

describe('package identity', () => {
  it('package.json declares the renamed identity', () => {
    expect(pkg.name).toBe(EXPECTED_NAME);
    expect(pkg.author).toBe('lucky-goals');
    expect(pkg.repository?.url).toBe('git+https://github.com/lucky-goals/dsh-agents-config-panel.git');
  });

  it('package-lock.json mirrors the package.json name', () => {
    const lock = JSON.parse(readText('package-lock.json')) as {
      name?: unknown;
      packages?: Record<string, { name?: unknown }>;
    };
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages?.['']?.name).toBe(pkg.name);
  });

  it('cordis.patch.yml inserts the wuyou-agent plugin under the renamed package', () => {
    const entry = insertEntries().find((candidate) => candidate.id === 'wuyou-agent');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe(pkg.name);
    expect(readText('cordis.patch.yml')).not.toContain(OLD_NAME);
  });

  it('CB0 build-client 不再写死 bundle id，由 package.json name 派生', () => {
    const source = readText('scripts/build-client.mjs');
    const packageName = pkg.name as string;

    expect(source).not.toContain(OLD_NAME);
    expect(source).not.toContain(packageName);
    expect(source).toContain('wrapClientBundle(');
  });

  it('user-facing docs no longer reference the old package name', () => {
    for (const doc of ['README.md', 'docs/requirements.md']) {
      expect(readText(doc), doc).not.toContain(OLD_NAME);
    }
  });

  it('keeps the third-party agent-teams package name untouched', () => {
    expect(AGENT_TEAMS_PACKAGE).toBe(THIRD_PARTY_NAME);

    const bootstrap = readText('src/host/agent-teams-bootstrap.ts');
    expect(bootstrap).toContain(`export const AGENT_TEAMS_PACKAGE = '${THIRD_PARTY_NAME}';`);
    expect(bootstrap).toContain("join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams')");
  });
});
