/**
 * place-menu.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * 几何规则照原型 placeMenu：安全区内收 8px；水平右缘对齐按钮并夹在安全区内；
 * 垂直优先下方（+4）、其次上方（−4），都放不下就贴顶并限高。
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it } from 'vitest';
import { placeMenu } from './place-menu';
import type { DOMRectLike } from './types';

/** 模态矩形 1000×800 → 安全区 l=8 r=992 t=8 b=792 */
const modal: DOMRectLike = { left: 0, right: 1000, top: 0, bottom: 800 };

function btn(left: number, right: number, top: number, bottom: number): DOMRectLike {
  return { left, right, top, bottom };
}

describe('placeMenu', () => {
  it('Given 下方放得下 When placeMenu Then top=按钮底+4，左缘按右缘对齐后夹进安全区，不限高', () => {
    const out = placeMenu(modal, btn(100, 140, 100, 120), { width: 200, height: 100 });
    expect(out.top).toBe(124);
    expect(out.left).toBe(8);
    expect(out.maxHeight).toBeUndefined();
  });

  it('Given 下方不够、上方够 When placeMenu Then top=按钮顶−4−菜单高度，左缘右对齐按钮', () => {
    const out = placeMenu(modal, btn(900, 960, 700, 720), { width: 200, height: 100 });
    expect(out.top).toBe(596);
    expect(out.left).toBe(760);
    expect(out.maxHeight).toBeUndefined();
  });

  it('Given 上下都放不下、上方空间 ≥96 When placeMenu Then 贴顶且 maxHeight=上方空间', () => {
    const out = placeMenu(modal, btn(100, 140, 400, 420), { width: 200, height: 600 });
    expect(out.top).toBe(8);
    expect(out.left).toBe(8);
    expect(out.maxHeight).toBe(388);
  });

  it('Given 上下都放不下、上方空间 <96 When placeMenu Then 贴顶且 maxHeight=整段安全区高度', () => {
    const out = placeMenu(modal, btn(100, 140, 60, 80), { width: 200, height: 800 });
    expect(out.top).toBe(8);
    expect(out.maxHeight).toBe(784);
  });

  it('Given 菜单宽度让右缘越过安全区 When placeMenu Then 夹到安全区右缘', () => {
    const out = placeMenu(modal, btn(950, 1010, 100, 120), { width: 200, height: 100 });
    expect(out.left).toBe(792);
  });

  it('Given 菜单宽度让左缘越过安全区 When placeMenu Then 夹到安全区左缘', () => {
    const out = placeMenu(modal, btn(0, 20, 100, 120), { width: 300, height: 100 });
    expect(out.left).toBe(8);
  });

  it('Given 按钮贴近安全区右缘、菜单更窄 When placeMenu Then 右缘与按钮右缘对齐', () => {
    const out = placeMenu(modal, btn(700, 980, 100, 120), { width: 120, height: 100 });
    expect(out.left).toBe(860);
    expect(out.top).toBe(124);
  });
});
