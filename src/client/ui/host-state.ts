/**
 * Framework-free helpers shared by both panel stores and views for reading
 * Host state metadata (team profile selection and runtime diagnostics).
 */
import type { StateDiagnostics } from '../shared/api-types';

/**
 * Preferred agent-teams team profile. This is a key under agent-teams
 * `profiles:` in cordis.patch.yml, unrelated to the DSH profile directory name.
 */
export const DEFAULT_TEAM_PROFILE = 'standard-acp';

/** Banner text shown when the Host could not load dsh-atomic-write. */
export const WRITE_UNAVAILABLE_MESSAGE =
  '写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置';

/** Hint shown when the model catalog came from cordis.patch.yml instead of the runtime LLM registry. */
export const CATALOG_FROM_PATCH_MESSAGE = '模型目录来自配置文件，可能不完整';

/**
 * Pick the team profile to show: keep the requested one when it exists,
 * otherwise prefer standard-acp, otherwise the first listed profile.
 * Returns null when the patch declares no team profiles.
 */
export function pickTeamProfile(teamProfiles: readonly string[], requested?: string): string | null {
  if (requested !== undefined && teamProfiles.includes(requested)) return requested;
  if (teamProfiles.includes(DEFAULT_TEAM_PROFILE)) return DEFAULT_TEAM_PROFILE;
  return teamProfiles[0] ?? null;
}

/** Writes are blocked only when the Host explicitly reports atomic-write as not loaded. */
export function isWriteBlocked(diagnostics: StateDiagnostics | null | undefined): boolean {
  return diagnostics?.atomicWrite?.loaded === false;
}
