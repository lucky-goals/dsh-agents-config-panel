/**
 * ACP registration test (v2.4): diagnose a saved `@deepseek-ai/dsh-subagent-acp`
 * row without waiting for a real delegation to fail.
 *
 * Static checks mirror what DSH 0.1.7-rc.2 does before spawning the child
 * (dsh-subprocess-local resolveExecutable, dsh-subagent-acp assertUsableCwd):
 * - `command` absolute → must be an executable file; bare name → searched on
 *   the child PATH; relative path with `/` → rejected;
 * - a `#!` interpreter (including `/usr/bin/env <name>`) must resolve too;
 * - a configured `cwd` must be an absolute, enterable directory.
 *
 * The optional handshake spawns the command with its args/env/cwd, sends the
 * ACP `initialize` request over ndjson stdio (the first message DSH sends),
 * reports the agent's answer, and then terminates the process group. It never
 * opens a session or sends a prompt, so no model is called.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AcpConfig } from './acp-manager.js';

/** `PROTOCOL_VERSION` of the @agentclientprotocol/sdk used by dsh-subagent-acp 0.1.5-rc.2. */
export const ACP_PROTOCOL_VERSION = 1;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 2000;
const KILL_GRACE_MS = 1000;

/** Same scrub as dsh-subprocess scrubbedParentEnv. */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;

export type ProbeStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface ProbeCheck {
  key: 'command' | 'interpreter' | 'cwd' | 'handshake';
  label: string;
  status: ProbeStatus;
  detail: string;
}

export interface ProbeAgentInfo {
  protocolVersion?: number;
  name?: string;
  title?: string;
  version?: string;
  authMethods?: string[];
}

export interface ProbeResult {
  /** No check failed (warnings allowed). */
  ok: boolean;
  /** Whether a handshake was requested. */
  handshake: boolean;
  checks: ProbeCheck[];
  resolvedCommand?: string;
  agent?: ProbeAgentInfo;
  /** Last part of the child's stderr, credential-looking values masked. */
  stderrTail?: string;
  durationMs: number;
}

export interface ProbeOptions {
  handshake?: boolean;
  timeoutMs?: number;
  /** Host environment the child inherits from (default process.env). */
  hostEnv?: NodeJS.ProcessEnv;
}

/** Child environment: the scrubbed host env with the config env on top. */
export function probeEnv(configEnv: Record<string, string>, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined && !SENSITIVE_ENV.test(key) && !key.toUpperCase().startsWith('DSH_')) env[key] = value;
  }
  return { ...env, ...configEnv };
}

async function isExecutableFile(path: string): Promise<'ok' | 'missing' | 'not-file' | 'not-executable'> {
  try {
    if (!(await stat(path)).isFile()) return 'not-file';
  } catch {
    return 'missing';
  }
  try {
    await access(path, constants.X_OK);
    return 'ok';
  } catch {
    return 'not-executable';
  }
}

async function findOnPath(name: string, env: Record<string, string>): Promise<string | undefined> {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if ((await isExecutableFile(candidate)) === 'ok') return candidate;
  }
  return undefined;
}

const LABELS: Record<ProbeCheck['key'], string> = {
  command: '可执行文件',
  interpreter: '解释器（#!）',
  cwd: '工作目录',
  handshake: 'ACP 握手',
};

function check(key: ProbeCheck['key'], status: ProbeStatus, detail: string): ProbeCheck {
  return { key, label: LABELS[key], status, detail };
}

async function commandCheck(command: string, env: Record<string, string>): Promise<{ check: ProbeCheck; resolved?: string }> {
  if (!command) return { check: check('command', 'fail', 'command 未配置') };
  if (!isAbsolute(command)) {
    if (command.includes('/')) {
      return { check: check('command', 'fail', `'${command}' 是相对路径，DSH 会拒绝启动。请写绝对路径，或只写命令名走 PATH`) };
    }
    const found = await findOnPath(command, env);
    return found
      ? { check: check('command', 'pass', `在 PATH 中找到：${found}`), resolved: found }
      : { check: check('command', 'fail', `在 PATH 中找不到 '${command}'。DSH 进程的 PATH 可能与终端不同，建议写绝对路径`) };
  }
  const state = await isExecutableFile(command);
  const detail = {
    ok: command,
    missing: `${command} 不存在`,
    'not-file': `${command} 不是文件`,
    'not-executable': `${command} 没有执行权限（chmod +x）`,
  }[state];
  return { check: check('command', state === 'ok' ? 'pass' : 'fail', detail), ...(state === 'ok' ? { resolved: command } : {}) };
}

