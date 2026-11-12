# Distribution notes

The web app and unpacked Chrome extension build locally. Public hosting and Chrome
Web Store publication have not been performed.

## Extension package

Run `pnpm package:extension` after README checks pass. It creates
`dist/brain-vat-chrome.zip`. Load `.output/chrome-mv3` in Chrome for a local smoke test.
Test the server origin and exact extension origin before distributing. Unpacked
IDs can differ between installations; configure approved origins, or use the stable
ID assigned to a published extension.

A store submission needs the owner's developer account, screenshots, support
contact, and a privacy policy at a stable URL. Its data disclosure should state:

- Local reading stores PDFs/highlights in browser storage.
- Saving a named solo context stores paper text, conversation, proof walkthroughs
  and checks on the local server and in its backups. Access references stay in
  browser storage; new work in a saved context updates automatically.
- Publishing a room uploads the PDF to the chosen Brain Vat server.
- Members share highlights, notes, discussion and AI conversations.
- AI requests send relevant context to the configured provider; external search
  is selected separately by the reader.
- Presence is optional and expires. Shared activity persists on the server;
  backups retain older data for their configured retention period.
- Host permissions are requested for paper imports and the chosen server.

Review current store requirements when submitting. This repository does not claim
store approval or browser support beyond tested Chromium.

## Product boundaries

Extraction is not OCR and can lose notation. The original PDF remains available
from derived sources. Reference overlays identify metadata and safe links;
external search does not promise full-text access to every reference. AI answers
are explanations with citations, not formal correctness proofs.

Notes merge through Yjs with authenticated polling. Membership, highlights, chat
and AI execution are server-owned. Losing access blocks future requests; previously
acquired data cannot be remotely erased. Keep disconnected note drafts until the
server confirms they were saved.

Lean-assisted walkthroughs and local checking are available; see PROOFS.md for
runtime requirements and the distinction between formal checks and paper meaning.
