import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/app.ts';
import { ProviderError } from '../../server/provider.ts';
import type { Anchor } from '../../src/document.ts';
import type {
  AiProvider,
  AiRun,
  GeneratedAnswer,
  RoomState,
  RoomSummary,
  RunInput,
  Session,
} from '../../src/workspace-contract.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const PASSWORD = 'a long test password';
const ANSWER: GeneratedAnswer = {
  blocks: [
    {
      heading: 'Definition',
      text: 'A semiring has two operations.',
      evidenceIds: ['paper-0'],
    },
  ],
  evidence: [
    {
      id: 'paper-0',
      origin: 'thisPaper',
      title: 'Page 1',
      excerpt: 'A semiring has addition and multiplication.',
      pageIndex: 0,
      url: null,
      availability: 'excerpt',
    },
  ],
  model: 'test-model',
  usage: { inputTokens: 20, outputTokens: 10 },
};

// Real, tiny PDF with a cross-reference table; imports still use the subprocess.
function pdfFixture(): Buffer {
  const stream =
    'BT /F1 12 Tf 20 100 Td (A semiring has addition and multiplication.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  content += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}

function selection(room: RoomSummary): Anchor {
  return {
    documentId: room.documentId,
    pageIndex: 0,
    kind: 'text',
    quote: 'semiring',
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

function runInput(): RunInput {
  return {
    requestId: randomUUID(),
    question: 'Define semiring.',
    kind: 'question',
    selection: null,
    image: null,
    externalQuery: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('shared workspace API', () => {
  let app: FastifyInstance;
  let directory: string;
  let dbPath: string;
  const generate = vi.fn<AiProvider['generate']>().mockResolvedValue(ANSWER);
  const provider = { name: 'test', model: 'test-model', configured: true, generate };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brain-vat-api-'));
    dbPath = join(directory, 'workspace.sqlite');
    generate.mockReset().mockResolvedValue(ANSWER);
    vi.mocked(spawn).mockClear();
    provider.configured = true;
    app = await createApp({ dbPath, provider, registrationOpen: true });
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  function request(
    method: HTTPMethods,
    path: string,
    user?: Session,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url: `/api${path}`,
      ...(user ? { headers: { authorization: `Bearer ${user.token}` } } : {}),
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: {
              'content-type': 'application/json',
              ...(user ? { authorization: `Bearer ${user.token}` } : {}),
            },
          }),
    });
  }
  async function register(username: string, inviteToken?: string): Promise<Session> {
    const response = await request('POST', '/auth/register', undefined, {
      username,
      password: PASSWORD,
      ...(inviteToken ? { inviteToken } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Session>();
  }
  async function roomFor(user: Session): Promise<RoomSummary> {
    const response = await request('POST', '/rooms', user, {
      title: 'Semirings',
      filename: 'semirings.pdf',
      sourceUrl: null,
      pdf: pdfFixture().toString('base64'),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<RoomSummary>();
  }
  async function invite(owner: Session, room: RoomSummary): Promise<string> {
    const response = await request('POST', `/rooms/${room.id}/invites`, owner);
    expect(response.statusCode).toBe(200);
    return response.json<{ token: string }>().token;
  }
  async function state(owner: Session, room: RoomSummary): Promise<RoomState> {
    const response = await request('GET', `/rooms/${room.id}`, owner);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RoomState>();
  }

  it('gates signup, hashes credentials, expires and revokes sessions', async () => {
    await app.close();
    app = await createApp({ dbPath, provider });
    const owner = await register('Owner');
    expect(
      (
        await request('POST', '/auth/register', undefined, {
          username: 'outsider',
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(403);
    const room = await roomFor(owner);
    const token = await invite(owner, room);
    const member = await register('member', token);
    expect((await state(member, room)).room.role).toBe('editor');
    expect(
      (await request('POST', '/invites/redeem', member, { token })).statusCode,
    ).toBe(400);
    const login = await request('POST', '/auth/login', undefined, {
      username: 'owner',
      password: PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    const db = new DatabaseSync(dbPath);
    const stored = db
      .prepare('SELECT password FROM accounts WHERE id = ?')
      .get(owner.account.id);
    expect(stored?.password).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(
      owner.token,
    );
    expect(JSON.stringify(db.prepare('SELECT * FROM invites').all())).not.toContain(
      token,
    );
    db.prepare('UPDATE sessions SET expires = 0 WHERE user_id = ?').run(
      member.account.id,
    );
    db.close();
    expect((await request('GET', '/auth/me', member)).statusCode).toBe(401);
    expect((await request('POST', '/auth/logout', owner)).statusCode).toBe(200);
    expect((await request('GET', `/rooms/${room.id}/pdf`, owner)).statusCode).toBe(401);
    expect(
      (
        await request('POST', '/auth/login', undefined, {
          username: 'owner',
          password: 'incorrect password',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('limits failed bearer authentication before parsing request bodies', async () => {
    const owner = await register('owner');
    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject({
        url: '/api/rooms',
        headers: index % 2 ? { authorization: `Bearer ${'x'.repeat(43)}` } : {},
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { 'content-type': 'application/json' },
      payload: '{broken JSON',
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (
        await app.inject({
          url: '/api/rooms',
          remoteAddress: '203.0.113.2',
          headers: { authorization: `Bearer ${owner.token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await request('GET', '/health')).statusCode).toBe(200);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      expect((await request('GET', '/rooms')).statusCode).toBe(401);
      expect((await request('GET', '/rooms', owner)).statusCode).toBe(200);
    } finally {
      now.mockRestore();
    }
  });

  it('starts PDF extraction without inherited credentials or Node options', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-only-secret');
    vi.stubEnv('NODE_OPTIONS', '--inspect=0');
    try {
      const owner = await register('owner');
      expect((await roomFor(owner)).pageCount).toBe(1);
      const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
      expect(options?.env).toEqual({ NODE_ENV: 'production' });
      expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options?.env).not.toHaveProperty('NODE_OPTIONS');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('isolates matching PDFs and atomically consumes owner invitations', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const outsider = await register('outsider');
    const room = await roomFor(owner);
    const separate = await roomFor(outsider);
    expect(separate.documentId).toBe(room.documentId);
    expect(separate.id).not.toBe(room.id);
    for (const path of [`/rooms/${room.id}`, `/rooms/${room.id}/pdf`]) {
      expect((await request('GET', path, outsider)).statusCode).toBe(404);
      expect((await request('GET', path)).statusCode).toBe(401);
    }
    const token = await invite(owner, room);
    const attempts = await Promise.all([
      request('POST', '/invites/redeem', member, { token }),
      request('POST', '/invites/redeem', outsider, { token }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    const joined = attempts[0]?.statusCode === 200 ? member : outsider;
    expect(
      (await request('POST', `/rooms/${room.id}/invites`, joined)).statusCode,
    ).toBe(403);
    expect((await request('DELETE', `/rooms/${room.id}`, joined)).statusCode).toBe(403);
    const revoked = await invite(owner, room);
    await request('DELETE', `/rooms/${room.id}/invites`, owner);
    expect(
      (await request('POST', '/invites/redeem', outsider, { token: revoked }))
        .statusCode,
    ).toBe(400);
  });

  it('versions highlights and rejects forged document or actor fields', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const member = await register('member', await invite(owner, room));
    const id = randomUUID();
    const path = `/rooms/${room.id}/highlights`;
    expect(
      (
        await request('POST', path, owner, {
          id,
          anchor: { ...selection(room), documentId: '0'.repeat(64) },
          note: '',
        })
      ).statusCode,
    ).toBe(400);
    const saved = await request('POST', path, member, {
      id,
      anchor: selection(room),
      note: 'Question about multiplication',
    });
    expect(saved.json()).toMatchObject({ authorId: member.account.id, version: 1 });
    const edits = await Promise.all([
      request('PATCH', `${path}/${id}`, owner, { version: 1, note: 'Owner edit' }),
      request('PATCH', `${path}/${id}`, member, { version: 1, note: 'Member edit' }),
    ]);
    expect(edits.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await state(member, room)).highlights[0]?.version).toBe(2);
    expect(
      (await request('DELETE', `${path}/${id}`, member, { version: 1 })).statusCode,
    ).toBe(409);
    expect(
      (await request('DELETE', `${path}/${id}`, member, { version: 2 })).statusCode,
    ).toBe(200);
    const messagePath = `/rooms/${room.id}/messages`;
    const message = { id: randomUUID(), text: 'Can we compare definitions?' };
    expect(
      (await request('POST', messagePath, member, { ...message, role: 'assistant' }))
        .statusCode,
    ).toBe(400);
    expect((await request('POST', messagePath, member, message)).json()).toMatchObject({
      role: 'user',
      authorId: member.account.id,
    });
    await request('POST', messagePath, member, message);
    expect((await state(owner, room)).messages).toHaveLength(1);
    expect(
      (await request('POST', messagePath, member, { ...message, text: 'Changed' }))
        .statusCode,
    ).toBe(409);
  });

  it('merges disconnected notes durably and rejects non-note CRDT state', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const member = await register('member', await invite(owner, room));
    const first = new Y.Doc();
    const second = new Y.Doc();
    first.getText('notes').insert(0, 'First. ');
    second.getText('notes').insert(0, 'Second. ');
    const sync = async (user: Session, document: Y.Doc) => {
      const response = await request('POST', `/rooms/${room.id}/notes`, user, {
        update: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
      });
      expect(response.statusCode, response.body).toBe(200);
      Y.applyUpdate(
        document,
        Buffer.from(response.json<{ update: string }>().update, 'base64'),
      );
    };
    await sync(owner, first);
    await sync(member, second);
    await sync(owner, first);
    expect(first.getText('notes').toString()).toBe(second.getText('notes').toString());
    expect(first.getText('notes').toString()).toContain('Second.');
    const database = new DatabaseSync(dbPath);
    const before = database.prepare('SELECT revision FROM notes').get()?.revision;
    await sync(owner, first);
    expect(database.prepare('SELECT revision FROM notes').get()?.revision).toBe(before);
    database.close();
    const invalid = new Y.Doc();
    invalid.getMap('members').set('owner', member.account.id);
    expect(
      (
        await request('POST', `/rooms/${room.id}/notes`, member, {
          update: Buffer.from(Y.encodeStateAsUpdate(invalid)).toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    const hidden = new Y.Doc();
    hidden.getMap('notes').set('hidden', 'Not plain text');
    expect(
      (
        await request('POST', `/rooms/${room.id}/notes`, member, {
          update: Buffer.from(Y.encodeStateAsUpdate(hidden)).toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    app = await createApp({ dbPath, provider });
    const restored = new Y.Doc();
    await sync(owner, restored);
    expect(restored.getText('notes').toString()).toBe(
      first.getText('notes').toString(),
    );
    await request('DELETE', `/rooms/${room.id}/members/${member.account.id}`, owner);
    expect(
      (
        await request('POST', `/rooms/${room.id}/notes`, member, {
          update: Buffer.from(Y.encodeStateAsUpdate(second)).toString('base64'),
        })
      ).statusCode,
    ).toBe(404);
    for (const document of [first, second, invalid, hidden, restored])
      document.destroy();
  });

  it('requires presence opt-in and expires stale positions', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    expect((await state(owner, room)).presence).toEqual([]);
    await request('POST', `/rooms/${room.id}/presence`, owner, { pageIndex: 0 });
    expect((await state(owner, room)).presence).toEqual([
      { ...owner.account, pageIndex: 0 },
    ]);
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE presence SET expires = 0').run();
    db.close();
    expect((await state(owner, room)).presence).toEqual([]);
    expect(
      (await request('POST', `/rooms/${room.id}/presence`, owner, { pageIndex: 2 }))
        .statusCode,
    ).toBe(400);
    await request('POST', `/rooms/${room.id}/presence`, owner, { pageIndex: null });
  });

  it('publishes one answer per request using canonical PDF text', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const gate = deferred<GeneratedAnswer>();
    generate.mockReturnValue(gate.promise);
    const input = runInput();
    const path = `/rooms/${room.id}/runs`;
    const accepted = await request('POST', path, owner, input);
    expect(accepted.statusCode).toBe(202);
    const run = accepted.json<AiRun>();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      pages: [{ pageIndex: 0, text: 'A semiring has addition and multiplication.' }],
    });
    expect((await request('POST', path, owner, input)).json<AiRun>().id).toBe(run.id);
    expect(
      (await request('POST', path, owner, { ...input, question: 'Changed' }))
        .statusCode,
    ).toBe(409);
    gate.resolve(ANSWER);
    await vi.waitFor(async () => {
      expect((await state(owner, room)).runs[0]?.status).toBe('completed');
    });
    await request('POST', path, owner, input);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      (await state(owner, room)).messages.filter((item) => item.role === 'assistant'),
    ).toHaveLength(1);
  });

  it('cancels revoked work before late provider answers can be published', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const member = await register('member', await invite(owner, room));
    const gate = deferred<GeneratedAnswer>();
    generate.mockReturnValue(gate.promise);
    await request('POST', `/rooms/${room.id}/runs`, member, runInput());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await request('DELETE', `/rooms/${room.id}/members/${member.account.id}`, owner);
    gate.resolve(ANSWER);
    await vi.waitFor(async () => {
      expect((await state(owner, room)).runs[0]?.status).toBe('cancelled');
    });
    expect(
      (await state(owner, room)).messages.some((item) => item.role === 'assistant'),
    ).toBe(false);
    expect((await request('GET', `/rooms/${room.id}/pdf`, member)).statusCode).toBe(
      404,
    );
  });

  it('marks interrupted requests uncertain without reissuing them', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const gate = deferred<GeneratedAnswer>();
    generate.mockReturnValue(gate.promise);
    const input = runInput();
    const path = `/rooms/${room.id}/runs`;
    const accepted = (await request('POST', path, owner, input)).json<AiRun>();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await app.close();
    app = await createApp({ dbPath, provider });
    gate.resolve(ANSWER);
    expect((await state(owner, room)).runs[0]?.status).toBe('uncertain');
    const replay = (await request('POST', path, owner, input)).json<AiRun>();
    expect(replay).toMatchObject({ id: accepted.id, status: 'uncertain' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await state(owner, room)).messages).toHaveLength(1);
    const database = new DatabaseSync(dbPath);
    expect(database.prepare('SELECT input FROM runs').get()?.input).toBe('{}');
    database.close();
  });

  it('reports missing configuration and uncertain outcomes safely', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const path = `/rooms/${room.id}/runs`;
    provider.configured = false;
    expect((await request('POST', path, owner, runInput())).statusCode).toBe(503);
    expect(generate).not.toHaveBeenCalled();
    provider.configured = true;
    generate.mockRejectedValue(new ProviderError('secret upstream error', true));
    await request('POST', path, owner, runInput());
    await vi.waitFor(async () => {
      expect((await state(owner, room)).runs[0]?.status).toBe('uncertain');
    });
    expect(JSON.stringify(await state(owner, room))).not.toContain('secret');
  });

  it('limits running jobs and prevents deleted records from returning', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const gate = deferred<GeneratedAnswer>();
    generate.mockReturnValue(gate.promise);
    const path = `/rooms/${room.id}/runs`;
    const first = (await request('POST', path, owner, runInput())).json<AiRun>();
    await request('POST', path, owner, runInput());
    expect((await request('POST', path, owner, runInput())).statusCode).toBe(429);
    const cancelled = await request('POST', `${path}/${first.id}/cancel`, owner);
    expect(cancelled.json<AiRun>().status).toBe('cancelled');
    await request('DELETE', `/rooms/${room.id}`, owner);
    gate.resolve(ANSWER);
    expect((await request('GET', `/rooms/${room.id}`, owner)).statusCode).toBe(404);
    const db = new DatabaseSync(dbPath);
    for (const table of ['rooms', 'runs', 'messages', 'members', 'notes']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    }
    expect(db.prepare('SELECT id FROM deleted_rooms').get()?.id).toBe(room.id);
    db.close();
  });

  it('caps daily requests while allowing accepted requests to replay', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    const path = `/rooms/${room.id}/runs`;
    const first = runInput();
    for (let index = 0; index < 100; index += 1) {
      const input = index === 0 ? first : runInput();
      const response = await request('POST', path, owner, input);
      expect(response.statusCode, response.body).toBe(202);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect((await request('POST', path, owner, runInput())).statusCode).toBe(429);
    expect((await request('POST', path, owner, first)).statusCode).toBe(202);
    expect(generate).toHaveBeenCalledTimes(100);
  });

  it('bounds shared snapshots and atomically refuses oversized publication', async () => {
    const owner = await register('owner');
    const room = await roomFor(owner);
    generate.mockResolvedValue({
      ...ANSWER,
      blocks: Array.from({ length: 14 }, () => ({
        heading: 'Long answer',
        text: 'x'.repeat(30_000),
        evidenceIds: ['paper-0'],
      })),
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await request(
        'POST',
        `/rooms/${room.id}/runs`,
        owner,
        runInput(),
      );
      expect(response.statusCode).toBe(202);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const snapshot = await state(owner, room);
    expect(snapshot.runs.map((run) => run.status)).toEqual([
      'completed',
      'failed',
      'failed',
    ]);
    expect(
      snapshot.messages.filter((message) => message.role === 'assistant'),
    ).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(2_100_000);
    expect(snapshot.runs[1]?.error).toContain('history limit');
  });

  it('rejects untrusted origins and malformed or oversized input', async () => {
    const owner = await register('owner');
    const denied = await app.inject({
      url: '/api/health',
      headers: { origin: 'https://untrusted.example' },
    });
    expect(denied.statusCode).toBe(403);
    const malformed = await request('POST', '/rooms', owner, {
      title: 'Bad',
      filename: 'bad.pdf',
      sourceUrl: null,
      pdf: Buffer.from('%PDF-1.4\nbroken').toString('base64'),
    });
    expect(malformed.statusCode).toBe(400);
    const room = await roomFor(owner);
    expect(
      (
        await request('POST', `/rooms/${room.id}/runs`, owner, {
          ...runInput(),
          image: 'data:image/png;base64,eA==',
        })
      ).statusCode,
    ).toBe(400);
    const tooLarge = await request('POST', `/rooms/${room.id}/messages`, owner, {
      id: randomUUID(),
      text: 'x'.repeat(4_000_001),
    });
    expect(tooLarge.statusCode).toBe(413);
  });
});
