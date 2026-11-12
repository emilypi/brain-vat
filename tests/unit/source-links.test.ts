import { describe, expect, it } from 'vitest';
import {
  findTextReferences,
  readLinkAnnotations,
  safeExternalUrl,
  validateAnswerEvidence,
} from '../../src/source-links';
import type { GeneratedAnswer } from '../../src/workspace-contract';
import { buildPaperEvidence } from '../../server/evidence';

describe('source links', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/a',
    'https://name:password@example.com/',
    'http://name:password@example.com/',
    '//example.com/paper',
    'https://example.com/\nx',
    'https://example.com/\tx',
    'https://example.com/a b',
    ' https://example.com/paper',
  ])('rejects unsafe external link %s', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });

  it.each([
    'https://doi.org/10.1000/182',
    'http://arxiv.org/abs/1903.10677',
    'http://example.org/background',
  ])('preserves an ordinary citation URL %s', (url) => {
    expect(safeExternalUrl(url)).toBe(url);
  });

  it('rejects oversized URLs at the shared citation boundary', () => {
    expect(safeExternalUrl('https://example.org/' + 'x'.repeat(2048))).toBeNull();
  });

  it('detects identifiers with their original text offsets', () => {
    const text = 'See [3, 5–7], arXiv:2611.02451v1 and 10.1000/example.';
    const references = findTextReferences(text);
    expect(references.map((item) => text.slice(item.start, item.end))).toEqual([
      '[3, 5–7]',
      'arXiv:2611.02451v1',
      '10.1000/example',
    ]);
    expect(references.map((item) => item.url)).toEqual([
      null,
      'https://arxiv.org/abs/2611.02451v1',
      'https://doi.org/10.1000/example',
    ]);
  });

  it('extracts PDF links but ignores script actions and malformed rectangles', () => {
    const links = readLinkAnnotations([
      { subtype: 'Link', rect: [1, 2, 10, 20], url: 'https://example.org/paper' },
      { subtype: 'Link', rect: [1, 2, 10, 20], dest: 'section.2' },
      { subtype: 'Link', rect: [1, 2, 10, 20], url: 'javascript:alert(1)' },
      { subtype: 'Link', rect: [1, 2, 10, 20], actions: { JS: 'alert(1)' } },
      { subtype: 'Link', rect: [1, 2, Infinity, 20], url: 'https://example.org/' },
    ]);
    expect(links).toHaveLength(2);
    expect(links[0]?.url).toBe('https://example.org/paper');
    expect(links[1]?.destination).toBe('section.2');
  });
});

describe('generated citation integrity', () => {
  const answer: GeneratedAnswer = {
    blocks: [
      { heading: 'Definition', text: 'A sourced statement.', evidenceIds: ['p1'] },
    ],
    evidence: [
      {
        id: 'p1',
        origin: 'thisPaper',
        title: 'Paper',
        excerpt: 'Source text.',
        pageIndex: 0,
        url: null,
        availability: 'excerpt',
      },
    ],
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 10 },
  };

  it('accepts a source that resolves to a paper page', () => {
    expect(validateAnswerEvidence(answer, 3)).toBeNull();
  });

  it('withholds answers with missing or ambiguous citation IDs', () => {
    expect(validateAnswerEvidence({ ...answer, evidence: [] }, 3)).toContain(
      'not returned',
    );
    expect(
      validateAnswerEvidence(
        { ...answer, evidence: [...answer.evidence, ...answer.evidence] },
        3,
      ),
    ).toContain('duplicate');
  });

  it('rejects pages beyond the source document', () => {
    expect(validateAnswerEvidence(answer, 0)).toContain('unavailable page');
  });

  it.each([false, true])('accepts HTTP bibliography evidence, cited=%s', (cited) => {
    const evidence = buildPaperEvidence({
      title: 'Vectorizing Recurrences over Semirings',
      question: 'explain prefix sum',
      kind: 'question',
      pages: [
        { pageIndex: 0, text: 'Prefix sum is a running total.' },
        {
          pageIndex: 1,
          text: 'References [7] http://arxiv.org/abs/1903.10677',
        },
      ],
      selection: null,
      image: null,
      externalQuery: null,
      history: [],
    });
    expect(evidence.find((source) => source.id === 'reference:1')?.url).toBe(
      'http://arxiv.org/abs/1903.10677',
    );
    expect(
      validateAnswerEvidence(
        {
          ...answer,
          blocks: [
            {
              heading: 'Prefix sums',
              text: 'A prefix sum is a running total.',
              evidenceIds: cited ? ['paper:p1:c1', 'reference:1'] : ['paper:p1:c1'],
            },
          ],
          evidence,
        },
        2,
      ),
    ).toBeNull();
  });

  it('still rejects an executable URL in a returned evidence record', () => {
    expect(
      validateAnswerEvidence(
        {
          ...answer,
          evidence: [{ ...answer.evidence[0]!, url: 'javascript:alert(1)' }],
        },
        3,
      ),
    ).toContain('unsupported link');
  });
});
