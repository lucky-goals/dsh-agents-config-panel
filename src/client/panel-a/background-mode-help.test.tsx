/**
 * v2.10: the Background Mode help text. Wording follows
 * @deepseek-ai/dsh-tool-subagent 0.1.7-rc.2 (resolveDelegationRun,
 * startContinuable, jobs.start) and the providers' prepareContinuable.
 */
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { BackgroundModeHelp } from './BackgroundModeHelp';

const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');
const currentModes = (html: string) => [...html.matchAll(/data-current-mode="([^"]+)"/g)].map((m) => m[1]);

describe('BackgroundModeHelp (v2.10)', () => {
  it('explains one-shot and continuable side by side, from the real tool behaviour', () => {
    const shown = text(renderToString(<BackgroundModeHelp current="continuable" continuableSupported />));
    // one-shot: waits in the foreground, no follow-up; background only on request, via jobs.
    expect(shown).toContain('默认在前台等子代理完成');
    expect(shown).toContain('run_in_background: true');
    expect(shown).toContain('job_output');
    expect(shown).toContain('job_kill');
    // continuable: background by default, returns an id, follow-ups through the control tools.
    expect(shown).toContain('默认在后台运行');
    expect(shown).toContain('send_message');
    expect(shown).toContain('interrupt_agent');
    expect(shown).toContain('run_in_background: false');
    expect(shown).toContain('需要 provider 支持');
  });

  it('marks the value selected in the drop-down', () => {
    expect(currentModes(renderToString(<BackgroundModeHelp current="continuable" continuableSupported />))).toEqual(['continuable']);
    expect(currentModes(renderToString(<BackgroundModeHelp current="one-shot" continuableSupported />))).toEqual(['one-shot']);
  });

  it('a provider without continuable support: one-shot is current and the reason is given', () => {
    const html = renderToString(<BackgroundModeHelp current="one-shot" continuableSupported={false} />);
    expect(currentModes(html)).toEqual(['one-shot']);
    expect(text(html)).toContain('当前 Provider 不支持 continuable，只能使用 one-shot');
    expect(text(renderToString(<BackgroundModeHelp current="one-shot" continuableSupported />))).not.toContain('当前 Provider 不支持');
  });
});
