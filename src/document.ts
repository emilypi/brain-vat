import { z } from 'zod';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const EXAMPLE_URL = 'https://arxiv.org/pdf/2611.02451v1';
export const EXAMPLE_HASH =
  '0a59c345fad3c15d6dd909250956b186f8526ee3414064d0b890101fb8232ad7';

const pointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

export const anchorSchema = z.object({
  documentId: z.string().regex(/^[a-f0-9]{64}$/),
  pageIndex: z.number().int().nonnegative(),
  kind: z.enum(['text', 'region']),
  quote: z.string().max(20000),
  quads: z
    .array(z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]))
    .min(1)
    .max(500),
});

export type Anchor = z.infer<typeof anchorSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Quad = Anchor['quads'][number];
export type Transform = readonly [number, number, number, number, number, number];
export type PageBox = readonly [number, number, number, number];

export interface Paper {
  id: string;
  title: string;
  filename: string;
  sourceUrl: string | null;
  bytes: ArrayBuffer;
  addedAt: string;
  pageCount: number;
}

export interface Highlight {
  id: string;
  anchor: Anchor;
  note: string;
  createdAt: string;
}

export interface PaperPassage {
  pageIndex: number;
  text: string;
}

export interface Evidence {
  pageIndex: number;
  excerpt: string;
  label: string;
}

/** Invert the PDF viewport so anchors are independent of zoom and rotation. */
export function viewportToPoint(
  x: number,
  y: number,
  transform: Transform,
  box: PageBox,
): Point {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new Error('The page transform is not invertible.');
  }
  const px = (d * (x - e) - c * (y - f)) / determinant;
  const py = (-b * (x - e) + a * (y - f)) / determinant;
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  if (width <= 0 || height <= 0) throw new Error('Invalid PDF page bounds.');
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return { x: clamp((px - box[0]) / width), y: clamp((box[3] - py) / height) };
}

/** Project a canonical CropBox point into the current viewport. */
export function pointToViewport(
  point: Point,
  transform: Transform,
  box: PageBox,
): Point {
  const x = box[0] + point.x * (box[2] - box[0]);
  const y = box[3] - point.y * (box[3] - box[1]);
  const [a, b, c, d, e, f] = transform;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

export function rectToQuad(
  rect: { left: number; top: number; right: number; bottom: number },
  transform: Transform,
  box: PageBox,
): Quad {
  return [
    viewportToPoint(rect.left, rect.top, transform, box),
    viewportToPoint(rect.right, rect.top, transform, box),
    viewportToPoint(rect.right, rect.bottom, transform, box),
    viewportToPoint(rect.left, rect.bottom, transform, box),
  ];
}

/** Accept explicit web URLs; arXiv abstract links become PDF links. */
export function parsePaperUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS link without embedded credentials.');
  }
  if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') {
    url.hostname = 'arxiv.org';
    url.protocol = 'https:';
    url.pathname = url.pathname.replace(/^\/abs\//, '/pdf/');
    url.search = '';
  }
  url.hash = '';
  return url.href;
}

export async function identifyPdf(bytes: ArrayBuffer): Promise<string> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('Choose a PDF under 25 MB.');
  const header = new TextDecoder().decode(bytes.slice(0, 1024));
  if (!header.includes('%PDF-')) throw new Error('This file is not a PDF.');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join(
    '',
  );
}

const STOP_WORDS = new Set([
  'what',
  'which',
  'where',
  'when',
  'does',
  'this',
  'that',
  'with',
  'from',
  'about',
  'explain',
  'paper',
  'have',
  'there',
  'their',
  'would',
  'could',
]);

/** Deterministic evidence lookup, deliberately separate from generated answers. */
export function findEvidence(query: string, pages: PaperPassage[]): Evidence[] {
  const terms = [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  ].filter((term) => !STOP_WORDS.has(term));
  if (terms.length === 0) return [];
  return pages
    .map((page) => {
      const lower = page.text.toLowerCase();
      const matches = terms.filter((term) => lower.includes(term));
      const index = matches.length ? lower.indexOf(matches[0] ?? '') : -1;
      const start = Math.max(0, index - 120);
      return {
        pageIndex: page.pageIndex,
        score: matches.length,
        excerpt: (start > 0 ? '…' : '') + page.text.slice(start, start + 600),
        label: 'This paper',
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}
