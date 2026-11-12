import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runInputSchema } from '../src/workspace-contract.ts';
import type {
  AiProvider,
  AiRun,
  ChatMessage,
  GeneratedAnswer,
  ProviderInput,
} from '../src/workspace-contract.ts';
import type { SavedContextCreated, SavedContextSummary } from '../src/saved-context.ts';
import type { ProofCheck, ProofCheckResult } from '../src/proof.ts';
import {
  attachProofArtifact,
  newProofCheck,
  proofCheckOutcome,
  proofContextFor,
  proofSourceHash,
} from './proofs.ts';
import type { ProofExecutor } from './proofs.ts';
import { ApiError } from './store.ts';
import type { WorkspaceStore } from './store.ts';
import { ProviderError } from './provider.ts';
import {
  interruptStoredContext,
  MAX_SAVED_RUNS,
  rememberedProofs,
  soloPaperSchema,
} from './solo-contexts.ts';
import type {
  SoloPaper,
  StoredSoloContext,
  StoredSoloRecord,
} from './solo-contexts.ts';

interface SoloRun {
  run: AiRun;
  digest: string;
  controller: AbortController;
}
interface SoloState {
  id: string;
  closed: boolean;
  paper: SoloPaper;
  runs: Map<string, SoloRun>;
  checks: Map<string, ProofCheck>;
  context: SavedContextSummary | null;
}
interface SoloSession {
  state: SoloState;
  expires: number;
  saved?: { requestId: string; name: string; result: SavedContextCreated };
}

