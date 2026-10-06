/* InnerCider — content script core
 *
 * Shared namespace for all Innergy content-script features. Loaded first (see
 * manifest.json content_scripts order); every feature file attaches to
 * `window.InnerCider` instead of keeping its own IIFE-local globals, so
 * features can share the Innergy access layer and register with the single
 * SPA-aware bootstrap observer (bootstrap.js).
 *
 * MV3 content scripts can't cleanly ES-`import` a shared module without a
 * bundler, so this uses the standard no-build equivalent: ordered files in
 * the manifest, sharing one global namespace. See ARCHITECTURE.md — this
 * converts to real `import`s 1:1 whenever a bundler is introduced.
 */

(() => {
  "use strict";

  if (window.InnerCider) return; // already initialized (re-injection guard)

  const features = [];

  function log(text, data) {
    console.log("[InnerCider]", text, data || "");
  }

  function warn(text, data) {
    console.warn("[InnerCider]", text, data || "");
  }

  // ---- Shared Innergy access layer -------------------------------------------
  // Every feature that needs PO or other data from Innergy should
  // go through here rather than re-implementing its own fetch/query logic.

  function getPoId() {
    const m = location.hash.match(/purchaseOrders\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  // Run one of Innergy's own queries against the session the user already has.
  // GET carries the query in the URL; POST is for the grid-style queries that
  // take DevExtreme LoadOptions. Resolves to null on any problem — callers
  // decide what a missing answer means.
  async function runQuery(query, { method = "GET" } = {}) {
    try {
      const resp =
        method === "POST"
          ? await fetch("https://app.innergy.com/query/run", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(query),
            })
          : await fetch(
              "https://app.innergy.com/query/run?query=" + encodeURIComponent(JSON.stringify(query)),
              { credentials: "include" }
            );
      if (!resp.ok) {
        warn(`query ${query.$type} failed: HTTP ${resp.status}`);
        return null;
      }
      return await resp.json();
    } catch (e) {
      warn(`query ${query.$type} threw:`, e);
      return null;
    }
  }

  // Fetch the files attached to this PO via the same API the Files tab uses.
  // Returns [{ name, url, flag }] for real files (folders and entries without a
  // download URL are skipped). `flag` is the innergyEmailAttach custom field
  // value ("yes" | "no" | "" if unset). Resolves to [] on any problem.
  async function fetchPoFiles() {
    const poId = getPoId();
    if (!poId) return [];
    const query = JSON.stringify({
      PurchaseOrderId: poId,
      $type: "PurchaseOrderAttachmentsQuery",
    });
    const url = "https://app.innergy.com/query/run?query=" + encodeURIComponent(query);
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return [];
      const json = await resp.json();
      return (json.data || [])
        .filter((it) => it && it.IsFolder === false && it.Name && it.Name.Url)
        .map((it) => ({
          name: (it.Name.DisplayName || it.Name.Title || "attachment").trim(),
          url: it.Name.Url,
          flag: String((it.CustomFields && it.CustomFields.innergyEmailAttach) || "")
            .trim()
            .toLowerCase(),
        }));
    } catch (e) {
      warn("Could not fetch PO files:", e);
      return [];
    }
  }

  // ---- Feature registry -------------------------------------------------------
  // Each feature file calls InnerCider.registerFeature({ id, mount }). `mount()`
  // must be cheap and idempotent — it runs on every SPA navigation/DOM mutation
  // (see bootstrap.js) and once on initial load. See docs/adding-a-feature.md.
  function registerFeature(feature) {
    features.push(feature);
  }

  window.InnerCider = {
    log,
    warn,
    innergy: {
      getPoId,
      fetchPoFiles,
    },
    registerFeature,
    _features: features,
  };
})();
