export type ReasoningEffort = string;

export interface SubagentInput {
  toolName: string;
  provider: 'spawn' | 'fork';
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
  editable: boolean;
  config: Record<string, unknown>;
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