export function localRequest(request: FastifyRequest): boolean {
  if (
    request.headers.forwarded ||
    request.headers['x-forwarded-for'] ||
    request.headers['x-forwarded-host']
  )
    return false;
  const address = request.raw.socket.remoteAddress;
  const local =
    address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  try {
    const host = new URL('http://' + request.headers.host).hostname;
    return local && ['localhost', '127.0.0.1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

function bearer(request: FastifyRequest): string {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization ?? '',
  )?.[1];
  if (!token) throw new ApiError(401, 'Reader access is missing or expired.');
  return token;
}

function stored(state: SoloState): StoredSoloContext {
  return {
    paper: state.paper,
    runs: [...state.runs.values()].map(({ run, digest }) => ({ run, digest })),
    checks: [...state.checks.values()],
  };
}

function publicState(state: SoloState) {
  if (state.closed) throw new ApiError(401, 'This reading context is closed.');
  return {
    context: state.context,
    runs: [...state.runs.values()].map(({ run }) => run),
  };
}

/** Solo access remains local; saved capabilities are distinct from session tokens. */
export async function registerSolo(
  app: FastifyInstance,
  provider: AiProvider,
  enabled: boolean,
  allowedOrigins: Set<string>,
  validate: (answer: GeneratedAnswer, pageCount: number) => GeneratedAnswer,
  proofs: ProofExecutor,
  store: WorkspaceStore,
): Promise<() => void> {
  const sessions = new Map<string, SoloSession>();
  const contexts = new Map<string, SoloState>();
  let active = 0;
  let startedToday = 0;
  let day = new Date().toISOString().slice(0, 10);
  const actors = new WeakMap<FastifyRequest, SoloSession>();
  const actorSession = (request: FastifyRequest): SoloSession => {
    const session = actors.get(request);
    if (!session || session.state.closed || sessions.get(bearer(request)) !== session)
      throw new ApiError(401, 'This reading session is closed.');
    return session;
  };
  const actorState = (request: FastifyRequest): SoloState =>
    actorSession(request).state;
  const savedRecord = (request: FastifyRequest): StoredSoloRecord => {
    const { id } = z.strictObject({ id: z.string().uuid() }).parse(request.params);
    return store.soloContext(id, bearer(request));
  };

  const commit = (
    state: SoloState,
    change: Partial<Pick<SoloState, 'runs' | 'checks'>>,
    name?: string,
  ): void => {
    if (state.closed) throw new ApiError(401, 'This reading context is closed.');
    const next = { ...state, ...change };
    // Commit before publishing the state or dispatching any paid/verified work.
    if (state.context)
      next.context = store.updateSoloContext(state.id, stored(next), name);
    Object.assign(state, next);
  };
  const abortState = (state: SoloState): void => {
    state.closed = true;
    for (const item of state.runs.values()) {
      item.controller.abort();
      proofs.cancel('solo:' + state.id + ':' + item.run.id);
    }
    for (const [token, session] of sessions) {
      if (session.state === state) sessions.delete(token);
    }
    contexts.delete(state.id);
  };
  const stop = (state: SoloState): void => {
    if (state.closed) return;
    const snapshot = stored(state);
    if (interruptStoredContext(snapshot)) {
      const runs = new Map(state.runs);
      for (const entry of snapshot.runs) {
        runs.set(entry.run.id, { ...runs.get(entry.run.id)!, ...entry });
      }
      try {
        commit(state, {
          runs,
          checks: new Map(snapshot.checks.map((check) => [check.runId, check])),
        });
      } finally {
        abortState(state);
      }
    } else abortState(state);
  };
  const detach = (token: string, session: SoloSession): void => {
    sessions.delete(token);
    // Saved work finishes durably even if its last browser tab closes.
    if (!session.state.context) stop(session.state);
  };
  const sweep = (): void => {
    for (const [token, session] of sessions) {
      if (session.expires <= Date.now()) detach(token, session);
    }
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  const attach = (state: SoloState): string => {
    if (sessions.size >= 8) throw new ApiError(429, 'Too many open solo papers.');
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { state, expires: Date.now() + 60 * 60_000 });
    return token;
  };
  const canonical = (record: StoredSoloRecord): SoloState => {
    const prior = contexts.get(record.summary.id);
    if (prior) return prior;
    // Live work always has canonical state. Uncached running records are orphaned.
    if (interruptStoredContext(record.state))
      record.summary = store.updateSoloContext(record.summary.id, record.state);
    const state: SoloState = {
      id: record.summary.id,
      closed: false,
      paper: record.state.paper,
      context: record.summary,
      runs: new Map(
        record.state.runs.map((entry) => [
          entry.run.id,
          { ...entry, controller: new AbortController() },
        ]),
      ),
      checks: new Map(record.state.checks.map((check) => [check.runId, check])),
    };
    contexts.set(state.id, state);
    return state;
  };
  const updateRun = (state: SoloState, run: AiRun): void => {
    const entry = state.runs.get(run.id)!;
    const runs = new Map(state.runs);
    runs.set(run.id, { ...entry, run });
    commit(state, { runs });
  };
  const updateCheck = (state: SoloState, check: ProofCheck): void => {
    const checks = new Map(state.checks);
    checks.set(check.runId, check);
    commit(state, { checks });
  };
  const proofRun = (state: SoloState, runId: string): AiRun => {
    if (state.closed) throw new ApiError(401, 'This reading context is closed.');
    const run = state.runs.get(runId)?.run;
    if (!run) throw new ApiError(404, 'Proof not found in this session.');
    if (run.status !== 'completed' || !run.answer?.proof || !run.answer.proofArtifact)
      throw new ApiError(409, 'A completed proof is required for verification.');
    return run;
  };
  const startCheck = async (
    state: SoloState,
    runId: string,
    sourceHash: string,
    automatic = false,
  ): Promise<ProofCheck | null> => {
    const run = proofRun(state, runId);
    const proof = run.answer!.proof!;
    if (
      run.answer!.proofArtifact!.sourceHash !== sourceHash ||
      proofSourceHash(proof) !== sourceHash
    )
      throw new ApiError(
        409,
        'This is a historical proof revision. Create a new walkthrough to recheck.',
      );
    const health = await proofs.status();
    if (state.closed) throw new ApiError(401, 'Solo session expired.');
    const prior = state.checks.get(runId);
    if (automatic && (!health.available || prior)) return prior ?? null;
    if (prior && !(prior.status === 'unavailable' && health.available)) return prior;
    const check = newProofCheck(runId, sourceHash);
    updateCheck(state, check);
    const finish = (result: ProofCheckResult): void => {
      if (
        state.closed ||
        state.checks.get(runId)?.id !== check.id ||
        state.checks.get(runId)?.status !== 'running'
      )
        return;
      try {
        updateCheck(state, {
          ...check,
          ...result,
          finishedAt: new Date().toISOString(),
        });
      } catch {
        // A failed durable write cannot publish a successful verification.
        abortState(state);
      }
    };
    if (!health.available) finish(proofCheckOutcome('unavailable', health.message));
    else if (!proofs.schedule('solo:' + state.id + ':' + runId, proof, finish))
      finish(
        proofCheckOutcome(
          'unavailable',
          'Lean verification is busy or at its daily limit. Try again later.',
        ),
      );
    if (state.closed) throw new ApiError(503, 'Could not save verification results.');
    return state.checks.get(runId)!;
  };

  await app.register(
    async (solo) => {
      solo.addHook('onRequest', async (request) => {
        if (!enabled || !localRequest(request))
          throw new ApiError(403, 'Solo AI is available only on the local server.');
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin))
          throw new ApiError(403, 'Open the local reader to use solo AI.');
        sweep();
        const route = request.routeOptions.url;
        if (route === '/api/solo/sessions' && request.method === 'POST') {
          if (!request.headers.origin)
            throw new ApiError(403, 'Reader origin required.');
          const origin = new URL(request.headers.origin);
          if (
            origin.protocol !== 'chrome-extension:' &&
            !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
          )
            throw new ApiError(403, 'Use the local reader for solo AI.');
          return;
        }
        if (route?.startsWith('/api/solo/contexts/:id')) {
          savedRecord(request);
          return;
        }
        const session = sessions.get(bearer(request));
        if (!session || session.state.closed)
          throw new ApiError(401, 'Solo session expired. Reopen the paper or context.');
        session.expires = Date.now() + 60 * 60_000;
        actors.set(request, session);
      });

      solo.post(
        '/sessions',
        {
          bodyLimit: 12_000_000,
          config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        },
        async (request, reply) => {
          const paper = soloPaperSchema.parse(request.body);
          const token = attach({
            id: randomUUID(),
            closed: false,
            paper,
            context: null,
            runs: new Map(),
            checks: new Map(),
          });
          return reply.code(201).send({ token });
        },
      );
      solo.get('/session', async (request) => {
        const { revision } = z
          .strictObject({ revision: z.coerce.number().int().positive().optional() })
          .parse(request.query);
        const state = actorState(request);
        if (state.context && state.context.revision === revision)
          return { context: state.context, runs: null };
        return publicState(state);
      });
      solo.delete('/session', async (request, reply) => {
        detach(bearer(request), actorSession(request));
        return reply.code(204).send();
      });
      const nameSchema = z.string().trim().min(1).max(80);
      solo.post('/context', async (request, reply) => {
        const { requestId, name } = z
          .strictObject({ requestId: z.string().uuid(), name: nameSchema })
          .parse(request.body);
        const session = actorSession(request);
        if (session.saved) {
          if (session.saved.requestId !== requestId || session.saved.name !== name)
            throw new ApiError(409, 'This session is already saved as a context.');
          return session.saved.result;
        }
        const state = session.state;
        if (state.context)
          throw new ApiError(
            409,
            'This context is already saved and updates automatically.',
          );
        const capability = randomBytes(32).toString('base64url');
        const context = store.createSoloContext(
          state.id,
          capability,
          name,
          stored(state),
        );
        state.context = context;
        contexts.set(state.id, state);
        const result = { context, capability };
        session.saved = { requestId, name, result };
        return reply.code(201).send(result);
      });
      solo.post('/contexts/:id/open', async (request, reply) => {
        const { documentId } = z
          .strictObject({ documentId: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(request.body);
        const record = savedRecord(request);
        if (record.summary.documentId !== documentId)
          throw new ApiError(409, 'This saved context belongs to a different PDF.');
        const state = canonical(record);
        const token = attach(state);
        return reply.code(201).send({ ...publicState(state), token });
      });
      solo.patch('/contexts/:id', async (request) => {
        const { name } = z.strictObject({ name: nameSchema }).parse(request.body);
        const state = canonical(savedRecord(request));
        commit(state, {}, name);
        return state.context;
      });
      solo.delete('/contexts/:id', async (request, reply) => {
        const state = canonical(savedRecord(request));
        store.deleteSoloContext(state.id);
        abortState(state);
        return reply.code(204).send();
      });

      solo.post('/runs', async (request, reply) => {
        const state = actorState(request);
        const input = runInputSchema.strict().parse(request.body);
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const existing = state.runs.get(input.requestId);
        if (existing) {
          if (existing.digest !== digest) throw new ApiError(409, 'Request ID reused.');
          return existing.run;
        }
        if (!provider.configured) throw new ApiError(503, 'Astra is not configured.');
        if (input.proofParent && input.kind !== 'proof')
          throw new ApiError(400, 'A proof parent requires a proof request.');
        if (input.proofParent && (input.selection || input.image))
          throw new ApiError(400, 'A prerequisite uses its parent proof’s source.');
        const parent = input.proofParent
          ? state.runs.get(input.proofParent.runId)?.run
          : undefined;
        if (input.proofParent && !parent)
          throw new ApiError(404, 'Parent proof not found in this session.');
        const proofContext =
          input.proofParent && parent
            ? proofContextFor(parent, input.proofParent)
            : null;
        if (input.proofParent && !proofContext)
          throw new ApiError(400, 'The parent proof or prerequisite is unavailable.');
        if (
          input.selection &&
          (input.selection.documentId !== state.paper.documentId ||
            input.selection.pageIndex >= state.paper.pages.length)
        )
          throw new ApiError(400, 'The selection belongs to another paper.');
        const today = new Date().toISOString().slice(0, 10);
        if (day !== today) {
          day = today;
          startedToday = 0;
        }
        const runLimit = state.context ? MAX_SAVED_RUNS : 30;
        if (state.runs.size >= runLimit)
          throw new ApiError(
            429,
            `This context has ${runLimit} questions. Start a new context to continue.`,
          );
        if (active >= 2 || startedToday >= 100)
          throw new ApiError(429, 'Solo AI limit reached. Try again later.');
        const history: ChatMessage[] = [...state.runs.values()]
          .flatMap(({ run }) => {
            if (run.status !== 'completed' || !run.answer) return [];
            return (['user', 'assistant'] as const).map((role) => ({
              id: randomUUID(),
              authorId: 'solo',
              authorName: role,
              role,
              text:
                role === 'user'
                  ? run.question
                  : run.answer!.blocks.map((block) => block.text).join('\n'),
              createdAt: run.createdAt,
              runId: run.id,
              answer: null,
            }));
          })
          .slice(-12);
        const run: AiRun = {
          id: input.requestId,
          requestId: input.requestId,
          authorId: 'solo',
          kind: input.kind,
          question: input.question,
          status: 'running',
          createdAt: new Date().toISOString(),
          answer: null,
          error: null,
        };
        const controller = new AbortController();
        const providerInput: ProviderInput = {
          ...input,
          ...state.paper,
          history,
          ...(proofContext ? { proofContext } : {}),
          ...(state.context
            ? {
                rememberedProofs: rememberedProofs(
                  [...state.runs.values()].map(({ run }) => run),
                  state.checks,
                  input.selection?.pageIndex ?? proofContext?.sourceAnchor?.pageIndex,
                ),
              }
            : {}),
        };
        const runs = new Map(state.runs);
        runs.set(run.id, { run, digest, controller });
        commit(state, { runs });
        active += 1;
        startedToday += 1;
        const deadline = setTimeout(() => controller.abort(), 150_000);
        void (async () => {
          try {
            const interrupted = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(new ProviderError('The request was interrupted.', true)),
                { once: true },
              );
            });
            const answer = await Promise.race([
              provider.generate(providerInput, controller.signal),
              interrupted,
            ]);
            if (state.closed || state.runs.get(run.id)?.run.status !== 'running')
              return;
            if (controller.signal.aborted)
              throw new ProviderError('Interrupted.', true);
            const completed: AiRun = {
              ...run,
              status: 'completed',
              answer: attachProofArtifact(
                validate(answer, state.paper.pages.length),
                providerInput,
              ),
            };
            updateRun(state, completed);
            if (completed.answer?.proofArtifact)
              await startCheck(
                state,
                run.id,
                completed.answer.proofArtifact.sourceHash,
                true,
              );
          } catch (error) {
            if (state.closed || state.runs.get(run.id)?.run.status !== 'running')
              return;
            try {
              updateRun(state, {
                ...run,
                status:
                  controller.signal.aborted ||
                  (error instanceof ProviderError && error.uncertain)
                    ? 'uncertain'
                    : 'failed',
                error:
                  error instanceof ProviderError
                    ? error.message
                    : 'Astra could not complete or save this answer.',
              });
            } catch {
              abortState(state);
            }
          } finally {
            active -= 1;
            clearTimeout(deadline);
          }
        })();
        return reply.code(202).send(run);
      });

      const paramsSchema = z.strictObject({ id: z.string().uuid() });
      solo.get('/runs/:id', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const item = actorState(request).runs.get(id);
        if (!item) throw new ApiError(404, 'Question not found in this session.');
        return item.run;
      });
      solo.post('/runs/:id/cancel', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const state = actorState(request);
        const item = state.runs.get(id);
        if (!item) throw new ApiError(404, 'Question not found in this session.');
        if (item.run.status === 'running') {
          updateRun(state, {
            ...item.run,
            status: 'uncertain',
            error: 'The request was cancelled; the provider outcome is uncertain.',
          });
          item.controller.abort();
        }
        return state.runs.get(id)!.run;
      });
      solo.get('/runs/:id/proof-check', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const state = actorState(request);
        proofRun(state, id);
        return state.checks.get(id) ?? null;
      });
      solo.post('/runs/:id/proof-check', async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        const { sourceHash } = z
          .strictObject({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(request.body);
        const check = await startCheck(actorState(request), id, sourceHash);
        return reply.code(check?.status === 'running' ? 202 : 200).send(check);
      });
      solo.post('/runs/:id/proof-check/cancel', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const state = actorState(request);
        proofRun(state, id);
        const check = state.checks.get(id);
        if (!check) throw new ApiError(404, 'No verification exists for this proof.');
        if (check.status !== 'running') return check;
        const cancelled: ProofCheck = {
          ...check,
          ...proofCheckOutcome('cancelled', 'Lean verification was cancelled.'),
          finishedAt: new Date().toISOString(),
        };
        updateCheck(state, cancelled);
        proofs.cancel('solo:' + state.id + ':' + id);
        return cancelled;
      });
    },
    { prefix: '/api/solo' },
  );
  return () => {
    clearInterval(timer);
    const states = new Set([
      ...contexts.values(),
      ...[...sessions.values()].map((session) => session.state),
    ]);
    let failure: unknown;
    for (const state of states) {
      try {
        stop(state);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
}
