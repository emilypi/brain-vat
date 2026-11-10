import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { anchorSchema, MAX_PDF_BYTES } from '../src/document.ts';
import { credentialsSchema, runInputSchema } from '../src/workspace-contract.ts';
import type {
  Account,
  AiProvider,
  GeneratedAnswer,
} from '../src/workspace-contract.ts';
import { AuthenticationBusyError, hashPassword, verifyPassword } from './auth.ts';
import { decodeBase64, extractPdf, PdfImportError } from './pdf-import.ts';
import { createAstraProvider, ProviderError } from './provider.ts';
import { ApiError, WorkspaceStore } from './store.ts';

export interface AppOptions {
  dbPath?: string;
  provider?: AiProvider;
  allowedOrigins?: string[];
  webRoot?: string;
  registrationOpen?: boolean;
}

const idSchema = z.string().uuid();
const roomParams = z.object({ id: idSchema });
const highlightParams = roomParams.extend({ hid: idSchema });
const runParams = roomParams.extend({ runId: idSchema });
const noteSchema = z.string().max(10_000);
const versionSchema = z.number().int().positive();
const safeUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      );
    } catch {
      return false;
    }
  });
const importSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    filename: z.string().trim().min(1).max(255),
    sourceUrl: safeUrl.nullable(),
    pdf: z.string().max(Math.ceil(MAX_PDF_BYTES / 3) * 4),
  })
  .strict();
const answerSchema = z.object({
  blocks: z
    .array(
      z.object({
        heading: z.string().max(500),
        text: z.string().max(30_000),
        evidenceIds: z.array(z.string().max(200)).max(100),
      }),
    )
    .min(1)
    .max(30),
  evidence: z
    .array(
      z.object({
        id: z.string().max(200),
        origin: z.enum(['thisPaper', 'citedReference', 'externalSource']),
        title: z.string().max(1000),
        excerpt: z.string().max(20_000),
        pageIndex: z.number().int().nonnegative().nullable(),
        url: safeUrl.nullable(),
        availability: z.enum(['excerpt', 'metadataOnly']),
      }),
    )
    .max(100),
  model: z.string().max(200),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

function tokenFrom(request: FastifyRequest): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization ?? '',
  );
  if (!match?.[1]) throw new ApiError(401, 'Sign in to continue.');
  return match[1];
}

