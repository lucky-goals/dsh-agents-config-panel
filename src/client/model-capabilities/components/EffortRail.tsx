/**
 * 思考档位轨道 (prototype railHTML + its keyboard handler).
 *
 * - multi: role=group of role=checkbox; arrows only move focus, Space/Enter toggle.
 * - single / ds: role=radiogroup of role=radio; arrows move and select.
 * - single can be cleared (「清除默认档」); ds cannot.
 * - Adjacent selected nodes join into a step: radius only on the run's ends.
 * - The default level is marked 「默认」 under the rail in 11px text.
 */
import React, { useId, useRef, useState } from 'react';
import { ADV_EFFORTS, DS_EFFORTS, MAIN_EFFORTS } from '../types';
import type { Effort, McSnapshot, ModelCapabilitiesStore } from '../types';
import { mcStyles as s, sx } from '../styles';
import { Btn, useIsoLayoutEffect } from './shared';

export interface EffortRailProps {
  railKey: string;
  mode: 'multi' | 'single' | 'ds';
  selected: string[];
  defaultLevel?: string;
  disabled?: boolean;
  isDisabled?: (level: string) => boolean;
  showAdv: boolean;
  onToggle: (level: string) => void;
  onClear?: () => void;
  onToggleAdv: () => void;
  label: string;
}

const ADV: readonly string[] = ADV_EFFORTS;
const MAIN: readonly string[] = MAIN_EFFORTS;
const DS: readonly string[] = DS_EFFORTS;

export function EffortRail({
  railKey,
  mode,
  selected,
  defaultLevel,
  disabled,
  isDisabled,
  showAdv,
  onToggle,
  onClear,
  onToggleAdv,
  label,
}: EffortRailProps): JSX.Element | null {
  const uid = useId();
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [focusLvl, setFocusLvl] = useState<string | null>(null);

  const dis = (l: string) => !!disabled || (isDisabled ? isDisabled(l) : false);
  const selAdv = selected.some((l) => ADV.includes(l));
  const defAdv = !!defaultLevel && ADV.includes(defaultLevel);
  const advOpen = mode !== 'ds' && (showAdv || selAdv || defAdv);
  const groups: Array<{ cap: string; levels: readonly string[] }> = mode === 'ds'
    ? [{ cap: '', levels: DS }]
    : advOpen ? [{ cap: '高级', levels: ADV }, { cap: '', levels: MAIN }] : [{ cap: '', levels: MAIN }];
  const flat = groups.flatMap((g) => g.levels);
  const enabled = flat.filter((l) => !dis(l));
  const multi = mode === 'multi';
  const role = multi ? 'checkbox' : 'radio';

  // Roving tabindex: the focused node (multi), else the first selected enabled node, else the first enabled one.
  const tabLvl = (multi && focusLvl && enabled.includes(focusLvl) ? focusLvl : null)
    ?? flat.find((l) => selected.includes(l) && !dis(l))
    ?? enabled[0];

  useIsoLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    nodes.current.get(want)?.focus();
  });

  const focusLater = (l: string | undefined) => {
    if (!l) return;
    pendingFocus.current = l;
    setFocusLvl(l);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, lvl: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (!enabled.length) return;
    let i = enabled.indexOf(lvl);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = enabled.length - 1;
    else i = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    const next = enabled[i];
    if (multi) {
      setFocusLvl(next);
      nodes.current.get(next)?.focus();
      return;
    }
    // radiogroup: moving selects. Selecting the already-selected level would clear it, so skip that.
    if (!selected.includes(next)) onToggle(next);
    focusLater(next);
  };

  const defId = `${uid}-def`;
  const advLink = mode !== 'ds' && (!advOpen
    ? { text: '显示 off、minimal', focus: 'off' }
    : !selAdv && !defAdv ? { text: '隐藏 off、minimal', focus: 'low' } : null);

  return (
    <div style={s.railRow} data-rail={railKey}>
      <div role={multi ? 'group' : 'radiogroup'} aria-label={label} style={s.railWrap}>
        {groups.map((g) => (
          <div
            key={g.cap || 'main'}
            style={s.railGrp}
            role={g.cap ? 'group' : undefined}
            aria-label={g.cap ? `${g.cap}档位` : undefined}
          >
            <span style={s.railCap} aria-hidden={g.cap ? undefined : 'true'}>{g.cap || '\u00a0'}</span>
            <div style={s.rail}>
              {g.levels.map((l, i) => {
                const on = selected.includes(l);
                const jl = on && i > 0 && selected.includes(g.levels[i - 1]);
                const jr = on && i < g.levels.length - 1 && selected.includes(g.levels[i + 1]);
                const d = dis(l);
                return (
                  <button
                    key={l}
                    ref={(el) => { if (el) nodes.current.set(l, el); else nodes.current.delete(l); }}
                    type="button"
                    role={role}
                    aria-checked={on}
                    aria-describedby={l === defaultLevel ? defId : undefined}
                    tabIndex={l === tabLvl ? 0 : -1}
                    disabled={d}
                    onClick={() => {
                      if (multi) setFocusLvl(l);
                      onToggle(l);
                    }}
                    onKeyDown={(e) => onKeyDown(e, l)}
                    style={sx(
                      s.railNode,
                      i === 0 && { marginLeft: 0 },
                      on && s.railNodeOn,
                      jl && { marginLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
                      jr && { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
                      d && { opacity: 0.4, cursor: 'not-allowed' },
                    )}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
            <div style={s.railMarks} aria-hidden={defaultLevel && g.levels.includes(defaultLevel) ? undefined : 'true'}>
              {g.levels.map((l, i) => {
                const jl = selected.includes(l) && i > 0 && selected.includes(g.levels[i - 1]);
                return (
                  <span
                    key={l}
                    id={l === defaultLevel ? defId : undefined}
                    style={sx(s.railMark, (i === 0 || jl) && { marginLeft: 0 })}
                  >
                    {l === defaultLevel ? '默认' : ''}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {advLink && (
        <Btn
          kind="link"
          style={s.railLink}
          disabled={!advOpen && disabled}
          onClick={() => {
            onToggleAdv();
            focusLater(advLink.focus);
          }}
        >
          {advLink.text}
        </Btn>
      )}
      {mode === 'single' && onClear && selected.length > 0 && (
        <Btn
          kind="link"
          style={s.railLink}
          disabled={disabled}
          onClick={() => {
            onClear();
            focusLater(MAIN[0]);
          }}
        >
          清除默认档
        </Btn>
      )}
    </div>
  );
}

/** Prototype singleRailHint(). */
export function SingleRailHint({ has }: { has: boolean }) {
  return <p style={s.hint}>{has ? '再点已选的档，或点「清除默认档」。' : '未设置。用方向键或点击选择一档。'}</p>;
}

export type { Effort };
export type EffortRailSnapshotProps = { snap: McSnapshot; store: ModelCapabilitiesStore };
