/**
 * Pure helpers for the Client bundle wrapper (lib/client.js).
 *
 * The wrapper registers the bundle with DSH's ModuleLoader under the
 * package.json name. lib/ is git-ignored, so pulling a renamed source tree
 * without rebuilding leaves a lib/client.js that registers the old id; these
 * helpers let the build derive the id and let verify detect that stale build.
 * No side effects: no file system, no process access.
 */

/** Allowed bundle ids: a plain (optionally scoped) npm package name. */
const VALID_ID_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;

/** Reads the id from a wrapped bundle; capture group 1 is the id. */
export const CLIENT_BUNDLE_ID_RE = /^window\.__ModuleLoader__\.load\(\{\n {2}id: '([^'\n]*)',/;

/**
 * Wrap an esbuild CJS body in the ModuleLoader registration DSH expects.
 * @param {string} id package name the bundle registers under
 * @param {string} body bundled CommonJS source
 * @returns {string}
 */
export function wrapClientBundle(id, body) {
  if (typeof id !== 'string' || !VALID_ID_RE.test(id)) {
    throw new Error(`invalid client bundle id: ${id}`);
  }
  return `window.__ModuleLoader__.load({
  id: '${id}',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`;
}

/**
 * @param {string} text contents of a wrapped bundle
 * @returns {string | undefined} the registered id, or undefined if not wrapped
 */
export function readClientBundleId(text) {
  if (typeof text !== 'string') return undefined;
  return CLIENT_BUNDLE_ID_RE.exec(text)?.[1];
}

/**
 * @param {string} expected package.json name
 * @param {string | undefined} actual id found in lib/client.js
 * @returns {string}
 */
export function staleBundleMessage(expected, actual) {
  return `lib/client.js 是旧构建：注册的模块 id 是 ${actual ?? '（缺失）'}，package.json name 是 ${expected}。请在仓库里执行 npm run build，再重启 DSH。`;
}

/**
 * @param {string} pkgName package.json name
 * @param {string | undefined} text lib/client.js contents; undefined when the file is missing
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkClientBundle(pkgName, text) {
  const actual = text === undefined ? undefined : readClientBundleId(text);
  if (actual !== undefined && actual === pkgName) return { ok: true };
  return { ok: false, message: staleBundleMessage(pkgName, actual) };
}
