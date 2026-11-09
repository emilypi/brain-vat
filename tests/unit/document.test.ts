import { describe, expect, it } from 'vitest';
import {
  anchorSchema,
  findEvidence,
  identifyPdf,
  parsePaperUrl,
  pointToViewport,
  rectToQuad,
  viewportToPoint,
} from '../../src/document';
import type { PageBox, Transform } from '../../src/document';

const BOX: PageBox = [10, 20, 610, 820];

describe('source geometry', () => {
  it.each<Transform>([
    [1, 0, 0, -1, -10, 820],
    [2, 0, 0, -2, -20, 1640],
    [0, 1, 1, 0, -20, -10],
    [-1, 0, 0, 1, 610, -20],
  ])('round trips CropBox coordinates through rotation and zoom', (...matrix) => {
    const canonical = { x: 0.25, y: 0.75 };
    const rendered = pointToViewport(canonical, matrix, BOX);
    const result = viewportToPoint(rendered.x, rendered.y, matrix, BOX);
    expect(result.x).toBeCloseTo(canonical.x);
    expect(result.y).toBeCloseTo(canonical.y);
  });

  it('keeps the same region when displayed at double scale', () => {
    const quad = rectToQuad(
      { left: 60, top: 80, right: 180, bottom: 160 },
      [1, 0, 0, -1, -10, 820],
      BOX,
    );
    expect(quad[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(pointToViewport(quad[2], [2, 0, 0, -2, -20, 1640], BOX)).toEqual({
      x: 360,
      y: 320,
    });
  });

  it('rejects a singular transform', () => {
    expect(() => viewportToPoint(0, 0, [0, 0, 0, 0, 0, 0], BOX)).toThrow(
      'not invertible',
    );
  });
});

describe('external inputs', () => {
  it('normalizes arXiv abstract URLs', () => {
    expect(parsePaperUrl('https://arxiv.org/abs/2611.02451v1#page=2')).toBe(
      'https://arxiv.org/pdf/2611.02451v1',
    );
  });

  it.each(['javascript:alert(1)', 'file:///tmp/paper.pdf', 'https://a:b@host/'])(
    'rejects an unsafe URL %s',
    (url) => {
      expect(() => parsePaperUrl(url)).toThrow();
    },
  );

  it('identifies documents by their bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nexample').buffer;
    expect(await identifyPdf(bytes)).toBe(await identifyPdf(bytes.slice(0)));
    expect(await identifyPdf(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects non-PDF bytes', async () => {
    await expect(
      identifyPdf(new TextEncoder().encode('<html>').buffer),
    ).rejects.toThrow('not a PDF');
  });

  it('rejects coordinates outside the document', () => {
    expect(
      anchorSchema.safeParse({
        documentId: 'a'.repeat(64),
        pageIndex: 0,
        kind: 'region',
        quote: '',
        quads: [
          [
            { x: 2, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        ],
      }).success,
    ).toBe(false);
  });
});

it('returns actual matching passages without inventing an answer', () => {
  const results = findEvidence('What is convolution?', [
    { pageIndex: 0, text: 'Introduction to vectorization.' },
    { pageIndex: 1, text: 'Convolution computes a sliding weighted sum.' },
  ]);
  expect(results).toEqual([
    {
      pageIndex: 1,
      score: 1,
      excerpt: 'Convolution computes a sliding weighted sum.',
      label: 'This paper',
    },
  ]);
  expect(findEvidence('unmentioned', [])).toEqual([]);
});
