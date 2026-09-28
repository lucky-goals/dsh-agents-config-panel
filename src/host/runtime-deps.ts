/**
 * Runtime dependency loading for optional peer dependencies.
 * Exports testable functions that work in both dev (tsx/vitest) and production (ESM).
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readCatalog, DEFAULT_REASONING_EFFORTS } from './catalog.js';
import type { ModelCatalog } from './catalog.js';

/**
 * LLM service interface matching @deepseek-ai/dsh-llm types.
 * listProviders is synchronous, listModels and resolveModelInfo are async.
 */
export interface LLMService {
  listProviders(): Array<{ id: string }>;
  listModels(providerId: string): Promise<Array<{ id: string }>>;
  resolveModelInfo(
    providerId: string,
    modelId: string,
    signal?: AbortSignal
  ): Promise<{ reasoning?: { efforts: Array<{ id: string }> } }>;
}

export interface AtomicWriteUtils {
  withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T>;
  writeFileAtomic(path: string, content: string, options: { mode: number }): Promise<void>;
}

export interface AtomicWriteLoadSuccess extends AtomicWriteUtils {
  anchor: string;
  resolvedPath: string;
}

export interface AtomicWriteLoadFailure {
  error: string;
  tried: string[];
}

export type AtomicWriteLoadResult = AtomicWriteLoadSuccess | AtomicWriteLoadFailure;

/**
 * Load @deepseek-ai/dsh-atomic-write using ESM-compatible methods, trying multiple anchors.
 * @param anchors - Array of module URLs to use as resolution anchors
 * @returns Atomic write utilities with metadata, or failure with tried anchors
 */
export function loadAtomicWrite(anchors: string[]): AtomicWriteLoadResult {
  const tried: string[] = [];
  
  for (const anchor of anchors) {
    tried.push(anchor);
    
    try {
      const require = createRequire(anchor);
      const resolvedPath = require.resolve('@deepseek-ai/dsh-atomic-write');
      const atomicWrite = require('@deepseek-ai/dsh-atomic-write');
      
      return {
        withFileLock: atomicWrite.withFileLock,
        writeFileAtomic: atomicWrite.writeFileAtomic,
        anchor,
        resolvedPath,
      };
    } catch (err) {
      // Try next anchor
      continue;
    }
  }
  
  return {
    error: 'Could not resolve @deepseek-ai/dsh-atomic-write from any anchor',
    tried,
  };
}

/**
 * Build model catalog from LLM runtime service or fallback to patch parsing.
 * @param llm - Optional LLM service from ctx.llm
 * @param yamlText - Patch file content for fallback catalog
 * @returns Complete model catalog with providers, models, and reasoning efforts
 */
export async function buildCatalog(
  llm: LLMService | undefined,
  yamlText: string
): Promise<ModelCatalog> {
  return (await buildCatalogWithSource(llm, yamlText)).catalog;
}

/** Where the catalog came from, for state diagnostics. */
export type CatalogSource = 'runtime' | 'patch';

export interface CatalogResult {
  catalog: ModelCatalog;
  source: CatalogSource;
  /** Non-fatal runtime lookup failures that were covered by a fallback. */
  errors: string[];
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Same as {@link buildCatalog}, also reporting the catalog source and any
 * runtime lookups that fell back, so the state route can expose diagnostics.
 */
export async function buildCatalogWithSource(
  llm: LLMService | undefined,
  yamlText: string
): Promise<CatalogResult> {
  if (!llm) {
    return { catalog: readCatalog(yamlText), source: 'patch', errors: [] };
  }

  const errors: string[] = [];
  try {
    // listProviders is synchronous per dsh-llm types
    const providers = llm.listProviders();
    const fallbackCatalog = readCatalog(yamlText);
    const catalog: ModelCatalog = { providers: [] };

    for (const provider of providers) {
      const models = await llm.listModels(provider.id);
      const catalogProvider: ModelCatalog['providers'][number] = {
        id: provider.id,
        models: [],
      };

      for (const model of models) {
        let efforts: string[] | undefined;

        try {
          // resolveModelInfo returns LlmResolvedModelInfo with reasoning field
          const resolved = await llm.resolveModelInfo(provider.id, model.id);
          efforts = resolved.reasoning?.efforts.map((e) => e.id);
        } catch (caught) {
          // Resolve failed, try fallback
          errors.push(`resolveModelInfo(${provider.id}, ${model.id}): ${errorText(caught)}`);
          efforts = undefined;
        }

        // If resolve didn't return efforts, try fallback catalog for this provider/model
        if (!efforts) {
          const fallbackProvider = fallbackCatalog.providers.find((p) => p.id === provider.id);
          const fallbackModel = fallbackProvider?.models.find((m) => m.id === model.id);
          efforts = fallbackModel?.reasoningEfforts;
        }

        // Last resort: use default efforts
        catalogProvider.models.push({
          id: model.id,
          reasoningEfforts: efforts ?? [...DEFAULT_REASONING_EFFORTS],
        });
      }

      catalog.providers.push(catalogProvider);
    }

    return { catalog, source: 'runtime', errors };
  } catch (caught) {
    // LLM service threw on listProviders or other unrecoverable error, use fallback
    errors.push(`runtime catalog unavailable: ${errorText(caught)}`);
    return { catalog: readCatalog(yamlText), source: 'patch', errors };
  }
}
