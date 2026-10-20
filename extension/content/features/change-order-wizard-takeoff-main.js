/* InnerCider — MAIN-world Takeoff API bridge for the Quick Change Order wizard
 *
 * The Takeoff API (`POST /Takeoff/QueryCommand/{Query,Command}`) requires custom
 * request headers the page generates — `clientId` (a per-session GUID), takeoffId,
 * projectId, clientVersion, timestamp, clientRequestPath — which an isolated
 * content script can't read (separate `window`). So this runs in the MAIN world:
 * it captures those headers off the app's own requests, captures the currently
 * open `sheetId`, and exposes a postMessage bridge so the isolated orchestrator
 * (change-order-wizard-takeoff.js) can run queries/commands with replayed headers.
 *
 * Both sides are our own extension code on the same origin; messages are gated on
 * `ev.source === window` and a fixed source tag. Mirrors the materials-read-main /
 * export-capture-main MAIN-world pattern. Only active on /Takeoff/ pages.
 */

(() => {
  "use strict";

  if (!/\/Takeoff\//.test(location.pathname)) return;

  const QC_RE = /\/Takeoff\/QueryCommand\//i;
  const QUERY_URL = "https://app.innergy.com/Takeoff/QueryCommand/Query";
  const COMMAND_URL = "https://app.innergy.com/Takeoff/QueryCommand/Command";
  const SHEET_RE = /"sheetId"\s*:\s*"([0-9a-fA-F-]{20,})"/;

  let headers = null; // {clientId, takeoffId, projectId, clientVersion, clientRequestPath}
  let sheetId = null;

  const origFetch = window.fetch;

  function grabHeaders(init) {
    if (headers || !init || !init.headers) return;
    try {
      const h = init.headers;
      const g = (k) => (h.get ? h.get(k) : h[k]);
      const cid = g("clientId");
      if (cid) headers = { clientId: cid, takeoffId: g("takeoffId"), projectId: g("projectId"), clientVersion: g("clientVersion"), clientRequestPath: g("clientRequestPath") };
    } catch (e) { /* ignore */ }
  }

  // Observe the app's own traffic to capture headers + an open sheetId.
  window.fetch = function (input, init) {
    try {
      const url = (typeof input === "string") ? input : (input && input.url) || "";
      if (QC_RE.test(url)) grabHeaders(init);
    } catch (e) { /* ignore */ }
    const p = origFetch.apply(this, arguments);
    if (!sheetId) {
      try {
        const url = (typeof input === "string") ? input : (input && input.url) || "";
        if (QC_RE.test(url)) p.then((r) => { try { r.clone().text().then((t) => { const m = t.match(SHEET_RE); if (m && !sheetId) sheetId = m[1]; }, () => {}); } catch (e) {} }, () => {});
      } catch (e) { /* ignore */ }
    }
    return p;
  };

  // Also hook XHR in case the app uses it for some calls.
  const OO = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send, SH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__icU = u; this.__icH = {}; return OO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (this.__icH) this.__icH[k] = v; } catch (e) {} return SH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (!headers && QC_RE.test(this.__icU || "") && this.__icH && this.__icH.clientId) {
        const h = this.__icH; headers = { clientId: h.clientId, takeoffId: h.takeoffId, projectId: h.projectId, clientVersion: h.clientVersion, clientRequestPath: h.clientRequestPath };
      }
      if (!sheetId && QC_RE.test(this.__icU || "")) {
        const self = this;
        this.addEventListener("load", function () { try { const m = String(self.responseText).match(SHEET_RE); if (m && !sheetId) sheetId = m[1]; } catch (e) {} });
      }
    } catch (e) { /* ignore */ }
    return OS.apply(this, arguments);
  };

  function hdr() {
    return {
      "Content-Type": "application/json",
      clientId: headers.clientId, takeoffId: headers.takeoffId, projectId: headers.projectId,
      clientVersion: headers.clientVersion, timestamp: String(Date.now()), clientRequestPath: headers.clientRequestPath,
    };
  }

  async function run(kind, body) {
    const r = await origFetch.call(window, kind === "command" ? COMMAND_URL : QUERY_URL, {
      method: "POST", credentials: "include", headers: hdr(), body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { /* non-json */ }
    return { ok: r.ok, status: r.status, data };
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== "ic-cow") return;
    const reply = (extra) => window.postMessage(Object.assign({ source: "ic-cow-main", requestId: m.requestId }, extra), location.origin);
    if (m.type === "STATE") { reply({ type: "STATE", ready: !!headers, sheetId }); return; }
    if (m.type === "RUN") {
      if (!headers) { reply({ type: "RESULT", ok: false, error: "no-headers" }); return; }
      try { reply(Object.assign({ type: "RESULT" }, await run(m.kind, m.body))); }
      catch (e) { reply({ type: "RESULT", ok: false, error: String(e && e.message || e).slice(0, 120) }); }
    }
  });
})();
