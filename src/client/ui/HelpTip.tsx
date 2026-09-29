/**
 * "?" toggletip next to a form label (v2.10).
 *
 * - The button keeps focus; the text appears inside an always-present
 *   `role="status"` region, so screen readers read it when it opens.
 * - The bubble is `position: fixed` at the button, so the dialog's
 *   `overflow: auto` does not clip it and its size does not change. It opens
 *   below the button and flips above when there is no room (placeHelpBubble).
 * - It closes on a second click, Escape, a pointer down outside it, focus
 *   leaving it, or a scroll of the dialog (which would move the button away).
 *   Escape closes only the bubble: it is handled in the window capture phase,
 *   before the dialog's document-level handler (Modal.tsx) and the host
 *   settings dialog, which both skip events whose defaultPrevented is set.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { observeComposition } from './composition-guard';

// Layout effect in the browser (place before paint); plain effect for SSR tests.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Distance between the button and the bubble. */
export const HELP_BUBBLE_GAP = 6;
/** Minimum distance between the bubble and the viewport edges. */
export const HELP_BUBBLE_MARGIN = 8;
/** Bubble width; narrower viewports use their width minus both margins. */
const HELP_BUBBLE_WIDTH = 340;

export interface HelpBubblePlacement {
  side: 'below' | 'above';
  top: number;
  left: number;
  /** Height available on the chosen side; taller content scrolls. */
  maxHeight: number;
}

/** Where the bubble goes, in viewport coordinates (for position: fixed). */
export function placeHelpBubble(
  anchor: { top: number; bottom: number; left: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): HelpBubblePlacement {
  const below = viewport.height - anchor.bottom - HELP_BUBBLE_GAP - HELP_BUBBLE_MARGIN;
  const above = anchor.top - HELP_BUBBLE_GAP - HELP_BUBBLE_MARGIN;
  const side = bubble.height <= below || below >= above ? 'below' : 'above';
  const maxHeight = Math.max(0, side === 'below' ? below : above);
  const height = Math.min(bubble.height, maxHeight);
  const top = side === 'below' ? anchor.bottom + HELP_BUBBLE_GAP : anchor.top - HELP_BUBBLE_GAP - height;
  const left = Math.max(HELP_BUBBLE_MARGIN, Math.min(anchor.left, viewport.width - HELP_BUBBLE_MARGIN - bubble.width));
  return { side, top, left, maxHeight };
}

const rootStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center' };

// 24×24 hit area around a 16px circle; the negative margin keeps the label row height.
const buttonStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  margin: '-4px 0',
  padding: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
};

function glyphStyle(open: boolean): React.CSSProperties {
  const tone = open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    boxSizing: 'border-box',
    borderRadius: '50%',
    border: `1px solid ${open ? tone : 'var(--dsw-alias-border-l3)'}`,
    color: tone,
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: 1,
  };
}

function bubbleStyle(placement: HelpBubblePlacement | null): React.CSSProperties {
  return {
    position: 'fixed',
    top: placement ? `${placement.top}px` : 0,
    left: placement ? `${placement.left}px` : 0,
    maxHeight: placement ? `${placement.maxHeight}px` : undefined,
    // Hidden only for the measuring pass inside the layout effect (never painted).
    visibility: placement ? 'visible' : 'hidden',
    zIndex: 1,
    boxSizing: 'border-box',
    width: `min(${HELP_BUBBLE_WIDTH}px, calc(100vw - ${2 * HELP_BUBBLE_MARGIN}px))`,
    overflowY: 'auto',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    // The theme has no shadow token; its translucent mask colour works in both themes.
    boxShadow: '0 4px 16px var(--dsw-alias-bg-mask-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 400,
    textAlign: 'left',
    outline: 'none',
  };
}

export interface HelpTipProps {
  /** Accessible name of the "?" button, e.g. "Background Mode 说明". */
  label: string;
  children: React.ReactNode;
}

export function HelpTip({ label, children }: HelpTipProps) {
  const bubbleId = useId();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<HelpBubblePlacement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Measure the natural size, then place; re-place when the window resizes.
  useIsomorphicLayoutEffect(() => {
    const button = buttonRef.current;
    const bubble = bubbleRef.current;
    const view = button?.ownerDocument.defaultView;
    if (!open || !button || !bubble || !view) return;
    const place = () => {
      const height = bubble.scrollHeight + bubble.offsetHeight - bubble.clientHeight;
      setPlacement(placeHelpBubble(
        button.getBoundingClientRect(),
        { width: bubble.offsetWidth, height },
        { width: view.innerWidth, height: view.innerHeight },
      ));
    };
    place();
    view.addEventListener('resize', place);
    return () => view.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    const root = rootRef.current;
    const doc = root?.ownerDocument;
    const view = doc?.defaultView;
    if (!open || !root || !doc || !view) return;
    // Same IME rules as the dialog: the Escape that cancels a candidate is not ours.
    const composition = observeComposition(doc, view);
    const onKeyDown = (event: KeyboardEvent) => {
      const composing = composition.guards(event);
      if (event.key !== 'Escape' || composing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) close(false);
    };
    const onScroll = (event: Event) => {
      if (!bubbleRef.current?.contains(event.target as Node)) close(false);
    };
    view.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('scroll', onScroll, true);
    return () => {
      view.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('scroll', onScroll, true);
      composition.dispose();
    };
  }, [open]);

  // Clicking inside the bubble focuses it (tabIndex -1), which stays inside the root.
  const onBlur = (event: React.FocusEvent) => {
    if (open && !rootRef.current?.contains(event.relatedTarget as Node | null)) close(false);
  };

  return (
    <div ref={rootRef} style={rootStyle} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={bubbleId}
        onClick={() => (open ? close(false) : setOpen(true))}
        style={buttonStyle}
      >
        <span aria-hidden="true" style={glyphStyle(open)}>?</span>
      </button>
      <div id={bubbleId} role="status">
        {open && (
          <div ref={bubbleRef} tabIndex={-1} data-help-bubble="" style={bubbleStyle(placement)}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
