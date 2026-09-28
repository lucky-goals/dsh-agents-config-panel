/**
 * In-panel dialog drawn with --dsw-alias-* tokens.
 *
 * Keyboard and focus follow the Harness modal layer used by the host settings
 * dialog (dsh-client-ui-primitives useModalLayer):
 * - opening focuses [data-modal-autofocus] or the first focusable control;
 * - Tab / Shift+Tab cycle inside the dialog;
 * - Escape calls onClose, except during IME composition (isComposing,
 *   keyCode 229, or the first key after compositionend);
 * - closing returns focus to the element that was focused before opening.
 *
 * The host settings dialog registers its own document-level keydown handler
 * that closes the whole settings panel on Escape and traps Tab in the panel,
 * but it skips events whose defaultPrevented is set. This dialog therefore
 * listens in the capture phase and calls preventDefault on the keys it owns,
 * so Escape closes only this dialog and Tab stays inside it.
 *
 * The dialog renders inside the host panel rather than portaling to
 * document.body: the host panel is itself an aria-modal dialog whose Tab trap
 * would pull focus back out of a body-level portal.
 */
import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { focusableWithin, initialFocusTarget, nextFocusTarget } from './focus-trap';
import { observeComposition } from './composition-guard';

// Layout effect in the browser (focus before paint); plain effect for SSR tests.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Stacking: the host settings overlay is `position:fixed; z-index:1000` and its
 * panel is `z-index:1` inside that overlay (dsh-client-ui-settings-general
 * SettingsRoot CSS). Rendered within the panel, this dialog only has to sit
 * above sibling content, so it uses the same local step (1) rather than a
 * global value of its own.
 */
const LOCAL_LAYER = 1;

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: LOCAL_LAYER,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// Same mask token the host settings dialog uses for its own backdrop.
const maskStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1)',
};

const dialogStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: LOCAL_LAYER,
  boxSizing: 'border-box',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '10px',
  padding: '20px 24px',
  maxWidth: '560px',
  width: 'calc(100% - 48px)',
  maxHeight: '80vh',
  overflow: 'auto',
  outline: 'none',
};

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useIsomorphicLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || dialog === null) return;
    const doc = dialog.ownerDocument;
    const previous = doc.activeElement;

    (initialFocusTarget(dialog) ?? dialog).focus();

    // Same IME rules as the host modal layer; see composition-guard.ts.
    const composition = observeComposition(doc, doc.defaultView);

    const onKeyDown = (event: KeyboardEvent) => {
      // Consult the guard first on every keydown, as useModalLayer does, so the
      // "just ended" flag is consumed by exactly the next key.
      const composing = composition.guards(event);
      if (event.defaultPrevented || composing || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      const target = nextFocusTarget(focusableWithin(dialog), active, event.shiftKey);
      (target ?? dialog).focus();
    };

    // Capture phase: runs before the host's document-level bubble listener.
    doc.addEventListener('keydown', onKeyDown, true);
    return () => {
      doc.removeEventListener('keydown', onKeyDown, true);
      composition.dispose();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div style={maskStyle} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={dialogStyle}
      >
        <div id={titleId} style={{ fontSize: '15px', fontWeight: 500, marginBottom: '16px' }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}
