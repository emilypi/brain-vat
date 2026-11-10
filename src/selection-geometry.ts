import type { Point } from './document';

export type SelectionMode = 'text' | 'region' | null;
export type SelectionHandle =
  'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface SelectionWord {
  text: string;
  rect: SelectionRect;
}

export function rectangle(start: Point, end: Point): SelectionRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

/** Clamp an edit to the page without letting resize handles invert their edges. */
export function adjustRectangle(
  rect: SelectionRect,
  handle: SelectionHandle,
  delta: Point,
  page: { width: number; height: number },
): SelectionRect {
  const clamp = (value: number, low: number, high: number): number =>
    Math.max(low, Math.min(high, value));
  if (handle === 'move') {
    const x = clamp(delta.x, -rect.left, page.width - rect.right);
    const y = clamp(delta.y, -rect.top, page.height - rect.bottom);
    return {
      left: rect.left + x,
      right: rect.right + x,
      top: rect.top + y,
      bottom: rect.bottom + y,
    };
  }
  return {
    left: handle.includes('w')
      ? clamp(rect.left + delta.x, 0, rect.right - 2)
      : rect.left,
    right: handle.includes('e')
      ? clamp(rect.right + delta.x, rect.left + 2, page.width)
      : rect.right,
    top: handle.includes('n')
      ? clamp(rect.top + delta.y, 0, rect.bottom - 2)
      : rect.top,
    bottom: handle.includes('s')
      ? clamp(rect.bottom + delta.y, rect.top + 2, page.height)
      : rect.bottom,
  };
}

/** Select words by their centers, so brushing a neighboring line does not grab it. */
export function wordsInside(
  words: SelectionWord[],
  rect: SelectionRect,
): SelectionWord[] {
  return words.filter(({ rect: word }) => {
    const x = (word.left + word.right) / 2;
    const y = (word.top + word.bottom) / 2;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
}

/** Use rendered word geometry rather than PDF text-stream selection order. */
export function readSelectionWords(layer: HTMLElement): SelectionWord[] {
  const bounds = layer.getBoundingClientRect();
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const words: SelectionWord[] = [];
  let node = walker.nextNode();
  while (node) {
    for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        words.push({
          text: match[0],
          rect: {
            left: rect.left - bounds.left,
            top: rect.top - bounds.top,
            right: rect.right - bounds.left,
            bottom: rect.bottom - bounds.top,
          },
        });
      }
    }
    node = walker.nextNode();
  }
  return words;
}
