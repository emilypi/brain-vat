import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAstraProvider, ProviderError } from '../../server/provider.ts';
import {
  buildExternalEvidence,
  buildPaperEvidence,
  safeSourceUrl,
} from '../../server/evidence.ts';
import type { ProviderInput } from '../../src/workspace-contract.ts';
import { PROOF_FIXTURE } from '../fixtures/proofs';
import { LEAN_VERSION, MATHLIB_VERSION } from '../../src/proof.ts';

const INPUT: ProviderInput = {
  title: 'Private unpublished paper',
  question: 'What is the main result?',
  kind: 'question',
  selection: null,
  image: null,
  externalQuery: null,
  pages: [{ pageIndex: 0, text: 'Private result: the process converges.' }],
  history: [],
};
const BLOCK = {
  heading: 'Result',
  text: 'The process converges.',
  evidenceIds: ['paper:p1:c1'],
};
const PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8A' +
  'AMBAQAY3Y2kAAAAASUVORK5CYII=';
const REGION: ProviderInput['selection'] = {
  documentId: 'a'.repeat(64),
  pageIndex: 0,
  kind: 'region',
  quote: '',
  quads: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  ],
};

function response(text = JSON.stringify({ blocks: [BLOCK] }), extra = {}) {
  return {
    status: 'completed',
    model: 'gpt-6-astra',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 50, output_tokens: 20 },
    ...extra,
  };
}

function fakeFetch(...results: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const result of results) fetch.mockResolvedValueOnce(Response.json(result));
  return fetch;
}

