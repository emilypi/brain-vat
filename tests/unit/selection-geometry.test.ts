import { describe, expect, test } from 'vitest';
import { adjustRectangle, rectangle, wordsInside } from '../../src/selection-geometry';

describe('precision selection geometry', () => {
  const page = { width: 600, height: 800 };
  const rect = { left: 10, top: 20, right: 110, bottom: 70 };
  test('normalizes dragging from any corner', () => {
    expect(rectangle({ x: 110, y: 20 }, { x: 10, y: 70 })).toEqual(rect);
  });
  test('keeps a moved selection within the page without changing its size', () => {
    expect(adjustRectangle(rect, 'move', { x: -100, y: 900 }, page)).toEqual({
      left: 0,
      top: 750,
      right: 100,
      bottom: 800,
    });
  });
  test.each(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const)(
    'keeps the %s handle from crossing the opposite edge',
    (handle) => {
      for (const direction of [-1, 1]) {
        const next = adjustRectangle(
          rect,
          handle,
          {
            x: direction * 1000,
            y: direction * 1000,
          },
          page,
        );
        expect(next.left).toBeGreaterThanOrEqual(0);
        expect(next.top).toBeGreaterThanOrEqual(0);
        expect(next.right).toBeLessThanOrEqual(page.width);
        expect(next.bottom).toBeLessThanOrEqual(page.height);
        expect(next.right - next.left).toBeGreaterThanOrEqual(2);
        expect(next.bottom - next.top).toBeGreaterThanOrEqual(2);
      }
    },
  );
  test('ignores a neighboring column and a barely touched line', () => {
    const words = [
      { text: 'Selected', rect: { left: 15, top: 30, right: 80, bottom: 45 } },
      { text: 'Other column', rect: { left: 120, top: 30, right: 190, bottom: 45 } },
      { text: 'Next line', rect: { left: 15, top: 68, right: 80, bottom: 85 } },
    ];
    expect(wordsInside(words, rect).map((word) => word.text)).toEqual(['Selected']);
  });
});
