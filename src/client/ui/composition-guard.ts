/**
 * IME composition guard for dialog keyboard handling.
 *
 * Mirrors the Harness modal layer's `observeComposition`
 * (@deepseek-ai/dsh-client-ui-primitives lib/index.js:3558-3593) and the way
 * `useModalLayer` consults it before any key handling (same file :3689-3690;
 * the settings dialog wires it at dsh-client-ui-settings-general
 * lib/client.js:275). The plugin cannot import that package, so the rules are
 * reproduced here:
 *
 * - keys pressed while a composition is active are ignored;
 * - the first keydown right after `compositionend` is ignored (Safari fires
 *   the Escape that cancels a candidate after the composition ends);
 * - `event.isComposing` and `keyCode === 229` are ignored;
 * - `keyup` clears the "just ended" flag; window blur resets both flags.
 */

/** Minimal event-target shape so tests can use Node's EventTarget without a DOM library. */
export interface ListenerTarget {
  addEventListener(type: string, listener: (event: any) => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: { capture?: boolean }): void;
}

export interface CompositionKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
}

export interface CompositionGuard {
  /** True when this keydown belongs to (or directly follows) an IME composition. Consumes the "just ended" flag. */
  guards(event: CompositionKeyEvent): boolean;
  dispose(): void;
}

export function observeComposition(doc: ListenerTarget, view?: ListenerTarget | null): CompositionGuard {
  let composing = false;
  let ended = false;
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
    ended = true;
  };
  const release = () => {
    ended = false;
  };
  const blur = () => {
    composing = false;
    ended = false;
  };
  // `{ capture: true }` rather than the boolean form: identical in browsers,
  // and Node's EventTarget only matches the object form on removal.
  const capture = { capture: true };
  doc.addEventListener('compositionstart', start, capture);
  doc.addEventListener('compositionend', end, capture);
  doc.addEventListener('keyup', release, capture);
  view?.addEventListener('blur', blur);
  return {
    guards(event) {
      const guarded = composing || ended || event.isComposing === true || event.keyCode === 229;
      ended = false;
      return guarded;
    },
    dispose() {
      doc.removeEventListener('compositionstart', start, capture);
      doc.removeEventListener('compositionend', end, capture);
      doc.removeEventListener('keyup', release, capture);
      view?.removeEventListener('blur', blur);
    },
  };
}
