import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import * as Y from 'yjs';
import type { Anchor, PaperPassage } from '../src/document.ts';
import type {
  Account,
  AiRun,
  ChatMessage,
  GeneratedAnswer,
  Member,
  Presence,
  ProviderInput,
  RoomState,
  RoomSummary,
  RunInput,
  Session,
  SharedHighlight,
} from '../src/workspace-contract.ts';
import { digest, newToken } from './auth.ts';
import type { ProofBreakdown, ProofCheck, ProofCheckResult } from '../src/proof.ts';
import {
  newProofCheck,
  proofCheckOutcome,
  proofContextFor,
  proofSourceHash,
} from './proofs.ts';

type Row = Record<string, SQLOutputValue>;

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function body<T>(row: Row): T {
  return JSON.parse(String(row.body)) as T;
}

function account(row: Row): Account {
  return { id: String(row.id), username: String(row.username) };
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, pdf BLOB NOT NULL, pages TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES accounts(id), role TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    hash TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS highlights (
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(room_id, id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    id TEXT NOT NULL, body TEXT NOT NULL, run_id TEXT UNIQUE,
    PRIMARY KEY(room_id, id)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
    digest TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
    body TEXT NOT NULL, input TEXT NOT NULL,
    UNIQUE(room_id, actor_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS runs_actor_created ON runs(actor_id, created);
  CREATE TABLE IF NOT EXISTS proof_checks (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES accounts(id), status TEXT NOT NULL,
    created INTEGER NOT NULL, body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    state BLOB NOT NULL, revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS presence (
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES accounts(id), page INTEGER NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS deleted_rooms (
    id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
  );
`;

export class WorkspaceStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Dispatch may have reached the provider before a crash. Never reissue it.
    for (const row of this.all("SELECT * FROM runs WHERE status = 'running'")) {
      const run = body<AiRun>(row);
      this.updateRun({
        ...run,
        status: 'uncertain',
        error: 'Service restarted before the provider outcome was recorded.',
      });
      this.execute('UPDATE runs SET input = ? WHERE id = ?', '{}', run.id);
    }
    for (const row of this.all(
      "SELECT body FROM proof_checks WHERE status = 'running'",
    )) {
      const check = body<ProofCheck>(row);
      this.updateProofCheck({
        ...check,
        ...proofCheckOutcome(
          'failed',
          'Server restarted before verification finished; the outcome is unconfirmed.',
        ),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...values);
  }

  private get(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...values);
  }

  private execute(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  private checkSharedSize(id: string, additional = 0): void {
    const row = this.get(
      `SELECT coalesce(sum(bytes), 0) AS total FROM (
         SELECT length(CAST(body AS BLOB)) AS bytes FROM highlights WHERE room_id = ?
         UNION ALL
         SELECT length(CAST(body AS BLOB)) FROM messages WHERE room_id = ?
         UNION ALL
         SELECT length(CAST(body AS BLOB)) FROM runs WHERE room_id = ?
         UNION ALL
         SELECT length(CAST(body AS BLOB)) FROM proof_checks WHERE room_id = ?
       )`,
      id,
      id,
      id,
      id,
    );
    if (Number(row?.total) + additional > 2_000_000) {
      throw new ApiError(429, 'Workspace shared history limit reached.');
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  registrationAvailable(open: boolean): boolean {
    return open || !this.get('SELECT id FROM accounts LIMIT 1');
  }

  passwordFor(username: string): string | null {
    const row = this.get('SELECT password FROM accounts WHERE username = ?', username);
    return row ? String(row.password) : null;
  }

  private usableInvite(token: string): Row {
    const row = this.get(
      'SELECT * FROM invites WHERE hash = ? AND used = 0 AND expires > ?',
      digest(token),
      Date.now(),
    );
    if (!row) throw new ApiError(400, 'Invitation is invalid or expired.');
    return row;
  }

  register(
    username: string,
    password: string,
    registrationOpen: boolean,
    inviteToken?: string,
  ): Session {
    return this.transaction(() => {
      const invite = inviteToken ? this.usableInvite(inviteToken) : undefined;
      if (!this.registrationAvailable(registrationOpen) && !invite) {
        throw new ApiError(403, 'An invitation is required to create an account.');
      }
      if (this.get('SELECT id FROM accounts WHERE username = ?', username)) {
        throw new ApiError(409, 'Username is unavailable.');
      }
      const user = { id: randomUUID(), username };
      this.execute(
        'INSERT INTO accounts VALUES (?, ?, ?)',
        user.id,
        username,
        password,
      );
      if (invite) this.consumeInvite(invite, user.id);
      return this.issueSession(user);
    });
  }

  login(username: string): Session {
    const row = this.get('SELECT * FROM accounts WHERE username = ?', username);
    if (!row) throw new ApiError(401, 'Invalid username or password.');
    return this.issueSession(account(row));
  }

  private issueSession(user: Account): Session {
    const token = newToken();
    this.execute('DELETE FROM sessions WHERE expires <= ?', Date.now());
    this.execute(
      'INSERT INTO sessions VALUES (?, ?, ?)',
      digest(token),
      user.id,
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    );
    return { token, account: user };
  }

  authenticate(token: string): Account {
    const row = this.get(
      `SELECT accounts.* FROM sessions JOIN accounts ON accounts.id = user_id
       WHERE hash = ? AND expires > ?`,
      digest(token),
      Date.now(),
    );
    if (!row) throw new ApiError(401, 'Sign in again to continue.');
    return account(row);
  }

  logout(token: string): void {
    this.execute('DELETE FROM sessions WHERE hash = ?', digest(token));
  }

  room(id: string, actorId: string, owner = false): RoomSummary {
    const row = this.get(
      `SELECT rooms.body, members.role FROM rooms JOIN members
       ON rooms.id = members.room_id WHERE rooms.id = ? AND user_id = ?`,
      id,
      actorId,
    );
    if (!row) throw new ApiError(404, 'Workspace not found.');
    if (owner && row.role !== 'owner') {
      throw new ApiError(403, 'Only the workspace owner can do that.');
    }
    return { ...body<RoomSummary>(row), role: row.role as 'owner' | 'editor' };
  }

  rooms(actorId: string): RoomSummary[] {
    return this.all(
      `SELECT rooms.body, members.role FROM rooms JOIN members
       ON rooms.id = members.room_id WHERE user_id = ? ORDER BY rooms.rowid DESC`,
      actorId,
    ).map((row) => ({
      ...body<RoomSummary>(row),
      role: row.role as 'owner' | 'editor',
    }));
  }

  createRoom(
    actorId: string,
    metadata: { title: string; filename: string; sourceUrl: string | null },
    pdf: Buffer,
    pages: PaperPassage[],
  ): RoomSummary {
    return this.transaction(() => {
      const storage = this.get(
        `SELECT count(*) AS count, coalesce(sum(length(pdf)), 0) AS bytes
         FROM rooms JOIN members ON rooms.id = members.room_id
         WHERE user_id = ? AND role = 'owner'`,
        actorId,
      );
      if (Number(storage?.count) >= 50 || Number(storage?.bytes) + pdf.length > 1e9) {
        throw new ApiError(429, 'Workspace storage limit reached.');
      }
      const room: RoomSummary = {
        ...metadata,
        id: randomUUID(),
        documentId: digest(pdf),
        pageCount: pages.length,
        createdAt: new Date().toISOString(),
        role: 'owner',
      };
      this.execute(
        'INSERT INTO rooms VALUES (?, ?, ?, ?)',
        room.id,
        JSON.stringify(room),
        pdf,
        JSON.stringify(pages),
      );
      this.execute('INSERT INTO members VALUES (?, ?, ?)', room.id, actorId, 'owner');
      return room;
    });
  }

  pdf(id: string, actorId: string): Buffer {
    this.room(id, actorId);
    const row = this.get('SELECT pdf FROM rooms WHERE id = ?', id);
    return Buffer.from(row?.pdf as Uint8Array);
  }

  state(id: string, actorId: string): RoomState {
    const room = this.room(id, actorId);
    const runs = this.all(
      'SELECT body FROM runs WHERE room_id = ? ORDER BY rowid',
      id,
    ).map((row) => body<AiRun>(row));
    return {
      room,
      highlights: this.all('SELECT body FROM highlights WHERE room_id = ?', id).map(
        (row) => body<SharedHighlight>(row),
      ),
      messages: this.messages(id),
      runs,
      guide:
        [...runs]
          .reverse()
          .find((run) => run.kind === 'guide' && run.status === 'completed') ?? null,
      members: this.all(
        `SELECT accounts.id, username, role FROM members JOIN accounts
         ON accounts.id = user_id WHERE room_id = ?`,
        id,
      ).map((row): Member => ({
        ...account(row),
        role: row.role as Member['role'],
      })),
      presence: this.all(
        `SELECT accounts.id, username, page FROM presence JOIN accounts
         ON accounts.id = user_id JOIN members USING (room_id, user_id)
         WHERE room_id = ? AND expires > ?`,
        id,
        Date.now(),
      ).map((row): Presence => ({ ...account(row), pageIndex: Number(row.page) })),
    };
  }

  deleteRoom(id: string, actorId: string): string[] {
    return this.transaction(() => {
      this.room(id, actorId, true);
      const runs = this.cancelPending(id);
      this.execute('INSERT INTO deleted_rooms VALUES (?, ?)', id, Date.now());
      this.execute('DELETE FROM rooms WHERE id = ?', id);
      return runs;
    });
  }

  invite(id: string, actorId: string): { token: string; expiresAt: string } {
    this.room(id, actorId, true);
    this.execute('DELETE FROM invites WHERE expires <= ? OR used = 1', Date.now());
    const count = this.get('SELECT count(*) AS n FROM invites WHERE room_id = ?', id);
    if (Number(count?.n) >= 20) throw new ApiError(429, 'Too many active invitations.');
    const token = newToken();
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    this.execute('INSERT INTO invites VALUES (?, ?, ?, 0)', digest(token), id, expires);
    return { token, expiresAt: new Date(expires).toISOString() };
  }

  revokeInvites(id: string, actorId: string): void {
    this.room(id, actorId, true);
    this.execute('DELETE FROM invites WHERE room_id = ?', id);
  }

  private consumeInvite(invite: Row, actorId: string): void {
    const count = this.get(
      'SELECT count(*) AS n FROM members WHERE room_id = ?',
      String(invite.room_id),
    );
    if (Number(count?.n) >= 20)
      throw new ApiError(429, 'Workspace member limit reached.');
    this.execute('UPDATE invites SET used = 1 WHERE hash = ?', String(invite.hash));
    this.execute(
      'INSERT OR IGNORE INTO members VALUES (?, ?, ?)',
      String(invite.room_id),
      actorId,
      'editor',
    );
  }

  redeem(token: string, actorId: string): RoomSummary {
    return this.transaction(() => {
      const invite = this.usableInvite(token);
      this.consumeInvite(invite, actorId);
      return this.room(String(invite.room_id), actorId);
    });
  }

  removeMember(id: string, actorId: string, userId: string): string[] {
    return this.transaction(() => {
      this.room(id, actorId, true);
      if (userId === actorId) throw new ApiError(400, 'The owner cannot be removed.');
      this.execute('DELETE FROM members WHERE room_id = ? AND user_id = ?', id, userId);
      this.execute(
        'DELETE FROM presence WHERE room_id = ? AND user_id = ?',
        id,
        userId,
      );
      return this.cancelPending(id, userId);
    });
  }

  validateAnchor(room: RoomSummary, anchor: Anchor): void {
    if (anchor.documentId !== room.documentId || anchor.pageIndex >= room.pageCount) {
      throw new ApiError(400, 'Selection does not belong to this PDF.');
    }
  }

  highlight(
    id: string,
    actor: Account,
    input: { id: string; anchor: Anchor; note: string },
  ): SharedHighlight {
    const room = this.room(id, actor.id);
    this.validateAnchor(room, input.anchor);
    if (
      this.get('SELECT id FROM highlights WHERE room_id = ? AND id = ?', id, input.id)
    ) {
      throw new ApiError(409, 'Highlight already exists.');
    }
    const count = this.get(
      'SELECT count(*) AS n FROM highlights WHERE room_id = ?',
      id,
    );
    if (Number(count?.n) >= 1000) throw new ApiError(429, 'Highlight limit reached.');
    const highlight: SharedHighlight = {
      ...input,
      authorId: actor.id,
      authorName: actor.username,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.checkSharedSize(id, Buffer.byteLength(JSON.stringify(highlight)));
    this.execute(
      'INSERT INTO highlights VALUES (?, ?, ?)',
      id,
      input.id,
      JSON.stringify(highlight),
    );
    return highlight;
  }

  editHighlight(
    id: string,
    actorId: string,
    highlightId: string,
    version: number,
    note: string | null,
  ): SharedHighlight | null {
    return this.transaction(() => {
      this.room(id, actorId);
      const row = this.get(
        'SELECT body FROM highlights WHERE room_id = ? AND id = ?',
        id,
        highlightId,
      );
      if (!row) throw new ApiError(404, 'Highlight not found.');
      const previous = body<SharedHighlight>(row);
      if (previous.version !== version) {
        throw new ApiError(409, 'Highlight changed. Refresh before editing.');
      }
      if (note === null) {
        this.execute(
          'DELETE FROM highlights WHERE room_id = ? AND id = ?',
          id,
          highlightId,
        );
        return null;
      }
      const next = { ...previous, note, version: version + 1 };
      this.execute(
        'UPDATE highlights SET body = ? WHERE room_id = ? AND id = ?',
        JSON.stringify(next),
        id,
        highlightId,
      );
      this.checkSharedSize(id);
      return next;
    });
  }

  private messages(id: string, limit = 2000): ChatMessage[] {
    return this.all(
      'SELECT body FROM messages WHERE room_id = ? ORDER BY rowid DESC LIMIT ?',
      id,
      limit,
    )
      .reverse()
      .map((row) => body<ChatMessage>(row));
  }

  private insertMessage(id: string, message: ChatMessage): void {
    this.checkSharedSize(id, Buffer.byteLength(JSON.stringify(message)));
    this.execute(
      'INSERT INTO messages VALUES (?, ?, ?, ?)',
      id,
      message.id,
      JSON.stringify(message),
      message.role === 'assistant' ? message.runId : null,
    );
  }

  message(id: string, actor: Account, messageId: string, text: string): ChatMessage {
    this.room(id, actor.id);
    const row = this.get(
      'SELECT body FROM messages WHERE room_id = ? AND id = ?',
      id,
      messageId,
    );
    if (row) {
      const existing = body<ChatMessage>(row);
      if (existing.authorId === actor.id && existing.text === text) return existing;
      throw new ApiError(409, 'Message ID has already been used.');
    }
    this.checkMessageLimit(id);
    const message: ChatMessage = {
      id: messageId,
      authorId: actor.id,
      authorName: actor.username,
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      runId: null,
      answer: null,
    };
    this.insertMessage(id, message);
    return message;
  }

  private checkMessageLimit(id: string): void {
    const count = this.get('SELECT count(*) AS n FROM messages WHERE room_id = ?', id);
    if (Number(count?.n) >= 2000)
      throw new ApiError(429, 'Conversation limit reached.');
  }

  beginRun(
    id: string,
    actor: Account,
    input: RunInput,
    configured: boolean,
  ): { run: AiRun; fresh: boolean } {
    return this.transaction(() => {
      const room = this.room(id, actor.id);
      const fingerprint = digest(JSON.stringify(input));
      const prior = this.get(
        'SELECT * FROM runs WHERE room_id = ? AND actor_id = ? AND request_id = ?',
        id,
        actor.id,
        input.requestId,
      );
      if (prior) {
        if (prior.digest !== fingerprint) {
          throw new ApiError(409, 'Request ID was already used for different input.');
        }
        return { run: body<AiRun>(prior), fresh: false };
      }
      if (!configured) throw new ApiError(503, 'AI provider is not configured.');
      if (input.proofParent && input.kind !== 'proof')
        throw new ApiError(400, 'A proof parent requires a proof request.');
      if (input.proofParent && (input.selection || input.image))
        throw new ApiError(400, 'A prerequisite uses its parent proof’s source.');
      if (input.selection) this.validateAnchor(room, input.selection);
      const proofContext = input.proofParent
        ? proofContextFor(
            this.run(id, actor.id, input.proofParent.runId),
            input.proofParent,
          )
        : null;
      if (input.proofParent && !proofContext)
        throw new ApiError(400, 'The parent proof or prerequisite is unavailable.');
      const daily = this.get(
        'SELECT count(*) AS n FROM runs WHERE actor_id = ? AND created >= ?',
        actor.id,
        Date.now() - 86_400_000,
      );
      const running = this.get(
        "SELECT count(*) AS n FROM runs WHERE room_id = ? AND status = 'running'",
        id,
      );
      if (Number(daily?.n) >= 100 || Number(running?.n) >= 2) {
        throw new ApiError(429, 'AI request limit reached. Try again later.');
      }
      this.checkMessageLimit(id);
      const pages = this.get('SELECT pages FROM rooms WHERE id = ?', id);
      const snapshot: ProviderInput = {
        title: room.title,
        question: input.question,
        kind: input.kind,
        selection: input.selection,
        image: input.image,
        externalQuery: input.externalQuery,
        pages: JSON.parse(String(pages?.pages)) as PaperPassage[],
        history: this.messages(id, 50),
        ...(proofContext ? { proofContext } : {}),
      };
      const run: AiRun = {
        id: randomUUID(),
        requestId: input.requestId,
        authorId: actor.id,
        kind: input.kind,
        question: input.question,
        status: 'running',
        createdAt: new Date().toISOString(),
        error: null,
        answer: null,
      };
      this.execute(
        'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        run.id,
        id,
        actor.id,
        input.requestId,
        fingerprint,
        'running',
        Date.now(),
        JSON.stringify(run),
        JSON.stringify(snapshot),
      );
      this.insertMessage(id, {
        id: `prompt:${run.id}`,
        authorId: actor.id,
        authorName: actor.username,
        role: 'user',
        text: input.question,
        createdAt: run.createdAt,
        runId: run.id,
        answer: null,
      });
      return { run, fresh: true };
    });
  }

  dispatch(runId: string): ProviderInput | null {
    const row = this.get(
      "SELECT * FROM runs WHERE id = ? AND status = 'running'",
      runId,
    );
    if (!row) return null;
    this.room(String(row.room_id), String(row.actor_id));
    return JSON.parse(String(row.input)) as ProviderInput;
  }

  private updateRun(run: AiRun): void {
    this.execute(
      'UPDATE runs SET status = ?, body = ? WHERE id = ?',
      run.status,
      JSON.stringify(run),
      run.id,
    );
  }

  finishRun(
    runId: string,
    outcome:
      { answer: GeneratedAnswer } | { status: 'failed' | 'uncertain'; error: string },
  ): void {
    this.transaction(() => {
      const row = this.get(
        "SELECT * FROM runs WHERE id = ? AND status = 'running'",
        runId,
      );
      if (!row) return;
      const run = body<AiRun>(row);
      const member = this.get(
        'SELECT user_id FROM members WHERE room_id = ? AND user_id = ?',
        String(row.room_id),
        run.authorId,
      );
      if (!member) {
        this.updateRun({ ...run, status: 'cancelled', error: 'Access was revoked.' });
        return;
      }
      if ('answer' in outcome) {
        this.updateRun({ ...run, status: 'completed', answer: outcome.answer });
        this.insertMessage(String(row.room_id), {
          id: `answer:${run.id}`,
          authorId: run.authorId,
          authorName: outcome.answer.model,
          role: 'assistant',
          text: outcome.answer.blocks.map((block) => block.text).join('\n\n'),
          createdAt: new Date().toISOString(),
          runId: run.id,
          answer: outcome.answer,
        });
      } else {
        this.updateRun({ ...run, ...outcome });
      }
      // Do not retain redundant images and private prompt snapshots indefinitely.
      this.execute('UPDATE runs SET input = ? WHERE id = ?', '{}', runId);
    });
  }

  cancelRun(id: string, actorId: string, runId: string): AiRun {
    const room = this.room(id, actorId);
    const row = this.get(
      'SELECT body FROM runs WHERE room_id = ? AND id = ?',
      id,
      runId,
    );
    if (!row) throw new ApiError(404, 'AI request not found.');
    const run = body<AiRun>(row);
    if (run.authorId !== actorId && room.role !== 'owner') {
      throw new ApiError(403, 'Only the author or owner can cancel this request.');
    }
    if (run.status !== 'running') return run;
    const next: AiRun = { ...run, status: 'cancelled', error: 'Request cancelled.' };
    this.updateRun(next);
    this.execute('UPDATE runs SET input = ? WHERE id = ?', '{}', runId);
    return next;
  }

  private cancelPending(id: string, actorId?: string): string[] {
    const rows = actorId
      ? this.all(
          `SELECT body FROM runs WHERE room_id = ? AND actor_id = ?
           AND status = 'running'`,
          id,
          actorId,
        )
      : this.all("SELECT body FROM runs WHERE room_id = ? AND status = 'running'", id);
    const runIds = rows.map((row) => {
      const run = body<AiRun>(row);
      this.updateRun({ ...run, status: 'cancelled', error: 'Access was revoked.' });
      this.execute('UPDATE runs SET input = ? WHERE id = ?', '{}', run.id);
      return run.id;
    });
    const checks = actorId
      ? this.all(
          'SELECT body FROM proof_checks WHERE room_id = ? AND actor_id = ? ' +
            "AND status = 'running'",
          id,
          actorId,
        )
      : this.all(
          "SELECT body FROM proof_checks WHERE room_id = ? AND status = 'running'",
          id,
        );
    for (const row of checks) {
      const check = body<ProofCheck>(row);
      this.updateProofCheck({
        ...check,
        ...proofCheckOutcome('cancelled', 'Access was revoked; verification stopped.'),
        finishedAt: new Date().toISOString(),
      });
      runIds.push(check.runId);
    }
    return [...new Set(runIds)];
  }

  run(id: string, actorId: string, runId: string): AiRun {
    this.room(id, actorId);
    const row = this.get(
      'SELECT body FROM runs WHERE room_id = ? AND id = ?',
      id,
      runId,
    );
    if (!row) throw new ApiError(404, 'Request not found in this room.');
    return body<AiRun>(row);
  }

  proofCheck(id: string, actorId: string, runId: string): ProofCheck | null {
    const run = this.run(id, actorId, runId);
    if (run.status !== 'completed' || !run.answer?.proofArtifact || !run.answer.proof)
      throw new ApiError(409, 'A completed proof is required for verification.');
    const row = this.get('SELECT body FROM proof_checks WHERE run_id = ?', runId);
    return row ? body<ProofCheck>(row) : null;
  }

  beginProofCheck(
    id: string,
    actorId: string,
    runId: string,
    sourceHash: string,
    retryUnavailable: boolean,
  ): { check: ProofCheck; fresh: boolean; proof: ProofBreakdown } {
    return this.transaction(() => {
      const prior = this.proofCheck(id, actorId, runId);
      const run = this.run(id, actorId, runId);
      const proof = run.answer!.proof!;
      if (
        sourceHash !== run.answer!.proofArtifact!.sourceHash ||
        sourceHash !== proofSourceHash(proof)
      )
        throw new ApiError(409, 'The requested source does not match this proof.');
      if (prior && !(retryUnavailable && prior.status === 'unavailable'))
        return { check: prior, fresh: false, proof };
      const daily = this.get(
        'SELECT count(*) AS n FROM proof_checks WHERE actor_id = ? AND created >= ?',
        actorId,
        Date.now() - 86_400_000,
      );
      if (Number(daily?.n) >= 100)
        throw new ApiError(429, 'Lean verification limit reached. Try again later.');
      const check = newProofCheck(runId, sourceHash);
      this.checkSharedSize(id, Buffer.byteLength(JSON.stringify(check)));
      this.execute(
        `INSERT INTO proof_checks VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET actor_id = excluded.actor_id,
         status = excluded.status, created = excluded.created, body = excluded.body`,
        runId,
        id,
        actorId,
        check.status,
        Date.now(),
        JSON.stringify(check),
      );
      return { check, fresh: true, proof };
    });
  }

  private updateProofCheck(check: ProofCheck): void {
    this.execute(
      'UPDATE proof_checks SET status = ?, body = ? WHERE run_id = ?',
      check.status,
      JSON.stringify(check),
      check.runId,
    );
  }

  finishProofCheck(check: ProofCheck, result: ProofCheckResult): void {
    this.transaction(() => {
      const row = this.get('SELECT * FROM proof_checks WHERE run_id = ?', check.runId);
      if (!row || row.status !== 'running' || body<ProofCheck>(row).id !== check.id)
        return;
      const member = this.get(
        'SELECT user_id FROM members WHERE room_id = ? AND user_id = ?',
        String(row.room_id),
        String(row.actor_id),
      );
      let next: ProofCheck = {
        ...check,
        ...(member ? result : proofCheckOutcome('cancelled', 'Access was revoked.')),
        finishedAt: new Date().toISOString(),
      };
      try {
        this.checkSharedSize(
          String(row.room_id),
          Buffer.byteLength(JSON.stringify(next)) - Buffer.byteLength(String(row.body)),
        );
      } catch {
        next = {
          ...check,
          ...proofCheckOutcome(
            'failed',
            'The room cannot store the verification result; not checked.',
          ),
          finishedAt: new Date().toISOString(),
        };
      }
      this.updateProofCheck(next);
    });
  }

  cancelProofCheck(id: string, actorId: string, runId: string): ProofCheck {
    const check = this.proofCheck(id, actorId, runId);
    if (!check) throw new ApiError(404, 'No verification exists for this proof.');
    const row = this.get('SELECT actor_id FROM proof_checks WHERE run_id = ?', runId);
    if (row?.actor_id !== actorId && this.room(id, actorId).role !== 'owner')
      throw new ApiError(403, 'Only the requester or room owner may cancel a check.');
    if (check.status !== 'running') return check;
    const cancelled: ProofCheck = {
      ...check,
      ...proofCheckOutcome('cancelled', 'Lean verification was cancelled.'),
      finishedAt: new Date().toISOString(),
    };
    this.updateProofCheck(cancelled);
    return cancelled;
  }

  mergeNotes(id: string, actorId: string, update: Uint8Array): Uint8Array {
    return this.transaction(() => {
      this.room(id, actorId);
      const document = new Y.Doc();
      const notes = document.getText('notes');
      try {
        const previous = this.get('SELECT * FROM notes WHERE room_id = ?', id);
        if (previous) Y.applyUpdate(document, previous.state as Uint8Array);
        try {
          Y.applyUpdate(document, update);
        } catch {
          throw new ApiError(400, 'Invalid notes update.');
        }
        const delta = notes.toDelta() as {
          insert: unknown;
          attributes?: Record<string, unknown>;
        }[];
        if (
          [...document.share.keys()].some((key) => key !== 'notes') ||
          document.getSubdocs().size > 0 ||
          Object.keys(notes.getAttributes()).length > 0 ||
          notes.length > 100_000 ||
          delta.some((part) => typeof part.insert !== 'string' || part.attributes)
        ) {
          throw new ApiError(400, 'Only plain text notes are supported.');
        }
        const state = Y.encodeStateAsUpdate(document);
        if (state.length > 1_000_000)
          throw new ApiError(413, 'Notes storage limit reached.');
        if (previous && Buffer.from(previous.state as Uint8Array).equals(state)) {
          return state;
        }
        this.execute(
          `INSERT INTO notes VALUES (?, ?, ?) ON CONFLICT(room_id)
           DO UPDATE SET state = excluded.state, revision = excluded.revision`,
          id,
          state,
          Number(previous?.revision ?? 0) + 1,
        );
        return state;
      } finally {
        document.destroy();
      }
    });
  }

  setPresence(id: string, actorId: string, pageIndex: number | null): void {
    const room = this.room(id, actorId);
    this.execute('DELETE FROM presence WHERE expires <= ?', Date.now());
    if (pageIndex === null) {
      this.execute(
        'DELETE FROM presence WHERE room_id = ? AND user_id = ?',
        id,
        actorId,
      );
    } else {
      if (pageIndex >= room.pageCount)
        throw new ApiError(400, 'Page is outside this PDF.');
      this.execute(
        `INSERT INTO presence VALUES (?, ?, ?, ?) ON CONFLICT(room_id, user_id)
         DO UPDATE SET page = excluded.page, expires = excluded.expires`,
        id,
        actorId,
        pageIndex,
        Date.now() + 45_000,
      );
    }
  }
}
