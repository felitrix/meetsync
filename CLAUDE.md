# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install deps
npm run dev        # Vite dev build with HMR, writes to dist/ (load dist/ unpacked in Chrome)
npm run build      # tsc --noEmit (type-check) + vite build → dist/
npm run zip        # package dist/ into meetsync-<version>.zip (requires built dist/)
npm run package    # build + zip
```

`npm test` covers caption reconciliation, legacy transcript cleaning, chat-header normalization, and
history-retention behavior. `npm run build` is the final gate: it must pass `tsc --noEmit` (strict)
before bundling.

Loading the extension: `chrome://extensions` → enable Developer mode → "Load unpacked" → select `dist/`.

**Icons:** `public/icons/icon-{16,32,48,128}.png` are rasterized from SVG via **headless Chromium** (crisp at exact sizes). 16/32/48 use a bold simplified glyph (`mark-small.svg`); 128 uses the full mark (`meetsync-mark.svg`). Do NOT use `scripts/gen-icons.mjs` (placeholder "M" generator) or `qlmanage` (adds margin / blurs). To regenerate, render the SVG at the target viewport size with Playwright/Chromium and screenshot.

## What this is

MeetSync is a **Manifest V3 Chrome extension** for Google Meet that scrapes the captions Meet already
renders (it never touches audio), shows them as a chat, and exports the meeting to `.txt`/`.json` — with
optional AI correction/summary via a user-configured **Ollama** server. Vanilla TypeScript (no UI
framework). `PRD.md` is the full product spec; requirements are referenced in code comments as
`RF-###` / `RNF-###`.

Being published to the **Chrome Web Store** (repo: github.com/daraujo85/meetsync, branch `master`).
Publishing assets live in the repo: `docs/privacy.html` (privacy policy, served via GitHub Pages at
`daraujo85.github.io/meetsync/privacy.html`), `STORE_LISTING.md` (copy-paste listing text + permission
justifications), `store-assets/` (1280×800 screenshots + promo tiles, JPEG no-alpha), `releases/*.zip`.
For the store: `package.json` description must stay ≤132 chars, and permissions are kept minimal (no
wildcard host perms — only `meet.google.com` + `localhost`/`127.0.0.1`).

## Architecture (the parts that span files)

Three Chrome execution contexts, wired in `src/content/content-script.ts` (the bootstrap):

- **Content script** (`src/content/`, `src/ui/`) — runs on `meet.google.com`. Owns all state, capture,
  and UI. Mounts the UI inside a **Shadow DOM** host (`#meetsync-host`, `position:fixed`) so MeetSync CSS
  and Meet CSS never collide. Styles are imported as strings via `?inline` and injected into the shadow root.
