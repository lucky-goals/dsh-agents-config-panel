import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAcp, probeEnv, ACP_PROTOCOL_VERSION } from './acp-probe.js';
import type { AcpConfig } from './acp-manager.js';

let dir: string;
const NODE = process.execPath;

function script(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

/** A fake ACP agent: answers initialize over ndjson, then idles until killed. */
function agent(name: string, opts: { reply?: string; noise?: boolean; pidFile?: string } = {}): string {
  const reply = opts.reply ?? `{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, agentInfo: { name: 'fake-acp', version: '9.9.9' }, agentCapabilities: {}, authMethods: [{ id: 'oauth', name: 'OAuth' }] } }`;
  return script(name, `#!${NODE}
${opts.pidFile ? `require('fs').writeFileSync(${JSON.stringify(opts.pidFile)}, String(process.pid));` : ''}
process.stderr.write('env E2E_FLAG=' + process.env.E2E_FLAG + ' leak=' + (process.env.WUYOU_PROBE_SECRET_TOKEN ?? 'none') + ' API_KEY=abc123\\n');
${opts.noise ? "process.stdout.write('starting up...\\n');" : ''}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') process.stdout.write(JSON.stringify(${reply}) + '\\n');
  }
});
setInterval(() => {}, 1000);
`);
}

function config(command: string, extra: Partial<AcpConfig> = {}): AcpConfig {
  return { providerName: 'fake', command, args: [], permission: 'reject', env: {}, ...extra };
}

const byKey = (result: Awaited<ReturnType<typeof probeAcp>>, key: string) => result.checks.find((c) => c.key === key)!;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wuyou-acp-probe-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'work'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('probeAcp static checks (same rules as dsh-subprocess-local)', () => {
  it('an absolute executable passes and reports its path; no process is started', async () => {
    const path = agent('ok-static', { pidFile: join(dir, 'never.pid') });
    const result = await probeAcp(config(path));
    expect(result).toMatchObject({ ok: true, handshake: false, resolvedCommand: path });
    expect(byKey(result, 'command')).toMatchObject({ status: 'pass' });
    expect(byKey(result, 'interpreter')).toMatchObject({ status: 'pass' });
    expect(byKey(result, 'interpreter').detail).toContain(NODE);
    expect(byKey(result, 'cwd').status).toBe('skip');
    expect(result.checks.some((c) => c.key === 'handshake')).toBe(false);
    expect(() => readFileSync(join(dir, 'never.pid'))).toThrow();
  });

  it.each([
    ['missing file', () => join(dir, 'nope'), '不存在'],
    ['not executable', () => script('plain.txt', 'hi', 0o644), '没有执行权限'],
    ['a directory', () => join(dir, 'bin'), '不是文件'],
    ['a relative path', () => 'bin/agent', '相对路径'],
    ['a bare name not on PATH', () => 'wuyou-no-such-agent-xyz', 'PATH'],
    ['empty', () => '', '未配置'],
  ])('fails for %s', async (_label, command, text) => {
    const result = await probeAcp(config(command()));
    expect(result.ok).toBe(false);
    expect(byKey(result, 'command').status).toBe('fail');
    expect(byKey(result, 'command').detail).toContain(text);
  });

  it('resolves a bare name through the child PATH (config env overrides the host PATH)', async () => {
    const path = join(dir, 'bin', 'my-acp');
    writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
    const result = await probeAcp(config('my-acp', { env: { PATH: join(dir, 'bin') } }));
    expect(result).toMatchObject({ ok: true, resolvedCommand: path });
    expect(byKey(result, 'command').detail).toContain('PATH');
  });

  it('checks the shebang interpreter, including `/usr/bin/env <name>`', async () => {
    const missingEnv = await probeAcp(config(script('env-missing', '#!/usr/bin/env wuyou-missing-interp-xyz\n')));
    expect(byKey(missingEnv, 'interpreter')).toMatchObject({ status: 'fail' });
    expect(byKey(missingEnv, 'interpreter').detail).toContain('wuyou-missing-interp-xyz');
    expect(missingEnv.ok).toBe(false);

    const missingAbs = await probeAcp(config(script('abs-missing', '#!/nonexistent/wuyou-sh\n')));
    expect(byKey(missingAbs, 'interpreter')).toMatchObject({ status: 'fail' });

    const viaEnv = await probeAcp(config(script('env-sh', '#!/usr/bin/env -S sh -e\n')));
    expect(byKey(viaEnv, 'interpreter')).toMatchObject({ status: 'pass' });
    expect(byKey(viaEnv, 'interpreter').detail).toMatch(/sh → \/.*sh/);

    const binary = await probeAcp(config('/bin/ls'));
    expect(byKey(binary, 'interpreter').status).toBe('skip');
  });

  it('checks a configured cwd the way the ACP plugin validates it at load', async () => {
    const path = agent('ok-cwd');
    expect(byKey(await probeAcp(config(path, { cwd: join(dir, 'work') })), 'cwd').status).toBe('pass');
    expect(byKey(await probeAcp(config(path, { cwd: 'work' })), 'cwd')).toMatchObject({ status: 'fail' });
    expect(byKey(await probeAcp(config(path, { cwd: join(dir, 'nowhere') })), 'cwd')).toMatchObject({ status: 'fail' });
  });
});

describe('probeAcp handshake', () => {
  it('sends ACP initialize, reports the agent, and terminates the process', async () => {
    const pidFile = join(dir, 'ok.pid');
    const previous = process.env.WUYOU_PROBE_SECRET_TOKEN;
    process.env.WUYOU_PROBE_SECRET_TOKEN = 'should-not-leak';
    try {
      const result = await probeAcp(config(agent('ok-agent', { pidFile }), { args: ['--acp'], env: { E2E_FLAG: 'on' } }), { handshake: true });
      expect(result.ok).toBe(true);
      expect(byKey(result, 'handshake')).toMatchObject({ status: 'pass' });
      expect(result.agent).toEqual({ protocolVersion: ACP_PROTOCOL_VERSION, name: 'fake-acp', version: '9.9.9', authMethods: ['oauth'] });
      // Env: config env added, credential-shaped host vars scrubbed; stderr secrets masked.
      expect(result.stderrTail).toContain('E2E_FLAG=on leak=none');
      expect(result.stderrTail).toContain('API_KEY=***');
      expect(result.stderrTail).not.toContain('abc123');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.WUYOU_PROBE_SECRET_TOKEN;
      else process.env.WUYOU_PROBE_SECRET_TOKEN = previous;
    }
  });

  it('a process that exits before answering fails with its exit code and stderr', async () => {
    const path = script('crash', `#!${NODE}\nprocess.stderr.write('fatal: not logged in\\n'); process.exit(3);\n`);
    const result = await probeAcp(config(path), { handshake: true });
    expect(result.ok).toBe(false);
    expect(byKey(result, 'handshake').detail).toContain('exit code 3');
    expect(result.stderrTail).toContain('fatal: not logged in');
  });

  it('an initialize error, a timeout, stdout noise and a version mismatch are reported', async () => {
    const refused = await probeAcp(config(agent('refuse', { reply: "{ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth required' } }" })), { handshake: true });
    expect(byKey(refused, 'handshake')).toMatchObject({ status: 'fail' });
    expect(byKey(refused, 'handshake').detail).toContain('auth required');

    const silent = await probeAcp(config(script('silent', `#!${NODE}\nsetInterval(() => {}, 1000);\n`)), { handshake: true, timeoutMs: 400 });
    expect(byKey(silent, 'handshake')).toMatchObject({ status: 'fail' });
    expect(byKey(silent, 'handshake').detail).toContain('没有响应');

    const noisy = await probeAcp(config(agent('noisy', { noise: true })), { handshake: true });
    expect(byKey(noisy, 'handshake')).toMatchObject({ status: 'warn' });
    expect(byKey(noisy, 'handshake').detail).toContain('非协议输出');
    expect(noisy.ok).toBe(true);

    const v2 = await probeAcp(config(agent('v2', { reply: "{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 2 } }" })), { handshake: true });
    expect(byKey(v2, 'handshake')).toMatchObject({ status: 'warn' });
    expect(byKey(v2, 'handshake').detail).toContain('协议版本 2');
  });

  it('does not start anything when the static checks fail', async () => {
    const result = await probeAcp(config(join(dir, 'nope')), { handshake: true });
    expect(byKey(result, 'handshake')).toMatchObject({ status: 'skip' });
    expect(result.stderrTail).toBeUndefined();
  });
});

describe('probeEnv', () => {
  it('drops credential-shaped and DSH_* names, then applies the config env', () => {
    expect(probeEnv({ A: 'x', GITHUB_TOKEN: 'mine' }, { PATH: '/bin', OPENAI_API_KEY: 's', DSH_HOME: '/h', db_password: 'p', A: 'old' }))
      .toEqual({ PATH: '/bin', A: 'x', GITHUB_TOKEN: 'mine' });
  });
});