function validateAnswer(value: GeneratedAnswer, pageCount: number): GeneratedAnswer {
  const answer = answerSchema.parse(value);
  const ids = new Set(answer.evidence.map((source) => source.id));
  if (
    JSON.stringify(answer).length > 500_000 ||
    ids.size !== answer.evidence.length ||
    answer.blocks.some((block) => block.evidenceIds.some((id) => !ids.has(id))) ||
    answer.evidence.some(
      (source) => source.pageIndex !== null && source.pageIndex >= pageCount,
    )
  ) {
    throw new Error('Invalid provider answer.');
  }
  return answer;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const store = new WorkspaceStore(options.dbPath ?? './data/brain-vat.sqlite');
  const provider = options.provider ?? createAstraProvider();
  const registrationOpen = options.registrationOpen ?? false;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const actors = new WeakMap<FastifyRequest, Account>();
  const failedAuthentication = new Map<string, { count: number; expires: number }>();
  const jobs = new Map<string, AbortController>();
  let closing = false;
  const app = Fastify({
    logger: false,
    bodyLimit: 4_000_000,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError || error instanceof PdfImportError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'Invalid request data.' });
    }
    if (error instanceof AuthenticationBusyError) {
      return reply.code(429).send({ error: error.message });
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    const safeStatus = status >= 400 && status < 500 ? status : 500;
    return reply.code(safeStatus).send({
      error:
        safeStatus === 500 ? 'Request could not be completed.' : 'Request rejected.',
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      throw new ApiError(403, 'Origin is not allowed.');
    }
  });
  await app.register(cors, {
    origin: [...allowedOrigins],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url;
    if (!path?.startsWith('/api/')) return;
    if (
      request.method === 'OPTIONS' ||
      ['/api/health', '/api/auth/register', '/api/auth/login'].includes(path ?? '')
    )
      return;
    const now = Date.now();
    let failures = failedAuthentication.get(request.ip);
    if (failures && failures.expires <= now) {
      failedAuthentication.delete(request.ip);
      failures = undefined;
    }
    if (failures && failures.count >= 30) {
      reply.header('Retry-After', Math.ceil((failures.expires - now) / 1000));
      throw new ApiError(429, 'Too many failed sign-in attempts. Try again shortly.');
    }
    try {
      actors.set(request, store.authenticate(tokenFrom(request)));
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        if (failures) {
          failures.count += 1;
        } else {
          // Bound memory even when requests arrive from many different addresses.
          if (failedAuthentication.size >= 1000) {
            const oldest = failedAuthentication.keys().next().value;
            if (oldest !== undefined) failedAuthentication.delete(oldest);
          }
          failedAuthentication.set(request.ip, { count: 1, expires: now + 60_000 });
        }
      }
      throw error;
    }
  });
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: 240,
    timeWindow: '1 minute',
    keyGenerator: (request) => actors.get(request)?.id ?? request.ip,
  });
  const actor = (request: FastifyRequest): Account => {
    const user = actors.get(request);
    if (!user) throw new ApiError(401, 'Sign in to continue.');
    return user;
  };
  const roomId = (request: FastifyRequest) => roomParams.parse(request.params).id;
  const abort = (ids: string[]) => {
    for (const id of ids) jobs.get(id)?.abort();
  };

  async function executeRun(runId: string): Promise<void> {
    const controller = new AbortController();
    jobs.set(runId, controller);
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    timer.unref();
    try {
      if (closing) return;
      const input = store.dispatch(runId);
      if (!input) return;
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(new ProviderError('Provider execution interrupted.', true));
          },
          { once: true },
        );
      });
      const answer = await Promise.race([
        provider.generate(input, controller.signal),
        interrupted,
      ]);
      if (closing) return;
      if (controller.signal.aborted) {
        store.finishRun(runId, {
          status: 'uncertain',
          error: 'Provider outcome was not confirmed before the request ended.',
        });
      } else {
        store.finishRun(runId, { answer: validateAnswer(answer, input.pages.length) });
      }
    } catch (error) {
      if (!closing) {
        const uncertain =
          controller.signal.aborted ||
          (error instanceof ProviderError && error.uncertain);
        store.finishRun(runId, {
          status: uncertain ? 'uncertain' : 'failed',
          error: uncertain
            ? 'Provider outcome is uncertain. It has not been retried.'
            : error instanceof ApiError
              ? error.message
              : 'AI request failed. No answer was published.',
        });
      }
    } finally {
      clearTimeout(timer);
      jobs.delete(runId);
    }
  }

  app.addHook('onClose', async () => {
    closing = true;
    abort([...jobs.keys()]);
    store.close();
  });
  app.get('/api/health', async () => ({
    provider: provider.name,
    model: provider.model,
    configured: provider.configured,
    registrationOpen: store.registrationAvailable(registrationOpen),
  }));
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/api/auth/register', authLimit, async (request, reply) => {
    const input = credentialsSchema.strict().parse(request.body);
    if (!store.registrationAvailable(registrationOpen) && !input.inviteToken) {
      throw new ApiError(403, 'An invitation is required to create an account.');
    }
    const hash = await hashPassword(input.password);
    const session = store.register(
      input.username,
      hash,
      registrationOpen,
      input.inviteToken,
    );
    return reply.code(201).send(session);
  });
  app.post('/api/auth/login', authLimit, async (request) => {
    const input = credentialsSchema
      .omit({ inviteToken: true })
      .strict()
      .parse(request.body);
    const hash = store.passwordFor(input.username);
    if (!(await verifyPassword(input.password, hash))) {
      throw new ApiError(401, 'Invalid username or password.');
    }
    return store.login(input.username);
  });
  app.get('/api/auth/me', async (request) => actor(request));
  app.post('/api/auth/logout', async (request) => {
    store.logout(tokenFrom(request));
    return { ok: true };
  });
  app.get('/api/rooms', async (request) => store.rooms(actor(request).id));
  app.post(
    '/api/rooms',
    {
      bodyLimit: Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4096,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { pdf, ...metadata } = importSchema.parse(request.body);
      const bytes = decodeBase64(pdf, MAX_PDF_BYTES);
      const pages = await extractPdf(bytes);
      const user = store.authenticate(tokenFrom(request));
      return reply.code(201).send(store.createRoom(user.id, metadata, bytes, pages));
    },
  );
  app.get('/api/rooms/:id', async (request) =>
    store.state(roomId(request), actor(request).id),
  );
  app.get('/api/rooms/:id/pdf', async (request, reply) => {
    const bytes = store.pdf(roomId(request), actor(request).id);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', 'inline; filename="paper.pdf"')
      .send(bytes);
  });
  app.delete('/api/rooms/:id', async (request) => {
    abort(store.deleteRoom(roomId(request), actor(request).id));
    return { ok: true };
  });
  app.post('/api/rooms/:id/invites', async (request) =>
    store.invite(roomId(request), actor(request).id),
  );
  app.delete('/api/rooms/:id/invites', async (request) => {
    store.revokeInvites(roomId(request), actor(request).id);
    return { ok: true };
  });
  app.post('/api/invites/redeem', async (request) => {
    const input = z
      .object({ token: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    return store.redeem(input.token, actor(request).id);
  });
  app.delete('/api/rooms/:id/members/:userId', async (request) => {
    const params = roomParams.extend({ userId: idSchema }).parse(request.params);
    abort(store.removeMember(params.id, actor(request).id, params.userId));
    return { ok: true };
  });
  app.post('/api/rooms/:id/highlights', async (request) => {
    const input = z
      .object({ id: idSchema, anchor: anchorSchema, note: noteSchema })
      .strict()
      .parse(request.body);
    return store.highlight(roomId(request), actor(request), input);
  });
  app.patch('/api/rooms/:id/highlights/:hid', async (request) => {
    const { id, hid } = highlightParams.parse(request.params);
    const input = z
      .object({ version: versionSchema, note: noteSchema })
      .strict()
      .parse(request.body);
    return store.editHighlight(id, actor(request).id, hid, input.version, input.note);
  });
  app.delete('/api/rooms/:id/highlights/:hid', async (request) => {
    const { id, hid } = highlightParams.parse(request.params);
    const input = z.object({ version: versionSchema }).strict().parse(request.body);
    store.editHighlight(id, actor(request).id, hid, input.version, null);
    return { ok: true };
  });
  app.post('/api/rooms/:id/messages', async (request) => {
    const input = z
      .object({
        id: idSchema,
        text: z.string().trim().min(1).max(10_000),
      })
      .strict()
      .parse(request.body);
    return store.message(roomId(request), actor(request), input.id, input.text);
  });
  app.post('/api/rooms/:id/runs', async (request, reply) => {
    const input = runInputSchema.strict().parse(request.body);
    if (input.image !== null) {
      const prefix = 'data:image/png;base64,';
      if (input.selection?.kind !== 'region' || !input.image.startsWith(prefix)) {
        throw new ApiError(400, 'An image must be a PNG crop of a selected region.');
      }
      const bytes = decodeBase64(input.image.slice(prefix.length), 2_250_000);
      if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new ApiError(400, 'Invalid PNG image.');
      }
    }
    const result = store.beginRun(
      roomId(request),
      actor(request),
      input,
      provider.configured,
    );
    if (result.fresh) {
      // Persistent acceptance precedes dispatch; reconnects observe the same run.
      setImmediate(() => {
        void executeRun(result.run.id).catch(() => {
          // A durable storage failure leaves the run uncertain on next startup.
        });
      });
    }
    return reply.code(202).send(result.run);
  });
  app.post('/api/rooms/:id/runs/:runId/cancel', async (request) => {
    const params = runParams.parse(request.params);
    const result = store.cancelRun(params.id, actor(request).id, params.runId);
    abort([params.runId]);
    return result;
  });
  app.post('/api/rooms/:id/notes', async (request) => {
    const input = z
      .object({ update: z.string().max(1_333_336) })
      .strict()
      .parse(request.body);
    const update = decodeBase64(input.update, 1_000_000);
    const state = store.mergeNotes(roomId(request), actor(request).id, update);
    return { update: Buffer.from(state).toString('base64') };
  });
  app.post('/api/rooms/:id/presence', async (request) => {
    const input = z
      .object({ pageIndex: z.number().int().nonnegative().nullable() })
      .strict()
      .parse(request.body);
    store.setPresence(roomId(request), actor(request).id, input.pageIndex);
    return { ok: true };
  });
  return app;
}
