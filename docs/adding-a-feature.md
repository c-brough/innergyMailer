# Adding a feature

This is the checklist for adding a new CPW tool to InnerCider. Read
[ARCHITECTURE.md](../ARCHITECTURE.md) first if you haven't — it explains why
the pieces are laid out this way.

Every feature falls into one of two shapes:

- **Page-only** — reads/annotates the Innergy page, no need to survive
  navigation or talk to the native host. Content script only. (e.g. the
  Materials total-cost chips.)
- **Needs privileged APIs** — downloads files, calls the native host, or needs
  state that survives a service-worker restart. Content script *and*
  background feature, talking over `chrome.runtime.sendMessage`. (e.g. Draft
  PO Email.)

## 1. Content-script feature (always needed)

Copy `extension/content/features/_template.js` to
`extension/content/features/your-feature.js` and fill it in. Every feature
file:

- Reads `const IC = window.InnerCider;` at the top.
- Does its own DOM scraping/injection — nothing to register with `core.js`
  beyond `IC.registerFeature`.
- Ends with `IC.registerFeature({ id: "your-feature", mount: yourMountFn })`.

`mount()` runs on every DOM mutation (Innergy is a single-page app) *and* once
at page load, so it must be:

- **Idempotent** — check for your own injected element/marker before adding
  it again (see `injectButton`'s `document.getElementById(OUR_BTN_ID)` guard
  or `materials-cost.js`'s per-cell `IC_MARK` check).
- **Cheap** — it runs on every DOM change on the page. Debounce expensive work
  (see `materials-cost.js`'s `scheduleAnnotate`).
- **Defensive** — wrap risky DOM traversal in `try/catch`; `bootstrap.js`
  already catches per-feature, but don't rely on that as your only guard.

Then add your file to `extension/manifest.json`'s `content_scripts[0].js`
array, **before** `content/bootstrap.js` (which must stay last) and **after**
`content/core.js` (which must stay first). Order between feature files
doesn't matter.

If you need Innergy PO/file data, use `IC.innergy.*` rather than writing your
own `fetch`. If your feature needs something the shared layer doesn't have
yet, add it to `content/core.js`'s `innergy` object so the next feature can
reuse it too.

## 2. Background feature (only if you need privileged APIs)

Copy `extension/background/features/_template.js` to
`extension/background/features/your-feature.js`. Export one handler function
per message type your feature sends, e.g.:

```js
export function handleYourMessage(msg, sender, sendResponse) {
  // ... sendResponse({ ok: true }) when done
}
```

Then in `extension/background/background.js`:

1. `import { handleYourMessage } from "./features/your-feature.js";`
2. Add `YOUR_MESSAGE_TYPE: handleYourMessage` to the `handlers` map.

Use the shared helpers instead of reimplementing them:

- `shared/native.js`'s `sendNative(payload)` to talk to the native host.
- `shared/session.js` if you need state that survives a worker restart.
- `shared/log.js`'s `dbg(text, data)` for diagnostics (mirrors to the active
  tab's console).

From the content script, send your message with
`chrome.runtime.sendMessage({ type: "YOUR_MESSAGE_TYPE", ... }, callback)`.

## 3. Native host (only if you need OS-level access)

Only needed if your feature must do something neither a content script nor
the background worker can — e.g. write a file, drive another application.
Add a new `action` (or message shape) to `native-host/innergy_mailer_host.py`
and `innergy_mailer_host_win.py`, following the existing `auth_start` /
`auth_complete` pattern for anything that needs multi-step back-and-forth.
Keep the native-messaging host name (`com.innergy.mailer`) and the extension's
manifest `key` unchanged — both are load-bearing for every existing install.

## 4. Verify

There's no automated test suite yet — verify by hand against a live Innergy
page: load the extension unpacked, open a PO page, confirm your feature does
its thing and the console shows `[InnerCider]` logs with no errors.
