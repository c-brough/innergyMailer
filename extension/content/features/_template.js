/* InnerCider — content feature template
 *
 * Copy this file to `your-feature.js`, fill it in, then add its path to
 * manifest.json's content_scripts[0].js (after core.js, before bootstrap.js).
 * See docs/adding-a-feature.md for the full checklist.
 *
 * NOT wired into the manifest — this file is never loaded as-is.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;

  // mount() runs on every DOM mutation on the page (Innergy is a single-page
  // app) plus once at load. Keep it cheap and idempotent — guard against
  // re-doing work you've already done (see draft-email.js's
  // `document.getElementById(OUR_BTN_ID)` check, or materials-cost.js's
  // per-cell marker class).
  function mount() {
    // TODO: find your target element(s); bail out cheaply if not present.
    // TODO: check for your own marker before injecting/annotating again.
    // TODO: do the actual work.
  }

  // Need PO/file data from Innergy? Use the shared access layer instead of a
  // new fetch():
  //   const files = await IC.innergy.fetchPoFiles();
  //   const poId = IC.innergy.getPoId();
  // If the layer doesn't have what you need yet, add it to core.js's
  // `innergy` object so the next feature can reuse it too.

  // Need to talk to the background worker (downloads, native host, storage
  // that survives navigation)? Send a message and add a matching handler in
  // extension/background/features/ (see docs/adding-a-feature.md §2):
  //   chrome.runtime.sendMessage({ type: "YOUR_MESSAGE_TYPE", ... }, (resp) => { ... });

  IC.registerFeature({ id: "your-feature", mount });
})();
