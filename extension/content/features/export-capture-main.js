/* InnerCider — MAIN-world capture of the exported PDF's URL
 *
 * Both PO export buttons end by opening an Azure blob URL with a SAS token
 * (plain GET, no Content-Disposition), just in two different shapes:
 *   • "Export Custom PDF" — a bare
 *       window.open("https://…blob.core.windows.net/…/PO-100005_….pdf?…&sig=…")
 *   • "Generate PDF" — builds the PDF in the page, POSTs it to
 *     Purchasing/PurchaseOrders/SavePdf (skipped when nothing changed since
 *     the last one), then opens a blank tab and points it at the saved copy:
 *       const w = window.open("", "_blank"); w.location.href = "https://…PO-100009_<timestamp>.pdf?…&sig=…"
 * What Chrome does with that depends on the user's PDF setting: "Download
 * PDFs" produces a download, "Open PDFs in Chrome" renders it in a new tab and
 * no download ever happens. draft-email.js used to rely solely on the download
 * event, so the whole feature silently did nothing for anyone who keeps the
 * inline viewer on — which Innergy label printing needs.
 *
 * So we take the URL at its source instead of waiting for a download: patch
 * window.open, and while draft-email.js is armed, hand the PDF URL to the
 * extension and swallow the call. The background worker fetches it with
 * chrome.downloads.download(), which always writes to disk — the PDF setting
 * governs navigations, not the downloads API. Same file on disk, same
 * downstream flow, both settings, and no stray PDF tab left behind.
 *
 * Armed-only is the load-bearing part. Unarmed, window.open is passed straight
 * through untouched, so label printing and every other Innergy popup behave
 * exactly as they do without the extension.
 *
 * This must run in the MAIN world: an isolated content script has its own
 * `window`, so patching it there would never see the page's call. That makes
 * this the one file outside the window.InnerCider namespace — it can't reach
 * it. The two worlds talk over window.postMessage; the other end lives in
 * content/features/draft-email.js ("MAIN-world bridge").
 */

(() => {
  "use strict";

  // Generous enough to cover Innergy generating the report server-side, short
  // enough that a failed export doesn't leave the hook live indefinitely.
  const ARM_TIMEOUT_MS = 60_000;

  let armedUntil = 0;

  function isPdfUrl(url) {
    try {
      // Match on the path only — the SAS token lives in the query string.
      return /\.pdf$/i.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== "innercider") return;
    if (msg.type === "ARM_EXPORT_CAPTURE") armedUntil = Date.now() + ARM_TIMEOUT_MS;
    else if (msg.type === "DISARM_EXPORT_CAPTURE") armedUntil = 0;
  });

  const originalOpen = window.open;

  function capture(url) {
    armedUntil = 0; // one capture per arm
    window.postMessage({ source: "innercider-main", type: "EXPORT_PDF_URL", url }, location.origin);
  }

  // Innergy ignores the return value, but returning null would break any
  // caller that does `w.focus()`. Hand back an inert stand-in instead.
  function inertWindow() {
    return new Proxy(
      {},
      { get: (_t, prop) => (prop === "closed" ? false : prop === "then" ? undefined : () => {}) }
    );
  }

  // Stand-in for the blank tab "Generate PDF" opens before navigating it. The
  // PDF URL is captured when it's assigned; anything else gets the real tab it
  // asked for, opened late (the popup blocker may object, but nothing we armed
  // for is ever lost to that).
  function deferredWindow(target, features) {
    const navigate = (next) => {
      const url = String(next);
      if (Date.now() < armedUntil && isPdfUrl(url)) capture(url);
      else originalOpen.call(window, url, target, features);
    };
    const loc = {
      assign: navigate,
      replace: navigate,
      get href() {
        return "about:blank";
      },
      set href(next) {
        navigate(next);
      },
    };
    return new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "location" ? loc : prop === "closed" ? false : prop === "then" ? undefined : () => {},
        set: (_t, prop, value) => {
          if (prop === "location") navigate(value);
          return true;
        },
      }
    );
  }

  window.open = function (url, target, features) {
    if (Date.now() < armedUntil) {
      if (typeof url === "string" && isPdfUrl(url)) {
        capture(url);
        return inertWindow();
      }
      if (url == null || url === "" || url === "about:blank") return deferredWindow(target, features);
    }
    // Everything else — label PDFs included — goes through untouched.
    return originalOpen.apply(window, arguments);
  };
})();
