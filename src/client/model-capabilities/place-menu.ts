import type { DOMRectLike } from './types';

export function placeMenu(
  modal: DOMRectLike,
  button: DOMRectLike,
  menu: { width: number; height: number },
): { left: number; top: number; maxHeight?: number } {
  const inset = 8;
  const leftEdge = modal.left + inset;
  const rightEdge = modal.right - inset;
  const topEdge = modal.top + inset;
  const bottomEdge = modal.bottom - inset;
  const left = Math.min(Math.max(button.right - menu.width, leftEdge), rightEdge - menu.width);
  const below = button.bottom + 4;
  if (below + menu.height <= bottomEdge) return { left, top: below };
  const above = button.top - 4 - menu.height;
  if (above >= topEdge) return { left, top: above };
  const aboveSpace = button.top - 4 - topEdge;
  const maxHeight = aboveSpace >= 96 ? aboveSpace : bottomEdge - topEdge;
  return { left, top: topEdge, maxHeight };
}
