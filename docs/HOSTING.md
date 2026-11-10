# Hosting and recovery

Run one Node 24 process on a host with TLS termination, a persistent disk, and enough
memory for the service plus two bounded PDF workers and password derivations. A
2 GB instance is a starting allocation to measure, not a performance guarantee.
Do not run multiple app replicas against this database or use ephemeral serverless
filesystems. No hosting account or paid resource has been created.

## Deploy

1. Install with `pnpm install --frozen-lockfile`; build with `pnpm build:web`.
   The runtime uses `tsx`, a production dependency.
2. Put secrets in the host's secret configuration, not Git or the web root.
   Set `HOST=0.0.0.0`, the host's `PORT`, and `DATABASE_PATH` on persistent disk.
   Set `ALLOWED_ORIGINS` to exact HTTPS app and approved Chrome extension origins,
   comma-separated. Keep `REGISTRATION_OPEN=false`.
3. Keep the service private while creating the first account. This bootstraps
   registration; an unclaimed service must not be exposed publicly.
4. Run `pnpm start` behind TLS. Health is `GET /api/health`; it reveals provider
   readiness, never secrets. The app serves `dist/web` on the same origin.
5. Set `OPENAI_API_KEY` and optionally `ASTRA_MODEL` (default `gpt-6-astra`).
   `OPENAI_BASE_URL` is an operator setting for compatible API deployments. It
   requires HTTPS except loopback and is never controlled by a room member.
6. Build the extension with `VITE_API_URL=https://your-app.example` for a hosted
   default. Otherwise readers set the server in Workspace.

Origins protect browser requests; bearer sessions authorize API requests. TLS is
required off-device. Sessions expire; logout invalidates their hashed server records.
Reverse proxies must not log authorization headers or bodies, and should cap request
bodies at 36 MB. Do not enable permissive trust-proxy forwarding without a trusted
proxy policy and verified rate-limit keys.

An exclusive `server.pid` lock precedes database recovery. After a crash, verify
the recorded process is stopped before removing the lock. Never remove a live
server's lock. Graceful shutdown removes it automatically.

The parser receives no server credentials and runs in a separate process with a
15-second deadline and a 256 MiB V8 heap bound. This is not an OS sandbox or an
absolute resident-memory limit. Use a dedicated least-privilege service account and
host-level memory/CPU limits. Public untrusted multi-tenant ingestion needs a stronger
isolated parser service; this release targets a small invited group.

## Backups

`pnpm backup` creates an online SQLite snapshot, including committed WAL contents
and PDF blobs. The server also snapshots on startup and every six hours. The seven
newest snapshots are retained in the database directory's `backups/` folder.
They are private files. Backup failures go to stderr and need operator attention.
These snapshots protect against application mistakes, not disk loss.

Copy snapshots to encrypted off-machine storage under your retention policy and
verify recovery periodically. Copies contain accounts, papers, chat and historical
membership. Deleted data remains in retained backups until expiry; revocation cannot
recall downloaded copies. No external backup provider is automatically configured.

## Restore into quarantine

Never replace the live database with an old snapshot and immediately reopen access.
That could restore deleted rooms, revoked memberships, or session tokens.

1. Stop the service; retain the current database and deletion/revocation records.
   Restore into a **new directory** with restricted permissions. Create a file
   named `RESTORE_QUARANTINE` there. Startup refuses to run while it exists.
   Do not copy old WAL or SHM files alongside the snapshot.
2. Open the restored database offline. Delete all rows in `sessions`, `invites`,
   and `presence`. Remove editor memberships from `members`; require fresh
   invitations. Retain owners only after verifying ownership.
3. Reapply every deletion from the current `deleted_rooms` table and any newer
   records. Delete those rooms with foreign keys enabled. Without complete deletion
   records, keep the service private and review every restored room with its owner.
4. Run `PRAGMA integrity_check`, verify PDF hashes, and test an isolated sign-in,
   PDF download and notes edit. Interrupted AI runs become uncertain on startup;
   do not reissue them automatically. Confirm old sessions and invitations fail.
5. Rotate credentials if disclosure occurred. Remove the quarantine marker only
   after the access/deletion review. Point the service to the new database. Have
   members sign in again and issue fresh invitations.

Usernames are not verified email identities. No email password-reset flow exists.
An operator must verify ownership out of band before any offline credential reset;
never infer identity from a handle.
