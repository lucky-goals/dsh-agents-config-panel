import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { computeRevision } from './patch-io';

const fixture = readFileSync(
  new URL('../../test/fixtures/real-web-cordis.patch.yml', import.meta.url),
  'utf8'
);

describe('patch-io', () => {
  it('parses the real fixture as a top-level sequence', () => {
    const document = parseDocument(fixture);
    expect(document.errors).toHaveLength(0);
    expect(Array.isArray(document.toJSON())).toBe(true);
  });

  it('computes a stable SHA-256 revision for exact YAML text', () => {
    const sameText = `${fixture}`;
    const changedText = `${fixture}\n`;

    expect(computeRevision(fixture)).toBe(computeRevision(sameText));
    expect(computeRevision(fixture)).not.toBe(computeRevision(changedText));
    expect(computeRevision(fixture)).toMatch(/^[0-9a-f]{64}$/);
  });
});
