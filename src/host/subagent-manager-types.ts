export type ReasoningEffort = string;

export interface SubagentInput {
  toolName: string;
  /** Any provider name registered in the current subagent provider directory (v2.1). */
  provider: string;
  backgroundMode?: 'continuable' | 'one-shot';
  agentOptions?: {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
  };
}

/**
 * updateSubagent patch. `agentOptions.reasoningEffort: null` deletes the
 * effort; null on any other field is rejected as INVALID (not clearable).
 */
export type SubagentPatch = {
  [K in Exclude<keyof SubagentInput, 'agentOptions'>]?: SubagentInput[K] | null;
} & {
  agentOptions?: {
    provider?: string | null;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  } | null;
};

export interface SubagentRow {
  id: string;
  disabled: boolean;
  /** true iff config.provider is in the current subagent provider directory. */
  editable: boolean;
  config: Record<string, unknown>;
  /** Present exactly when editable is false. */
  readOnlyReason?: string;
}

/** Compatibility aliases for the original Panel A client contract. */
export type SubagentConfig = SubagentInput;
export interface SubagentEntry extends SubagentRow {
  name: '@deepseek-ai/dsh-tool-subagent';
}

export interface SubagentManagerOptions {
  knownProviders: string[];
}

export type SubagentSuccess = { yamlText: string };
export type SubagentError = { error: string };
export type SubagentResult = SubagentSuccess | SubagentError;

export function isSubagentError(result: SubagentResult): result is SubagentError {
  return 'error' in result;
}

export function isSubagentSuccess(result: SubagentResult): result is SubagentSuccess {
  return 'yamlText' in result;
}
