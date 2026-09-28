import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCatalog, validateModelRoute } from './catalog';

const fixture = readFileSync(
  new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url),
  'utf8'
);

describe('model catalog against the real llm-pi-ai shape', () => {
  it('reads provider model IDs and reasoningEfforts map keys', () => {
    const catalog = readCatalog(fixture);
    const gpt = catalog.providers.find((provider) => provider.id === 'gpt-gateway');
    const gusu = catalog.providers.find((provider) => provider.id === 'gusu-gateway');

    expect(gpt?.models.map((model) => model.id)).toContain('gpt-6-luna');
    expect(gusu?.models.map((model) => model.id)).toContain('claude-opus-5-5');
    expect(gpt?.models.find((model) => model.id === 'gpt-6-luna')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(gusu?.models.find((model) => model.id === 'claude-opus-5-5')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('B15: distinguishes reasoningEfforts map keys from the default effort set', () => {
    // Synthetic YAML: the key set differs from both the default set and the map values.
    const synthetic = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      synth:',
      '        models:',
      '          - id: keyed',
      '            reasoningEfforts:',
      '              minimal: none',
      '              xhigh: very-high',
      '          - id: bare',
      '',
    ].join('\n');
    const synth = readCatalog(synthetic).providers.find((provider) => provider.id === 'synth');

    expect(synth?.models.find((model) => model.id === 'keyed')?.reasoningEfforts).toEqual(['minimal', 'xhigh']);
    expect(synth?.models.find((model) => model.id === 'bare')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);

    const catalog = readCatalog(synthetic);
    expect(validateModelRoute(catalog, 'synth', 'keyed', 'xhigh')).toBeNull();
    expect(validateModelRoute(catalog, 'synth', 'keyed', 'very-high')).toContain("reasoning effort 'very-high'");
    expect(validateModelRoute(catalog, 'synth', 'keyed', 'high')).toContain("reasoning effort 'high'");
    expect(validateModelRoute(catalog, 'synth', 'bare', 'max')).toBeNull();
  });

  it('validates model routes and returns Chinese errors for unsupported routes', () => {
    const catalog = readCatalog(fixture);

    expect(validateModelRoute(catalog, 'gpt-gateway', 'gpt-6-luna')).toBeNull();
    expect(validateModelRoute(catalog, 'gpt-gateway', 'gpt-6-luna', 'max')).toBeNull();
    expect(validateModelRoute(catalog, 'gusu-gateway', 'claude-opus-5-5', 'high')).toBeNull();

    expect(validateModelRoute(catalog, 'gpt-gateway', 'gpt-5.6-luna')).toContain(
      "模型 'gpt-5.6-luna' 不在 provider 'gpt-gateway' 的目录中"
    );
    expect(validateModelRoute(catalog, 'gusu-gateway', 'claude-opus-5-5', 'xhigh')).toContain(
      "reasoning effort 'xhigh' 不被模型 'claude-opus-5-5' 支持"
    );
    expect(validateModelRoute(catalog, 'missing-provider', 'missing-model')).toContain(
      "provider 'missing-provider' 未配置"
    );
  });
});
