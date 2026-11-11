import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../server/app.ts';
import { createBackup } from '../../server/backup.ts';
import {
  proofCheckOutcome,
  ProofExecutor,
  proofSourceHash,
} from '../../server/proofs.ts';
import type { Anchor } from '../../src/document.ts';
import { LEAN_VERSION, MATHLIB_VERSION } from '../../src/proof.ts';
import type { LeanChecker, ProofCheck, ProofCheckResult } from '../../src/proof.ts';
import type {
  AiProvider,
  AiRun,
  GeneratedAnswer,
  RoomState,
  RoomSummary,
  RunInput,
  Session,
} from '../../src/workspace-contract.ts';
import { makePdfFixture } from '../fixtures/pdf-fixtures.ts';
import { PROOF_FIXTURE } from '../fixtures/proofs.ts';

const origin = 'http://127.0.0.1:5173';
const localHeaders = { origin, host: '127.0.0.1:8787' };
const paper = {
  documentId: 'a'.repeat(64),
  title: 'Associativity',
  pages: [{ pageIndex: 0, text: 'Natural-number addition is associative.' }],
};
const answer: GeneratedAnswer = {
  blocks: [{ heading: 'Proof', text: 'Associate the terms.', evidenceIds: [] }],
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
  model: 'test',
  usage: { inputTokens: 10, outputTokens: 20 },
};
const checked: ProofCheckResult = {
  ...proofCheckOutcome('checked', 'The exact formalization was checked.'),
  steps: [
    { stepId: 'introduce', before: ['⊢ ∀ a b c : Nat, _'], after: ['a b c : Nat'] },
    { stepId: 'associate', before: ['⊢ a + b + c = a + (b + c)'], after: [] },
  ],
};

function selection(documentId: string): Anchor {
  return {
    documentId,
    pageIndex: 0,
    kind: 'text',
    quote: paper.pages[0]!.text,
    quads: [
      [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.1, y: 0.2 },
      ],
    ],
  };
}

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    requestId: randomUUID(),
    question: 'Break down this proof.',
    kind: 'proof',
    selection: null,
    image: null,
    externalQuery: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

interface Scope {
  base: string;
  headers: Record<string, string>;
  documentId: string;
}

