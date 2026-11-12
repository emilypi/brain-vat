import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../server/app.ts';
import { digest } from '../../server/auth.ts';
import { proofCheckOutcome, proofSourceHash } from '../../server/proofs.ts';
import { WorkspaceStore } from '../../server/store.ts';
import { rememberedProofs } from '../../server/solo-contexts.ts';
import type { StoredSoloContext } from '../../server/solo-contexts.ts';
import { LEAN_VERSION, MATHLIB_VERSION, renderLeanProof } from '../../src/proof.ts';
import type { LeanChecker, ProofCheck } from '../../src/proof.ts';
import type {
  SavedContextCreated,
  SavedContextOpened,
  SoloContextState,
} from '../../src/saved-context.ts';
import type {
  AiProvider,
  AiRun,
  GeneratedAnswer,
  RunInput,
} from '../../src/workspace-contract.ts';
import { PROOF_FIXTURE } from '../fixtures/proofs.ts';

const origin = 'http://127.0.0.1:5173';
const headers = { origin, host: '127.0.0.1:8787' };
const paper = {
  documentId: 'a'.repeat(64),
  title: 'Associativity',
  pages: [{ pageIndex: 0, text: 'Natural-number addition is associative.' }],
};
const answer: GeneratedAnswer = {
  blocks: [{ heading: 'Explanation', text: 'Associate the terms.', evidenceIds: [] }],
  evidence: [
    {
      id: 'paper:p1:c1',
      origin: 'thisPaper',
      title: 'Page 1',
      excerpt: paper.pages[0]!.text,
      pageIndex: 0,
      url: null,
      availability: 'excerpt',
    },
  ],
  model: 'fixture',
  usage: { inputTokens: 10, outputTokens: 20 },
};
function question(change: Partial<RunInput> = {}): RunInput {
  return {
    requestId: randomUUID(),
    question: 'Explain associativity.',
    kind: 'question',
    selection: null,
    image: null,
    externalQuery: null,
    ...change,
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let app: FastifyInstance;
let directory: string;
let dbPath: string;
const generate = vi.fn<AiProvider['generate']>();
const check = vi.fn<LeanChecker['check']>();
const provider: AiProvider = {
  name: 'fixture',
  model: 'fixture',
  configured: true,
  generate,
};
const checker: LeanChecker = {
  status: async () => ({
    available: true,
    leanVersion: LEAN_VERSION,
    mathlibVersion: MATHLIB_VERSION,
    message: 'Fixture checker.',
  }),
  check,
};
const start = () =>
  createApp({
    dbPath,
    provider,
    leanChecker: checker,
    enableSolo: true,
    allowedOrigins: [origin],
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brain-vat-contexts-'));
  dbPath = join(directory, 'workspace.sqlite');
  provider.configured = true;
  generate.mockReset().mockImplementation(async (input) => ({
    ...structuredClone(answer),
    ...(input.kind === 'proof' ? { proof: structuredClone(PROOF_FIXTURE) } : {}),
  }));
  check
    .mockReset()
    .mockResolvedValue(proofCheckOutcome('checked', 'Fixture accepted.'));
  app = await start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

function request(method: HTTPMethods, path: string, token?: string, payload?: unknown) {
  return app.inject({
    method,
    url: '/api/solo' + path,
    headers: {
      ...headers,
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    remoteAddress: '127.0.0.1',
  });
}
async function session(): Promise<string> {
  const response = await request('POST', '/sessions', undefined, paper);
  expect(response.statusCode).toBe(201);
  return response.json<{ token: string }>().token;
}
async function save(token: string, name = 'Reading notes') {
  const response = await request('POST', '/context', token, {
    requestId: randomUUID(),
    name,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<SavedContextCreated>();
}
async function open(saved: SavedContextCreated): Promise<SavedContextOpened> {
  const response = await request(
    'POST',
    '/contexts/' + saved.context.id + '/open',
    saved.capability,
    { documentId: paper.documentId },
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<SavedContextOpened>();
}
async function run(token: string, input = question()): Promise<AiRun> {
  const response = await request('POST', '/runs', token, input);
  expect(response.statusCode, response.body).toBe(202);
  let result: AiRun;
  await vi.waitFor(async () => {
    result = (await request('GET', '/runs/' + input.requestId, token)).json<AiRun>();
    expect(result.status).toBe('completed');
  });
  return result!;
}
async function checked(token: string, runId: string): Promise<ProofCheck> {
  let result: ProofCheck;
  await vi.waitFor(async () => {
    result = (
      await request('GET', '/runs/' + runId + '/proof-check', token)
    ).json<ProofCheck>();
    expect(result?.status).toBe('checked');
  });
  return result!;
}

function databaseState(id: string): StoredSoloContext {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT body FROM solo_contexts WHERE id = ?').get(id)!;
    return JSON.parse(String(row.body)) as StoredSoloContext;
  } finally {
    db.close();
  }
}

describe('saved solo contexts', () => {
  test.each(['open', 'read'] as const)(
    'revokes an already authorized delayed %s when its context is deleted',
    async (operation) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      app.addHook('preHandler', async (incoming) => {
        if (incoming.headers['x-test-delay'] === 'yes') {
          entered.resolve();
          await release.promise;
        }
      });
      const token = await session();
      const saved = await save(token);
      const delayed = app.inject({
        method: operation === 'open' ? 'POST' : 'GET',
        url:
          operation === 'open'
            ? '/api/solo/contexts/' + saved.context.id + '/open'
            : '/api/solo/session',
        headers: {
          ...headers,
          'x-test-delay': 'yes',
          authorization: 'Bearer ' + (operation === 'open' ? saved.capability : token),
        },
        ...(operation === 'open' ? { payload: { documentId: paper.documentId } } : {}),
      });
      await entered.promise;
      expect(
        (await request('DELETE', '/contexts/' + saved.context.id, saved.capability))
          .statusCode,
      ).toBe(204);
      release.resolve();
      expect((await delayed).statusCode).toBe(operation === 'open' ? 404 : 401);
    },
  );

  test('saves without Astra and binds capabilities to the PDF', async () => {
    provider.configured = false;
    const token = await session();
    const input = { requestId: randomUUID(), name: 'Algebra' };
    const savedResponse = await request('POST', '/context', token, input);
    expect(savedResponse.statusCode).toBe(201);
    const saved = savedResponse.json<SavedContextCreated>();
    expect((await request('POST', '/context', token, input)).json()).toEqual(saved);
    expect(
      (await request('POST', '/context', token, { ...input, name: 'Changed' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await request('POST', '/context', token, { ...input, checks: [] })).statusCode,
    ).toBe(400);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT * FROM solo_contexts').get()!;
    db.close();
    expect(row.capability_hash).toBe(digest(saved.capability));
    expect(JSON.stringify(row)).not.toContain(saved.capability);
    expect(saved.capability).not.toBe(token);
    expect((await request('POST', '/runs', token, question())).statusCode).toBe(503);
    expect(
      (
        await request('POST', '/runs', token, {
          ...question(),
          rememberedProofs: [{ verification: { status: 'checked' } }],
        })
      ).statusCode,
    ).toBe(400);
    const path = '/contexts/' + saved.context.id + '/open';
    expect(
      (await request('POST', path, token, { documentId: paper.documentId })).statusCode,
    ).toBe(404);
    expect(
      (await request('POST', path, saved.capability, { documentId: 'b'.repeat(64) }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await request('POST', path, saved.capability, {
          documentId: paper.documentId,
          runs: [],
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    app = await start();
    const restored = await open(saved);
    expect(restored.runs).toEqual([]);
    expect(restored.context.name).toBe('Algebra');
    expect(generate).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  test('restores proof graphs, source and checks without dispatch', async () => {
    const token = await session();
    const saved = await save(token);
    const input = question({ kind: 'proof' });
    const proof = await run(token, input);
    const verdict = await checked(token, proof.id);
    const child = await run(
      token,
      question({
        kind: 'proof',
        proofParent: { runId: proof.id, prerequisiteId: 'associativity' },
      }),
    );
    await checked(token, child.id);
    expect(proof.answer?.proofArtifact?.renderedSource).toEqual(
      renderLeanProof(PROOF_FIXTURE),
    );
    await app.close();
    app = await start();
    const restored = await open(saved);
    expect(restored.runs).toEqual([proof, child]);
    expect(await checked(restored.token, proof.id)).toEqual(verdict);
    expect((await request('POST', '/runs', restored.token, input)).json()).toEqual(
      proof,
    );
    expect(
      (
        await request('POST', '/runs/' + proof.id + '/proof-check', restored.token, {
          sourceHash: proof.answer!.proofArtifact!.sourceHash,
        })
      ).json(),
    ).toEqual(verdict);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('shares state across tabs and finishes work after they detach', async () => {
    const pending = deferred<GeneratedAnswer>();
    generate.mockImplementationOnce(() => pending.promise);
    const first = await session();
    const saved = await save(first);
    const second = await open(saved);
    const input = question();
    expect((await request('POST', '/runs', first, input)).statusCode).toBe(202);
    expect((await request('POST', '/runs', second.token, input)).statusCode).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(databaseState(saved.context.id).runs[0]?.run.status).toBe('running');
    const state = (
      await request('GET', '/session', second.token)
    ).json<SoloContextState>();
    expect(state.runs[0]?.id).toBe(input.requestId);
    expect(
      (
        await request(
          'GET',
          '/session?revision=' + state.context!.revision,
          second.token,
        )
      ).json(),
    ).toEqual({ context: state.context, runs: null });
    const renamed = await request(
      'PATCH',
      '/contexts/' + saved.context.id,
      saved.capability,
      { name: 'Algebra in depth' },
    );
    expect(renamed.statusCode).toBe(200);
    expect(
      (await request('GET', '/session', first)).json<SoloContextState>().context?.name,
    ).toBe('Algebra in depth');
    await request('DELETE', '/session', first);
    expect(generate.mock.calls[0]![1].aborted).toBe(false);
    await request('DELETE', '/session', second.token);
    expect(generate.mock.calls[0]![1].aborted).toBe(false);
    pending.resolve(answer);
    await vi.waitFor(() => {
      expect(databaseState(saved.context.id).runs[0]?.run.status).toBe('completed');
    });
    expect((await open(saved)).runs[0]?.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('reopens orphaned work as unconfirmed after a failed terminal write', async () => {
    const pending = deferred<Awaited<ReturnType<LeanChecker['check']>>>();
    check.mockImplementationOnce(() => pending.promise);
    const token = await session();
    const saved = await save(token);
    const proof = await run(token, question({ kind: 'proof' }));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    const update = WorkspaceStore.prototype.updateSoloContext;
    const write = vi
      .spyOn(WorkspaceStore.prototype, 'updateSoloContext')
      .mockImplementation(function (this: WorkspaceStore, id, state, name) {
        if (state.checks.some((result) => result.status === 'checked'))
          throw new Error('Simulated failed durable write');
        return update.call(this, id, state, name);
      });
    pending.resolve(proofCheckOutcome('checked', 'Not durably recorded.'));
    await vi.waitFor(async () => {
      expect((await request('GET', '/session', token)).statusCode).toBe(401);
    });
    write.mockRestore();
    const restored = await open(saved);
    const result = (
      await request('GET', '/runs/' + proof.id + '/proof-check', restored.token)
    ).json<ProofCheck>();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('unconfirmed');
    expect(databaseState(saved.context.id).checks[0]?.status).toBe('failed');
    expect(check).toHaveBeenCalledTimes(1);
  });

  test('records interrupted work without replay after restart', async () => {
    const pendingProof = deferred<Awaited<ReturnType<LeanChecker['check']>>>();
    check.mockImplementationOnce(() => pendingProof.promise);
    const token = await session();
    const saved = await save(token);
    const proof = await run(token, question({ kind: 'proof' }));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    const pendingAi = deferred<GeneratedAnswer>();
    generate.mockImplementationOnce(() => pendingAi.promise);
    const input = question();
    await request('POST', '/runs', token, input);
    await app.close();
    expect(generate.mock.calls[1]![1].aborted).toBe(true);
    app = await start();
    const restored = await open(saved);
    expect(restored.runs.find((item) => item.id === input.requestId)?.status).toBe(
      'uncertain',
    );
    expect(
      (
        await request('GET', '/runs/' + proof.id + '/proof-check', restored.token)
      ).json<ProofCheck>().status,
    ).toBe('failed');
    pendingAi.resolve(answer);
    pendingProof.resolve(proofCheckOutcome('checked', 'Too late.'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      databaseState(saved.context.id).runs.find(({ run }) => run.id === input.requestId)
        ?.run.status,
    ).toBe('uncertain');
    expect(databaseState(saved.context.id).checks[0]?.status).toBe('failed');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test('revokes tabs on deletion and ignores late callbacks', async () => {
    const pendingProof = deferred<Awaited<ReturnType<LeanChecker['check']>>>();
    check.mockImplementationOnce(() => pendingProof.promise);
    const first = await session();
    const saved = await save(first);
    const second = await open(saved);
    await run(first, question({ kind: 'proof' }));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    const pendingAi = deferred<GeneratedAnswer>();
    generate.mockImplementationOnce(() => pendingAi.promise);
    await request('POST', '/runs', second.token, question());
    expect(
      (await request('DELETE', '/contexts/' + saved.context.id, saved.capability))
        .statusCode,
    ).toBe(204);
    expect((await request('GET', '/session', first)).statusCode).toBe(401);
    expect((await request('GET', '/session', second.token)).statusCode).toBe(401);
    expect(
      (
        await request(
          'POST',
          '/contexts/' + saved.context.id + '/open',
          saved.capability,
          { documentId: paper.documentId },
        )
      ).statusCode,
    ).toBe(404);
    pendingAi.resolve(answer);
    pendingProof.resolve(proofCheckOutcome('checked', 'Too late.'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT * FROM solo_contexts WHERE id = ?')
      .get(saved.context.id)!;
    db.close();
    expect(row.deleted).toBe(1);
    expect(row.body).toBe('');
    expect(row.reserved_bytes).toBe(0);
  });

  test('remembers checked proofs beyond chat history within its scope', async () => {
    const token = await session();
    await save(token);
    const proof = await run(token, question({ kind: 'proof' }));
    const verdict = await checked(token, proof.id);
    for (let index = 0; index < 7; index += 1) await run(token);
    const last = generate.mock.calls.at(-1)![0];
    expect(last.history.every((message) => message.runId !== proof.id)).toBe(true);
    expect(last.rememberedProofs).toEqual([
      expect.objectContaining({
        runId: proof.id,
        assumptions: PROOF_FIXTURE.assumptions,
        gaps: PROOF_FIXTURE.gaps,
        statement: PROOF_FIXTURE.statement,
        verification: {
          status: 'checked',
          sourceHash: proofSourceHash(PROOF_FIXTURE),
          leanVersion: LEAN_VERSION,
          mathlibVersion: MATHLIB_VERSION,
          matchesCurrentRuntime: true,
        },
      }),
    ]);
    const other = await session();
    await save(other);
    await run(other);
    expect(generate.mock.calls.at(-1)![0].rememberedProofs).toEqual([]);
    const oldVerdict = { ...verdict, leanVersion: '4.0.0' };
    expect(
      rememberedProofs([proof], new Map([[proof.id, oldVerdict]]), undefined)[0]
        ?.verification.matchesCurrentRuntime,
    ).toBe(false);
  });
});

describe('durable context capacity', () => {
  test('bounds contexts, total bytes and runs without deleting existing data', () => {
    const store = new WorkspaceStore(':memory:');
    const state: StoredSoloContext = { paper, runs: [], checks: [] };
    try {
      const first = randomUUID();
      store.createSoloContext(first, 'capability', 'First', state);
      for (let index = 1; index < 100; index += 1)
        store.createSoloContext(randomUUID(), 'capability', 'Context', state);
      expect(() =>
        store.createSoloContext(randomUUID(), 'new', 'Excess', state),
      ).toThrow('100');
      expect(store.soloContext(first, 'capability').summary.name).toBe('First');
      store.deleteSoloContext(first);
      expect(() => store.updateSoloContext(first, state)).toThrow('deleted');
      store.createSoloContext(randomUUID(), 'replacement', 'Replacement', state);
    } finally {
      store.close();
    }
    const large = new WorkspaceStore(':memory:');
    try {
      const full: StoredSoloContext = {
        paper: { ...paper, pages: [{ pageIndex: 0, text: 'x'.repeat(13_000_000) }] },
        runs: [],
        checks: [],
      };
      const first = randomUUID();
      large.createSoloContext(first, 'capability', 'Full', full);
      for (let index = 1; index < 9; index += 1)
        large.createSoloContext(randomUUID(), 'capability', 'Full', full);
      expect(() =>
        large.createSoloContext(randomUUID(), 'excess', 'Excess', full),
      ).toThrow('128 MB');
      const pending: AiRun = {
        ...question(),
        id: randomUUID(),
        authorId: 'solo',
        status: 'running',
        createdAt: new Date().toISOString(),
        answer: null,
        error: null,
      };
      expect(() =>
        large.updateSoloContext(first, {
          ...full,
          runs: [{ run: pending, digest: 'original' }],
        }),
      ).toThrow('16 MB');
      expect(() =>
        large.updateSoloContext(first, {
          ...state,
          runs: Array.from({ length: 501 }, () => ({
            run: { ...pending, id: randomUUID(), status: 'failed' as const },
            digest: 'original',
          })),
        }),
      ).toThrow('500 questions');
      expect(large.soloContext(first, 'capability').state.runs).toEqual([]);
    } finally {
      large.close();
    }
  });
});
