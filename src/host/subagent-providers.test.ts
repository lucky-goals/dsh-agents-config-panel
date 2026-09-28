import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSubagentProviders } from './subagent-providers.js';

const fixture = readFileSync(
  new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url),
  'utf8',
);

const noCapabilities = {
  agentOptions: false,
  depthLimit: false,
  continuable: false,
  persona: false,
  toolFilter: false,
};

describe('resolveSubagentProviders', () => {
  it('infers spawn, fork, and every ACP registration from the real patch', () => {
    const providers = resolveSubagentProviders(fixture, null);

    expect(providers.map((provider) => provider.name)).toEqual([
      'spawn',
      'fork',
      'ccacp',
      'cursoracp',
      'kiroopsuacp',
      'kirogptacp',
    ]);
    expect(providers.slice(0, 2)).toEqual([
      {
        name: 'spawn',
        kind: 'in-process',
        capabilities: {
          agentOptions: true,
          depthLimit: true,
          continuable: true,
          persona: true,
          toolFilter: true,
        },
        source: 'patch',
      },
      {
        name: 'fork',
        kind: 'in-process',
        capabilities: {
          agentOptions: true,
          depthLimit: true,
          continuable: true,
          persona: true,
          toolFilter: true,
        },
        source: 'patch',
      },
    ]);
    expect(providers.slice(2)).toEqual(
      ['ccacp', 'cursoracp', 'kiroopsuacp', 'kirogptacp'].map((name) => ({
        name,
        kind: 'acp',
        capabilities: noCapabilities,
        source: 'patch',
      })),
    );
    expect(providers.every((provider) => !('command' in provider))).toBe(true);
  });

  it('uses runtime names and registration order without merging patch-only providers', () => {
    const providers = resolveSubagentProviders(fixture, {
      names: ['custom', 'spawn', 'missing', 'fork'],
      providers: {
        custom: {
          capabilities: {
            agentOptions: true,
            depthLimit: true,
            continuable: false,
            persona: true,
            toolFilter: false,
          },
          // The public result derives continuable from prepareContinuable.
          prepareContinuable: true,
        },
        spawn: {
          capabilities: {
            agentOptions: true,
            depthLimit: true,
            continuable: true,
            persona: true,
            toolFilter: true,
          },
          prepareContinuable: true,
        },
        fork: {
          capabilities: {
            agentOptions: false,
            depthLimit: true,
            continuable: true,
            persona: false,
            toolFilter: false,
          },
          prepareContinuable: false,
        },
      },
    });

    expect(providers.map((provider) => provider.name)).toEqual(['custom', 'spawn', 'fork']);
    expect(providers).toEqual([
      {
        name: 'custom',
        kind: 'unknown',
        capabilities: {
          agentOptions: true,
          depthLimit: true,
          continuable: true,
          persona: true,
          toolFilter: false,
        },
        source: 'runtime',
      },
      {
        name: 'spawn',
        kind: 'in-process',
        capabilities: {
          agentOptions: true,
          depthLimit: true,
          continuable: true,
          persona: true,
          toolFilter: true,
        },
        source: 'runtime',
      },
      {
        name: 'fork',
        kind: 'in-process',
        capabilities: {
          agentOptions: false,
          depthLimit: true,
          continuable: false,
          persona: false,
          toolFilter: false,
        },
        source: 'runtime',
      },
    ]);
  });

  it('treats an empty runtime as authoritative instead of falling back to patch', () => {
    expect(resolveSubagentProviders(fixture, { names: [], providers: {} })).toEqual([]);
  });
});
