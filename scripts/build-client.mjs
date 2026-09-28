import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(root, 'src/client/index.tsx');
const outputFile = resolve(root, 'lib/client.js');

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  sourcemap: false,
  legalComments: 'none',
});

const body = result.outputFiles[0]?.text.trim();
if (!body) {
  throw new Error('esbuild did not produce a Client bundle');
}

const wrapped = `window.__ModuleLoader__.load({
  id: '@nanmicoder/dsh-wuyou-agent',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`;

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, wrapped, 'utf8');
