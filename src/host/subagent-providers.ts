/**
 * Subagent provider directory (contract v2.1 §1).
 *
 * Pure: no Cordis. `src/index.ts` turns the running `subagents` service into a
 * plain {@link SubagentRuntimeSnapshot} via {@link snapshotSubagentRuntime} and
 * passes it here; `null` means "service unavailable" and falls back to what
 * the patch declares.
 */
import { isSeq } from 'yaml';
import { nodeJson, pairValue, parseYaml, scalarString } from './patch-io.js';

export interface SubagentProviderCapabilities {
  agentOptions: boolean;
  depthLimit: boolean;
  continuable: boolean;
  persona: boolean;
  toolFilter: boolean;
}

export interface SubagentProviderInfo {
  name: string;
  /** Display/diagnostics only; form and write behavior follow `capabilities`. */
  kind: 'in-process' | 'acp' | 'unknown';
  capabilities: SubagentProviderCapabilities;
  source: 'runtime' | 'patch';
}

/** Plain-object view of the DSH `subagents` service (SubagentRuntime). */
export interface SubagentRuntimeSnapshot {
  /** `list()` in registration order. */
  names: string[];
  providers: Record<string, {
    capabilities: Partial<Record<keyof SubagentProviderCapabilities, unknown>> | undefined;
    prepareContinuable: boolean;
  }>;
}

export interface SubagentProviderDirectory {
  providers: SubagentProviderInfo[];
  source: 'runtime' | 'patch';
  errors: string[];
}

export const ACP_REGISTRATION_NAME = '@deepseek-ai/dsh-subagent-acp';
export const PATCH_FALLBACK_MESSAGE = 'subagents 服务尚未绑定，provider 能力来自配置推断';

const CAPABILITY_KEYS = ['agentOptions', 'depthLimit', 'continuable', 'persona', 'toolFilter'] as const;

const ALL_CAPABILITIES: SubagentProviderCapabilities = {
  agentOptions: true, depthLimit: true, continuable: true, persona: true, toolFilter: true,
};
const NO_CAPABILITIES: SubagentProviderCapabilities = {
  agentOptions: false, depthLimit: false, continuable: false, persona: false, toolFilter: false,
};

function kindOf(name: string, capabilities: SubagentProviderCapabilities): SubagentProviderInfo['kind'] {
  if (name === 'spawn' || name === 'fork') return 'in-process';
  if (CAPABILITY_KEYS.every((key) => capabilities[key] === false)) return 'acp';
  return 'unknown';
}

/** `providerName` of every `@deepseek-ai/dsh-subagent-acp` row inside a root `insert`, first wins. */
function patchAcpNames(yamlText: string): string[] {
  let root: unknown;
  try {
    root = parseYaml(yamlText).contents;
  } catch {
    return [];
  }
  if (!isSeq(root)) return [];
  const names: string[] = [];
  for (const item of root.items) {
    const insert = pairValue(item, 'insert');
    if (!isSeq(insert)) continue;
    for (const entry of insert.items) {
      if (scalarString(pairValue(entry, 'name')) !== ACP_REGISTRATION_NAME) continue;
      const config = nodeJson<Record<string, unknown>>(pairValue(entry, 'config'));
      const providerName = config && typeof config === 'object' ? config.providerName : undefined;
      if (typeof providerName === 'string' && providerName.length > 0 && !names.includes(providerName)) {
        names.push(providerName);
      }
    }
  }
  return names;
}

/**
 * Providers for this request. With a runtime snapshot the runtime list is
 * authoritative (order kept, patch names not merged, an empty list stays
 * empty); runtime names without a readable provider are dropped. With `null`
 * the list is inferred from the patch: spawn, fork, then ACP registrations.
 */
export function resolveSubagentProviders(
  yamlText: string,
  runtime: SubagentRuntimeSnapshot | null,
): SubagentProviderInfo[] {
  if (runtime !== null) {
    const out: SubagentProviderInfo[] = [];
    for (const name of runtime.names) {
      const provider = runtime.providers[name];
      if (!provider) continue;
      const raw = provider.capabilities ?? {};
      const capabilities: SubagentProviderCapabilities = {
        agentOptions: raw.agentOptions === true,
        depthLimit: raw.depthLimit === true,
        // continuable is a method on the provider, not a declared flag.
        continuable: provider.prepareContinuable === true,
        persona: raw.persona === true,
        toolFilter: raw.toolFilter === true,
      };
      out.push({ name, kind: kindOf(name, capabilities), capabilities, source: 'runtime' });
    }
    return out;
  }

  const inProcess = ['spawn', 'fork'].map((name): SubagentProviderInfo => ({
    name, kind: 'in-process', capabilities: { ...ALL_CAPABILITIES }, source: 'patch',
  }));
  const acp = patchAcpNames(yamlText)
    .filter((name) => name !== 'spawn' && name !== 'fork')
    .map((name): SubagentProviderInfo => ({
      name, kind: 'acp', capabilities: { ...NO_CAPABILITIES }, source: 'patch',
    }));
  return [...inProcess, ...acp];
}

/**
 * Read the live `subagents` service into a snapshot. Falls back (null) only
 * when the service is missing, `list`/`getProvider` are not functions, or a
 * call throws; an empty `list()` is a valid runtime answer.
 */
export function snapshotSubagentRuntime(service: unknown): { runtime: SubagentRuntimeSnapshot | null; errors: string[] } {
  const svc = service as { list?: unknown; getProvider?: unknown } | null | undefined;
  if (!svc || typeof svc.list !== 'function' || typeof svc.getProvider !== 'function') {
    return { runtime: null, errors: [PATCH_FALLBACK_MESSAGE] };
  }
  try {
    const listed = (svc.list as () => unknown).call(svc);
    const names = Array.isArray(listed) ? listed.filter((name): name is string => typeof name === 'string') : [];
    const providers: SubagentRuntimeSnapshot['providers'] = {};
    const errors: string[] = [];
    for (const name of names) {
      const provider = (svc.getProvider as (n: string) => unknown).call(svc, name) as
        | { capabilities?: Record<string, unknown>; prepareContinuable?: unknown }
        | null
        | undefined;
      if (!provider) {
        errors.push(`subagent provider '${name}' 已列出但无法读取能力`);
        continue;
      }
      providers[name] = {
        capabilities: provider.capabilities,
        prepareContinuable: typeof provider.prepareContinuable === 'function',
      };
    }
    return { runtime: { names, providers }, errors };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return { runtime: null, errors: [PATCH_FALLBACK_MESSAGE, `subagents 服务调用失败：${reason}`] };
  }
}

/** Directory for one request: live service when usable, else the patch. */
export function subagentProviderDirectory(yamlText: string, service: unknown): SubagentProviderDirectory {
  const { runtime, errors } = snapshotSubagentRuntime(service);
  return {
    providers: resolveSubagentProviders(yamlText, runtime),
    source: runtime === null ? 'patch' : 'runtime',
    errors,
  };
}
