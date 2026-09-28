import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAtomicWrite, buildCatalog } from './runtime-deps.js';
import type { LLMService } from './runtime-deps.js';

describe('runtime-deps', () => {
  describe('loadAtomicWrite', () => {
    // A throwaway tree with a fake @deepseek-ai/dsh-atomic-write so success and
    // failure are deterministic, independent of what this machine has installed.
    let root: string;
    let withDep: string;
    let withoutDep: string;
    let fakeEntry: string;

    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'wuyou-loadaw-')));
      withDep = join(root, 'has-dep');
      withoutDep = join(root, 'no-dep');
      const pkgDir = join(withDep, 'node_modules', '@deepseek-ai', 'dsh-atomic-write');
      mkdirSync(pkgDir, { recursive: true });
      mkdirSync(withoutDep, { recursive: true });
      writeFileSync(join(withDep, 'package.json'), '{}');
      writeFileSync(join(withoutDep, 'package.json'), '{}');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-atomic-write', main: 'index.cjs' }));
      fakeEntry = join(pkgDir, 'index.cjs');
      writeFileSync(fakeEntry, 'exports.withFileLock = async (_f, op) => op();\nexports.writeFileAtomic = async () => {};\n');
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('reports every anchor it tried, in order, when none resolves the package', () => {
      const anchors = [
        pathToFileURL(join(withoutDep, 'package.json')).href,
        'file:///nonexistent/first/index.js',
        'file:///nonexistent/second/index.js',
      ];
      const result = loadAtomicWrite(anchors);

      expect(result).toEqual({
        error: 'Could not resolve @deepseek-ai/dsh-atomic-write from any anchor',
        tried: anchors,
      });
    });

    it('stops at the first anchor that resolves and reports it with the resolved path', () => {
      const missing = pathToFileURL(join(withoutDep, 'package.json')).href;
      const hit = pathToFileURL(join(withDep, 'package.json')).href;
      const never = 'file:///nonexistent/after/index.js';
      const result = loadAtomicWrite([missing, hit, never]);

      expect('error' in result).toBe(false);
      expect(result).toMatchObject({ anchor: hit, resolvedPath: fakeEntry });
      const loaded = result as Extract<typeof result, { anchor: string }>;
      expect(typeof loaded.withFileLock).toBe('function');
      expect(typeof loaded.writeFileAtomic).toBe('function');
    });

    it('returns an empty tried list for no anchors', () => {
      expect(loadAtomicWrite([])).toEqual({
        error: 'Could not resolve @deepseek-ai/dsh-atomic-write from any anchor',
        tried: [],
      });
    });
  });

  describe('buildCatalog', () => {
    it('falls back to readCatalog when llm is undefined', async () => {
      const yamlText = `
- id: llm-pi-ai
  config:
    providers:
      test-provider:
        models:
          - id: test-model
            reasoningEfforts:
              low: low
              high: high
`;
      const catalog = await buildCatalog(undefined, yamlText);
      expect(catalog.providers).toHaveLength(1);
      expect(catalog.providers[0].id).toBe('test-provider');
      expect(catalog.providers[0].models[0].reasoningEfforts).toEqual(['low', 'high']);
    });

    it('uses llm.resolveModelInfo for reasoning efforts', async () => {
      const mockLLM: LLMService = {
        listProviders: () => [{ id: 'gpt-gateway' }],
        listModels: vi.fn().mockResolvedValue([{ id: 'gpt-6-luna' }]),
        resolveModelInfo: vi.fn().mockResolvedValue({
          reasoning: {
            efforts: [{ id: 'low' }, { id: 'high' }],
          },
        }),
      };

      const catalog = await buildCatalog(mockLLM, '');
      expect(catalog.providers).toHaveLength(1);
      expect(catalog.providers[0].id).toBe('gpt-gateway');
      expect(catalog.providers[0].models[0].id).toBe('gpt-6-luna');
      expect(catalog.providers[0].models[0].reasoningEfforts).toEqual(['low', 'high']);
      expect(mockLLM.resolveModelInfo).toHaveBeenCalledWith('gpt-gateway', 'gpt-6-luna');
    });

    it('falls back to readCatalog for specific model when resolveModelInfo fails', async () => {
      const yamlText = `
- id: llm-pi-ai
  config:
    providers:
      gpt-gateway:
        models:
          - id: gpt-6-luna
            reasoningEfforts:
              medium: medium
              max: max
`;
      const mockLLM: LLMService = {
        listProviders: () => [{ id: 'gpt-gateway' }],
        listModels: vi.fn().mockResolvedValue([{ id: 'gpt-6-luna' }]),
        resolveModelInfo: vi.fn().mockRejectedValue(new Error('resolve failed')),
      };

      const catalog = await buildCatalog(mockLLM, yamlText);
      expect(catalog.providers[0].models[0].reasoningEfforts).toEqual(['medium', 'max']);
    });

    it('uses default efforts when resolveModelInfo returns no reasoning and no fallback', async () => {
      const mockLLM: LLMService = {
        listProviders: () => [{ id: 'new-provider' }],
        listModels: vi.fn().mockResolvedValue([{ id: 'new-model' }]),
        resolveModelInfo: vi.fn().mockResolvedValue({}), // No reasoning field
      };

      const catalog = await buildCatalog(mockLLM, ''); // Empty yaml, no fallback
      expect(catalog.providers[0].models[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);
    });

    it('falls back to readCatalog when listProviders throws', async () => {
      const yamlText = `
- id: llm-pi-ai
  config:
    providers:
      fallback-provider:
        models:
          - id: fallback-model
`;
      const mockLLM: LLMService = {
        listProviders: () => {
          throw new Error('service unavailable');
        },
        listModels: vi.fn(),
        resolveModelInfo: vi.fn(),
      };

      const catalog = await buildCatalog(mockLLM, yamlText);
      expect(catalog.providers).toHaveLength(1);
      expect(catalog.providers[0].id).toBe('fallback-provider');
      expect(mockLLM.listModels).not.toHaveBeenCalled();
    });
  });
});
