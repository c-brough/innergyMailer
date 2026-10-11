# Architecture

InnerCider is a Chrome extension (Manifest V3) + a local native-messaging host,
built to grow into a toolkit of CPW-specific tools for Innergy rather than stay
a single-purpose "mail a PO" extension. This document describes how the pieces
fit together and the pattern new features should follow. For step-by-step
instructions on adding one, see [docs/adding-a-feature.md](docs/adding-a-feature.md).

## The three layers

```
extension/content/       Content scripts injected into app.innergy.com pages
extension/background/    The MV3 service worker
native-host/              A local Python process the extension talks to
```

Content scripts read and modify the Innergy page. The background worker holds
state that must survive page navigation (and MV3 service-worker restarts) and
is the only layer allowed to talk to `chrome.downloads` and the native host.
The native host exists only because content scripts and the background worker
are both sandboxed and cannot create OS-level Mail/Outlook drafts directly.

## Content scripts: a feature registry, not a bundler

MV3 content scripts can't cleanly `import` a shared module — there's no
bundler in this repo (deliberately, for now; see "Why no bundler yet" below).
Instead, `manifest.json` lists ordered files that all attach to one global,
`window.InnerCider`:

1. **`content/core.js`** — loaded first. Defines `window.InnerCider`: a
   logger (`log`/`warn`), the shared Innergy access layer (the authenticated
   `query/run` API client, plus `innergy.getPoId`, `innergy.getWorkOrderIds`,
   `innergy.fetchPoFiles`, `innergy.fetchWorkOrderInfo`,
   `innergy.fetchEmployeeGroupEmails`), and a feature registry
   (`registerFeature`, `_features`).
2. **`content/features/*.js`** — one file per feature. Each is a self-contained
   IIFE that reads `window.InnerCider`, does its own DOM scraping/injection,
   and finishes by calling `IC.registerFeature({ id, mount })`. `mount()` must
   be cheap and idempotent.
3. **`content/bootstrap.js`** — loaded last. Runs a single `MutationObserver`
   (Innergy is a single-page app; toolbars and grids mount/unmount as the user
   navigates) that calls every registered feature's `mount()` on every DOM
   change, plus once at load.

One file sits outside this pattern: **`content/features/export-capture-main.js`**
runs in the page's MAIN world (a second `content_scripts` entry, `"world":
"MAIN"`, `document_start`) because it patches `window.open` — the page's own
`window`, which an isolated content script can't reach. It has no access to
`window.InnerCider` for the same reason, so it stays deliberately tiny: while
armed, capture the export PDF's URL, post it to the isolated world, suppress
the popup; unarmed, pass every call straight through. `draft-email.js` holds
the other end of that `window.postMessage` bridge. Prefer the isolated world
for anything new — MAIN-world code shares a global scope with Innergy's own
bundle and can break the app.

This ordered-globals pattern is the plain-JS equivalent of ES module imports:
each feature's file boundary is real, but wiring happens through the shared
namespace instead of `import`/`export`. It converts to real modules 1:1
whenever a bundler is introduced — `IC.innergy.fetchPoFiles()` becomes
`import { fetchPoFiles } from "../shared/innergy.js"`, `registerFeature` calls
become a plain array export, etc.

## Background worker: real ES modules

The service worker *can* use `import`/`export` with zero build step — MV3
supports `"background": { "type": "module" }`. So the background side is
structured as actual modules:

- **`background/background.js`** (entry) — imports every feature's handler
  functions and wires them into a small `chrome.runtime.onMessage` router
  keyed by message `type`, plus the one `chrome.downloads.onChanged` listener.
- **`background/features/*.js`** — one file per feature, exporting plain
  handler functions (e.g. `handleExportAndMail`, `handleGraphAuth`).
- **`background/shared/*.js`** — `native.js` (the `sendNativeMessage` wrapper
  around the native host), `session.js` (`chrome.storage.session` helpers for
  state that must survive worker restarts), `log.js` (the `dbg` helper that
  mirrors console output to the active tab).

**MV3 note:** the worker can be killed and restarted at any time, including
mid-download. ES module imports resolve before a file's top-level code runs,
so registering `chrome.*` listeners synchronously at the top of
`background.js` is safe on every restart — nothing here waits on an async
`import()`.

### Why content uses globals but background uses modules

This asymmetry is deliberate, not an oversight: content scripts have no
module-loading option without a bundler; the background service worker does.
Using real modules where they're free (background) and the standard
ordered-globals fallback where they're not (content) gets the same
per-feature isolation on both sides without introducing a build step.

## The native host

`native-host/innergy_mailer_host.py` (macOS, AppleScript via `osascript`),
`innergy_mailer_host_win.py` (Windows, Outlook COM or Microsoft Graph), and
`innergy_mailer_host_linux.py` (Linux, Microsoft Graph or `xdg-email`) are
separate processes launched by Chrome via native messaging. They share the
message framing, the `{ok, error}` reply shape, and the Graph device-code
actions (`auth_start` / `auth_complete`), but not code — each is standalone so
an installer only ever has to place one file. The Linux host adds one wrinkle:
it returns an `openUrl` in its reply instead of launching a browser, because a
host spawned by Chromium has no reliable claim on `DISPLAY`. `draft-email.js`
and `graph-auth.js` open that URL with `chrome.tabs.create()`; the other two
hosts omit the field, so the call stays a no-op there. The host's
registered name, `com.innergy.mailer`, and the extension's manifest `key`
(which pins a stable extension ID) are both left unchanged from the original
"Innergy Mailer" naming — every existing install's native-messaging manifest
and Chrome's allow-list match against these exact strings, so changing either
would force every user to reinstall for no functional benefit.

## Why no bundler yet

A bundler (and optionally TypeScript) is the natural next step once there are
enough features to make `import`-based sharing across content scripts worth
the build step. This repo's structure is deliberately shaped so that step is
additive: the module boundaries already exist as separate files; a bundler
would only change how they're wired together, not where the code lives.

## Adding a feature

See [docs/adding-a-feature.md](docs/adding-a-feature.md) for the concrete
steps and a template file to copy from.
