export interface PathSelector {
  key: string;
  matchId: string;
}

export interface ArrayEntry {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

export type ErrorCode =
  | 'STRUCTURE'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'INVALID'
  | 'READ_ONLY'
  | 'LAST_MEMBER';

export interface MutationError {
  ok: false;
  code: ErrorCode;
  message: string;
}

export interface MutationSuccess {
  ok: true;
  yamlText: string;
}

export type MutationResult = MutationSuccess | MutationError;
