import { z } from 'zod';
import type { GeneratedAnswer, SourceEvidence } from './workspace-contract';

export interface TextReference {
  start: number;
  end: number;
  label: string;
  url: string | null;
  origin: SourceEvidence['origin'];
}

export interface PdfSource {
  id: string;
  rect: [number, number, number, number];
  url: string | null;
  destination: string | unknown[] | null;
  label: string;
}

const annotationSchema = z.object({
  id: z.string().optional(),
  subtype: z.literal('Link'),
  rect: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]),
  url: z.string().optional(),
  dest: z.union([z.string(), z.array(z.unknown())]).optional(),
});

export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Decode link data only; PDF actions and scripts are never evaluated. */
export function readLinkAnnotations(annotations: unknown[]): PdfSource[] {
  return annotations.slice(0, 200).flatMap((raw, index) => {
    const parsed = annotationSchema.safeParse(raw);
    if (!parsed.success) return [];
    const { rect, url, dest, id } = parsed.data;
    if (rect[0] === rect[2] || rect[1] === rect[3]) return [];
    const safeUrl = safeExternalUrl(url);
    const destination = dest ?? null;
    if (!safeUrl && !destination) return [];
    return [
      {
        id: id ?? 'annotation-' + index,
        rect,
        url: safeUrl,
        destination,
        label: safeUrl ? new URL(safeUrl).hostname : 'Linked passage in this paper',
      },
    ];
  });
}

/** Detect explicit identifiers without inventing bibliography metadata. */
export function findTextReferences(text: string): TextReference[] {
  const pattern = new RegExp(
    [
      String.raw`https:\/\/[^\s<>]+`,
      String.raw`\b10\.\d{4,9}\/[^\s<>]+`,
      String.raw`\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?`,
      String.raw`\[\d+(?:\s*[-–,]\s*\d+)*\]`,
    ].join('|'),
    'gi',
  );
  const references: TextReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const label = raw.replace(/[.,;:]+$/, '');
    let url: string | null = null;
    if (/^https:/i.test(label)) url = safeExternalUrl(label);
    else if (/^10\./.test(label)) url = safeExternalUrl('https://doi.org/' + label);
    else if (/^arxiv:/i.test(label)) {
      url = safeExternalUrl(
        'https://arxiv.org/abs/' + label.replace(/^arxiv:\s*/i, ''),
      );
    }
    if (!url && !label.startsWith('[')) continue;
    references.push({
      start: match.index,
      end: match.index + label.length,
      label,
      url,
      origin: 'citedReference',
    });
    if (references.length === 60) break;
  }
  return references;
}

export function sourceOriginLabel(origin: SourceEvidence['origin']): string {
  return {
    thisPaper: 'This paper',
    citedReference: 'Cited reference',
    externalSource: 'External source',
  }[origin];
}

/** A generated citation must resolve to one unique, usable evidence record. */
export function validateAnswerEvidence(
  answer: GeneratedAnswer,
  pageCount: number,
): string | null {
  const ids = new Set<string>();
  for (const source of answer.evidence) {
    if (!source.id || ids.has(source.id))
      return 'The answer contains duplicate sources.';
    ids.add(source.id);
    if (
      source.origin === 'thisPaper' &&
      (source.pageIndex === null ||
        !Number.isInteger(source.pageIndex) ||
        source.pageIndex < 0 ||
        source.pageIndex >= pageCount)
    )
      return 'A paper citation points to an unavailable page.';
    if (source.url !== null && !safeExternalUrl(source.url)) {
      return 'A source contains an unsupported link.';
    }
  }
  if (answer.blocks.some((block) => block.evidenceIds.some((id) => !ids.has(id)))) {
    return 'The answer refers to a source that was not returned.';
  }
  return null;
}
