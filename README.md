# Brain Vat

Read a paper closely, follow its sources, and work through ideas with other readers.
Brain Vat runs as a web app and a Chrome extension, with light and dark themes.

## Try it locally

Use Node 24 and pnpm 10.13.1:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev:all
```

Open [Brain Vat](http://127.0.0.1:5173). Choose **Read the example paper**, upload a
PDF, or open an arXiv/public PDF link. The local reader needs no account. It saves
local papers and highlights in that browser. URL imports require the site's CORS
permission; otherwise download the PDF and upload it, or use the extension.

Select text or use **Region** for an equation or figure. Saved highlights follow
zoom and rotation. Source overlays open safe links and preview reference metadata.
**Enhanced reading** toggles between the PDF and a readable text/guide view.
Extracted text may lose mathematical layout; citations return to the original page.

## Use Astra and shared rooms

1. Put an OpenAI API key with Astra access in `.env` as `OPENAI_API_KEY=...`.
   Restart the server. Keep the key on the server; never use a `VITE_` secret.
2. Open **Workspace** and create the first account. Subsequent accounts need an
   invitation by default. Usernames are handles, not verified identities.
3. Open a paper, then choose **Upload paper and create room**. This sends its bytes
   to your server. The server extracts text from those bytes in a bounded process.
4. Ask a question, select **Expand definition**, or generate a reading guide.
   Region questions attach a rendered PNG crop. These are user-supplied images;
   they are not independently verified against the stored PDF.
5. Expand **Shared room** to edit shared notes, opt into page presence, or create an
   invite link. Invitees open it in a browser; the extension is optional.

Everyone in a room shares highlights, notes, discussion, and AI conversations.
Invites expire after 24 hours and can be used once. Owners can revoke invitations,
remove readers, and delete rooms. Revocation stops new access; it cannot erase a
PDF someone already downloaded. Shared PDFs are kept in memory by the reader,
separately from the account-free local library. Notes have a local recovery draft
and sync automatically; their status distinguishes local persistence from server
acknowledgement. Sign-out removes the device's shared-note drafts.

The initial adapter uses `gpt-6-astra` through the Responses API. `AiProvider` is
replaceable. Answers cite server-owned evidence IDs; unknown citations are rejected.
Origins are labeled **This paper**, **Cited reference**, or **External source**.
Bibliography metadata is not evidence of a reference's full contents. External
search summaries are identified as summaries, not quotations from fetched pages.
Use the separate external-search field to choose what is sent to web search;
private PDF passages are not included in that search request. The final synthesis
does send relevant paper passages, selected images, and recent shared chat to the
configured LLM API. Provider-side storage is disabled in the requests.

Without a key, reading, accounts and collaboration work; AI requests show that
configuration is missing. The integration is tested with injected provider responses.
A live Astra response has not been verified without a configured key.

## Chrome extension

```sh
pnpm build:extension
```

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select `.output/chrome-mv3`, pin Brain Vat, and click it on a paper page.
3. Use **Chrome panel** to move the companion into Chrome's native side panel.
4. In **Workspace**, set the same server origin as the web app and sign in.
   Add the extension's exact `chrome-extension://ID` origin to the server's
   `ALLOWED_ORIGINS`. Chrome asks for access to that server when you connect.

The web app and extension have independent local libraries and sessions. Shared
rooms synchronize through the server. The panel validates active tab, browser
document, reader session, room, and PDF identity before using its context.

`pnpm package:extension` creates `dist/brain-vat-chrome.zip`. Fonts, PDF workers,
CMaps, and decoders are bundled. No executable scripts load from a CDN. Publishing
to the Chrome Web Store remains an owner action; see [release notes](docs/RELEASE.md).

## Hosting and recovery

The first deployment is one Node service with a persistent SQLite database, including
PDF bytes. It serves the built web app and API. It supports a small invited group,
not horizontal replicas. [Hosting and backup instructions](docs/HOSTING.md) cover
TLS, exact allowed origins, persistent storage, online backups and isolated recovery.
No public service has been provisioned by this repository.

Useful limits: 25 MiB/PDF, 300 pages/PDF, 50 owned rooms and 1 GB of PDF bytes per
account, 20 members/room, 1,000 highlights/room, 2,000 messages/room, two concurrent
AI runs/room and 100 AI requests/account/day. The server also bounds aggregate room
history, request sizes, authentication work, processing time and request rates.
Failed or uncertain paid requests are never automatically resubmitted. Restarted
runs remain visibly uncertain rather than being silently charged again.

Scanned PDFs support region selection but not OCR. Paywall integrations, mobile
layout support, and comprehensive PDF accessibility remain outside this release.
The next work item is a Lean-assisted tactical proof workspace; see
[the workpile](docs/ROADMAP.md).

## Checks and code map

```sh
pnpm check
pnpm format:check
pnpm build:web
pnpm build:extension
pnpm exec playwright install chromium
pnpm test:e2e
pnpm audit
```

- `src/reader-app.tsx`, `src/pdf-page.tsx`: PDF reader, anchors and source overlays.
- `src/assistant-panel.tsx`, `src/enhanced-reader.tsx`: shared AI and enhanced mode.
- `src/workspace-contract.ts`, `src/workspace-client.ts`: domain contracts and client.
- `src/workspace-panel.tsx`, `src/room-notes.tsx`: accounts, invitations and Yjs notes.
- `server/app.ts`, `server/store.ts`: authenticated API and durable shared state.
- `server/provider.ts`, `server/evidence.ts`: Astra and evidence validation.
- `server/pdf-import.ts`, `server/pdf-worker.ts`: bounded PDF extraction.
- `extension/`: packaged reader, native panel and validated active-tab messaging.

Tests cover account/room isolation, invite replay, revocation, concurrent notes,
restart recovery, AI request idempotency, provider failure handling, and real browser
reading flows. Test providers are explicit fixtures; tests do not incur LLM charges.
See [THIRD_PARTY.md](THIRD_PARTY.md) for the example paper's attribution and license.