describe('proof service boundaries', () => {
  let app: FastifyInstance;
  let directory: string;
  let dbPath: string;
  let available: boolean;
  const generate = vi.fn<AiProvider['generate']>();
  const check = vi.fn<LeanChecker['check']>();
  const provider: AiProvider = {
    name: 'test',
    model: 'test',
    configured: true,
    generate,
  };
  const checker: LeanChecker = {
    status: async () => ({
      available,
      leanVersion: LEAN_VERSION,
      mathlibVersion: MATHLIB_VERSION,
      message: available ? 'Ready.' : 'Install the pinned Lean runtime.',
    }),
    check,
  };
  const start = () =>
    createApp({
      dbPath,
      provider,
      leanChecker: checker,
      enableSolo: true,
      registrationOpen: true,
      allowedOrigins: [origin],
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brain-vat-proofs-'));
    dbPath = join(directory, 'workspace.sqlite');
    available = true;
    generate.mockReset().mockImplementation(async (request) => ({
      ...structuredClone(answer),
      ...(request.kind === 'proof' ? { proof: structuredClone(PROOF_FIXTURE) } : {}),
    }));
    check.mockReset().mockResolvedValue(checked);
    app = await start();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  function request(scope: Scope, method: HTTPMethods, path: string, payload?: unknown) {
    return app.inject({
      method,
      url: scope.base + path,
      headers: {
        ...scope.headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }
  async function solo(): Promise<Scope> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/solo/sessions',
      headers: localHeaders,
      payload: paper,
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      base: '/api/solo',
      headers: {
        ...localHeaders,
        authorization: 'Bearer ' + response.json<{ token: string }>().token,
      },
      documentId: paper.documentId,
    };
  }
  async function register(username: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'long proof test password' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Session>();
  }
  async function room(user: Session): Promise<Scope> {
    const headers = { authorization: 'Bearer ' + user.token };
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers,
      payload: {
        title: 'Proofs',
        filename: 'proof.pdf',
        sourceUrl: null,
        pdf: makePdfFixture().toString('base64'),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<RoomSummary>();
    return {
      base: '/api/rooms/' + created.id,
      headers,
      documentId: created.documentId,
    };
  }
  async function run(scope: Scope, payload = input()): Promise<AiRun> {
    const response = await request(scope, 'POST', '/runs', payload);
    expect(response.statusCode, response.body).toBe(202);
    const id = response.json<AiRun>().id;
    let current: AiRun | undefined;
    await vi.waitFor(async () => {
      if (scope.base === '/api/solo')
        current = (await request(scope, 'GET', '/runs/' + id)).json<AiRun>();
      else
        current = (await request(scope, 'GET', ''))
          .json<RoomState>()
          .runs.find((item) => item.id === id);
      expect(current?.status).toBe('completed');
    });
    return current!;
  }
  function checkPath(run: AiRun) {
    return '/runs/' + run.id + '/proof-check';
  }
  async function outcome(scope: Scope, run: AiRun, status = 'checked') {
    let result: ProofCheck | null = null;
    await vi.waitFor(async () => {
      const response = await request(scope, 'GET', checkPath(run));
      expect(response.statusCode, response.body).toBe(200);
      result = response.json<ProofCheck | null>();
      expect(result?.status).toBe(status);
    });
    return result! as ProofCheck;
  }

  test.each(['solo', 'room'] as const)(
    '%s checks exact source once and preserves server-owned provenance',
    async (mode) => {
      const scope =
        mode === 'solo' ? await solo() : await room(await register('owner'));
      const anchor = selection(scope.documentId);
      generate.mockResolvedValueOnce({
        ...answer,
        proof: PROOF_FIXTURE,
        proofArtifact: {
          sourceHash: '0'.repeat(64),
          sourceAnchor: null,
          parent: { runId: randomUUID(), prerequisiteId: null },
        },
      });
      const proof = await run(scope, input({ selection: anchor }));
      const sourceHash = proofSourceHash(PROOF_FIXTURE);
      expect(proof.answer?.proofArtifact).toEqual({
        sourceHash,
        sourceAnchor: anchor,
        parent: null,
      });
      const verified = await outcome(scope, proof);
      expect(verified.steps).toEqual(checked.steps);
      const repeat = await request(scope, 'POST', checkPath(proof), { sourceHash });
      expect(repeat.json<ProofCheck>().id).toBe(verified.id);
      expect(check).toHaveBeenCalledTimes(1);
      expect(
        (await request(scope, 'POST', checkPath(proof), { sourceHash: '0'.repeat(64) }))
          .statusCode,
      ).toBe(409);
      if (mode === 'room') {
        const state = (await request(scope, 'GET', '')).json<RoomState>();
        expect(
          state.messages.find((item) => item.role === 'assistant')?.answer,
        ).toEqual(proof.answer);
      }
    },
  );

  test.each(['solo', 'room'] as const)(
    '%s isolates parent and check access even for the same paper',
    async (mode) => {
      const owner = mode === 'room' ? await register('owner') : null;
      const first = owner ? await room(owner) : await solo();
      const second = owner ? await room(owner) : await solo();
      const parent = await run(first);
      await outcome(first, parent);
      for (const method of ['GET', 'POST'] as const) {
        const result = await request(
          second,
          method,
          checkPath(parent),
          method === 'POST'
            ? { sourceHash: parent.answer!.proofArtifact!.sourceHash }
            : undefined,
        );
        expect(result.statusCode).toBe(404);
      }
      expect(
        (await request(second, 'POST', checkPath(parent) + '/cancel')).statusCode,
      ).toBe(404);
      const result = await request(
        second,
        'POST',
        '/runs',
        input({ proofParent: { runId: parent.id, prerequisiteId: 'associativity' } }),
      );
      expect(result.statusCode).toBe(404);
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['solo', 'room'] as const)(
    '%s expands prerequisites recursively with exact parent context',
    async (mode) => {
      available = false;
      const scope =
        mode === 'solo' ? await solo() : await room(await register('owner'));
      const anchor = selection(scope.documentId);
      const parent = await run(scope, input({ selection: anchor }));
      for (let index = 0; index < 7; index += 1)
        await run(scope, input({ kind: 'question', question: 'Follow-up ' + index }));
      const reference = { runId: parent.id, prerequisiteId: 'associativity' };
      const child = await run(scope, input({ proofParent: reference }));
      const context = generate.mock.lastCall![0].proofContext;
      expect(context).toMatchObject({
        parentRunId: parent.id,
        claim: PROOF_FIXTURE.claim,
        interpretation: PROOF_FIXTURE.interpretation,
        sourceAnchor: anchor,
        prerequisite: PROOF_FIXTURE.prerequisites[0],
      });
      expect(
        generate.mock
          .lastCall![0].history.slice(-12)
          .some((item) => item.runId === parent.id),
      ).toBe(false);
      expect(child.answer?.proofArtifact).toMatchObject({
        sourceAnchor: anchor,
        parent: reference,
      });
      const grandchild = await run(
        scope,
        input({
          proofParent: { runId: child.id, prerequisiteId: null },
        }),
      );
      expect(grandchild.answer?.proofArtifact?.sourceAnchor).toEqual(anchor);
      expect(generate.mock.lastCall![0].proofContext?.parentRunId).toBe(child.id);
      expect(check).not.toHaveBeenCalled();
      for (const change of [
        { kind: 'question' as const, proofParent: reference },
        { selection: anchor, proofParent: reference },
        { proofParent: { runId: parent.id, prerequisiteId: 'missing' } },
      ]) {
        expect((await request(scope, 'POST', '/runs', input(change))).statusCode).toBe(
          400,
        );
      }
    },
  );

  test('accepts ordinary answers and rejects invented proof references', async () => {
    const scope = await solo();
    const ordinary = await run(scope, input({ kind: 'question' }));
    expect(ordinary.answer).toEqual(answer);
    expect(check).not.toHaveBeenCalled();
    const invalid = structuredClone(PROOF_FIXTURE);
    invalid.steps[0]!.evidenceIds = ['invented'];
    generate.mockResolvedValueOnce({ ...answer, proof: invalid });
    const response = await request(scope, 'POST', '/runs', input());
    const id = response.json<AiRun>().id;
    await vi.waitFor(async () => {
      const failed = (await request(scope, 'GET', '/runs/' + id)).json<AiRun>();
      expect(failed.status).toBe('failed');
      expect(failed.answer).toBeNull();
    });
    expect(check).not.toHaveBeenCalled();
    expect(
      (
        await request(
          scope,
          'POST',
          '/runs',
          input({
            proofParent: { runId: ordinary.id, prerequisiteId: null },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  test('separates checks for equal request IDs in different solo sessions', async () => {
    const first = await solo();
    const second = await solo();
    const payload = input();
    const firstProof = await run(first, payload);
    const secondProof = await run(second, payload);
    const firstCheck = await outcome(first, firstProof);
    const secondCheck = await outcome(second, secondProof);
    expect(firstCheck.id).not.toBe(secondCheck.id);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('deduplicates concurrent checks after runtime setup', async () => {
    available = false;
    const scope = await solo();
    const proof = await run(scope);
    expect((await request(scope, 'GET', checkPath(proof))).json()).toBeNull();
    const sourceHash = proof.answer!.proofArtifact!.sourceHash;
    const unavailable = await request(scope, 'POST', checkPath(proof), { sourceHash });
    expect(unavailable.json<ProofCheck>().status).toBe('unavailable');
    available = true;
    const responses = await Promise.all([
      request(scope, 'POST', checkPath(proof), { sourceHash }),
      request(scope, 'POST', checkPath(proof), { sourceHash }),
    ]);
    expect(responses[0]!.json<ProofCheck>().id).toBe(
      responses[1]!.json<ProofCheck>().id,
    );
    await outcome(scope, proof);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test.each(['incomplete', 'failed'] as const)(
    'retains a %s verdict without retrying or labelling it checked',
    async (status) => {
      check.mockResolvedValueOnce(proofCheckOutcome(status, 'No accepted proof.'));
      const scope = await solo();
      const proof = await run(scope);
      const result = await outcome(scope, proof, status);
      const again = await request(scope, 'POST', checkPath(proof), {
        sourceHash: proof.answer!.proofArtifact!.sourceHash,
      });
      expect(again.json<ProofCheck>().id).toBe(result.id);
      expect(again.json<ProofCheck>().status).toBe(status);
      expect(check).toHaveBeenCalledTimes(1);
    },
  );

  test('cancels late results and aborts checks when leaving the paper', async () => {
    const pending = deferred<ProofCheckResult>();
    check.mockReturnValue(pending.promise);
    const scope = await solo();
    const proof = await run(scope);
    await outcome(scope, proof, 'running');
    const cancelled = await request(scope, 'POST', checkPath(proof) + '/cancel');
    expect(cancelled.json<ProofCheck>().status).toBe('cancelled');
    expect(check.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve(checked);
    await outcome(scope, proof, 'cancelled');
    check.mockReturnValue(new Promise(() => undefined));
    const next = await run(scope);
    await outcome(scope, next, 'running');
    expect((await request(scope, 'DELETE', '/session')).statusCode).toBe(204);
    expect(check.mock.lastCall![1].aborted).toBe(true);
    expect((await request(scope, 'GET', checkPath(next))).statusCode).toBe(401);
  });

  test('shared verdicts and provenance survive restart and database backup', async () => {
    const scope = await room(await register('owner'));
    const proof = await run(scope, input({ selection: selection(scope.documentId) }));
    const verified = await outcome(scope, proof);
    const backup = await createBackup(dbPath);
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try {
      const row = snapshot.prepare('SELECT body FROM proof_checks').get();
      expect(JSON.parse(String(row!.body))).toEqual(verified);
    } finally {
      snapshot.close();
    }
    await app.close();
    app = await start();
    expect(await outcome(scope, proof)).toEqual(verified);
    const state = (await request(scope, 'GET', '')).json<RoomState>();
    expect(state.runs[0]!.answer).toEqual(proof.answer);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test('reports interrupted checks as unconfirmed after restart', async () => {
    const scope = await room(await register('owner'));
    const proof = await run(scope);
    const verified = await outcome(scope, proof);
    await app.close();
    const database = new DatabaseSync(dbPath);
    database
      .prepare('UPDATE proof_checks SET status = ?, body = ?')
      .run(
        'running',
        JSON.stringify({ ...verified, status: 'running', finishedAt: null }),
      );
    database.close();
    app = await start();
    const recovered = await outcome(scope, proof, 'failed');
    expect(recovered.message).toContain('unconfirmed');
    expect(recovered.finishedAt).not.toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
  });

  test('revoking membership stops checks and prevents further access', async () => {
    check.mockReturnValue(new Promise(() => undefined));
    const owner = await register('owner');
    const editor = await register('editor');
    const scope = await room(owner);
    const invite = await request(scope, 'POST', '/invites');
    const editorHeaders = { authorization: 'Bearer ' + editor.token };
    const joined = await app.inject({
      method: 'POST',
      url: '/api/invites/redeem',
      headers: editorHeaders,
      payload: { token: invite.json<{ token: string }>().token },
    });
    expect(joined.statusCode, joined.body).toBe(200);
    const editorScope = { ...scope, headers: editorHeaders };
    const proof = await run(editorScope);
    await outcome(scope, proof, 'running');
    const revoked = await request(scope, 'DELETE', '/members/' + editor.account.id);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(check.mock.lastCall![1].aborted).toBe(true);
    await outcome(scope, proof, 'cancelled');
    expect((await request(editorScope, 'GET', checkPath(proof))).statusCode).toBe(404);
  });
});

describe('bounded proof execution', () => {
  test('caps daily attempts even when callers immediately cancel each job', async () => {
    const executor = new ProofExecutor({
      status: async () => {
        throw new Error('Unused');
      },
      check: async () => new Promise(() => undefined),
    });
    try {
      for (let index = 0; index < 500; index += 1) {
        const key = String(index);
        expect(executor.schedule(key, PROOF_FIXTURE, vi.fn())).toBe(true);
        executor.cancel(key);
      }
      expect(executor.schedule('over-limit', PROOF_FIXTURE, vi.fn())).toBe(false);
    } finally {
      executor.close();
    }
  });

  test('bounds queued jobs and releases capacity on cancellation', async () => {
    const checker: LeanChecker = {
      status: async () => ({
        available: true,
        leanVersion: LEAN_VERSION,
        mathlibVersion: MATHLIB_VERSION,
        message: 'Ready.',
      }),
      check: vi.fn<LeanChecker['check']>(() => new Promise(() => undefined)),
    };
    const executor = new ProofExecutor(checker);
    try {
      for (let index = 0; index < 16; index += 1)
        expect(executor.schedule(String(index), PROOF_FIXTURE, vi.fn())).toBe(true);
      expect(checker.check).toHaveBeenCalledTimes(2);
      expect(executor.schedule('overflow', PROOF_FIXTURE, vi.fn())).toBe(false);
      executor.cancel('0');
      await vi.waitFor(() => expect(checker.check).toHaveBeenCalledTimes(3));
      expect(executor.schedule('replacement', PROOF_FIXTURE, vi.fn())).toBe(true);
    } finally {
      executor.close();
    }
  });

  test.each(['unknown-step', 'oversized'])(
    'fails closed for %s checker output',
    async (kind) => {
      const result: ProofCheckResult =
        kind === 'unknown-step'
          ? { ...checked, steps: [{ stepId: 'invented', before: [], after: [] }] }
          : { ...checked, message: 'x'.repeat(200_001) };
      const executor = new ProofExecutor({
        status: async () => {
          throw new Error('Runtime metadata unreadable.');
        },
        check: async () => result,
      });
      const finish = vi.fn();
      expect((await executor.status()).available).toBe(false);
      executor.schedule('test', PROOF_FIXTURE, finish);
      await vi.waitFor(() =>
        expect(finish).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'failed', steps: [], diagnostics: [] }),
        ),
      );
      executor.close();
    },
  );
});