function body(fetch: ReturnType<typeof fakeFetch>, call = 0) {
  const value = fetch.mock.calls[call]?.[1]?.body;
  if (typeof value !== 'string') throw new Error('Expected a JSON request.');
  return JSON.parse(value);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('grounded Responses requests', () => {
  it('keeps remembered proofs separate from sources in ordinary questions', async () => {
    const rememberedProofs: NonNullable<ProviderInput['rememberedProofs']> = [
      {
        runId: crypto.randomUUID(),
        title: PROOF_FIXTURE.title,
        claim: PROOF_FIXTURE.claim,
        summary: PROOF_FIXTURE.summary,
        assumptions: PROOF_FIXTURE.assumptions,
        gaps: ['The link to the paper still requires interpretation.'],
        statement: PROOF_FIXTURE.statement,
        sourceAnchor: null,
        verification: {
          status: 'checked',
          sourceHash: 'a'.repeat(64),
          leanVersion: LEAN_VERSION,
          mathlibVersion: MATHLIB_VERSION,
          matchesCurrentRuntime: true,
        },
      },
    ];
    const fetch = fakeFetch(response());
    await createAstraProvider({ apiKey: 'key', fetch }).generate(
      { ...INPUT, rememberedProofs },
      new AbortController().signal,
    );
    const sent = body(fetch);
    const context = JSON.parse(sent.input[0].content[0].text);
    expect(context.rememberedProofs).toEqual(rememberedProofs);
    expect(context.evidence).toEqual(buildPaperEvidence(INPUT));
    expect(sent.instructions).toContain('historical explanations, not source evidence');
    expect(sent.instructions).toContain('not imported Lean lemmas');
    expect(sent.instructions).toContain('runId is internal');
  });

  it('sends the model and strict schema with server-only credentials', async () => {
    const fetch = fakeFetch(response());
    const provider = createAstraProvider({ apiKey: 'secret-key', fetch });
    const answer = await provider.generate(INPUT, new AbortController().signal);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer secret-key' },
    });
    expect(body(fetch)).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      text: { format: { type: 'json_schema', strict: true, name: 'paper_answer' } },
    });
    expect(body(fetch).tools).toBeUndefined();
    expect(JSON.stringify(body(fetch))).not.toContain('secret-key');
    expect(answer.blocks).toEqual([BLOCK]);
    expect(answer.usage).toEqual({ inputTokens: 50, outputTokens: 20 });
    expect(answer.evidence[0]).toMatchObject({
      origin: 'thisPaper',
      pageIndex: 0,
      url: null,
      availability: 'excerpt',
    });
  });

  it('sends a bounded PNG only with its matching region selection', async () => {
    const fetch = fakeFetch(response());
    await createAstraProvider({ apiKey: 'key', fetch }).generate(
      { ...INPUT, selection: REGION, image: PNG },
      new AbortController().signal,
    );
    expect(body(fetch).input[0].content).toContainEqual({
      type: 'input_image',
      image_url: PNG,
      detail: 'high',
    });
    expect(body(fetch).input[0].content[0].type).toBe('input_text');
    expect(body(fetch).instructions).toContain('Region images are user-contributed');
    const context = JSON.parse(body(fetch).input[0].content[0].text);
    expect(context.evidence[0]).toMatchObject({
      id: 'paper:region:p1',
      excerpt: expect.stringContaining('correspondence to stored PDF is unverified'),
    });
  });

  it.each([
    { image: PNG, selection: null },
    { image: null, selection: REGION },
    { image: 'data:image/png;base64,ZmFrZQ==', selection: REGION },
    { image: 'data:image/svg+xml;base64,PHN2Zy8+', selection: REGION },
    { image: PNG + 'a'.repeat(3_000_000), selection: REGION },
  ])('rejects an invalid region before dispatch: %j', async (region) => {
    const fetch = fakeFetch();
    await expect(
      createAstraProvider({ apiKey: 'key', fetch }).generate(
        { ...INPUT, ...region },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prioritizes a selected page and bounds supplied passages and history', async () => {
    const pages = Array.from({ length: 40 }, (_, pageIndex) => ({
      pageIndex,
      text: ('Page ' + pageIndex + ' contents. ').repeat(1000),
    }));
    const input: ProviderInput = {
      ...INPUT,
      pages,
      selection: { ...REGION!, pageIndex: 39, kind: 'text', quote: 'forged quote' },
      history: Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        authorId: 'reader',
        authorName: 'Reader',
        role: 'user',
        text: 'history'.repeat(4000),
        createdAt: '2026-11-10',
        runId: null,
        answer: null,
      })),
    };
    const evidence = buildPaperEvidence(input);
    expect(evidence[0]?.pageIndex).toBe(39);
    expect(
      evidence.reduce((sum, item) => sum + item.excerpt.length, 0),
    ).toBeLessThanOrEqual(60_000);
    expect(JSON.stringify(evidence)).not.toContain('forged quote');
    const fetch = fakeFetch(
      response(
        JSON.stringify({
          blocks: [{ ...BLOCK, evidenceIds: [evidence[0]?.id] }],
        }),
      ),
    );
    await createAstraProvider({ apiKey: 'key', fetch }).generate(
      input,
      new AbortController().signal,
    );
    const context = JSON.parse(body(fetch).input[0].content[0].text);
    expect(JSON.stringify(context.history).length).toBeLessThan(13_000);
  });

  it.each(['guide', 'definition'] as const)(
    'specializes %s instructions',
    async (kind) => {
      const fetch = fakeFetch(response());
      await createAstraProvider({ apiKey: 'key', fetch }).generate(
        { ...INPUT, kind },
        new AbortController().signal,
      );
      expect(body(fetch).instructions).toContain(
        kind === 'guide' ? 'study guide' : 'contextual definition',
      );
      expect(body(fetch).instructions).toContain('inference');
    },
  );
});

