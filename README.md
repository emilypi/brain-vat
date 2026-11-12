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

The design principle is a lightweight overlay that enhances legibility at all times.
Visible UI takes priority over preparation: show the reader first, then restore
annotations and index the full paper in the background.
The paper opens without a title banner; the library and companion start collapsed.
Use **Library** in the slim left rail to find papers, highlights and room notes.
Its **Contents** browser shows the PDF's embedded section hierarchy, with search
and page links. PDFs without an embedded outline say so; headings are not inferred.
The bottom dock holds page navigation, zoom, **Reading options**, and **Ask**. Closing the
companion preserves an unfinished question. The rail's theme toggle switches between
bright cream and neutral charcoal, and remembers the choice.
Rose and lilac accents connect controls, source links and translucent PDF highlights.
Drag the companion's divider to make room for a proof; its arrow keys resize it,
and Enter or a double-click restores the default width.
Ask eases open and closed; on narrower screens it overlays the page to preserve
the reading size. The motion follows your system's reduced-motion preference.

The first page appears while later page dimensions and paper text load in the
background. Scroll continuously through the PDF; nearby pages render as you reach them. Zoom
stays visible and preserves your reading position. Select text to save a highlight
or ask about it. **Reading options** contains rotation, **Region** capture, source
visibility and **Enhanced reading**. PDFs fit the available width by default;
saved highlights follow zoom and rotation. Lilac underlines mark source links,
with reference previews on hover or keyboard focus. Enhanced reading provides a text/guide view;
extracted text may lose mathematical layout, so citations return to the PDF.

Use the **Highlight tool** in the dock when ordinary text selection is awkward.
**Text** snaps a click to one word or selects words inside a drawn box, keeping
neighboring columns out. **Area** captures an equation, figure, or scanned passage.
Finishing a precision selection opens the companion and shows the selected words
or an image preview of the area. Refining the box updates that preview locally.
A 2.5× preview appears while drawing or resizing. Drag the box to move it, or use
its eight handles to refine the edges. Focus the box or a handle and use arrow
keys for one-pixel adjustments; Shift increases the step to ten pixels. Escape
cancels a drawing or clears the box. **Save highlight** and **Ask about selection**
use the refined selection; **Done** returns to ordinary PDF selection.

Select a term, then choose **Define** beside it for a compact inline explanation.
This works with ordinary text selection and the precision **Text** tool, in both
solo reading and shared rooms. **In this paper** explains its contextual meaning;
**Outside sources** lets you edit the search terms before choosing **Look up**.
Evidence origins are labeled, and expanding **Sources** opens page citations or
external links. Escape or a click outside dismisses the card. It follows scrolling
and zoom, and hides when the selected passage is offscreen.

Definitions use the configured AI service only after you choose **Define**. Reopening
the same term on the same page reuses its answer during that reading session.
Definitions also appear in **Ask**, and shared-room definitions remain in the room's
conversation. Failed delivery can be retried with the original request ID.

## Work through a proof

