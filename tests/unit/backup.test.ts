import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { createBackup } from '../../server/backup';

test('online backup preserves WAL bytes with a live writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brain-vat-backup-'));
  const path = join(directory, 'source.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    database.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, bytes BLOB)');
    const bytes = Buffer.from('%PDF-test\u0000\u0001\uffff');
    database.prepare('INSERT INTO documents VALUES (?, ?)').run('paper', bytes);
    const snapshot = await createBackup(path);
    const recovered = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const row = recovered.prepare('SELECT bytes FROM documents').get();
      expect(Buffer.from(row?.bytes as Uint8Array)).toEqual(bytes);
      expect(recovered.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe(
        'ok',
      );
      expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
    } finally {
      recovered.close();
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
