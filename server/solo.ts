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
import { ProviderError } from './provider.ts';

const paperSchema = z
  .object({
    documentId: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(500),
    pages: z
      .array(
        z
          .object({
            pageIndex: z.number().int().min(0).max(299),
            text: z.string().max(2_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict()
  .refine(
    (value) =>
      value.pages.every((page, index) => page.pageIndex === index) &&
      value.pages.reduce((sum, page) => sum + page.text.length, 0) <= 2_000_000,
  );
type SoloPaper = z.infer<typeof paperSchema>;
interface SoloSession {
  id: string;
  closed: boolean;
  paper: SoloPaper;
  expires: number;
  runs: Map<string, { run: AiRun; digest: string; controller: AbortController }>;
  checks: Map<string, ProofCheck>;
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

/** Ephemeral solo sessions are available only on an explicitly local server. */
export async function registerSolo(
  app: FastifyInstance,
  provider: AiProvider,
  enabled: boolean,
  allowedOrigins: Set<string>,
  validate: (answer: GeneratedAnswer, pageCount: number) => GeneratedAnswer,
  proofs: ProofExecutor,
): Promise<void> {
  const sessions = new Map<string, SoloSession>();
  let active = 0;
  let startedToday = 0;
  let day = new Date().toISOString().slice(0, 10);
  const actors = new WeakMap<FastifyRequest, SoloSession>();
  const dispose = (token: string, session: SoloSession): void => {
    session.closed = true;
    for (const item of session.runs.values()) {
      item.controller.abort();
      proofs.cancel('solo:' + session.id + ':' + item.run.id);
    }
    sessions.delete(token);
  };
  const sweep = (): void => {
    for (const [token, session] of sessions) {
      if (session.expires <= Date.now()) dispose(token, session);
    }
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const [token, session] of sessions) dispose(token, session);
  });

  const proofRun = (session: SoloSession, runId: string): AiRun => {
    const run = session.runs.get(runId)?.run;
    if (!run) throw new ApiError(404, 'Proof not found in this session.');
    if (run.status !== 'completed' || !run.answer?.proof || !run.answer.proofArtifact)
      throw new ApiError(409, 'A completed proof is required for verification.');
    return run;
  };
  const startCheck = async (
    session: SoloSession,
    runId: string,
    sourceHash: string,
    automatic = false,
  ): Promise<ProofCheck | null> => {
    const run = proofRun(session, runId);
    const proof = run.answer!.proof!;
    if (
      run.answer!.proofArtifact!.sourceHash !== sourceHash ||
      proofSourceHash(proof) !== sourceHash
    )
      throw new ApiError(409, 'The requested source does not match this proof.');
    const health = await proofs.status();
    if (session.closed) throw new ApiError(401, 'Solo session expired.');
    const prior = session.checks.get(runId);
    if (automatic && (!health.available || prior)) return prior ?? null;
    if (prior && !(prior.status === 'unavailable' && health.available)) return prior;
    const check = newProofCheck(runId, sourceHash);
    session.checks.set(runId, check);
    const finish = (result: ProofCheckResult): void => {
      if (
        !session.closed &&
        session.checks.get(runId)?.id === check.id &&
        session.checks.get(runId)?.status === 'running'
      )
        session.checks.set(runId, {
          ...check,
          ...result,
          finishedAt: new Date().toISOString(),
        });
    };
    if (!health.available) finish(proofCheckOutcome('unavailable', health.message));
    else if (!proofs.schedule('solo:' + session.id + ':' + runId, proof, finish))
      finish(
        proofCheckOutcome(
          'unavailable',
          'Lean verification is busy or at its daily limit. Try again later.',
        ),
      );
    return session.checks.get(runId)!;
  };

  await app.register(
    async (solo) => {
      solo.addHook('onRequest', async (request) => {
        if (!enabled || !localRequest(request)) {
          throw new ApiError(403, 'Solo AI is available only on the local server.');
        }
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
          throw new ApiError(403, 'Open the local reader to use solo AI.');
        }
        sweep();
        if (
          request.routeOptions.url === '/api/solo/sessions' &&
          request.method === 'POST'
        ) {
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
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const session = sessions.get(token);
        if (!session)
          throw new ApiError(401, 'Solo session expired. Reopen the paper.');
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
          if (!provider.configured) throw new ApiError(503, 'Astra is not configured.');
          if (sessions.size >= 8) throw new ApiError(429, 'Too many open solo papers.');
          const paper = paperSchema.parse(request.body);
          const token = randomBytes(32).toString('base64url');
          sessions.set(token, {
            id: randomUUID(),
            closed: false,
            paper,
            expires: Date.now() + 60 * 60_000,
            runs: new Map(),
            checks: new Map(),
          });
          return reply.code(201).send({ token });
        },
      );

      solo.delete('/session', async (request, reply) => {
        const token = request.headers.authorization!.slice(7);
        dispose(token, actors.get(request)!);
        return reply.code(204).send();
      });

      solo.post('/runs', async (request, reply) => {
        const session = actors.get(request)!;
        const input = runInputSchema.strict().parse(request.body);
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const existing = session.runs.get(input.requestId);
        if (existing) {
          if (existing.digest !== digest) throw new ApiError(409, 'Request ID reused.');
          return existing.run;
        }
        if (input.proofParent && input.kind !== 'proof')
          throw new ApiError(400, 'A proof parent requires a proof request.');
        if (input.proofParent && (input.selection || input.image))
          throw new ApiError(400, 'A prerequisite uses its parent proof’s source.');
        const parent = input.proofParent
          ? session.runs.get(input.proofParent.runId)?.run
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
          (input.selection.documentId !== session.paper.documentId ||
            input.selection.pageIndex >= session.paper.pages.length)
        ) {
          throw new ApiError(400, 'The selection belongs to another paper.');
        }
        const today = new Date().toISOString().slice(0, 10);
        if (day !== today) {
          day = today;
          startedToday = 0;
        }
        if (active >= 2 || startedToday >= 100 || session.runs.size >= 30) {
          throw new ApiError(429, 'Solo AI limit reached. Try again later.');
        }
        const history: ChatMessage[] = [...session.runs.values()]
          .flatMap(({ run }) => {
            if (!run.answer) return [];
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
          ...session.paper,
          history,
          ...(proofContext ? { proofContext } : {}),
        };
        session.runs.set(run.id, { run, digest, controller });
        active += 1;
        startedToday += 1;
        const deadline = setTimeout(() => controller.abort(), 150_000);
        void (async () => {
          try {
            const interrupted = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => {
                  reject(new ProviderError('The request was interrupted.', true));
                },
                { once: true },
              );
            });
            const answer = await Promise.race([
              provider.generate(providerInput, controller.signal),
              interrupted,
            ]);
            if (controller.signal.aborted)
              throw new ProviderError('Interrupted.', true);
            run.answer = attachProofArtifact(
              validate(answer, session.paper.pages.length),
              providerInput,
            );
            run.status = 'completed';
            if (run.answer.proofArtifact)
              void startCheck(
                session,
                run.id,
                run.answer.proofArtifact.sourceHash,
                true,
              ).catch(() => undefined);
          } catch (error) {
            run.status =
              controller.signal.aborted ||
              (error instanceof ProviderError && error.uncertain)
                ? 'uncertain'
                : 'failed';
            run.error =
              error instanceof ProviderError
                ? error.message
                : 'Astra could not complete this answer.';
          } finally {
            active -= 1;
            clearTimeout(deadline);
          }
        })();
        return reply.code(202).send(run);
      });

      solo.get('/runs/:id', async (request) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const item = actors.get(request)!.runs.get(id);
        if (!item) throw new ApiError(404, 'Question not found in this session.');
        return item.run;
      });
      solo.post('/runs/:id/cancel', async (request) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const item = actors.get(request)!.runs.get(id);
        if (!item) throw new ApiError(404, 'Question not found in this session.');
        if (item.run.status === 'running') item.controller.abort();
        return item.run;
      });
      const paramsSchema = z.object({ id: z.string().uuid() });
      solo.get('/runs/:id/proof-check', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const session = actors.get(request)!;
        proofRun(session, id);
        return session.checks.get(id) ?? null;
      });
      solo.post('/runs/:id/proof-check', async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        const { sourceHash } = z
          .strictObject({
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(request.body);
        const check = await startCheck(actors.get(request)!, id, sourceHash);
        return reply.code(check?.status === 'running' ? 202 : 200).send(check);
      });
      solo.post('/runs/:id/proof-check/cancel', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const session = actors.get(request)!;
        proofRun(session, id);
        const check = session.checks.get(id);
        if (!check) throw new ApiError(404, 'No verification exists for this proof.');
        if (check.status !== 'running') return check;
        const cancelled: ProofCheck = {
          ...check,
          ...proofCheckOutcome('cancelled', 'Lean verification was cancelled.'),
          finishedAt: new Date().toISOString(),
        };
        session.checks.set(id, cancelled);
        proofs.cancel('solo:' + session.id + ':' + id);
        return cancelled;
      });
    },
    { prefix: '/api/solo' },
  );
}
