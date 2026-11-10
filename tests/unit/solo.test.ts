import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../server/app.ts';
import { ProviderError } from '../../server/provider.ts';
import type { FastifyInstance } from 'fastify';
import type { AiProvider, AiRun, ProviderInput } from '../../src/workspace-contract.ts';

const origin = 'http://127.0.0.1:5173';
const headers = { origin, host: '127.0.0.1:8787' };
const paper = {
  documentId: 'a'.repeat(64),
  title: 'Test paper',
  pages: [{ pageIndex: 0, text: 'A semiring has addition and multiplication.' }],
};
const question = () => ({
  requestId: crypto.randomUUID(),
  question: 'What is a semiring?',
  kind: 'question',
  selection: null,
  image: null,
  externalQuery: null,
});
const generate = vi.fn(async (input: ProviderInput) => ({
  blocks: [{ heading: 'Definition', text: input.question, evidenceIds: ['p0'] }],
  evidence: [
    {
      id: 'p0',
      origin: 'thisPaper' as const,
      title: input.title,
      excerpt: input.pages[0]!.text,
      pageIndex: 0,
      url: null,
      availability: 'excerpt' as const,
    },
  ],
  model: 'fixture',
  usage: { inputTokens: 10, outputTokens: 5 },
}));
const provider: AiProvider = {
  name: 'Test',
  model: 'fixture',
  configured: true,
  generate,
};
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
  generate.mockClear();
});
async function start(enableSolo = true): Promise<void> {
  app = await createApp({
    dbPath: ':memory:',
    enableSolo,
    provider,
    allowedOrigins: [origin, 'https://trusted.example'],
  });
}
async function session(): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/solo/sessions',
    headers,
    payload: paper,
    remoteAddress: '127.0.0.1',
  });
  expect(response.statusCode).toBe(201);
  return {
    ...headers,
    authorization: 'Bearer ' + response.json<{ token: string }>().token,
  };
}

describe('local solo Astra boundary', () => {
  test('requires an enabled loopback server and an allowed reader origin', async () => {
    await start();
    for (const change of [
      { remoteAddress: '192.0.2.1', headers },
      { remoteAddress: '127.0.0.1', headers: { ...headers, host: 'attacker.example' } },
      {
        remoteAddress: '127.0.0.1',
        headers: { ...headers, origin: 'https://evil.test' },
      },
      { remoteAddress: '127.0.0.1', headers: { host: headers.host } },
      {
        remoteAddress: '127.0.0.1',
        headers: { ...headers, 'x-forwarded-for': '192.0.2.1' },
      },
      {
        remoteAddress: '127.0.0.1',
        headers: { ...headers, origin: 'https://trusted.example' },
      },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/solo/sessions',
        payload: paper,
        ...change,
      });
      expect(response.statusCode).toBe(403);
    }
    await app.close();
    await start(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/solo/sessions',
          headers,
          payload: paper,
        })
      ).statusCode,
    ).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });

  test('isolates sessions, deduplicates runs and keeps history', async () => {
    await start();
    const first = await session();
    const second = await session();
    const input = question();
    const send = (payload = input) =>
      app.inject({ method: 'POST', url: '/api/solo/runs', headers: first, payload });
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/solo/runs/' + input.requestId,
        headers: first,
      });
      expect(response.json<AiRun>().status).toBe('completed');
    });
    expect((await send({ ...input, question: 'Changed question' })).statusCode).toBe(
      409,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/solo/runs/' + input.requestId,
          headers: second,
        })
      ).statusCode,
    ).toBe(404);
    await send({ ...question(), question: 'And how is it used?' });
    expect(generate.mock.calls[1]?.[0].history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  test('rejects malformed pages and selections from another paper', async () => {
    await start();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/solo/sessions',
          headers,
          payload: { ...paper, pages: [{ pageIndex: 1, text: 'Wrong index' }] },
        })
      ).statusCode,
    ).toBe(400);
    const auth = await session();
    const result = await app.inject({
      method: 'POST',
      url: '/api/solo/runs',
      headers: auth,
      payload: {
        ...question(),
        selection: {
          documentId: 'b'.repeat(64),
          pageIndex: 0,
          kind: 'text',
          quote: 'Other paper',
          quads: [
            [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ],
          ],
        },
      },
    });
    expect(result.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  test('reports uncertain outcomes without retrying', async () => {
    await start();
    generate.mockRejectedValueOnce(new ProviderError('Provider timed out.', true));
    const auth = await session();
    const input = question();
    await app.inject({
      method: 'POST',
      url: '/api/solo/runs',
      headers: auth,
      payload: input,
    });
    await vi.waitFor(async () => {
      const result = await app.inject({
        method: 'GET',
        headers: auth,
        url: '/api/solo/runs/' + input.requestId,
      });
      expect(result.json<AiRun>().status).toBe('uncertain');
      expect(result.json<AiRun>().error).toBe('Provider timed out.');
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('revokes the ephemeral session when the reader leaves the paper', async () => {
    await start();
    const auth = await session();
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/solo/session', headers: auth }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/solo/runs',
          headers: auth,
          payload: question(),
        })
      ).statusCode,
    ).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  test('caps concurrent work and releases capacity after cancellation', async () => {
    await start();
    generate.mockImplementationOnce(() => new Promise(() => undefined));
    generate.mockImplementationOnce(() => new Promise(() => undefined));
    const auth = await session();
    const first = question();
    const send = (payload = question()) =>
      app.inject({
        method: 'POST',
        url: '/api/solo/runs',
        headers: auth,
        payload,
      });
    expect((await send(first)).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(429);
    await app.inject({
      method: 'POST',
      headers: auth,
      url: '/api/solo/runs/' + first.requestId + '/cancel',
    });
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        headers: auth,
        url: '/api/solo/runs/' + first.requestId,
      });
      expect(response.json<AiRun>().status).toBe('uncertain');
    });
    expect((await send()).statusCode).toBe(202);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  test('expires inactive sessions before accepting another paid request', async () => {
    await start();
    const auth = await session();
    const expired = Date.now() + 61 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(expired);
    const response = await app.inject({
      method: 'POST',
      url: '/api/solo/runs',
      headers: auth,
      payload: question(),
    });
    expect(response.statusCode).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });
});