describe('Lean proof proposals', () => {
  it('requests proposals without accepting model verification', async () => {
    const fetch = fakeFetch(
      response(
        JSON.stringify({
          blocks: [BLOCK],
          proof: PROOF_FIXTURE,
        }),
      ),
    );
    const answer = await createAstraProvider({ apiKey: 'key', fetch }).generate(
      { ...INPUT, kind: 'proof' },
      new AbortController().signal,
    );
    expect(answer.proof).toEqual(PROOF_FIXTURE);
    expect(answer.proofArtifact).toBeUndefined();
    expect(body(fetch).instructions).toContain('Lean 4.35.0');
    expect(body(fetch).instructions).toContain('Mathlib v4.35.0');
    expect(body(fetch).instructions).toContain('Do not claim Lean accepted');
    expect(body(fetch).text.format.schema.required).toContain('proof');
    expect(body(fetch).text.format.schema.properties.proof.additionalProperties).toBe(
      false,
    );
    expect(body(fetch).tools).toBeUndefined();
  });

  it('includes selected images and an explicit interpretation', async () => {
    const fetch = fakeFetch(
      response(
        JSON.stringify({
          blocks: [BLOCK],
          proof: PROOF_FIXTURE,
        }),
      ),
    );
    const answer = await createAstraProvider({ apiKey: 'key', fetch }).generate(
      { ...INPUT, kind: 'proof', selection: REGION, image: PNG },
      new AbortController().signal,
    );
    expect(body(fetch).input[0].content).toContainEqual({
      type: 'input_image',
      image_url: PNG,
      detail: 'high',
    });
    expect(body(fetch).instructions).toContain('transcription');
    expect(answer.proof?.interpretation).toBe(PROOF_FIXTURE.interpretation);
  });

  it('retains exact parent context beyond recent chat history', async () => {
    const proofContext: NonNullable<ProviderInput['proofContext']> = {
      parentRunId: '12345678-1234-4123-8123-123456789abc',
      title: 'Parent proof',
      claim: 'An exact older claim.',
      interpretation: 'The parent interprets an image of an algebraic identity.',
      summary: 'Older summary.',
      assumptions: ['Finite support.'],
      steps: [{ title: 'Rearrange', explanation: 'Use associativity.' }],
      prerequisite: PROOF_FIXTURE.prerequisites[0]!,
      sourceAnchor: { ...REGION!, pageIndex: 39 },
    };
    const input: ProviderInput = {
      ...INPUT,
      kind: 'proof',
      proofContext,
      pages: Array.from({ length: 40 }, (_, pageIndex) => ({
        pageIndex,
        text: ('Page ' + pageIndex + ' contents. ').repeat(1000),
      })),
    };
    const evidence = buildPaperEvidence(input);
    expect(evidence[0]?.pageIndex).toBe(39);
    const fetch = fakeFetch(
      response(
        JSON.stringify({
          blocks: [{ ...BLOCK, evidenceIds: [evidence[0]!.id] }],
          proof: {
            ...PROOF_FIXTURE,
            steps: PROOF_FIXTURE.steps.map((step) => ({
              ...step,
              evidenceIds: [evidence[0]!.id],
            })),
          },
        }),
      ),
    );
    await createAstraProvider({ apiKey: 'key', fetch }).generate(
      input,
      new AbortController().signal,
    );
    const payload = JSON.parse(body(fetch).input[0].content[0].text);
    expect(payload.proofContext).toEqual(proofContext);
    expect(payload.history).toEqual([]);
    expect(payload.evidence[0].pageIndex).toBe(39);
    expect(body(fetch).input[0].content).toHaveLength(1);
  });

  it.each(['missing', 'checked', 'unknown-evidence', 'unknown-prerequisite'])(
    'rejects a %s proof proposal without retrying the paid call',
    async (invalid) => {
      const proof = structuredClone(PROOF_FIXTURE);
      if (invalid === 'unknown-evidence') proof.steps[0]!.evidenceIds = ['invented'];
      if (invalid === 'unknown-prerequisite')
        proof.steps[0]!.prerequisiteIds = ['invented'];
      const value =
        invalid === 'missing'
          ? { blocks: [BLOCK] }
          : {
              blocks: [BLOCK],
              proof:
                invalid === 'checked'
                  ? {
                      ...proof,
                      status: 'checked',
                    }
                  : proof,
            };
      const fetch = fakeFetch(response(JSON.stringify(value)));
      await expect(
        createAstraProvider({ apiKey: 'key', fetch }).generate(
          { ...INPUT, kind: 'proof' },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ProviderError);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('keeps an unformalized explanation without inventing a proof', async () => {
    const proof = structuredClone(PROOF_FIXTURE);
    proof.statement = null;
    proof.gaps = ['The excerpt does not state the hypotheses.'];
    proof.steps = proof.steps.map((step) => ({ ...step, tactic: null }));
    const fetch = fakeFetch(response(JSON.stringify({ blocks: [BLOCK], proof })));
    const answer = await createAstraProvider({ apiKey: 'key', fetch }).generate(
      { ...INPUT, kind: 'proof' },
      new AbortController().signal,
    );
    expect(answer.proof?.statement).toBeNull();
    expect(answer.proof?.gaps).toEqual(proof.gaps);
  });
});

describe('explicit external search', () => {
  const summary = 'Convergence follows under bounded assumptions.';
  const search = response(summary, {
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: summary + ' https://model-invented.invalid/ is unverified.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.org/research',
                title: 'Research',
                start_index: 0,
                end_index: summary.length,
              },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  it('isolates the search query and freezes annotated evidence', async () => {
    const fetch = fakeFetch(
      search,
      response(
        JSON.stringify({
          blocks: [
            {
              ...BLOCK,
              evidenceIds: ['external:1', 'reference:1', 'paper:p1:c1'],
            },
          ],
        }),
      ),
    );
    const input: ProviderInput = {
      ...INPUT,
      externalQuery: 'convergence definition',
      selection: { ...REGION!, kind: 'text', quote: 'private selection' },
      pages: [
        {
          pageIndex: 0,
          text: INPUT.pages[0]!.text + '\nReferences\n[1] doi:10.1234/result.',
        },
      ],
      history: [
        {
          id: 'h',
          authorId: 'u',
          authorName: 'Private name',
          role: 'user',
          text: 'private history',
          createdAt: '2026-11-10',
          runId: null,
          answer: null,
        },
      ],
    };
    const answer = await createAstraProvider({ apiKey: 'key', fetch }).generate(
      input,
      new AbortController().signal,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch).input).toBe('convergence definition');
    expect(body(fetch).tools).toEqual([{ type: 'web_search' }]);
    expect(body(fetch).tool_choice).toBe('required');
    expect(JSON.stringify(body(fetch))).not.toMatch(/private/i);
    expect(body(fetch, 1).tools).toBeUndefined();
    expect(body(fetch, 1).previous_response_id).toBeUndefined();
    expect(answer.usage).toEqual({ inputTokens: 60, outputTokens: 25 });
    expect(answer.evidence.map((item) => item.origin)).toEqual([
      'thisPaper',
      'citedReference',
      'externalSource',
    ]);
    expect(
      answer.evidence.find((item) => item.origin === 'citedReference'),
    ).toMatchObject({
      availability: 'metadataOnly',
      url: 'https://doi.org/10.1234/result',
    });
    expect(
      answer.evidence.find((item) => item.origin === 'externalSource'),
    ).toMatchObject({ url: 'https://example.org/research' });
    expect(answer.evidence.some((item) => item.url?.includes('model-invented'))).toBe(
      false,
    );
  });

  it('retains usage from both calls when the final answer is rejected', async () => {
    const fetch = fakeFetch(search, response('invalid JSON'));
    await expect(
      createAstraProvider({ apiKey: 'key', fetch }).generate(
        { ...INPUT, externalQuery: 'term' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      uncertain: false,
      usage: { inputTokens: 60, outputTokens: 25 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not accept plain-text links as checked external sources', async () => {
    const fetch = fakeFetch(
      response('See https://invented.invalid', {
        output: [{ type: 'web_search_call', status: 'completed' }],
      }),
    );
    await expect(
      createAstraProvider({ apiKey: 'key', fetch }).generate(
        { ...INPUT, externalQuery: 'term' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    'file:///etc/passwd',
    'https://user:password@example.org',
    '//example.org',
    'https://example.org/\nx',
  ])('excludes unsafe citation URL %s', (url) => {
    expect(safeSourceUrl(url)).toBeNull();
    expect(
      buildExternalEvidence([
        {
          url,
          title: 'Unsafe',
          text: summary,
          startIndex: 0,
          endIndex: summary.length,
        },
      ]),
    ).toEqual([]);
  });

  it('identifies DOI and arXiv bibliography links as unread metadata', () => {
    const evidence = buildPaperEvidence({
      ...INPUT,
      pages: [
        {
          pageIndex: 0,
          text:
            'References [1] A. doi:10.1000/example. ' +
            '[2] B. https://arxiv.org/abs/2611.02451v1.',
        },
      ],
    });
    expect(evidence.filter((item) => item.origin === 'citedReference')).toMatchObject([
      { availability: 'metadataOnly', url: 'https://doi.org/10.1000/example' },
      { availability: 'metadataOnly', url: 'https://arxiv.org/abs/2611.02451v1' },
    ]);
  });
});

describe('provider failures and cancellation', () => {
  it('reports a missing key without dispatching', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetch = fakeFetch();
    const provider = createAstraProvider({ fetch });
    expect(provider.configured).toBe(false);
    await expect(
      provider.generate(INPUT, new AbortController().signal),
    ).rejects.toThrow('OPENAI_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    response(JSON.stringify({ blocks: [{ ...BLOCK, evidenceIds: ['made-up'] }] })),
    response(
      JSON.stringify({ blocks: [{ ...BLOCK, url: 'https://invented.invalid' }] }),
    ),
    response(
      JSON.stringify({ blocks: [{ ...BLOCK, text: '[link](javascript:bad)' }] }),
    ),
    response(JSON.stringify({ blocks: [] })),
    response(JSON.stringify({ blocks: [{ ...BLOCK, text: '   ' }] })),
    response('not JSON'),
    response('', { usage: null }),
    response('', { status: 'incomplete' }),
    response('', {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'Declined' }],
        },
      ],
    }),
  ])(
    'rejects forged, incomplete or malformed answers without retry',
    async (result) => {
      const fetch = fakeFetch(result);
      await expect(
        createAstraProvider({ apiKey: 'key', fetch }).generate(
          INPUT,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ uncertain: false });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('rejects cancellation before dispatch without calling the provider', async () => {
    const fetch = fakeFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createAstraProvider({ apiKey: 'key', fetch }).generate(INPUT, controller.signal),
    ).rejects.toMatchObject({ uncertain: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'timeout'])(
    'aborts an in-flight %s and cleans up',
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            ),
          ),
      );
      const pending = createAstraProvider({ apiKey: 'key', fetch }).generate(
        INPUT,
        controller.signal,
      );
      const assertion = expect(pending).rejects.toMatchObject({ uncertain: true });
      if (mode === 'cancel') controller.abort();
      else await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(fetch).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([401, 500])('does not retry provider HTTP %i', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private upstream error', { status }));
    await expect(
      createAstraProvider({ apiKey: 'key', fetch }).generate(
        INPUT,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      message: `Provider request failed (HTTP ${status}).`,
      uncertain: status >= 500,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects insecure endpoints and accepts explicit localhost development', () => {
    expect(() => createAstraProvider({ baseUrl: 'http://example.org/v1' })).toThrow();
    expect(() =>
      createAstraProvider({ baseUrl: 'https://u:p@example.org/v1' }),
    ).toThrow();
    expect(() =>
      createAstraProvider({ baseUrl: 'http://127.0.0.1:8080/v1' }),
    ).not.toThrow();
  });
});
