import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_BUNDLE_ID_RE,
  checkClientBundle,
  readClientBundleId,
  staleBundleMessage,
  wrapClientBundle,
} from '../../scripts/client-bundle.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(THIS_DIR, '../..');

/** Name this plugin publishes under after the scope rename. */
const NEW_NAME = '@luckygoals/dsh-wuyou-agent';
/** Retired name: a lib/client.js that was never rebuilt still registers under it. */
const OLD_NAME = '@nanmicoder/dsh-wuyou-agent';

const LIB_CLIENT = 'lib/client.js';

function readText(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function tryReadText(relativePath: string): string | undefined {
  try {
    return readText(relativePath);
  } catch {
    return undefined;
  }
}

const libClientText = tryReadText(LIB_CLIENT);
const pkgName = (JSON.parse(readText('package.json')) as { name?: string }).name as string;

describe('client bundle identity', () => {
  it('CB1 wrapClientBundle reproduces the build-client.mjs wrapper verbatim', () => {
    // Byte-for-byte the template scripts/build-client.mjs used to write, with the
    // `${body}` slot filled by 'X'. Continuation lines start at column 0 on
    // purpose: that is exactly where they sit in the emitted file, and the
    // trailing newline after `});` is part of the output too.
    const expected = `window.__ModuleLoader__.load({
  id: '@luckygoals/dsh-wuyou-agent',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
X
    return module.exports;
  },
});
`;
    expect(wrapClientBundle(NEW_NAME, 'X')).toBe(expected);
  });

  it('CB2 readClientBundleId round-trips the wrapper id and ignores unwrapped text', () => {
    for (const id of [NEW_NAME, '@other-scope/other-client']) {
      expect(readClientBundleId(wrapClientBundle(id, 'const marker = 1;'))).toBe(id);
    }

    // The exported regex is part of the contract: it must read the wrapper.
    const wrapped = wrapClientBundle(NEW_NAME, 'const marker = 1;');
    const found = new RegExp(CLIENT_BUNDLE_ID_RE.source, '').exec(wrapped);
    expect(found?.[1]).toBe(NEW_NAME);

    expect(readClientBundleId('window.__ModuleLoader__.register({ id: "x" });')).toBeUndefined();
    expect(readClientBundleId('')).toBeUndefined();
  });

  it('CB3 wrapClientBundle rejects ids that are not a plain package name', () => {
    for (const id of ["x'); alert(1); ('", '', 'has space', '@luckygoals/dsh-wuyou-agent/']) {
      expect(() => wrapClientBundle(id, 'X')).toThrow(`invalid client bundle id: ${id}`);
    }
  });

  it('CB4 checkClientBundle reports a stale or missing lib/client.js', () => {
    expect(checkClientBundle(NEW_NAME, wrapClientBundle(NEW_NAME, 'X'))).toEqual({ ok: true });

    const stale = checkClientBundle(NEW_NAME, wrapClientBundle(OLD_NAME, 'X'));
    expect(stale.ok).toBe(false);
    const staleMessage = (stale as { ok: false; message: string }).message;
    expect(staleMessage).toBe(staleBundleMessage(NEW_NAME, OLD_NAME));
    expect(staleMessage).toContain('npm run build');
    expect(staleBundleMessage(NEW_NAME, OLD_NAME)).toBe(
      `lib/client.js 是旧构建：注册的模块 id 是 ${OLD_NAME}，package.json name 是 ${NEW_NAME}。请在仓库里执行 npm run build，再重启 DSH。`,
    );

    const missing = checkClientBundle(NEW_NAME, undefined);
    expect(missing.ok).toBe(false);
    const missingMessage = (missing as { ok: false; message: string }).message;
    expect(missingMessage).toBe(staleBundleMessage(NEW_NAME, undefined));
    expect(missingMessage).toContain('（缺失）');
    expect(missingMessage).toContain('npm run build');
  });

  it('CB5 build-client.mjs no longer hard-codes a bundle id', () => {
    const source = readText('scripts/build-client.mjs');
    expect(source).not.toContain(NEW_NAME);
    expect(source).not.toContain(OLD_NAME);
    expect(source).toContain('client-bundle.mjs');
    expect(source).toContain('package.json');
  });

  it('CB6 verify-runtime-deps.mjs checks the client bundle id too', () => {
    expect(readText('scripts/verify-runtime-deps.mjs')).toContain('checkClientBundle');
  });

  it.skipIf(!existsSync(resolve(ROOT, LIB_CLIENT)))(
    'CB7 the built lib/client.js registers the current package name',
    () => {
      expect(readClientBundleId(libClientText as string)).toBe(pkgName);
    },
  );
});
