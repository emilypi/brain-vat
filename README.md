# Brain Vat

A local prototype for reading research papers with persistent highlights and a
source-aware side panel. The local repository is named `brain-vat`.

## Try it

Use Node 24 or later and pnpm 10.13.1:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the local reader](http://127.0.0.1:5173) and choose **Read the example paper**.
Drag across text, choose **Save highlight**, then try zooming, rotating, or reloading.
Use **Region** to capture an equation or figure. The panel searches the paper and
returns passages with clickable page references.

Use the sun/moon toggle in the header to switch light and dark modes. The palette
includes the PDF display, remembers your choice, and follows your system preference
until you choose a mode. The extension reader and its native panel share the choice.

**Open a paper** accepts local PDFs, arXiv links, and ordinary public PDF URLs up to
25 MB. In the web app, a remote server must permit browser cross-origin access;
otherwise download the PDF and open the file. The extension can request site access
for the specific origin you choose.

## Load the Chrome extension

```sh
pnpm build:extension
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `.output/chrome-mv3` folder.
3. Pin **Brain Vat**. On an arXiv or PDF page, click its toolbar icon.
4. Confirm the paper URL in the reader. Choose **Chrome panel** to use the native
   side panel instead of the companion embedded in the reader.

For development, `pnpm dev:extension` runs WXT's extension development workflow.
The production package includes its PDF worker, fonts, CMaps, and image decoders.
It does not load executable scripts from a CDN.

## What works now

- PDF.js canvas rendering and selectable text for text-based PDFs.
- Local file imports and URL imports with a 25 MB limit and 30-second fetch timeout.
- A bundled copy of the example paper, available without an external request.
- Text highlights and rectangular equation/figure selections.
- IndexedDB persistence, document deduplication by SHA-256 of the original bytes,
  and normalized CropBox anchors that survive zoom and rotation.
- Deterministic passage search, with provenance labeled **This paper** and page jumps.
- Packaged Manifest V3 extension with a native side panel, active-tab context,
  validated messages, and rejection of stale document/session navigation.

The web reader and extension share implementation but have separate browser storage
origins. Their local libraries do not synchronize. Clearing browser data or removing
the extension can remove locally saved work. There is no account or backup service.

## Deliberate prototype limits

The panel is **local evidence search**, not a connected LLM. It does not generate
answers, identify verified definitions, or retrieve outside sources. Region
selections preserve geometry but do not interpret an equation or figure.

The alphaXiv-style enhanced mode, definition tooltips, bibliography enrichment,
replaceable hosted model providers, browser invitations, shared AI conversations,
and CRDT collaboration remain planned. Scanned-PDF OCR, paywall integrations,
mobile support, and formal proof checking are outside the initial product scope.

The current UI renders one page at a time. PDF forms, scripts, multimedia and embedded
PDF annotation links are not activated. Full PDF accessibility and comprehensive
cross-browser support are not claimed by this prototype.

## Development checks

```sh
pnpm check
pnpm format:check
pnpm build:web
pnpm build:extension
pnpm exec playwright install chromium
pnpm test:e2e
pnpm audit
```

Unit tests cover coordinate transforms, unsafe URL forms, document identity, source
lookup, and reader-session validation. Browser tests use the actual example PDF for
selection, persistence, zoom, rotation, regions, source jumps and local uploads.
The extension test opens a real native panel in packaged Chromium, rejects stale
or inactive-tab navigation, accepts valid navigation, and clears context when the
reader navigates away or a replacement PDF fails to parse.

The minimatch override pins the patched version for development-only dependency
paths; remove it when the upstream packages adopt the fix.

## Code map

- `src/document.ts`: document identity, anchor geometry, input validation and evidence.
- `src/storage.ts`: local papers and highlights in IndexedDB.
- `src/pdf.ts`, `src/pdf-page.tsx`: PDF lifecycle, text selection and overlays.
- `src/reader-app.tsx`, `src/assistant-panel.tsx`: shared reader and companion UI.
- `src/bridge.ts`: validated extension messages and reader-environment contract.
- `extension/`: background routing, reader entry point and native side panel.
- `tests/`: domain checks and browser-level behavior.

See [THIRD_PARTY.md](THIRD_PARTY.md) for the example paper's attribution and license.
