/**
 * 流空闲超时 streamIdleTimeoutMs (docs/specs/r4b-stream-idle-timeout.md 6.1).
 * Controlled: the pi access layer, the DeepSeek detail and the wizard's step 2
 * feed it, and it only reports input / blur / preset / reset back.
 *
 * Rows: label + minutes input + 「分钟」 + 恢复 DSH 默认 · presets · error or
 * hint · fixed meaning note. Minutes only; the store turns them into integer ms.
 */
import React, { useId } from 'react';
import { TIMEOUT_PRESETS } from '../types';
import type { McSnapshot, ProviderDraft } from '../types';
import { msToMinutesText, parseTimeoutMinutes, timeoutHint } from '../timeout';
import { mcStyles as s, sx } from '../styles';
import { Btn, ErrText, Hint } from './shared';

export interface TimeoutFieldProps {
  scope: 'access' | 'ds' | 'wizard';
  /** Shown value: timeoutText ?? (ms set ? msToMinutesText(ms) : ''). */
  text: string;
  /** For the hint and the pressed preset. */
  resolvedMs: number | undefined;
  /** Whether 「恢复 DSH 默认」 is clickable (a value is set or typed). */
  explicit: boolean;
  error?: string;
  disabled?: boolean;
  onText(v: string): void;
  onBlur(): void;
  onPreset(ms: number): void;
  onReset(): void;
}

export const TIMEOUT_NOTE = '连续这么久没有收到任何数据就判定超时；不是单次调用的总时长。超时后 DSH 会话默认会自动重试。';

/** The recommended preset carries 「（推荐）」 (spec 2 (c)). */
const presetLabel = (label: string, ms: number) => (ms === 1800000 ? `${label}（推荐）` : label);

/** Display props of a provider route (pi access layer and DeepSeek detail). */
export function routeTimeoutProps(snap: McSnapshot, route: string, p: ProviderDraft) {
  const text = p.timeoutText ?? (p.streamIdleTimeoutMs !== undefined ? msToMinutesText(p.streamIdleTimeoutMs) : '');
  let resolvedMs = p.streamIdleTimeoutMs;
  if (p.timeoutText !== undefined) {
    const parsed = parseTimeoutMinutes(p.timeoutText);
    if (parsed.kind === 'ok') resolvedMs = parsed.ms;
  }
  return {
    text,
    resolvedMs,
    explicit: p.streamIdleTimeoutMs !== undefined || (p.timeoutText ?? '') !== '',
    error: snap.errors[route]?.route?.streamIdleTimeoutMs,
  };
}

export function TimeoutField({
  scope, text, resolvedMs, explicit, error, disabled, onText, onBlur, onPreset, onReset,
}: TimeoutFieldProps): JSX.Element {
  const id = useId();
  return (
    <div style={s.field} data-mc="timeout" data-mc-scope={scope}>
      <div style={s.capline}>
        <label htmlFor={id} style={s.label}>流空闲超时</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          placeholder="30"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : `${id}-h`}
          data-mc="timeout-input"
          onChange={(e) => onText(e.target.value)}
          onBlur={onBlur}
          style={sx(s.input, s.mono, s.capInput, error && s.inputInvalid, disabled && s.inputDisabled)}
        />
        <span style={s.timeoutUnit}>分钟</span>
        <Btn kind="link" disabled={disabled || !explicit} onClick={onReset} data-mc="timeout-reset">恢复 DSH 默认</Btn>
      </div>
      <div role="group" aria-label="流空闲超时预设" style={sx(s.chips, { marginTop: '2px' })}>
        {TIMEOUT_PRESETS.map(([label, ms]) => (
          <button
            key={ms}
            type="button"
            aria-pressed={resolvedMs === ms}
            disabled={disabled}
            data-mc="timeout-preset"
            data-mc-ms={ms}
            onClick={() => onPreset(ms)}
            style={sx(resolvedMs === ms ? s.chipOn : s.chip, s.chipSm, disabled && s.disabled)}
          >
            {presetLabel(label, ms)}
          </button>
        ))}
      </div>
      {error ? (
        <ErrText id={`${id}-e`}>{error}</ErrText>
      ) : (
        <p id={`${id}-h`} data-mc="timeout-hint" style={s.hint}>{timeoutHint(resolvedMs)}</p>
      )}
      <Hint style={{ margin: 0 }}>{TIMEOUT_NOTE}</Hint>
    </div>
  );
}