- **Background service worker** (`src/background/service-worker.ts`) — deliberately thin. Its only job is
  to run Ollama HTTP calls, because cross-origin fetch to `localhost` only bypasses CORS when issued from
  the worker (which holds the extension's host permissions). It is a message router for `ollama:*` actions.
- **Manifest** is generated from `manifest.config.ts` by `@crxjs/vite-plugin` (not hand-written JSON).

### State flow

`src/services/store.ts` is the single source of truth: a hand-rolled pub/sub `store` (no framework).
Capture modules and async actions write to it; `Panel` subscribes in `panel.ts` and patches the DOM. The
meeting transcript lives in memory during capture and is auto-saved to local meeting history, via
`storage-service.ts` → `chrome.storage.local`. Retention is configurable (10/20/40 non-favorites);
favorites are preserved.

`MeetDetector` (`meet-detector.ts`) fires `onJoined`/`onLeft` (patches `history.pushState` for the SPA +
MutationObserver + poll). On join → `store.startSession` + `CaptionCapture.start()`/`ChatCapture.start()`
+ auto-enable captions. On leave → `store.endSession()` keeps the transcript visible (state `ended:true`,
panel stays open so the user can review/download after the meeting); the transcript is only cleared by
`resetSession()` when a **new** meeting starts.

### Caption + chat capture — the fragile, isolated core

`src/content/caption-capture.ts` and `src/content/chat-capture.ts` are the **highest-risk files** and are
self-contained. All DOM coupling to Meet lives in the `SELECTORS` object at the top of each — **edit only
there when Meet's DOM changes**. They avoid obfuscated class names and key off stable signals confirmed
live: captions use `[role="region"][aria-label*="Legenda"]` + `jscontroller`; the caption toggle is
`button[jsname="RrG0hf"]`; chat uses `div[jsname="xySENc"]` with one message per `[data-message-id]`
(`[jsname="dTKtvb"]` = text) and auto-opens the chat on the unread badge (`[jscontroller="fIa6jf"]` /
aria-label "...nova mensagem"). Speaker rows are found **structurally** (the direct child of the region
that contains the avatar `<img>`), not by class. Dedup: each caption DOM node → one entry (`WeakMap`),
plus a rolling-window reconciler (`caption-utils.ts`) that appends only the unseen suffix when Meet
slides a cumulative caption window. Long monologues are split into readable entries by size/time, and
detached/recreated DOM rows can reconnect to a matching speaker stream. Chat dedups by
`data-message-id`; its header parser handles both 24-hour and AM/PM timestamps without leaking `AM`
into participant names.

Capture health is tracked in the store: last caption activity, observer attachment, automatic
reconnections, and a neutral silence warning after 30 seconds without a new caption. The pure
`cleanRollingTranscript` utility also repairs legacy JSON exports before importing a cleaned copy.

### Mention alerts (toolbar action + notifications)

`src/content/alert-watcher.ts` watches captured speech and alerts the user when **someone else**
mentions a watched term or (via Ollama) talks about a topic of interest — for when the user is in
another tab. It hooks `store.onEntry()` (fired on every `upsertEntry`), does accent/case-insensitive
**whole-word** matching for `mentionTerms`, and skips the user's own lines (`selfName` / "Você"). The
AI path polls every 15s, sending recent non-self lines + `mentionAiTopics` to `ollama.generate`,
expecting strict JSON `{relevante, motivo}`. Actions (all toggles in the new **Alertas** tab):
clickable Chrome notification (worker focuses the originating Meet tab on click — `meetsync:alert`),
a Web Audio beep in the page, and a per-tab toolbar badge counter (cleared when the Meet tab is
re-activated). No new permissions beyond `notifications`.

The **toolbar icon** uses a conditional popup (`src/popup/`, no `onClicked` since they're mutually
exclusive in MV3): in a Meet tab it shows capture status + a panel toggle (via `meetsync:get-status` /
`meetsync:toggle-panel` to the content script); elsewhere it orients the user. `src/welcome/welcome.html`
is a static extension page opened on first install (`onInstalled`) and from the popup; it's an extra
Rollup input in `vite.config.ts` (not referenced by the manifest).

### Ollama bridge (+ streaming)

`src/services/ollama-client.ts` holds both sides: pure fetch functions run in the worker via
`handleOllamaAction`, and the content-side `ollama` bridge that `sendMessage`s the worker. Streaming
(real-time summary) uses a long-lived **Port** (`STREAM_PORT`): the worker reads `/api/generate`
`stream:true` NDJSON and posts chunks; `ollama.generateStream` reassembles them. CORS to `localhost` works
because the fetch runs in the worker (host permission) — and the user's Ollama is configured with
`OLLAMA_ORIGINS=*` (see the project memory). URLs are normalized to `http://` for localhost.

### Export

`src/services/export-txt.ts` builds the `.txt` (header + chronological `[HH:MM] Name (chat?): text`,
sorted by `capturedAt`) and the structured `.json` (`buildMeetingJson`, PRD §12). Downloads via `Blob` +
`<a download>` — no `chrome.downloads` round-trip.

### UI panel

`src/ui/panel.ts` (one class, no framework) renders the compact bar + expanded panel: header (logo +
wordmark + About sheet), status strip with a Legendas toggle, 4 tabs (Transcrição/Resumo/Exportar/Upload),
and a sticky footer. The whole overlay is **draggable** (offset persisted in `chrome.storage.local`). Logo
is inlined as a `data:` SVG (`src/ui/logo.ts`) to avoid web-accessible-resources in the Shadow DOM.
Real-time summary scheduling lives here (`summaryIntervalMin`, periodic `rtTick` + 1s `rtUiTick`).

## Conventions

- UI: design tokens in `src/ui/styles/tokens.css`. **Capture status = red REC (capturing) / terracota
  `--ms-paused-clay` (paused)**; **blue `--ms-accent-blue` for active/toggles/links; never green.** UI text
  is Brazilian Portuguese. Visual source of truth: the mockup at `~/Downloads/Mockups do Projeto/`.
- AI correction must return ONLY the corrected transcript (no preamble) — see `summary-service.ts` prompt.
- `tsconfig` is strict with `verbatimModuleSyntax` (use `import type`) and `noUnusedLocals`; `@/*` → `src/*`.
- Keep modules separated by concern (capture / state / UI / export / Ollama) — see PRD RNF-023.
