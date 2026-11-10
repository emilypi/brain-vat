import { mkdir, readdir, unlink, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

/** Online SQLite backup includes committed WAL data and the stored PDF blobs. */
export async function createBackup(dbPath: string): Promise<string> {
  const directory = join(dirname(resolve(dbPath)), 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(
    directory,
    'brain-vat-' + new Date().toISOString().replaceAll(':', '-') + '.sqlite',
  );
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(database, destination);
    await chmod(destination, 0o600);
  } finally {
    database.close();
  }
  const snapshots = (await readdir(directory))
    .filter((name) => /^brain-vat-[\dTZ.-]+\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const expired of snapshots.slice(7)) await unlink(join(directory, expired));
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = await createBackup(
    process.env.DATABASE_PATH ?? './data/brain-vat.sqlite',
  );
  process.stdout.write('Backup created: ' + destination + '\n');
}
