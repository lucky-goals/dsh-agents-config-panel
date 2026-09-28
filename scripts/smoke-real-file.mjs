#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  listSubagents,
  listMembers,
  readCatalog,
} from '../lib/index.js';

const profileDir = process.env.DSH_SMOKE_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web');
const patchPath = join(profileDir, 'cordis.patch.yml');
const before = createHash('sha256').update(await readFile(patchPath)).digest('hex');
const yamlText = await readFile(patchPath, 'utf8');
const subagents = listSubagents(yamlText);
const members = listMembers(yamlText, 'standard-acp');
const catalog = readCatalog(yamlText);
const after = createHash('sha256').update(await readFile(patchPath)).digest('hex');

if (subagents.length === 0) throw new Error('real patch produced no subagent rows');
if (members.length === 0) throw new Error('real patch produced no standard-acp members');
if (before !== after) throw new Error('real patch changed during read-only smoke test');

const result = {
  patchPath,
  bytes: Buffer.byteLength(yamlText),
  revision: before,
  subagents: subagents.map(({ id, editable, disabled }) => ({ id, editable, disabled })),
  members: members.map(({ name }) => name),
  providers: catalog.providers.map(({ id, models }) => ({ id, models: models.map(({ id: modelId }) => modelId) })),
};
console.log(JSON.stringify(result, null, 2));
console.log(`REAL_FILE_SMOKE_PASS subagents=${subagents.length} members=${members.length}`);
