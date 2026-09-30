/**
 * 模型能力 panel styles (spec E): inline style objects only, no <style>, no
 * colour literals. Colours come from the allowed --dsw-alias-* tokens; the
 * prototype's tertiary text maps to label-secondary, its link colour to
 * brand-primary, its layer-3 fill to bg-layer-2 and its l4 border to border-l2.
 * Radii are plain px. Focus rings stay the browser default.
 */
import type React from 'react';

type S = React.CSSProperties;

export const C = {
  fg: 'var(--dsw-alias-label-primary)',
  fg2: 'var(--dsw-alias-label-secondary)',
  onFill: 'var(--dsw-alias-label-primary-foreground)',
  bg1: 'var(--dsw-alias-bg-layer-1)',
  bg2: 'var(--dsw-alias-bg-layer-2)',
  line1: 'var(--dsw-alias-border-l1)',
  line2: 'var(--dsw-alias-border-l2)',
  fill: 'var(--dsw-alias-button-primary-fill)',
  error: 'var(--dsw-alias-state-error-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  link: 'var(--dsw-alias-brand-primary)',
  mask: 'var(--dsw-alias-bg-mask-1)',
  code: 'var(--dsw-alias-markdown-inline-code)',
} as const;

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const HAIR = `0.5px solid ${C.line2}`;
const DASH = `0.5px dashed ${C.line2}`;

function styles<T extends Record<string, S>>(t: T): T {
  return t;
}

const btnBase: S = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
  height: '28px',
  padding: '0 10px',
  borderRadius: '8px',
  border: HAIR,
  background: 'transparent',
  color: C.fg,
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const tagBase: S = {
  display: 'inline-block',
  fontSize: '11px',
  lineHeight: '16px',
  padding: '0 6px',
  borderRadius: '4px',
  border: HAIR,
  color: C.fg2,
  fontWeight: 400,
  verticalAlign: '1px',
};

const bannerBase: S = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  padding: '10px 12px',
  borderRadius: '12px',
  border: HAIR,
  background: C.bg2,
  fontSize: '13px',
  lineHeight: '20px',
};

const markBase: S = {
  width: '16px',
  height: '16px',
  boxSizing: 'border-box',
  borderRadius: '50%',
  flex: 'none',
  marginTop: '2px',
  fontSize: '11px',
  lineHeight: '15px',
  textAlign: 'center',
  border: HAIR,
  color: C.fg2,
};

