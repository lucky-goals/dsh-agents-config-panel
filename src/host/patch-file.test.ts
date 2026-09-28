import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, chmod, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPatchIO, patchFileMode } from './patch-file.js';
import { computeRevision } from './patch-io.js';

describe('patch-file', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wuyou-patch-file-test-'));
    await writeFile(join(testDir, 'package.json'), '{}', 'utf8');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('reads patch file', async () => {
    const content = '- id: test\n  name: test-plugin\n';
    await writeFile(join(testDir, 'cordis.patch.yml'), content, 'utf8');

    const io = createPatchIO(testDir);
    const result = await io.readPatch();
    expect(result).toBe(content);
  });

  it('writes patch with correct revision', async () => {
    const initial = '- id: test\n';
    await writeFile(join(testDir, 'cordis.patch.yml'), initial, 'utf8');

    // Mock lock and atomic write
    const withFileLock = async <T>(lockPath: string, op: () => Promise<T>): Promise<T> => {
      expect(lockPath).toBe(join(testDir, 'package.json'));
      return await op();
    };
    const writeFileAtomic = async (path: string, content: string) => {
      await writeFile(path, content, 'utf8');
    };

    const io = createPatchIO(testDir, withFileLock, writeFileAtomic);
    const expectedRevision = computeRevision(initial);
    
    const newRevision = await io.writePatchLocked(expectedRevision, (current) => {
      expect(current).toBe(initial);
      return current + '- id: added\n';
    });

    const written = await readFile(join(testDir, 'cordis.patch.yml'), 'utf8');
    expect(written).toBe(initial + '- id: added\n');
    expect(newRevision).toBe(computeRevision(written));
  });

  it('rejects stale revision', async () => {
    const initial = '- id: test\n';
    await writeFile(join(testDir, 'cordis.patch.yml'), initial, 'utf8');

    const withFileLock = async <T>(_: string, op: () => Promise<T>): Promise<T> => await op();
    const writeFileAtomic = async (path: string, content: string) => {
      await writeFile(path, content, 'utf8');
    };

    const io = createPatchIO(testDir, withFileLock, writeFileAtomic);
    const wrongRevision = 'wrong-revision-hash';

    await expect(
      io.writePatchLocked(wrongRevision, (c) => c + '- id: added\n')
    ).rejects.toThrow('配置已被其他地方修改，请刷新后重试');

    // File should be unchanged
    const unchanged = await readFile(join(testDir, 'cordis.patch.yml'), 'utf8');
    expect(unchanged).toBe(initial);
  });

  describe('R28-01: preserves the patch file permission bits', () => {
    const patchPath = () => join(testDir, 'cordis.patch.yml');
    const lockPassthrough = async <T>(_: string, op: () => Promise<T>): Promise<T> => await op();

    /** Honors opts.mode like dsh-atomic-write: fresh temp inode, then rename. */
    function recordingAtomicWrite(modes: number[]) {
      return async (path: string, content: string, opts: { mode: number }) => {
        modes.push(opts.mode);
        const temp = `${path}.tmp-${modes.length}`;
        await writeFile(temp, content, { encoding: 'utf8', mode: opts.mode });
        await chmod(temp, opts.mode); // cancel the umask so the assertion sees opts.mode exactly
        await rename(temp, path);
      };
    }

    for (const mode of [0o600, 0o640]) {
      it(`keeps ${mode.toString(8)} after an update and after an identical re-save`, async () => {
        const initial = '- id: test\n';
        await writeFile(patchPath(), initial, 'utf8');
        await chmod(patchPath(), mode);
        const modes: number[] = [];
        const io = createPatchIO(testDir, lockPassthrough, recordingAtomicWrite(modes));

        const updated = await io.writePatchLocked(computeRevision(initial), (current) => `${current}- id: added\n`);
        expect((await stat(patchPath())).mode & 0o777).toBe(mode);

        await io.writePatchLocked(updated, (current) => current);
        expect((await stat(patchPath())).mode & 0o777).toBe(mode);
        expect(modes).toEqual([mode, mode]);
      });
    }

    it('uses 0600 when the patch file does not exist', async () => {
      await expect(patchFileMode(join(testDir, 'missing.yml'))).resolves.toBe(0o600);
    });

    it('reports the existing permission bits only (no type bits)', async () => {
      await writeFile(patchPath(), 'x\n', 'utf8');
      await chmod(patchPath(), 0o640);
      await expect(patchFileMode(patchPath())).resolves.toBe(0o640);
    });
  });

  it('throws when atomic write utilities are missing', async () => {
    await writeFile(join(testDir, 'cordis.patch.yml'), '- id: test\n', 'utf8');
    
    const io = createPatchIO(testDir); // No lock/write utilities
    
    await expect(
      io.writePatchLocked('any', (c) => c)
    ).rejects.toThrow('缺少 @deepseek-ai/dsh-atomic-write，无法安全写入配置');
  });
});
