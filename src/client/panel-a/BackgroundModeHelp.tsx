/**
 * v2.10: what the two Background Mode values do, shown from the "?" next to
 * the field. Wording follows @deepseek-ai/dsh-tool-subagent 0.1.7-rc.2:
 * - resolveDelegationRun: `run_in_background` defaults to false for one-shot
 *   and to true for continuable;
 * - one-shot in the background is a jobs task (job_output / job_kill);
 *   continuable in the background is ctx.subagents.startContinuable(), which
 *   returns the child id for send_message / interrupt_agent
 *   (dsh-tool-subagent-control);
 * - continuable needs the provider's prepareContinuable (spawn and fork have
 *   it, dsh-subagent-acp does not).
 */
import React from 'react';

export type BackgroundMode = 'continuable' | 'one-shot';

export interface BackgroundModeHelpProps {
  /** The value in the form (for a provider without continuable, always one-shot). */
  current: BackgroundMode;
  /** The selected provider supports continuable (capabilities.continuable). */
  continuableSupported: boolean;
}

const titleStyle: React.CSSProperties = { margin: '0 0 8px', fontWeight: 500 };
const listStyle: React.CSSProperties = { margin: 0 };
const termStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 };
const descStyle: React.CSSProperties = { margin: '2px 0 10px' };
const noteStyle: React.CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)' };
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '11px',
  padding: '0 3px',
  borderRadius: '3px',
  background: 'var(--dsw-alias-markdown-inline-code)',
  // Keep `run_in_background: true` on one line.
  whiteSpace: 'nowrap',
};
const currentTagStyle: React.CSSProperties = {
  padding: '0 6px',
  fontSize: '11px',
  lineHeight: '16px',
  fontWeight: 400,
  borderRadius: '4px',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
};

const Code = ({ children }: { children: React.ReactNode }) => <code style={codeStyle}>{children}</code>;

function Term({ mode, current }: { mode: BackgroundMode; current: BackgroundMode }) {
  return (
    <dt style={termStyle}>
      <Code>{mode}</Code>
      {mode === current && <span data-current-mode={mode} style={currentTagStyle}>当前</span>}
    </dt>
  );
}

export function BackgroundModeHelp({ current, continuableSupported }: BackgroundModeHelpProps) {
  return (
    <>
      <p style={titleStyle}>决定主代理调用这个工具时默认等不等结果，以及子代理完成后还能不能继续对话。</p>
      <dl style={listStyle}>
        <Term mode="one-shot" current={current} />
        <dd style={descStyle}>默认在前台等子代理完成，结果直接交回主代理；完成后不能再给它发消息。主代理也可以传 <Code>run_in_background: true</Code> 改为后台任务，用 <Code>job_output</Code> 取结果、<Code>job_kill</Code> 停止。适合一次就能做完的任务。</dd>
        <Term mode="continuable" current={current} />
        <dd style={descStyle}>默认在后台运行：立即返回子代理 id，主代理可以继续做别的事，子代理完成时会收到通知。之后可以用 <Code>send_message</Code> 在同一个会话里追问或补充要求、用 <Code>interrupt_agent</Code> 打断（需要同一预设加载 subagent-control 工具）。主代理传 <Code>run_in_background: false</Code> 时改为前台等待，这次调用也就不能再追问。适合耗时长、需要多轮沟通或要并行的任务。需要 provider 支持：spawn、fork 支持，ACP 不支持。</dd>
      </dl>
      {!continuableSupported && <p style={noteStyle}>当前 Provider 不支持 continuable，只能使用 one-shot。</p>}
    </>
  );
}