const chipBase: S = {
  height: '28px',
  boxSizing: 'border-box',
  padding: '0 12px',
  borderRadius: '8px',
  fontSize: '13px',
  border: HAIR,
  background: 'transparent',
  color: C.fg2,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const trackBase: S = {
  position: 'relative',
  display: 'inline-block',
  flex: 'none',
  width: '32px',
  height: '18px',
  boxSizing: 'border-box',
  borderRadius: '9px',
  background: C.bg2,
  border: HAIR,
};

const knobBase: S = {
  position: 'absolute',
  top: '2px',
  left: '2px',
  width: '13px',
  height: '13px',
  borderRadius: '50%',
  background: C.fg2,
};

const mrowBase: S = {
  gridColumn: '1 / -1',
  display: 'grid',
  gridTemplateColumns: 'subgrid',
  alignItems: 'center',
  columnGap: '8px',
  padding: '8px 0',
  fontSize: '13px',
};

const stepNBase: S = {
  display: 'inline-block',
  width: '20px',
  height: '20px',
  boxSizing: 'border-box',
  borderRadius: '50%',
  fontSize: '11px',
  lineHeight: '19px',
  textAlign: 'center',
  border: HAIR,
};

export const mcStyles: Record<string, S> = styles({
  /* ---------- shell ---------- */
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: '420px',
    boxSizing: 'border-box',
    color: C.fg,
    fontSize: '14px',
    lineHeight: '22px',
    overflow: 'hidden',
  },
  body: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  topbar: { display: 'flex', justifyContent: 'flex-end', padding: '8px 16px 0', flex: 'none' },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: '48px',
    left: 0,
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: C.bg1,
  },
  savebar: {
    height: '48px',
    flex: 'none',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 16px',
    borderTop: HAIR,
    background: C.bg1,
  },
  count: { flex: 1, fontSize: '13px', color: C.fg2 },
  countErr: { flex: 1, fontSize: '13px', color: C.error },
  rev: { fontSize: '11px', color: C.fg2, fontVariantNumeric: 'tabular-nums' },

  /* ---------- type ---------- */
  h1: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' },
  h2: { margin: 0, fontSize: '14px', fontWeight: 500, lineHeight: '22px' },
  desc: { margin: 0, fontSize: '14px', lineHeight: '22px', color: C.fg2 },
  small: { fontSize: '12px', lineHeight: '18px', color: C.fg2 },
  hint: { fontSize: '12px', lineHeight: '18px', color: C.fg2, margin: '4px 0 0' },
  errtext: { fontSize: '12px', lineHeight: '18px', color: C.error, margin: '4px 0 0' },
  err: { color: C.error },
  mono: { fontFamily: MONO },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  rowWrap: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  head: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
  headMain: { flex: 1, minWidth: 0 },
  statusline: { fontSize: '12px', color: C.fg2, minHeight: '18px' },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },

  /* ---------- buttons ---------- */
  btn: btnBase,
  btnPrimary: {
    ...btnBase,
    height: '36px',
    padding: '0 16px',
    borderRadius: '12px',
    border: 0,
    background: C.fill,
    color: C.onFill,
    fontSize: '14px',
    fontWeight: 500,
  },
  btnPrimarySm: {
    ...btnBase,
    padding: '0 12px',
    border: 0,
    background: C.fill,
    color: C.onFill,
    fontWeight: 500,
  },
  btnDanger: { ...btnBase, border: 0, color: C.error },
  btnGhost: { ...btnBase, border: 0, color: C.fg2 },
  iconbtn: { ...btnBase, width: '28px', padding: 0, border: 0, color: C.fg2 },
  linkbtn: {
    border: 0,
    background: 'none',
    padding: 0,
    color: C.link,
    fontSize: '13px',
    fontFamily: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  disabled: { opacity: 0.45, cursor: 'not-allowed' },

  /* ---------- cards / banners ---------- */
  card: { border: HAIR, background: C.bg2, borderRadius: '20px', padding: '12px 14px' },
  pcard: { display: 'flex', alignItems: 'center', gap: '12px' },
  pmain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  pname: { fontSize: '14px', fontWeight: 500 },
  purl: { fontSize: '12px', color: C.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pmeta: { fontSize: '12px', color: C.fg2, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  tag: tagBase,
  tagOld: { ...tagBase, marginLeft: '4px', border: DASH },
  dotOk: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', flex: 'none', background: C.success },
  dotBad: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', flex: 'none', background: C.error },
  readonlyLine: { margin: 0, fontSize: '12px', color: C.fg2 },
  skeleton: { height: '76px', flex: 'none', borderRadius: '20px', background: C.bg2, border: HAIR },
  empty: {
    textAlign: 'center',
    padding: '24px 12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
  },
  banner: bannerBase,
  bannerError: { ...bannerBase, border: `0.5px solid ${C.error}` },
  bannerTxt: { flex: 1, minWidth: 0 },
  mark: markBase,
  markError: { ...markBase, border: `0.5px solid ${C.error}`, color: C.error },

  /* ---------- forms ---------- */
  field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  label: { fontSize: '13px', fontWeight: 500, color: C.fg },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '12px' },
  input: {
    height: '32px',
    boxSizing: 'border-box',
    padding: '0 10px',
    borderRadius: '8px',
    border: HAIR,
    background: C.bg1,
    color: C.fg,
    width: '100%',
    minWidth: 0,
    fontSize: '13px',
    fontFamily: 'inherit',
  },
  inputInvalid: { borderColor: C.error },
  inputDisabled: { color: C.fg2, background: C.bg2, cursor: 'not-allowed' },
  inputSm: { height: '28px' },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '16px',
    border: HAIR,
  },
  sectionTitle: { fontSize: '13px', fontWeight: 500 },
  check: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' },
  checkDis: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', opacity: 0.45, cursor: 'not-allowed' },
  checkInput: { margin: 0, accentColor: C.fill },

  /* switch: the knob is a child element (spec E) */
  switchBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    border: 0,
    background: 'none',
    padding: 0,
    fontSize: '13px',
    color: C.fg,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  switchTrack: trackBase,
  switchTrackOn: { ...trackBase, background: C.fill, border: `0.5px solid ${C.fill}` },
  switchKnob: knobBase,
  switchKnobOn: { ...knobBase, left: '16px', background: C.onFill },

  /* chips */
  chips: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' },
  chip: chipBase,
  chipOn: { ...chipBase, border: '0.5px solid transparent', background: C.fill, color: C.onFill },
  chipInherit: { ...chipBase, border: DASH, cursor: 'default' },
  chipSm: { height: '24px', padding: '0 8px', fontSize: '12px' },

  /* ---------- effort rail ---------- */
  railRow: { display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' },
  railWrap: { display: 'inline-flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' },
  railGrp: { display: 'flex', flexDirection: 'column', gap: '2px' },
  railCap: { fontSize: '11px', lineHeight: '14px', color: C.fg2, paddingLeft: '4px', minHeight: '14px' },
  rail: {
    display: 'flex',
    height: '32px',
    boxSizing: 'border-box',
    padding: '2px',
    borderRadius: '8px',
    background: C.bg2,
    border: `0.5px solid ${C.line1}`,
  },
  railNode: {
    width: '64px',
    height: '28px',
    flex: 'none',
    boxSizing: 'border-box',
    padding: 0,
    marginLeft: '3px',
    fontSize: '13px',
    border: HAIR,
    background: 'transparent',
    color: C.fg2,
    borderRadius: '6px',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  railNodeOn: { background: C.fill, color: C.onFill, borderColor: 'transparent' },
  railMarks: { display: 'flex', padding: '0 2px', height: '14px' },
  railMark: { width: '64px', flex: 'none', marginLeft: '3px', textAlign: 'center', fontSize: '11px', lineHeight: '14px', color: C.fg2 },
  railLink: { marginBottom: '18px' },

  /* ---------- model table (CSS grid + ARIA, subgrid rows) ---------- */
  mtable: {
    border: HAIR,
    borderRadius: '16px',
    padding: '0 12px',
    display: 'grid',
    gridTemplateColumns: '24px minmax(120px,1.6fr) minmax(100px,1fr) minmax(64px,1.2fr) minmax(104px,max-content) max-content',
    columnGap: '8px',
  },
  mrow: { ...mrowBase, borderTop: HAIR },
  mrowHdr: { ...mrowBase, padding: '6px 0', fontSize: '12px', color: C.fg2 },
  cell: { minWidth: 0 },
  selcell: { display: 'flex', alignItems: 'center', justifyContent: 'flex-start', minWidth: 0 },
  mid: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mname: { fontSize: '12px', color: C.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sum: { color: C.fg2, minWidth: 0 },
  think: { color: C.fg2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  capCell: { minWidth: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' },
  capEx: { color: C.fg },
  capInh: { color: C.fg2 },
  capBad: { color: C.error },
  capSlash: { color: C.fg2, whiteSpace: 'pre' },
  ops: { display: 'flex', gap: '4px', justifyContent: 'flex-end', minWidth: 0 },
  mfoot: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: HAIR },
  seltool: { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '28px' },
  selcount: { fontSize: '14px', fontWeight: 500, lineHeight: '22px', fontVariantNumeric: 'tabular-nums' },
  toast: { fontSize: '12px', color: C.fg2, display: 'flex', alignItems: 'center', gap: '8px' },

  /* ---------- capacity field ---------- */
  capline: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  capInput: { width: '140px', flex: 'none' },
  abbr: { fontSize: '12px', color: C.fg2, fontVariantNumeric: 'tabular-nums' },

  /* ---------- row menu ---------- */
  menu: {
    position: 'fixed',
    zIndex: 2,
    minWidth: '132px',
    boxSizing: 'border-box',
    padding: '4px',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '12px',
    background: C.bg1,
    border: HAIR,
    overflowY: 'auto',
  },
  menuItem: {
    flex: 'none',
    textAlign: 'left',
    height: '30px',
    padding: '0 10px',
    border: 0,
    background: 'transparent',
    borderRadius: '6px',
    fontSize: '13px',
    color: C.fg,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  menuSep: { flex: 'none', border: 0, borderTop: HAIR, margin: '4px 0', width: '100%' },

  /* ---------- bulk ---------- */
  bradios: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px' },
  bsrc: { display: 'flex', flexDirection: 'column', gap: '4px' },
  bulkfoot: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 16px',
    borderTop: HAIR,
    background: C.bg1,
  },
  bsum: { flex: 1, minWidth: 0, margin: 0, fontSize: '13px', lineHeight: '20px', color: C.fg2 },
  bsumErr: { flex: 1, minWidth: 0, margin: 0, fontSize: '13px', lineHeight: '20px', color: C.error },

  /* ---------- spelling rows ---------- */
  spell: { display: 'grid', gridTemplateColumns: '64px minmax(0,1fr) auto auto', gap: '8px', alignItems: 'center' },
  spellLvl: { fontSize: '13px', color: C.fg2 },

  /* ---------- wizard ---------- */
  steps: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', color: C.fg2, listStyle: 'none', margin: 0, padding: 0 },
  step: { display: 'flex', alignItems: 'center', gap: '6px' },
  stepCur: { display: 'flex', alignItems: 'center', gap: '6px', color: C.fg, fontWeight: 500 },
  stepN: stepNBase,
  stepNOn: { ...stepNBase, border: '0.5px solid transparent', background: C.fill, color: C.onFill },
  stepLine: { display: 'inline-block', width: '24px', height: 0, borderTop: HAIR },
  fieldset: { border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  optcard: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px', cursor: 'pointer' },
  optcardSel: { borderColor: C.fg },

  /* ---------- preview ---------- */
  diff: {
    margin: 0,
    padding: '12px 14px',
    fontFamily: MONO,
    fontSize: '12px',
    lineHeight: '18px',
    whiteSpace: 'pre',
    overflowX: 'auto',
    borderRadius: '12px',
    background: C.bg2,
    border: HAIR,
    color: C.fg,
  },

  /* ---------- dialog body ---------- */
  dlgBody: { display: 'flex', flexDirection: 'column', gap: '12px' },
  dlgDesc: { margin: 0, fontSize: '13px', lineHeight: '20px', color: C.fg2 },
  dlgActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
});

/** Merge style objects left to right; falsy entries are skipped. */
export function sx(...parts: Array<S | false | null | undefined | '' | 0>): S {
  return Object.assign({}, ...parts.filter(Boolean));
}
