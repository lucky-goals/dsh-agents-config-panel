/**
 * Focus helpers for the plugin's in-panel dialog.
 *
 * The selector mirrors the Harness modal layer
 * (@deepseek-ai/dsh-client-ui-primitives useModalLayer) so keyboard traversal
 * behaves the same as the host settings dialog around it. The plugin cannot
 * import that package, so the rules are reproduced here.
 */

export const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';

/** Focusable descendants in document order, skipping inert/hidden subtrees. */
export function focusableWithin(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.closest('[inert], [hidden]'),
  );
}

/**
 * Where Tab / Shift+Tab should move focus inside a dialog, wrapping at both
 * ends. Returns null when the dialog has no focusable items (the caller then
 * keeps focus on the dialog element itself).
 */
export function nextFocusTarget<T>(items: readonly T[], active: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const index = active === null ? -1 : items.indexOf(active);
  if (index === -1) return backwards ? items[items.length - 1] : items[0];
  const next = backwards ? index - 1 : index + 1;
  return items[(next + items.length) % items.length];
}

/** Initial focus: an explicit data-modal-autofocus control, else the first focusable item. */
export function initialFocusTarget(container: Element): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-modal-autofocus]') ?? focusableWithin(container)[0] ?? null;
}
