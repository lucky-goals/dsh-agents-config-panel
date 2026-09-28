import { isMap, isSeq } from 'yaml';
import {
  nodeJson,
  pairValue,
  parseYaml,
  scalarString,
} from './patch-io.js';

export const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export interface ModelCatalog {
  providers: Array<{
    id: string;
    models: Array<{
      id: string;
      reasoningEfforts: string[];
    }>;
  }>;
}

function readEfforts(model: unknown): string[] {
  const efforts = (model as { reasoningEfforts?: unknown } | undefined)?.reasoningEfforts;
  if (efforts && typeof efforts === 'object' && !Array.isArray(efforts)) {
    return Object.keys(efforts as Record<string, unknown>);
  }
  if (Array.isArray(efforts)) {
    return efforts.filter((effort): effort is string => typeof effort === 'string');
  }
  return [...DEFAULT_REASONING_EFFORTS];
}

/** Read the llm-pi-ai provider/model shape from the root patch sequence. */
export function readCatalog(yamlText: string): ModelCatalog {
  try {
    const document = parseYaml(yamlText);
    const root = document.contents;
    if (!isSeq(root)) return { providers: [] };
    const llm = root.items.find((entry) => scalarString(pairValue(entry, 'id')) === 'llm-pi-ai');
    const config = pairValue(llm, 'config');
    const providersNode = pairValue(config, 'providers');
    if (!isMap(providersNode)) return { providers: [] };

    const providers: ModelCatalog['providers'] = [];
    for (const providerPair of providersNode.items) {
      const providerId = scalarString(providerPair.key);
      const provider = nodeJson<Record<string, unknown>>(providerPair.value) ?? {};
      const modelsValue = provider.models;
      const models = Array.isArray(modelsValue)
        ? modelsValue
          .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === 'object'))
          .map((model) => ({
            id: typeof model.id === 'string' ? model.id : '',
            reasoningEfforts: readEfforts(model),
          }))
          .filter((model) => model.id.length > 0)
        : [];
      providers.push({ id: providerId, models });
    }
    return { providers };
  } catch {
    return { providers: [] };
  }
}

/** Return null when the route is supported, otherwise a user-facing Chinese error. */
export function validateModelRoute(
  catalog: ModelCatalog,
  provider: string,
  model: string,
  effort?: string,
): string | null {
  const providerEntry = catalog.providers.find((entry) => entry.id === provider);
  if (!providerEntry) return `provider '${provider}' 未配置`;
  const modelEntry = providerEntry.models.find((entry) => entry.id === model);
  if (!modelEntry) return `模型 '${model}' 不在 provider '${provider}' 的目录中`;
  if (effort !== undefined && !modelEntry.reasoningEfforts.includes(effort)) {
    return `reasoning effort '${effort}' 不被模型 '${model}' 支持`;
  }
  return null;
}
