import type { ProviderInput, SourceEvidence } from '../src/workspace-contract.ts';

const PASSAGE_CHARS = 2400;
const PAPER_CHARS = 60_000;
const MAX_REFERENCES = 20;

export interface SearchCitation {
  url: string;
  title: string;
  text: string;
  startIndex: number;
  endIndex: number;
}

/** Links are displayed to readers, never fetched by this module. */
export function safeSourceUrl(raw: string): string | null {
  if (raw.length > 2048) return null;
  if ([...raw].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
    return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function trimReference(raw: string): string {
  let value = raw.replace(/[.,;:]+$/, '');
  while (
    value.endsWith(')') &&
    (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)
  )
    value = value.slice(0, -1);
  return value;
}

function bibliography(pages: ProviderInput['pages']): SourceEvidence[] {
  const evidence: SourceEvidence[] = [];
  const seen = new Set<string>();
  let inReferences = false;
  for (const page of [...pages].sort((a, b) => a.pageIndex - b.pageIndex)) {
    const heading = /\b(?:references|bibliography)\b/i.exec(page.text);
    if (heading) inReferences = true;
    if (!inReferences) continue;
    const text = page.text.slice(heading?.index ?? 0);
    const pattern =
      'https?://(?:www\\.)?arxiv\\.org/(?:abs|pdf)/[^\\s<>"\\]]+' +
      '|\\b10\\.\\d{4,9}/[^\\s<>"\\]]+';
    const links = text.matchAll(new RegExp(pattern, 'gi'));
    for (const match of links) {
      const raw = trimReference(match[0]);
      const url = safeSourceUrl(raw.startsWith('10.') ? 'https://doi.org/' + raw : raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const index = match.index;
      evidence.push({
        id: 'reference:' + (evidence.length + 1),
        origin: 'citedReference',
        title: 'Reference listed on page ' + (page.pageIndex + 1),
        excerpt: text.slice(Math.max(0, index - 180), index + raw.length + 100),
        pageIndex: page.pageIndex,
        url,
        availability: 'metadataOnly',
      });
      if (evidence.length >= MAX_REFERENCES) return evidence;
    }
  }
  return evidence;
}

/** Only server-extracted text becomes paper evidence; selection quotes do not. */
export function buildPaperEvidence(input: ProviderInput): SourceEvidence[] {
  const selection = input.selection ?? input.proofContext?.sourceAnchor;
  const terms = [
    ...new Set(input.question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)),
  ].slice(0, 40);
  const candidates: {
    evidence: SourceEvidence;
    score: number;
    chunk: number;
    selected: boolean;
  }[] = [];
  for (const page of input.pages) {
    const selected = selection?.pageIndex === page.pageIndex;
    const quoteAt =
      selected && selection?.quote ? page.text.indexOf(selection.quote) : -1;
    for (let offset = 0; offset < page.text.length; offset += PASSAGE_CHARS) {
      const excerpt = page.text.slice(offset, offset + PASSAGE_CHARS);
      if (!excerpt.trim()) continue;
      const chunk = Math.floor(offset / PASSAGE_CHARS);
      const lower = excerpt.toLowerCase();
      const relevant = terms.filter((term) => lower.includes(term)).length;
      const containsQuote = quoteAt >= offset && quoteAt < offset + PASSAGE_CHARS;
      candidates.push({
        evidence: {
          id: `paper:p${page.pageIndex + 1}:c${chunk + 1}`,
          origin: 'thisPaper',
          title: `Page ${page.pageIndex + 1}, passage ${chunk + 1}`,
          excerpt,
          pageIndex: page.pageIndex,
          url: null,
          availability: 'excerpt',
        },
        score: (selected ? 1000 : 0) + (containsQuote ? 1000 : 0) + relevant,
        chunk,
        selected,
      });
    }
  }
  candidates.sort((a, b) => {
    if (input.kind === 'guide') {
      return (
        Number(b.selected) - Number(a.selected) ||
        a.chunk - b.chunk ||
        (a.evidence.pageIndex ?? 0) - (b.evidence.pageIndex ?? 0)
      );
    }
    return (
      b.score - a.score ||
      (a.evidence.pageIndex ?? 0) - (b.evidence.pageIndex ?? 0) ||
      a.chunk - b.chunk
    );
  });
  let remaining = PAPER_CHARS;
  const evidence: SourceEvidence[] = [];
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const excerpt = candidate.evidence.excerpt.slice(0, remaining);
    evidence.push({ ...candidate.evidence, excerpt });
    remaining -= excerpt.length;
  }
  if (input.selection?.kind === 'region' && input.image) {
    const pageIndex = input.selection.pageIndex;
    evidence.unshift({
      id: `paper:region:p${pageIndex + 1}`,
      origin: 'thisPaper',
      title: 'Contributed region, page ' + (pageIndex + 1),
      excerpt:
        'User-contributed region image; correspondence to stored PDF is unverified.',
      pageIndex,
      url: null,
      availability: 'excerpt',
    });
  }
  return [...evidence, ...bibliography(input.pages)];
}

/** Annotation URLs come from the search response, never model-written JSON/text. */
export function buildExternalEvidence(citations: SearchCitation[]): SourceEvidence[] {
  const evidence: SourceEvidence[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const url = safeSourceUrl(citation.url);
    if (
      !url ||
      seen.has(url) ||
      citation.startIndex < 0 ||
      citation.endIndex < citation.startIndex ||
      citation.endIndex > citation.text.length
    )
      continue;
    seen.add(url);
    const start = Math.max(0, citation.startIndex - 600);
    const excerpt = citation.text.slice(
      start,
      Math.min(start + 1000, citation.endIndex),
    );
    evidence.push({
      id: 'external:' + (evidence.length + 1),
      origin: 'externalSource',
      title: citation.title.trim().slice(0, 500) || new URL(url).hostname,
      excerpt: 'Search summary, not a source quotation: ' + excerpt,
      pageIndex: null,
      url,
      availability: 'excerpt',
    });
    if (evidence.length === 12) break;
  }
  return evidence;
}
