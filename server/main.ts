import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from './app.ts';
import { createBackup } from './backup.ts';
import { createAstraProvider } from './provider.ts';

process.umask(0o077);
const dbPath = resolve(process.env.DATABASE_PATH ?? './data/brain-vat.sqlite');
const directory = dirname(dbPath);
await mkdir(directory, { recursive: true, mode: 0o700 });
if (existsSync(join(directory, 'RESTORE_QUARANTINE'))) {
  throw new Error('Restored data is quarantined. Complete docs/HOSTING.md recovery.');
}
const pidFile = join(directory, 'server.pid');
await writeFile(pidFile, String(process.pid), { mode: 0o600, flag: 'wx' }).catch(() => {
  throw new Error(
    'Server lock exists. Stop the previous server before removing data/server.pid.',
  );
});
const app = await createApp({
  dbPath,
  provider: createAstraProvider({
    model: process.env.ASTRA_MODEL ?? 'gpt-6-astra',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  }),
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:8787'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  registrationOpen: process.env.REGISTRATION_OPEN === 'true',
});
const webRoot = resolve('dist/web');
if (existsSync(webRoot)) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/api/')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "worker-src 'self' blob:",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' blob: data:",
          "font-src 'self' blob: data:",
          "connect-src 'self' https:",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      );
    }
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  await app.register(fastifyStatic, { root: webRoot });
}
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
try {
  await app.listen({ port, host });
} catch (error) {
  await app.close();
  await unlink(pidFile);
  throw error;
}
process.stdout.write(`Brain Vat listening at http://${host}:${port}\n`);

let backingUp = false;
const periodicBackup = async (): Promise<void> => {
  if (backingUp) return;
  backingUp = true;
  try {
    await createBackup(dbPath);
  } catch {
    process.stderr.write(
      'Scheduled backup failed. Check disk space and permissions.\n',
    );
  } finally {
    backingUp = false;
  }
};
const backupTimer = setInterval(() => void periodicBackup(), 6 * 60 * 60 * 1000);
backupTimer.unref();
void periodicBackup();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(backupTimer);
    void app.close().finally(async () => {
      await unlink(pidFile).catch(() => undefined);
      process.exit(0);
    });
  });
}
