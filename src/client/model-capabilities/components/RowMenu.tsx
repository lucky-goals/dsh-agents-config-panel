/**
 * Row menu of a pi-ai model (prototype rowMenuHTML / placeMenu / keyboard).
 *
 * position:fixed, appended at the end of the panel root. After layout it
 * measures the safe area (closest [role=dialog], else the panel root), the
 * 「···」 button and itself, and asks placeMenu for left/top/maxHeight.
 * Scroll or resize closes it and returns focus to the button. ArrowUp/Down
 * cycle over enabled items, Home/End jump, Escape/Tab close.
 */
import React, { useEffect, useRef, useState } from 'react';
import { NS_PI } from '../types';
import type { DOMRectLike, McSnapshot, ModelCapabilitiesStore } from '../types';
import { placeMenu } from '../place-menu';
import { C, mcStyles as s, sx } from '../styles';
import { useIsoLayoutEffect } from './shared';

export interface RowMenuProps {
  snap: McSnapshot;
  store: ModelCapabilitiesStore;
  anchor: HTMLElement | null;
}

const rect = (r: DOMRect): DOMRectLike => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });

export function RowMenu({ snap, store, anchor }: RowMenuProps): JSX.Element | null {
  const { ui } = snap;
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const idx = ui.menuIdx;
  const p = ui.route ? snap.draft.providers[ui.route] : undefined;
  const m = idx != null && p && p.ns === NS_PI ? p.models[idx] : undefined;
  const open = !!m && ui.view === 'detail' && !ui.edit && !ui.bulk && !ui.dialog;

  const close = (refocus: boolean) => {
    store.closeMenu();
    if (refocus) anchor?.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Measure and place; the first enabled item takes focus once placed.
  useIsoLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el || !anchor) return;
    const root = el.parentElement ?? el;
    const modalEl = (anchor.closest('[role="dialog"]') as HTMLElement | null) ?? root;
    el.style.maxHeight = '';
    const next = placeMenu(rect(modalEl.getBoundingClientRect()), rect(anchor.getBoundingClientRect()), {
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
    setPos(next);
    el.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [open, anchor, idx]);

  // Scroll (outside the menu) or resize closes; so does a pointer press elsewhere.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (menu.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      closeRef.current(true);
    };
    const onResize = () => closeRef.current(true);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || menu.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current(false);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, anchor]);

  if (!open || idx == null || !p || !m) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (!items.length) return;
    let i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = items.length - 1;
    else i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[i].focus({ preventScroll: true });
  };

  const item = (text: string, onClick: () => void, disabled = false, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      style={sx(s.menuItem, danger && { color: C.error }, disabled && { opacity: 0.4, cursor: 'not-allowed' })}
    >
      {text}
    </button>
  );

  const last = p.models.length - 1;
  return (
    <div
      ref={menu}
      id="mc-row-menu"
      role="menu"
      aria-label={`${m.id || '未命名模型'} 的操作`}
      onKeyDown={onKeyDown}
      style={sx(
        s.menu,
        pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: 0, top: 0, visibility: 'hidden' },
      )}
    >
      {item('复制', () => store.copyModel(idx))}
      {item('上移', () => store.moveModel(idx, -1), idx === 0)}
      {item('下移', () => store.moveModel(idx, 1), idx === last)}
      <hr role="separator" style={s.menuSep} />
      {item('删除', () => store.deleteModel(idx), false, true)}
    </div>
  );
}