Highlight a proof, claim, or equation and choose **Break down proof**. The companion's
**Proofs** view gives a summary and a numbered argument outline. Choose a step to
enter its explanation, use previous/next to continue, or return to **Proof outline**.
Following a prerequisite and returning restores your place in the parent proof.
**Highlighted passage** locates its original PDF region with a lilac outline.
Expand **Lean
tactic and goals** to see each proposed tactic and the states observed by Lean.
Lean source has line numbers and restrained syntax coloring; unproved `sorry` steps
remain visibly marked. The panel's outline and focused detail are inspired by the
[Literature Links proof viewer](https://mathlib-initiative.github.io/seifert-van-kampen-tauceti/pdf-overlay/viewer/index.html).
Use **Explain** on a prerequisite, or ask about background knowledge in your own
words, to open another stepwise walkthrough with a link back to its parent.

Lean checks the proposed formal statement automatically when its local runtime is
ready. A checked statement still needs review against the paper's meaning; missing
assumptions and formalization gaps stay visible. Shared-room walkthroughs and checks
persist automatically. Save a named context to retain them while reading solo.
See [proof reading and runtime setup](docs/PROOFS.md).

## Ask Astra while reading solo

Put `OPENAI_API_KEY=...` in `.env` and restart the server. Open a local paper and
click **Ask**; no account or reading room is required on the local server.
**Enter** sends the question; **Shift+Enter** adds a newline. Astra receives relevant
paper passages, your selected passage or region, and recent conversation context.
Answers include clickable sources. **Find passages** searches the PDF without AI.

Use **Contexts** in Ask to save a named context for this PDF. Its conversation,
proof walkthroughs, parent/prerequisite links and recorded Lean checks keep updating
as you work. Reopen a context to continue it, or start a separate unsaved context
for a different line of inquiry. Contexts can be renamed and deleted.

Reopening loads recorded results without calling Astra or rerunning Lean, even when
the API key is unavailable. Later questions receive relevant remembered proof
results, with their assumptions, gaps and historical verification status. Selecting
the same proof again reopens its existing walkthrough. Newly generated Lean proofs
still need their own checks; saved theorems are not yet imported as Lean dependencies.

Saved contexts belong to the exact PDF and server. Their access references stay in
this browser; the server stores paper text, conversation and proof results in its
local database and backups. Web and extension storage are separate. Clearing browser
storage loses its references; this release has no account recovery for solo contexts.
Unsaved conversations expire after an hour of inactivity and end on reload, switching
papers or server restart. Failed delivery preserves the draft; retrying delivery
uses the same request ID to avoid duplicate model calls.

## Use shared rooms

1. Put an OpenAI API key with Astra access in `.env` as `OPENAI_API_KEY=...`.
   Restart the server. Keep the key on the server; never use a `VITE_` secret.
2. Open **Workspace** and create the first account. Subsequent accounts need an
   invitation by default. Usernames are handles, not verified identities.
3. Open a paper, then choose **Upload paper and create room**. This sends its bytes
   to your server. The server extracts text from those bytes in a bounded process.
4. Ask a question, select **Expand definition**, or generate a reading guide.
   Region questions attach a rendered PNG crop. These are user-supplied images;
   they are not independently verified against the stored PDF.
5. Open **Library**, then expand **Shared room** to edit shared notes, opt into page
   presence, or create an invite link. Invitees can join without the extension.

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

Without a key, solo Ask offers passage search; reading, accounts and collaboration
still work. Automated tests use injected providers and block production AI calls.

## Chrome extension

```sh
pnpm build:extension
```

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select `.output/chrome-mv3`, pin Brain Vat, and click it on a paper page.
3. Under **Reading options**, use **Chrome panel** to open the native side panel.
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
See [the workpile](docs/ROADMAP.md) for the current proof workspace and follow-ups.

## Checks and code map

```sh
pnpm check
pnpm format:check
pnpm build:web
pnpm build:extension
pnpm exec playwright install chromium
pnpm test:e2e
pnpm exec playwright install firefox
pnpm test:e2e:firefox
pnpm audit
```

- `src/reader-app.tsx`, `src/pdf-reader.tsx`, `src/pdf-page.tsx`: continuous PDF reader.
- `src/assistant-panel.tsx`, `src/enhanced-reader.tsx`: shared AI and enhanced mode.
- `src/workspace-contract.ts`, `src/workspace-client.ts`: domain contracts and client.
- `src/workspace-panel.tsx`, `src/room-notes.tsx`: accounts, invitations and Yjs notes.
- `server/app.ts`, `server/store.ts`: authenticated API and durable shared state.
- `server/provider.ts`, `server/evidence.ts`: Astra and evidence validation.
- `server/solo.ts`: local AI sessions and named contexts without an account.
- `src/proof.ts`, `src/proof-workspace.tsx`: proof proposals and step navigation.
- `server/proofs.ts`, `server/lean-runner.ts`: scoped checks and isolated Lean workers.
- `lean/`, `scripts/setup-lean.mjs`: pinned Lean/Mathlib project and runtime setup.
- `server/pdf-import.ts`, `server/pdf-worker.ts`: bounded PDF extraction.
- `extension/`: packaged reader, native panel and validated active-tab messaging.

Tests cover account/room isolation, invite replay, revocation, concurrent notes,
restart recovery, AI request idempotency, provider failure handling, and real browser
reading flows. Test providers are explicit fixtures; tests do not incur LLM charges.
The web reader is tested in Chromium and Firefox; extension tests use Chromium.
See [THIRD_PARTY.md](THIRD_PARTY.md) for the example paper's attribution and license.
