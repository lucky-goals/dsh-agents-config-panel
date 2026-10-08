/**
 * Small presentational pieces shared by the 模型能力 components. Everything
 * here is stateless apart from React ids/refs; state changes go through the
 * store in the calling component.
 */
import React, { useEffect, useId, useLayoutEffect } from 'react';
import { API_OPTS } from '../types';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { badge, testKey, type TestTone } from '../model-test';
import { mcStyles as s, sx } from '../styles';

/** Layout effect in the browser, plain effect under SSR (no warning). */
export const useIsoLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/**
 * React 18's DOM types have no `inert`, so it is toggled on the node. Pair it
 * with aria-hidden in JSX for the SSR markup.
 */
export function useInert(ref: React.RefObject<HTMLElement>, on: boolean): void {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [ref, on]);
}

type BtnKind = 'default' | 'primary' | 'primary-sm' | 'danger' | 'ghost' | 'icon' | 'link';
const KIND: Record<BtnKind, React.CSSProperties> = {
  default: s.btn,
  primary: s.btnPrimary,
  'primary-sm': s.btnPrimarySm,
  danger: s.btnDanger,
  ghost: s.btnGhost,
  icon: s.iconbtn,
  link: s.linkbtn,
};

export type BtnProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { kind?: BtnKind };

/**
 * Prototype-sized button. The repo Button has one size (and no ref/aria
 * passthrough), so the 36px/12px primary and the 28px row buttons live here.
 */
export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { kind = 'default', style, disabled, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" disabled={disabled} style={sx(KIND[kind], disabled && s.disabled, style)} {...rest}>
      {children}
    </button>
  );
});

