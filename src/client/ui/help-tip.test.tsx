/**
 * v2.10 HelpTip: bubble placement (pure) and the closed markup (SSR).
 * Opening, Escape, outside clicks and the on-screen geometry run in a real
 * browser (E2E_BROWSER_V210).
 */
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { HELP_BUBBLE_GAP, HELP_BUBBLE_MARGIN, HelpTip, placeHelpBubble } from './HelpTip';

const VIEWPORT = { width: 1440, height: 900 };
/** A 24×24 "?" button at (x, y). */
const button = (x: number, y: number) => ({ left: x, top: y, right: x + 24, bottom: y + 24 });

describe('placeHelpBubble (v2.10)', () => {
  it('opens below the button, left edges aligned, when it fits', () => {
    expect(placeHelpBubble(button(600, 300), { width: 340, height: 200 }, VIEWPORT)).toEqual({
      side: 'below',
      top: 324 + HELP_BUBBLE_GAP,
      left: 600,
      maxHeight: 900 - 324 - HELP_BUBBLE_GAP - HELP_BUBBLE_MARGIN,
    });
  });

  it('flips above when there is not enough room below but enough above', () => {
    const placed = placeHelpBubble(button(600, 700), { width: 340, height: 300 }, VIEWPORT);
    expect(placed.side).toBe('above');
    expect(placed.top + 300).toBe(700 - HELP_BUBBLE_GAP); // bottom edge GAP above the button
    expect(placed.maxHeight).toBe(700 - HELP_BUBBLE_GAP - HELP_BUBBLE_MARGIN);
  });

  it('when neither side fits, takes the larger side and caps the height to it (the bubble scrolls)', () => {
    expect(placeHelpBubble(button(100, 150), { width: 340, height: 500 }, { width: 800, height: 400 })).toEqual({
      side: 'below',
      top: 174 + HELP_BUBBLE_GAP,
      left: 100,
      maxHeight: 400 - 174 - HELP_BUBBLE_GAP - HELP_BUBBLE_MARGIN,
    });
  });

  it('stays inside the viewport horizontally, including a 390px phone', () => {
    expect(placeHelpBubble(button(1300, 300), { width: 340, height: 200 }, VIEWPORT).left).toBe(1440 - HELP_BUBBLE_MARGIN - 340);
    const phone = { width: 390, height: 844 };
    expect(placeHelpBubble(button(200, 300), { width: 340, height: 200 }, phone).left).toBe(390 - HELP_BUBBLE_MARGIN - 340);
    expect(placeHelpBubble(button(2, 300), { width: 340, height: 200 }, phone).left).toBe(HELP_BUBBLE_MARGIN);
    // Wider than the viewport: still starts at the margin.
    expect(placeHelpBubble(button(200, 300), { width: 400, height: 200 }, phone).left).toBe(HELP_BUBBLE_MARGIN);
  });
});

describe('HelpTip closed markup (v2.10)', () => {
  const html = renderToString(<HelpTip label="Background Mode 说明"><p>说明内容</p></HelpTip>);
  const tag = html.match(/<button([^>]*)>/)?.[1] ?? '';

  it('is a plain button with a name, collapsed, controlling a status region that is empty while closed', () => {
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-label="Background Mode 说明"');
    expect(tag).toContain('aria-expanded="false"');
    const controls = tag.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    // Always in the DOM, so screen readers announce the text when it opens.
    expect(html).toContain(`<div id="${controls}" role="status"></div>`);
    expect(html).not.toContain('说明内容');
  });

  it('shows a "?" that screen readers skip (the button has its own name)', () => {
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>\?<\/span>/);
  });

  it('has a 24×24 hit area that does not make the label row taller', () => {
    expect(tag).toContain('width:24px;height:24px;margin:-4px 0');
  });
});