/** First-line `#!` of `path`, or undefined for binaries and unreadable files. */
async function shebang(path: string): Promise<string[] | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    if (!head.startsWith('#!')) return undefined;
    return head.slice(2).split('\n')[0].trim().split(/\s+/).filter(Boolean);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function interpreterCheck(resolved: string, env: Record<string, string>): Promise<ProbeCheck> {
  const words = await shebang(resolved);
  if (!words || words.length === 0) return check('interpreter', 'skip', '不是脚本（无 #!），无需解释器');
  const [interpreter, ...rest] = words;
  if ((await isExecutableFile(interpreter)) !== 'ok') {
    return check('interpreter', 'fail', `#! 指向的解释器不存在或不可执行：${interpreter}`);
  }
  if (!/(^|\/)env$/.test(interpreter)) return check('interpreter', 'pass', interpreter);
  // `/usr/bin/env [-S] [VAR=x] name ...`: the named program must be on the child PATH.
  const name = rest.find((word) => !word.startsWith('-') && !word.includes('='));
  if (!name) return check('interpreter', 'warn', `无法从 '#!${words.join(' ')}' 识别解释器`);
  const found = isAbsolute(name) ? ((await isExecutableFile(name)) === 'ok' ? name : undefined) : await findOnPath(name, env);
  return found
    ? check('interpreter', 'pass', `${name} → ${found}`)
    : check('interpreter', 'fail', `#!${words.join(' ')}：在子进程 PATH 中找不到 '${name}'（常见于 node 脚本，DSH 进程的 PATH 里没有 node）`);
}

async function cwdCheck(cwd: string | undefined): Promise<ProbeCheck> {
  if (cwd === undefined) return check('cwd', 'skip', '未配置：运行时使用发起委派的会话的工作目录');
  if (!isAbsolute(cwd)) return check('cwd', 'fail', `${cwd} 不是绝对路径，DSH 加载该 ACP 时会报错`);
  try {
    if (!(await stat(cwd)).isDirectory()) return check('cwd', 'fail', `${cwd} 不是目录`);
    await access(cwd, constants.X_OK);
    return check('cwd', 'pass', cwd);
  } catch {
    return check('cwd', 'fail', `${cwd} 不存在或无法进入`);
  }
}

