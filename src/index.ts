/**
 * 无忧Agent插件 Host 入口
 */

import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createPatchIO } from './host/patch-file.js';
import { createRoutes } from './host/http-routes.js';
import { ensureStandardAcpPreset, readInstalledStandardPreset } from './host/preset-bootstrap.js';
import { loadAtomicWrite, buildCatalogWithSource } from './host/runtime-deps.js';
import type { LLMService, AtomicWriteLoadSuccess } from './host/runtime-deps.js';
import type { AtomicWriteDiagnostics } from './host/http-routes.js';

// Re-export public API
export * from './host/subagent-manager.js';
export * from './host/subagent-manager-types.js';
export * from './host/members-editor.js';
export * from './host/members-editor-types.js';
export * from './host/patch-io.js';
export * from './host/types.js';
export * from './host/catalog.js';
export * from './host/runtime-deps.js';
export * from './host/subagent-providers.js';

export const name = 'wuyou-agent';

export interface Config {
  /** Default profile name for agent-teams. */
  profileDefault?: string;
}

interface WebServer {
  register(route: { kind: 'exact'; path: string; handler: (req: any, res: any) => Promise<void> }): () => void;
}

interface Connection {
  requestRejection(req: any): number | undefined;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface LoggerService extends Logger {
  (name?: string): Logger;
}

interface ProfileContext {
  /** DSH profile name (web, desktop, cli, ...); older hosts may omit it. */
  name?: string;
  patchPath: string;
  dir: string;
}

interface Context {
  get(key: string): unknown;
  logger: LoggerService;
  effect(fn: () => void | (() => void), label?: string): unknown;
  on(event: 'internal/service', listener: (name: string, value: unknown) => void): unknown;
}

/** Module URLs used to resolve optional host packages (atomic-write, standard preset). */
function resolutionAnchors(profileDir: string): string[] {
  const anchors: string[] = [
    import.meta.url,
    pathToFileURL(join(profileDir, 'package.json')).href,
  ];
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      anchors.push(pathToFileURL(realpathSync(entry)).href);
    } catch {
      // Entry script not on disk (e.g. `node -e`); skip this anchor.
    }
  }
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const cordisPath = runtimeRequire.resolve('@deepseek-ai/cordis/package.json');
    anchors.push(pathToFileURL(cordisPath).href);
  } catch {
    // Cordis not resolvable from plugin location, skip this anchor.
  }
  return anchors;
}

function errorCode(caught: unknown): string | undefined {
  if (!caught || typeof caught !== 'object' || !('code' in caught)) return undefined;
  const code = (caught as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function apply(ctx: Context, config?: Config) {
  const resolvedConfig = config ?? {};
  const profileDefault = resolvedConfig.profileDefault ?? 'standard-acp';
  let webRegistered = false;
  let atomicWriteCache: AtomicWriteLoadSuccess | null | undefined = undefined;
  // dsh web keeps plugin logs in an in-memory buffer only, so the load outcome
  // is also surfaced through state diagnostics.
  let atomicWriteDiagnostics: AtomicWriteDiagnostics = { loaded: false };
  let standardTemplate: string | undefined;
  let templateLoaded = false;
  // Kept for the life of this process so a panel refresh still shows the restart hint.
  let presetNotice: string | null = null;

  // Web services can bind after this plugin during concurrent activation.
  const tryRegisterWeb = () => {
    if (webRegistered) return;

    const webServer = ctx.get('webServer') as WebServer | undefined;

    if (!webServer) {
      ctx.logger.info('wuyou-agent: webServer not available, waiting to register HTTP routes');
      return;
    }

    const profileContext = ctx.get('profileContext') as ProfileContext | undefined;
    if (!profileContext) {
      ctx.logger.warn('wuyou-agent: profileContext not available, waiting to register HTTP routes');
      return;
    }

    const anchors = resolutionAnchors(profileContext.dir);

    // Lazy load atomic-write with multiple anchors
    if (atomicWriteCache === undefined) {
      const result = loadAtomicWrite(anchors);

      if ('error' in result) {
        atomicWriteCache = null;
        atomicWriteDiagnostics = { loaded: false, tried: result.tried };
        ctx.logger.error(`wuyou-agent: failed to load @deepseek-ai/dsh-atomic-write. Tried anchors: ${result.tried.join(', ')}`);
      } else {
        atomicWriteCache = result;
        atomicWriteDiagnostics = { loaded: true, anchor: result.anchor, resolvedPath: result.resolvedPath };
        ctx.logger.info(`wuyou-agent: dsh-atomic-write loaded via ${result.anchor} -> ${result.resolvedPath}`);
      }
    }

    if (!templateLoaded) {
      templateLoaded = true;
      standardTemplate = readInstalledStandardPreset(anchors);
    }

    const io = createPatchIO(
      profileContext.dir,
      atomicWriteCache?.withFileLock,
      atomicWriteCache?.writeFileAtomic
    );

    const ensurePreset = async () => {
      const result = await ensureStandardAcpPreset(io, standardTemplate, ctx.logger);
      if (result.notice) presetNotice = result.notice;
      return { yamlText: result.yamlText, notice: presetNotice };
    };
    // Startup writes the preset even if the panel is never opened, so the next
    // restart can mount it. The state route awaits the same function.
    void ensurePreset().catch((err) => {
      if (errorCode(err) === 'ENOENT') {
        ctx.logger.warn('wuyou-agent: 未找到 cordis.patch.yml，跳过 preset-standard-acp 初始化');
        return;
      }
      ctx.logger.error(`wuyou-agent: 初始化 preset-standard-acp 失败：${err instanceof Error ? err.message : String(err)}`);
    });

    const routes = createRoutes({
      io,
      profileDefault,
      getCatalog: (yamlText) => buildCatalogWithSource(ctx.get('llm') as LLMService | undefined, yamlText),
      getAtomicWriteDiagnostics: () => atomicWriteDiagnostics,
      // Late-bound on purpose: `subagents` is not in inject (contract v2.1 §1),
      // so a service that binds after these routes is picked up on the next
      // request without restarting the plugin.
      getSubagentsService: () => ctx.get('subagents'),
      // This instance edits exactly one DSH profile's patch; name it for the
      // panel and for export files (v2.3).
      dshProfile: {
        name: profileContext.name || basename(profileContext.dir),
        patchPath: profileContext.patchPath || join(profileContext.dir, 'cordis.patch.yml'),
      },
      profileDir: profileContext.dir,
      ensurePreset,
      logger: ctx.logger,
    });

    for (const route of routes) {
      ctx.effect(() => {
        return webServer.register({
          kind: route.kind,
          path: route.path,
          async handler(req, res) {
            const connection = ctx.get('connection') as Connection | undefined;
            const rejection = connection === undefined ? 503 : connection.requestRejection(req);
            if (rejection !== undefined) {
              res.writeHead(rejection, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              });
              res.end(JSON.stringify({
                error: rejection === 503
                  ? 'authentication unavailable'
                  : rejection === 401 ? 'unauthorized' : 'forbidden',
              }));
              return;
            }
            await route.handler(req, res);
          },
        });
      }, `wuyou-agent: ${route.path}`);
    }

    webRegistered = true;
    ctx.logger.info('wuyou-agent: HTTP routes registered');
  };

  tryRegisterWeb();
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'webServer' || serviceName === 'profileContext') {
      tryRegisterWeb();
    }
  });
}
