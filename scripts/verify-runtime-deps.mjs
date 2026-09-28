#!/usr/bin/env node
/**
 * Verify runtime dependencies work correctly from built lib/ artifacts.
 * Runs with plain Node (no vitest/tsx) to validate real ESM behavior.
 *
 * Portable: no personal paths. The DSH runtime (where the host's own
 * @deepseek-ai/dsh-atomic-write lives) comes from WUYOU_DSH_RUNTIME_DIR, else
 * from the `dsh` executable on PATH. Without either, the runtime-only check
 * prints `SKIP: <reason>` and the rest use a throwaway stand-in package.
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = join(repoRoot, 'lib');
const fixturePath = join(repoRoot, 'test/fixtures/real-web-cordis.patch.yml');
const ATOMIC = '@deepseek-ai/dsh-atomic-write';
const skips = [];

function fail(message, detail) {
  console.error(`✗ ${message}`);
  if (detail !== undefined) console.error('  ', detail);
  process.exit(1);
}

function skip(reason) {
  skips.push(reason);
  console.log(`SKIP: ${reason}`);
}

/** Temp dirs created by this script; always removed on exit. */
const tempDirs = [];
function makeTemp(prefix) {
  const dir = realpathSync(tmpdir());
  const path = join(dir, `${prefix}-${process.pid}-${Date.now()}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway stand-in for dsh-atomic-write under `<root>/node_modules`. */
function writeStandInAtomicWrite(root) {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-atomic-write');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: ATOMIC, main: 'index.cjs' }));
  writeFileSync(join(pkg, 'index.cjs'), [
    "const fs = require('node:fs/promises');",
    'exports.withFileLock = async (_file, operation) => operation();',
    'exports.writeFileAtomic = async (file, content) => { await fs.writeFile(`${file}.tmp`, content); await fs.rename(`${file}.tmp`, file); };',
    '',
  ].join('\n'));
  return pkg;
}

/**
 * Locate the DSH runtime anchor: a file URL from which the host's
 * dsh-atomic-write resolves. Returns { anchor, source } or { reason }.
 */
function findRuntimeAnchor() {
  const fromEnv = process.env.WUYOU_DSH_RUNTIME_DIR;
  if (fromEnv) {
    const anchor = pathToFileURL(join(resolve(fromEnv), 'package.json')).href;
    try {
      createRequire(anchor).resolve(ATOMIC);
      return { anchor, source: `WUYOU_DSH_RUNTIME_DIR=${fromEnv}` };
    } catch {
      return { reason: `WUYOU_DSH_RUNTIME_DIR=${fromEnv} does not resolve ${ATOMIC}` };
    }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    if (!existsSync(candidate)) continue;
    let real;
    try {
      real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    const anchor = pathToFileURL(real).href;
    try {
      createRequire(anchor).resolve(ATOMIC);
      return { anchor, source: `dsh on PATH (${candidate} -> ${real})` };
    } catch {
      // This dsh does not carry dsh-atomic-write; keep looking.
    }
  }
  return { reason: `neither WUYOU_DSH_RUNTIME_DIR nor a dsh executable on PATH resolves ${ATOMIC}` };
}

// ---------------------------------------------------------------------------
// 1. Import built modules
const { apply, loadAtomicWrite, buildCatalog } = await import(pathToFileURL(join(libDir, 'index.js')).href);
console.log('✓ Imported built modules');

// 2. Activate the built plugin with the config shape Cordis supplies for this bundle
{
  const registeredRoutes = [];
  const registeredDisposers = [];
  const webServer = {
    register(route) {
      registeredRoutes.push(route);
      const dispose = () => {
        const index = registeredRoutes.indexOf(route);
        if (index >= 0) registeredRoutes.splice(index, 1);
      };
      registeredDisposers.push(dispose);
      return dispose;
    },
  };
  const loggerMethods = { info() {}, warn() {}, error() {} };
  const logger = Object.assign(() => loggerMethods, loggerMethods);
  const profileDir = join(repoRoot, 'test/fixtures');
  const services = new Map([
    ['webServer', webServer],
    ['connection', { requestRejection: () => undefined }],
    ['profileContext', {
      name: 'wuyou-test',
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(profileDir, 'package.json'),
      cwd: process.cwd(),
      home: process.cwd(),
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    }],
  ]);
  const collectedEffects = [];
  const activationContext = {
    get: (key) => services.get(key),
    logger,
    effect(execute, label) {
      const disposer = execute();
      if (typeof disposer !== 'function') {
        throw new Error(`effect ${JSON.stringify(label)} did not return a route disposer`);
      }
      collectedEffects.push(disposer);
      return async () => disposer();
    },
    on(event) {
      if (event !== 'internal/service') throw new Error(`unexpected Cordis event subscription: ${String(event)}`);
      return () => {};
    },
  };

  apply(activationContext, undefined);

  const expectedRoutePaths = [
    '/plugins/dsh-wuyou-agent/api/state',
    '/plugins/dsh-wuyou-agent/api/subagents',
    '/plugins/dsh-wuyou-agent/api/members',
  ];
  const actualRoutePaths = registeredRoutes.map((route) => route.path);
  if (
    registeredRoutes.length !== 3
    || collectedEffects.length !== 3
    || registeredDisposers.some((disposer, index) => disposer !== collectedEffects[index])
    || registeredRoutes.some((route) => route.kind !== 'exact')
    || JSON.stringify(actualRoutePaths) !== JSON.stringify(expectedRoutePaths)
  ) {
    fail('apply(ctx, undefined) did not lifecycle-register the three expected API routes', actualRoutePaths);
  }
  console.log('✓ apply(ctx, undefined) registered three lifecycle-owned API routes');
}

// 3. loadAtomicWrite against the real DSH runtime (portable discovery, else SKIP)
const runtime = findRuntimeAnchor();
let atomicWriteAnchor;
let atomicWriteLabel;
if ('reason' in runtime) {
  skip(`real DSH runtime dsh-atomic-write check — ${runtime.reason}`);
} else {
  const loaded = loadAtomicWrite([runtime.anchor]);
  if (!('anchor' in loaded) || typeof loaded.withFileLock !== 'function' || typeof loaded.writeFileAtomic !== 'function') {
    fail('loadAtomicWrite did not return valid functions from the DSH runtime', loaded);
  }
  atomicWriteAnchor = runtime.anchor;
  atomicWriteLabel = 'real DSH runtime';
  console.log(`✓ loadAtomicWrite resolved the real runtime via ${runtime.source} -> ${loaded.resolvedPath}`);
}

// 4. buildCatalog with a mock LLM that resolves efforts
{
  const mockLLM = {
    listProviders: () => [{ id: 'gpt-gateway' }],
    listModels: async () => [{ id: 'gpt-6-luna' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  };
  const catalog = await buildCatalog(mockLLM, '');
  const model = catalog.providers[0]?.models[0];
  if (catalog.providers.length !== 1 || catalog.providers[0].id !== 'gpt-gateway' || model?.id !== 'gpt-6-luna') {
    fail('buildCatalog provider/model mismatch', catalog);
  }
  if (JSON.stringify(model.reasoningEfforts) !== JSON.stringify(['low', 'high'])) {
    fail('buildCatalog efforts mismatch', model.reasoningEfforts);
  }
  console.log('✓ buildCatalog with resolveModelInfo works');
}

// 5. buildCatalog falls back to readCatalog when resolveModelInfo throws
const fixtureYaml = readFileSync(fixturePath, 'utf8');
{
  const { readCatalog } = await import(pathToFileURL(join(libDir, 'host/catalog.js')).href);
  const mockLLM = {
    listProviders: () => [{ id: 'gpt-gateway' }],
    listModels: async () => [{ id: 'gpt-6-luna' }],
    resolveModelInfo: async () => {
      throw new Error('resolve failed');
    },
  };
  const catalog = await buildCatalog(mockLLM, fixtureYaml);
  const efforts = catalog.providers.find((p) => p.id === 'gpt-gateway')?.models.find((m) => m.id === 'gpt-6-luna')?.reasoningEfforts;
  const expected = readCatalog(fixtureYaml).providers.find((p) => p.id === 'gpt-gateway')?.models.find((m) => m.id === 'gpt-6-luna')?.reasoningEfforts;
  if (!efforts || efforts.length === 0 || JSON.stringify(efforts) !== JSON.stringify(expected)) {
    fail('buildCatalog did not fall back to readCatalog for the same provider/model', { efforts, expected });
  }
  console.log('✓ buildCatalog falls back to readCatalog on resolveModelInfo error');
}

// Without a real runtime, route and symlink checks use a throwaway stand-in.
if (atomicWriteAnchor === undefined) {
  const standInRoot = makeTemp('wuyou-atomic-standin');
  writeFileSync(join(standInRoot, 'package.json'), '{}');
  writeStandInAtomicWrite(standInRoot);
  atomicWriteAnchor = pathToFileURL(join(standInRoot, 'package.json')).href;
  atomicWriteLabel = 'stand-in dsh-atomic-write';
}

// 5b. Built routes + async catalog (production shape): one spawn create on a
// temp fixture copy must return 200 and change the file (t16 F1 regression).
{
  const { Readable } = await import('node:stream');
  const { createHash } = await import('node:crypto');
  const { createRoutes } = await import(pathToFileURL(join(libDir, 'host/http-routes.js')).href);
  const { createPatchIO } = await import(pathToFileURL(join(libDir, 'host/patch-file.js')).href);
  const { buildCatalogWithSource } = await import(pathToFileURL(join(libDir, 'host/runtime-deps.js')).href);

  const routesDir = makeTemp('wuyou-routes-async-sim');
  writeFileSync(join(routesDir, 'package.json'), '{}');
  writeFileSync(join(routesDir, 'cordis.patch.yml'), fixtureYaml);

  const atomic = loadAtomicWrite([atomicWriteAnchor]);
  if (!('anchor' in atomic)) fail(`could not load ${atomicWriteLabel}`, atomic);
  const routes = createRoutes({
    io: createPatchIO(routesDir, atomic.withFileLock, atomic.writeFileAtomic),
    profileDefault: 'standard-acp',
    getCatalog: async (yamlText) => {
      await new Promise((tick) => setImmediate(tick));
      return buildCatalogWithSource(undefined, yamlText);
    },
  });
  const route = routes.find((entry) => entry.path === '/plugins/dsh-wuyou-agent/api/subagents');

  const before = readFileSync(join(routesDir, 'cordis.patch.yml'), 'utf8');
  const body = JSON.stringify({
    expectedRevision: createHash('sha256').update(before).digest('hex'),
    action: 'create',
    input: {
      toolName: 'subagent_verify_async',
      provider: 'spawn',
      agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
    },
  });
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    url: '/plugins/dsh-wuyou-agent/api/subagents',
    headers: {},
  });
  const response = { status: 0, body: '' };
  const res = {
    writeHead(status) { response.status = status; },
    end(data) { response.body = data === undefined ? '' : String(data); },
  };

  await route.handler(req, res);
  const after = readFileSync(join(routesDir, 'cordis.patch.yml'), 'utf8');
  if (response.status !== 200 || after === before || !after.includes('toolName: subagent_verify_async')) {
    fail('built routes: async-catalog spawn create did not return 200 and write the row',
      `status ${response.status}, body ${response.body.slice(0, 300)}`);
  }
  console.log(`✓ built routes: async-catalog spawn create returned 200 and changed the temp fixture copy (${atomicWriteLabel})`);
}

// 6. Symlink installation: the plugin dir is a symlink into this repo, so Node
// ESM resolves import.meta.url to the repo, which lacks dsh-atomic-write.
{
  const simBase = makeTemp('wuyou-symlink-sim');
  const profilePath = join(simBase, 'profiles/p1');
  const pluginLink = join(profilePath, 'node_modules/@nanmicoder/dsh-wuyou-agent');
  const profilesNodeModules = join(simBase, 'profiles');
  mkdirSync(dirname(pluginLink), { recursive: true });
  writeFileSync(join(profilePath, 'package.json'), '{}');
  symlinkSync(repoRoot, pluginLink);

  // dsh-atomic-write one level above the profile, like ~/.dsh/profiles/node_modules.
  const atomicLink = join(profilesNodeModules, 'node_modules/@deepseek-ai/dsh-atomic-write');
  mkdirSync(dirname(atomicLink), { recursive: true });
  const realPkg = (() => {
    try {
      return dirname(createRequire(atomicWriteAnchor).resolve(`${ATOMIC}/package.json`));
    } catch {
      return undefined;
    }
  })();
  if (realPkg) {
    symlinkSync(realPkg, atomicLink);
  } else {
    // Stand-in without an exported ./package.json: place a copy directly.
    rmSync(atomicLink, { recursive: true, force: true });
    writeStandInAtomicWrite(profilesNodeModules);
  }

  const { loadAtomicWrite: loadViaSymlink } = await import(pathToFileURL(join(pluginLink, 'lib/host/runtime-deps.js')).href);
  const pluginSelf = pathToFileURL(join(repoRoot, 'lib/index.js')).href;

  const selfOnly = loadViaSymlink([pluginSelf]);
  if (!('error' in selfOnly)) fail('symlink test: expected failure with the plugin\'s own anchor only', selfOnly);
  console.log('✓ Symlink test: plugin anchor alone fails as expected');

  const profileAnchor = pathToFileURL(join(profilePath, 'package.json')).href;
  const withProfile = loadViaSymlink([pluginSelf, profileAnchor]);
  if (!('anchor' in withProfile) || withProfile.anchor !== profileAnchor
      || typeof withProfile.withFileLock !== 'function' || typeof withProfile.writeFileAtomic !== 'function') {
    fail('symlink test: expected success via the profile anchor', withProfile);
  }
  console.log(`✓ Symlink test: profile anchor resolves dsh-atomic-write (${realPkg ? 'real package' : 'stand-in'})`);
}

// 7. Scan Host ESM artifacts for unauthorized `require`. Any reference to a
// `require` binding is a violation unless that binding was initialized
// directly by node:module createRequire(); aliases (`const r = require`) and
// indirect calls (`(0, require)(…)`) are therefore caught, and calls through
// an alias are reported at the call site too. lib/client.js is a CommonJS
// ModuleLoader factory (its parameter is named require) and is excluded.

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(path));
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(path);
  }
  return out;
}

function scanRequire(root, { exclude = [] } = {}) {
  const files = listJsFiles(root).filter((file) => !exclude.includes(relative(root, file)));
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const violations = [];

  const isNodeCreateRequire = (identifier) => checker.getSymbolAtLocation(identifier)?.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false;
    const importedName = declaration.propertyName?.text ?? declaration.name.text;
    const importDeclaration = declaration.parent.parent.parent;
    return importedName === 'createRequire'
      && ts.isImportDeclaration(importDeclaration)
      && ts.isStringLiteral(importDeclaration.moduleSpecifier)
      && ['node:module', 'module'].includes(importDeclaration.moduleSpecifier.text);
  }) ?? false;

  const initializerOf = (identifier) => {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.find(ts.isVariableDeclaration);
    return declaration?.initializer;
  };

  /** Strip parentheses, `(0, x)` comma sequences and non-null/type wrappers. */
  const unwrap = (node) => {
    let current = node;
    for (;;) {
      if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)
          || ts.isAsExpression(current) || ts.isTypeAssertionExpression?.(current)) {
        current = current.expression;
      } else if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        current = current.right;
      } else {
        return current;
      }
    }
  };

  /** `require` identifier that is not a createRequire()-initialized local. */
  const isForbiddenRequire = (identifier) => {
    if (identifier.text !== 'require') return false;
    const init = initializerOf(identifier);
    if (init && ts.isCallExpression(unwrap(init))) {
      const callee = unwrap(unwrap(init).expression);
      if (ts.isIdentifier(callee) && isNodeCreateRequire(callee)) return false;
    }
    return true;
  };

  /** Does this expression evaluate to a forbidden require (following aliases)? */
  const resolvesToForbidden = (expression, depth = 0) => {
    if (depth > 8) return false;
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) return false;
    if (node.text === 'require') return isForbiddenRequire(node);
    const init = initializerOf(node);
    return init !== undefined && resolvesToForbidden(init, depth + 1);
  };

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      violations.push(`${relative(root, file)}: could not parse`);
      continue;
    }
    const report = (node, what) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${relative(root, file)}:${line + 1}:${character + 1} ${what}`);
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === 'require') {
        const parent = node.parent;
        const isDeclarationName = parent && (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node;
        const isPropertyName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node));
        if (!isDeclarationName && !isPropertyName && isForbiddenRequire(node)) report(node, 'require reference');
      } else if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && callee.text !== 'require' && resolvesToForbidden(callee)) {
          report(node, `call through require alias '${callee.text}'`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { files, violations };
}

// 7a. Self-test: the scanner must catch these shapes and accept the legal one.
{
  const samples = makeTemp('wuyou-require-samples');
  mkdirSync(join(samples, 'deep/er'), { recursive: true });
  writeFileSync(join(samples, 'alias.js'), 'const req = require;\nexport const a = req("fs");\n');
  writeFileSync(join(samples, 'indirect.js'), 'export const b = (0, require)("fs");\n');
  writeFileSync(join(samples, 'deep/er/nested.mjs'), 'export const c = require("fs");\n');
  writeFileSync(join(samples, 'ok.js'), 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const d = require("fs");\n');
  writeFileSync(join(samples, 'client.js'), 'export default function factory(require) { return require("react"); }\n');

  const { violations } = scanRequire(samples, { exclude: ['client.js'] });
  const flagged = (name) => violations.some((entry) => entry.startsWith(name));
  const expectations = [['alias.js', true], ['indirect.js', true], [join('deep/er/nested.mjs'), true], ['ok.js', false], ['client.js', false]];
  const wrong = expectations.filter(([name, should]) => flagged(name) !== should);
  if (wrong.length > 0) fail('require scanner self-test failed', { wrong, violations });
  rmSync(samples, { recursive: true, force: true });
  console.log('✓ require scanner self-test: alias, (0, require)() and nested-dir samples caught; createRequire binding and client.js accepted');
}

// 7b. Real scan of lib/**.
{
  const { files, violations } = scanRequire(libDir, { exclude: ['client.js'] });
  if (violations.length > 0) fail('found unauthorized require usage in Host ESM artifacts', violations);
  console.log(`✓ No unauthorized require in ${files.length} Host artifacts under lib/** (client.js excluded)`);
}

console.log(skips.length === 0
  ? '\n✅ All runtime dependency checks passed'
  : `\n✅ All runtime dependency checks passed (${skips.length} skipped: see SKIP lines above)`);
