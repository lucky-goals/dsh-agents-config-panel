import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapClientBundle } from './client-bundle.mjs';

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

// The bundle id must equal the package name; derive it so a rename cannot drift.
const { name: packageName } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const wrapped = wrapClientBundle(packageName, body);

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, wrapped, 'utf8');
