/* InnerCider — Windows file-path links (opt-out, on by default)
 *
 * Innergy notes often paste a network path to a work-order folder, e.g.
 *   M:\Work Orders\LOOK-103 ISLAND 10_20_2026 11 43AM\B1
 * These show up as plain text. This feature turns any `W:\…` or `M:\…` path it
 * finds in the page text into a clickable link that opens that folder:
 *
 *   • Windows  → the native path (File Explorer).
 *   • Mac/Linux → the CPW file server over SMB, mapping the mapped drive to its
 *     share: W:\  →  smb://10.1.0.6/Projects-CPW
 *             M:\  →  smb://10.1.0.6/Projects-CPW/CNC/Microvellum Data
 *     and the rest of the path (backslashes → forward slashes, spaces encoded).
 *
 * The whole path is captured to the end of its line, so folder/file names with
 * spaces (very common here) stay intact.
 *
 * NO NETWORK: this feature makes zero requests. It only reads page text and
 * reads chrome.storage.local for its on/off flag. Clicking a link hands the
 * URL to the OS (Finder/Explorer), not to Innergy.
 *
 * PERFORMANCE: bootstrap calls mount() on every DOM mutation, so mount() just
 * init-once + schedules a debounced scan. The scan walks text nodes, skips edit
 * surfaces (compose editor, inputs), and never descends into links it already
 * made — so a path is only ever linkified once. Opt out in Options
 * (filePathLinksEnabled).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;

  // ---- drive → share mapping (edit here if the file server changes) ----------
  // Base URLs are pre-encoded (note the %20 in "Microvellum Data").
  const SMB = {
    W: "smb://10.1.0.6/Projects-CPW",
    M: "smb://10.1.0.6/Projects-CPW/CNC/Microvellum%20Data",
  };

  const isWindows = /Windows/.test(navigator.userAgent);

  // Drive letter must sit at a boundary (start of node or after a non-alphanumeric)
  // so we don't match mid-token. Path runs to the end of the line; trailing
  // punctuation/space is trimmed back off afterwards.
  const RE = /(^|[^A-Za-z0-9])([WwMm]:\\[^\r\n]*)/g;
  const TRIM_TAIL = /[\s.,;:!?)\]}>"'»]+$/;

  // Don't touch editable surfaces, form controls, existing links, or our own UI.
  const SKIP_SEL =
    'a,script,style,noscript,textarea,input,select,option,button,' +
    '[contenteditable="true"],[data-lexical-editor],.ContentEditable__root,.ic-path-toast';
  const SCAN_DEBOUNCE_MS = 350;

  // ---- enabled flag (opt-out) ------------------------------------------------
  let enabled = true;
  chrome.storage.local.get("filePathLinksEnabled", (d) => {
    enabled = d.filePathLinksEnabled !== false;
    if (!enabled) teardown(); else scheduleScan();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !c.filePathLinksEnabled) return;
    enabled = c.filePathLinksEnabled.newValue !== false;
    if (!enabled) teardown(); else scheduleScan();
  });

  // ---- URL building ----------------------------------------------------------
  function hrefFor(path) {
    const drive = path[0].toUpperCase();
    const segs = path.slice(3).split(/\\+/).filter(Boolean); // drop "X:\" then split
    if (isWindows) return "file:///" + drive + ":/" + segs.map(encodeURIComponent).join("/");
    const base = SMB[drive] || SMB.W;
    return base + segs.map((s) => "/" + encodeURIComponent(s)).join("");
  }

  function buildLink(path) {
    const a = document.createElement("a");
    a.className = "ic-path-link";
    a.setAttribute("href", hrefFor(path));
    a.setAttribute("rel", "noopener");
    a.dataset.icNative = path;
    a.title = (isWindows ? "Open in File Explorer" : "Open in Finder") + " — " + path;
    const ico = document.createElement("span");
    ico.className = "ic-path-ico";
    ico.textContent = "📁";
    const txt = document.createElement("span");
    txt.className = "ic-path-text";
    txt.textContent = path;
    a.append(ico, txt);
    return a;
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("ic-path-style")) return;
    const st = document.createElement("style");
    st.id = "ic-path-style";
    st.textContent = `
      .ic-path-link{cursor:pointer;color:#1a56db;text-decoration:none;white-space:normal}
      .ic-path-link .ic-path-ico{margin-right:3px;font-size:.9em;text-decoration:none}
      .ic-path-link .ic-path-text{text-decoration:underline;text-decoration-style:dotted;
        text-underline-offset:2px;word-break:break-all}
      .ic-path-link:hover .ic-path-text{text-decoration-style:solid}
      .ic-path-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
        z-index:2147483600;background:#1f2937;color:#fff;padding:9px 16px;border-radius:9px;
        font:13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);
        animation:icPathToast .2s ease-out}
      @keyframes icPathToast{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- scan + linkify --------------------------------------------------------
  function linkifyNode(node) {
    const text = node.nodeValue;
    if (!text || text.indexOf(":\\") === -1) return;
    RE.lastIndex = 0;
    let m, last = 0, frag = null;
    while ((m = RE.exec(text))) {
      const path = m[2].replace(TRIM_TAIL, "");
      if (!/^[WwMm]:\\/.test(path)) continue;     // trimmed away to nothing
      const start = m.index + m[1].length;
      if (!frag) frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(last, start)));
      frag.appendChild(buildLink(path));
      last = start + path.length;
      RE.lastIndex = last;                        // keep any trimmed tail as text
    }
    if (!frag) return;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer || !enabled) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try { scan(); } catch (e) { IC.warn("file-path-links scan", e); }
    }, SCAN_DEBOUNCE_MS);
  }

  function scan() {
    if (!enabled || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf(":\\") === -1) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || (p.closest && p.closest(SKIP_SEL))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const hits = [];
    let node;
    while ((node = walker.nextNode())) hits.push(node);
    if (!hits.length) return;
    ensureStyle();
    for (const n of hits) linkifyNode(n);
  }

  // ---- click handling --------------------------------------------------------
  // Mac/Linux: let the smb:// href navigate — the OS prompts to open Finder/Files.
  // Windows: file:// links are blocked from an https page, so also copy the native
  // path and toast, so the user can paste it into Explorer's address bar.
  function onClick(e) {
    if (!enabled) return;
    const a = e.target && e.target.closest && e.target.closest("a.ic-path-link");
    if (!a) return;
    if (!isWindows) return;
    copyText(a.dataset.icNative || "");
    toast("Path copied — paste into Explorer's address bar");
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove();
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.querySelector(".ic-path-toast");
    if (!t) { t = document.createElement("div"); t.className = "ic-path-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (t) t.remove(); }, 2600);
  }

  // ---- teardown (unwrap links back to text) ----------------------------------
  function teardown() {
    document.querySelectorAll("a.ic-path-link").forEach((a) => {
      a.replaceWith(document.createTextNode(a.dataset.icNative || a.textContent || ""));
    });
  }

  // ---- one-time wiring -------------------------------------------------------
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    document.addEventListener("click", onClick, true);
  }

  IC.registerFeature({ id: "file-path-links", mount: () => { init(); scheduleScan(); } });
})();