export function Tag({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <span style={sx(s.tag, mono && s.mono)}>{children}</span>;
}

/** Credential state: exactly one dot + label per card (captain ruling 4). */
export function CredStatus({ configured }: { configured: boolean }) {
  return (
    <span style={s.row}>
      <span style={configured ? s.dotOk : s.dotBad} aria-hidden="true" />
      {configured ? '已配置' : '凭证缺失'}
    </span>
  );
}

const BANNER_TONE = {
  info: { box: s.banner, mark: s.mark, glyph: 'i' },
  error: { box: s.bannerError, mark: s.markError, glyph: '!' },
  warn: { box: s.bannerWarn, mark: s.markWarn, glyph: '!' },
} as const;

export function Banner({
  tone = 'info',
  role = 'note',
  children,
  sub,
  actions,
  id,
  dataMc,
}: {
  tone?: 'info' | 'error' | 'warn';
  role?: 'note' | 'alert' | 'status';
  children: React.ReactNode;
  /** Secondary line under the text (R4a banners). */
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
  dataMc?: string;
}) {
  const t = BANNER_TONE[tone];
  return (
    <div role={role} id={id} data-mc={dataMc} style={t.box}>
      <span style={t.mark} aria-hidden="true">{t.glyph}</span>
      <span style={s.bannerTxt}>
        {children}
        {sub != null && <span style={s.bannerSub}>{sub}</span>}
      </span>
      {actions}
    </div>
  );
}

/* ---------------- R4a 模型测试：共用的门控与按钮 ---------------- */

const BADGE_STYLE: Record<TestTone, React.CSSProperties> = {
  success: s.tbadgeOk,
  error: s.tbadgeBad,
  warn: s.tbadgeWarn,
  muted: s.tbadgeRun,
};

/** Provider-level summary badge (spec 2.5 badge()); null when nothing was tested. */
export function TestBadge({ snap, route }: { snap: McSnapshot; route: string }) {
  const t = snap.test;
  const p = snap.draft.providers[route];
  if (!t || !p) return null;
  const keys = p.models.filter((m) => m.id).map((m) => testKey(route, m.id));
  const b = badge(keys, t.results, t.batches[route]);
  if (!b) return null;
  return (
    <span data-mc-badge={route} title={b.title} style={BADGE_STYLE[b.tone]}>
      {b.tone === 'muted' && <span style={sx(s.ring, { width: '8px', height: '8px', marginRight: '4px' })} aria-hidden="true" />}
      {b.text}
    </span>
  );
}

export const HOST_UNSUPPORTED_TEXT = '当前 Host 不支持模型测试，重启 DSH 后可用';
export const SAVE_FIRST = '先保存再测试';

/**
 * Why testing this route is blocked, or null. `snap.test.blocked` is computed
 * by the store; hostUnsupported also gates routes it has no entry for.
 */
export function testGate(snap: McSnapshot, route: string): string | null {
  const t = snap.test;
  if (!t) return null;
  return t.blocked[route] ?? (t.hostUnsupported ? HOST_UNSUPPORTED_TEXT : null);
}

/** The gate reasons that render the 「先保存再测试」 banner / card line. */
export function isSaveGate(reason: string | null): boolean {
  return !!reason && reason.startsWith(SAVE_FIRST);
}

/**
 * Button that stays focusable and clickable while gated (spec 2.6): it carries
 * aria-disabled + title instead of `disabled`, and the store explains why.
 */
export const GateBtn = React.forwardRef<HTMLButtonElement, BtnProps & { why?: string | null }>(function GateBtn(
  { why, style, title, ...rest },
  ref,
) {
  return (
    <Btn
      ref={ref}
      aria-disabled={why ? 'true' : undefined}
      title={why || title}
      style={sx(why && s.disabled, style)}
      {...rest}
    />
  );
});

export function Switch({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      style={sx(s.switchBtn, disabled && s.disabled)}
    >
      <span style={on ? s.switchTrackOn : s.switchTrack} aria-hidden="true">
        <span style={on ? s.switchKnobOn : s.switchKnob} />
      </span>
      {label}
    </button>
  );
}

export function Section({ title, titleAddon, children }: { title?: string; titleAddon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={s.section}>
      {title && (titleAddon ? (
        <div style={s.row}>
          <div style={sx(s.sectionTitle, s.spacer)}>{title}</div>
          {titleAddon}
        </div>
      ) : (
        <div style={s.sectionTitle}>{title}</div>
      ))}
      {children}
    </div>
  );
}

export function Hint({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <p style={sx(s.hint, style)}>{children}</p>;
}

export function ErrText({ children, id, style }: { children: React.ReactNode; id?: string; style?: React.CSSProperties }) {
  return <p id={id} style={sx(s.errtext, style)}>{children}</p>;
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  type?: 'text' | 'password';
  autoComplete?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}

/** Label + input + error/hint, prototype textField(). Error wins over hint. */
export function TextField({
  label, value, onChange, onBlur, error, hint, placeholder, disabled, mono, type = 'text', autoComplete, inputRef,
}: TextFieldProps) {
  const id = useId();
  return (
    <div style={s.field}>
      <label htmlFor={id} style={s.label}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete ?? 'off'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : undefined}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
        style={sx(s.input, mono && s.mono, error && s.inputInvalid, disabled && s.inputDisabled)}
      />
      {error ? <ErrText id={`${id}-e`}>{error}</ErrText> : hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}

/** A native radio group laid out like the prototype's radioGroup(). */
export function RadioGroup<V extends string>({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: V;
  options: Array<{ v: V; t: string; disabled?: boolean }>;
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} style={s.bradios}>
      {options.map((o) => {
        const dis = !!disabled || !!o.disabled;
        return (
          <label key={o.v} style={dis ? s.checkDis : s.check}>
            <input
              type="radio"
              name={name}
              value={o.v}
              checked={value === o.v}
              disabled={dis}
              onChange={() => onChange(o.v)}
              style={s.checkInput}
            />
            {o.t}
          </label>
        );
      })}
    </div>
  );
}

export function apiName(v: string | undefined): string {
  const o = API_OPTS.find((x) => x.v === v);
  return o ? o.t : v ?? '';
}

/** Routes with at least one field error, read from snap.errors only (captain ruling 1). */
export function errorCount(snap: McSnapshot): number {
  const has = (o: object | undefined) => !!o && Object.values(o).some(Boolean);
  return Object.values(snap.errors).filter((e) => has(e.route) || (e.models ?? []).some(has)).length;
}

/**
 * The store's input hint for one chip group. Keys follow the prototype
 * (`model`, `route:<id>`, `wiz`, `bulk`); a prefix match keeps route keys working.
 */
export function hintFor(snap: McSnapshot, scope: 'model' | 'route' | 'wizard' | 'bulk'): string | undefined {
  const h = snap.ui.inputHint;
  if (!h) return undefined;
  const names = scope === 'wizard' ? ['wizard', 'wiz'] : [scope];
  return names.some((n) => h.key === n || h.key.startsWith(`${n}:`)) ? h.text : undefined;
}

const PI_WRITTEN = 'llm-pi-ai 已写入。';

/**
 * Top-of-content banners (prototype bannersHTML): read-only note, the conflict
 * banner in its two wordings (spec C), other save errors and the status line.
 * The main area and every layer render it, since a layer covers the main area.
 */
export function Banners({ snap, store }: { snap: McSnapshot; store: ModelCapabilitiesStore }) {
  const { ui, saveError } = snap;
  const conflict = ui.conflict !== 'hidden';
  return (
    <>
      {ui.readonly && <Banner>只能在本机上修改设置。</Banner>}
      {ui.conflict === 'shown' && (
        <Banner
          tone="error"
          role="alert"
          actions={(
            <>
              <Btn onClick={() => store.askReload()}>重新加载</Btn>
              <Btn onClick={() => store.keepConflict()}>保留草稿</Btn>
            </>
          )}
        >
          这份配置刚刚被别处改过，这次没写入。你的修改还在。
        </Banner>
      )}
      {ui.conflict === 'kept' && (
        <Banner tone="error" role="status" actions={<Btn onClick={() => store.askReload()}>重新加载</Btn>}>
          这份配置刚刚被别处改过。草稿还在，但解除冲突前保存会失败。
        </Banner>
      )}
      {/* The conflict wording is fixed above; only the partial-write note is added (spec C). */}
      {conflict && saveError?.includes(PI_WRITTEN) && <div role="status" style={s.statusline}>{PI_WRITTEN}</div>}
      {!conflict && saveError && (
        <Banner tone="error" role="alert" actions={<Btn kind="ghost" aria-label="关闭提示" onClick={() => store.dismissStatus()}>×</Btn>}>
          {saveError}
        </Banner>
      )}
      {ui.status && <div role="status" style={s.statusline}>{ui.status}</div>}
    </>
  );
}