function maskSecrets(text: string): string {
  return text.replace(/([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1***');
}

interface HandshakeOutcome {
  check: ProbeCheck;
  agent?: ProbeAgentInfo;
  stderr: string;
}

function agentInfo(result: Record<string, any>): ProbeAgentInfo {
  const info = result.agentInfo ?? {};
  return {
    ...(typeof result.protocolVersion === 'number' ? { protocolVersion: result.protocolVersion } : {}),
    ...(typeof info.name === 'string' ? { name: info.name } : {}),
    ...(typeof info.title === 'string' ? { title: info.title } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
    ...(Array.isArray(result.authMethods) ? { authMethods: result.authMethods.map((m: any) => String(m?.id ?? m?.name ?? '')) } : {}),
  };
}

function handshake(resolved: string, config: AcpConfig, env: Record<string, string>, cwd: string, timeoutMs: number): Promise<HandshakeOutcome> {
  return new Promise((resolveOutcome) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let noise = 0;
    let settled = false;
    let closed = false;
    let closedCode: number | null = null;
    let closedSignal: NodeJS.Signals | null = null;
    const closedWaiters: Array<() => void> = [];

    const child = spawn(resolved, config.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const waitClosed = (ms: number) => new Promise<void>((done) => {
      if (closed) return done();
      const timer = setTimeout(done, ms);
      closedWaiters.push(() => { clearTimeout(timer); done(); });
    });
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };

    const finish = async (result: Omit<HandshakeOutcome, 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminate the whole process group: close stdin, SIGTERM, then SIGKILL.
      if (!closed) {
        child.stdin?.end();
        signal('SIGTERM');
        await waitClosed(KILL_GRACE_MS);
        if (!closed) { signal('SIGKILL'); await waitClosed(KILL_GRACE_MS); }
      }
      resolveOutcome({ ...result, stderr });
    };

    const timer = setTimeout(() => {
      void finish({ check: check('handshake', 'fail', `${Math.round(timeoutMs / 1000)} 秒内没有响应 initialize。命令可能不是 ACP 模式（检查 args），或在等待登录/交互输入`) });
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      void finish({ check: check('handshake', 'fail', `无法启动进程：${err.code ?? ''} ${err.message}`.trim()) });
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS * 2);
    });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      let index: number;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { noise += 1; continue; }
        if (message?.id !== 1) continue; // notifications or requests from the agent
        const ms = Date.now() - started;
        if (message.error) {
          void finish({ check: check('handshake', 'fail', `initialize 被拒绝：${message.error.message ?? JSON.stringify(message.error)}`) });
          return;
        }
        const info = agentInfo(message.result ?? {});
        const notes: string[] = [];
        if (info.protocolVersion !== undefined && info.protocolVersion !== ACP_PROTOCOL_VERSION) {
          notes.push(`对方协议版本 ${info.protocolVersion}，DSH 使用 ${ACP_PROTOCOL_VERSION}`);
        }
        if (noise > 0) notes.push(`stdout 有 ${noise} 行非协议输出，可能干扰 DSH 解析`);
        const base = `${ms} ms 内收到 initialize 响应`;
        void finish({
          check: check('handshake', notes.length > 0 ? 'warn' : 'pass', notes.length > 0 ? `${base}；${notes.join('；')}` : base),
          agent: info,
        });
        return;
      }
    });
    child.on('close', (code, sig) => {
      closed = true;
      closedCode = code;
      closedSignal = sig;
      closedWaiters.splice(0).forEach((fn) => fn());
      const how = closedSignal ? `signal ${closedSignal}` : `exit code ${closedCode}`;
      void finish({ check: check('handshake', 'fail', `进程在响应 initialize 前退出（${how}）。见下方 stderr`) });
    });
    child.stdin?.on('error', () => { /* EPIPE when the child exits early */ });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} } })}\n`);
  });
}

export async function probeAcp(config: AcpConfig, options: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  const env = probeEnv(config.env ?? {}, options.hostEnv);
  const command = await commandCheck(config.command, env);
  const checks: ProbeCheck[] = [command.check];
  checks.push(command.resolved
    ? await interpreterCheck(command.resolved, env)
    : check('interpreter', 'skip', '可执行文件未通过，跳过'));
  const cwd = await cwdCheck(config.cwd);
  checks.push(cwd);

  const result: ProbeResult = { ok: false, handshake: options.handshake === true, checks, durationMs: 0 };
  if (command.resolved) result.resolvedCommand = command.resolved;

  if (options.handshake) {
    const blocked = checks.find((c) => c.status === 'fail');
    if (blocked) {
      checks.push(check('handshake', 'skip', `「${blocked.label}」未通过，未启动进程`));
    } else {
      const outcome = await handshake(
        command.resolved!, config, env, config.cwd ?? homedir(),
        options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      );
      if (config.cwd === undefined) outcome.check.detail += `（测试时在 ${homedir()} 启动）`;
      checks.push(outcome.check);
      if (outcome.agent) result.agent = outcome.agent;
      const tail = maskSecrets(outcome.stderr).slice(-STDERR_TAIL_CHARS).trim();
      if (tail) result.stderrTail = tail;
    }
  }

  result.ok = checks.every((c) => c.status !== 'fail');
  result.durationMs = Date.now() - started;
  return result;
}
