/* InnerCider — content script bootstrap
 *
 * Innergy is a single-page app; toolbars/grids mount and unmount as the user
 * navigates. A single MutationObserver re-runs every registered feature's
 * mount() on each DOM change (and once on initial load) — features must keep
 * mount() cheap and idempotent. See docs/adding-a-feature.md for how to add
 * a new one.
 *
 * Must be the LAST file listed in manifest.json's content_scripts, so every
 * feature has already registered by the time this runs.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;

  function mountAll() {
    for (const feature of IC._features) {
      try {
        feature.mount();
      } catch (e) {
        IC.warn(`feature "${feature.id}" mount() threw`, e);
      }
    }
  }

  const observer = new MutationObserver(mountAll);
  observer.observe(document.body, { childList: true, subtree: true });
  mountAll();
  IC.log(
    `content scripts loaded (${IC._features.length} feature${IC._features.length === 1 ? "" : "s"})`,
    IC._features.map((f) => f.id)
  );
})();
