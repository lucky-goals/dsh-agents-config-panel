/**
 * File I/O abstraction for cordis.patch.yml reads and locked writes.
 * Designed as injectable dependencies for testability.
 */

import { readFile as fsReadFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { computeRevision } from './patch-io.js';

/** Mode for a patch file that does not exist yet: owner read/write only, like DSH configEditor. */
const NEW_PATCH_MODE = 0o600;

/**
 * Permission bits to write `path` with: the current file's own bits, so a save
 * never widens a private (owner-only) patch; owner-only when it is missing.
 */
export async function patchFileMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException | null)?.code === 'ENOENT') return NEW_PATCH_MODE;
    throw caught;
  }
}

export interface PatchIO {
  /** Read the current patch file content. */
  readPatch(): Promise<string>;
  
  /**
   * Write patch with optimistic locking and atomic replace.
   * @param expectedRevision - SHA-256 of the content before transform
   * @param transform - Produces the new YAML text from the text read under the lock.
   *   May be async (e.g. to await the runtime model catalog); it is awaited while
   *   the lock is held, so validation always sees the same text that gets replaced.
   * @returns The new revision after write
   * @throws Error with code STALE_REVISION if expectedRevision doesn't match
   */
  writePatchLocked(
    expectedRevision: string,
    transform: (current: string) => string | Promise<string>
  ): Promise<string>;
}

/**
 * Create real file I/O implementation that locks on package.json.
 * @param profileDir - Profile directory (contains package.json and cordis.patch.yml)
 * @param withFileLock - Lock function from @deepseek-ai/dsh-atomic-write (optional peer dep)
 * @param writeFileAtomic - Atomic write from @deepseek-ai/dsh-atomic-write (optional peer dep)
 */
export function createPatchIO(
  profileDir: string,
  withFileLock?: <T>(lockPath: string, op: () => Promise<T>) => Promise<T>,
  writeFileAtomic?: (path: string, content: string, opts: { mode: number }) => Promise<void>
): PatchIO {
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const lockPath = join(profileDir, 'package.json');

  return {
    async readPatch() {
      return await fsReadFile(patchPath, 'utf8');
    },

    async writePatchLocked(expectedRevision, transform) {
      if (!withFileLock || !writeFileAtomic) {
        const error = new Error('缺少 @deepseek-ai/dsh-atomic-write，无法安全写入配置') as Error & { code: string };
        error.code = 'DEPENDENCY_UNAVAILABLE';
        throw error;
      }

      return await withFileLock(lockPath, async () => {
        const current = await fsReadFile(patchPath, 'utf8');
        const currentRevision = computeRevision(current);
        
        if (currentRevision !== expectedRevision) {
          const error = new Error('配置已被其他地方修改，请刷新后重试') as Error & { code: string };
          error.code = 'STALE_REVISION';
          throw error;
        }

        const next = await transform(current);
        // Keep the file's existing permission bits (R28-01); the file is never chmod-ed.
        await writeFileAtomic(patchPath, next, { mode: await patchFileMode(patchPath) });
        return computeRevision(next);
      });
    },
  };
}
