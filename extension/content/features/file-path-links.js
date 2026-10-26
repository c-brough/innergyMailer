/* InnerCider — Windows file-path links (opt-out, on by default)
 *
 * Innergy notes often paste a network path to a work-order folder, e.g.
 *   M:\Work Orders\LOOK-103 ISLAND 10_20_2026 11 43AM\B1
 * These show up as plain text. This feature turns any `W:\…` or `M:\…` path it
 * finds in the page text into a clickable link that opens that folder:
 *
 *   • Windows  → opens the folder as Chrome's own file-browser tab (file:///…),
 *     opened by the background worker since an https page can't navigate to
 *     file://. This needs Chrome's one-time per-extension "Allow access to file
 *     URLs" toggle; when it's off we guide the user to it and copy the path.
 *   • Mac/Linux → the CPW file server over SMB, mapping the mapped drive to its
 *     share: W:\  →  smb://10.1.0.6/Projects-CPW
 *             M:\  →  smb://10.1.0.6/Projects-CPW/CNC/Microvellum Data
 *     and the rest of the path (backslashes → forward slashes, spaces encoded).
 *
 * The whole path is captured to the end of its line, so folder/file names with
 * spaces (very common here) stay intact.
 *
 * "Open in real app" option (filePathOpenNative, off by default): when on, a
 * click hands the path to the native helper, which opens it in the OS file
 * browser (Finder/Explorer) and files in their default app — on every OS. When
 * off, the per-OS behavior above is used.
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

  // ---- flags -----------------------------------------------------------------
  // enabled: opt-out, on by default. openNative: opt-in — open in the OS file
  // browser / default app via the native helper instead of a browser view.
  let enabled = true;
  let openNative = false;
  chrome.storage.local.get(["filePathLinksEnabled", "filePathOpenNative"], (d) => {
    enabled = d.filePathLinksEnabled !== false;
    openNative = d.filePathOpenNative === true;
    if (!enabled) teardown(); else scheduleScan();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.filePathOpenNative) openNative = c.filePathOpenNative.newValue === true;
    if (c.filePathLinksEnabled) {
      enabled = c.filePathLinksEnabled.newValue !== false;
      if (!enabled) teardown(); else scheduleScan();
    }
  });

  // ---- URL building ----------------------------------------------------------
  function smbUrlFor(path) {
    const drive = path[0].toUpperCase();
    const segs = path.slice(3).split(/\\+/).filter(Boolean); // drop "X:\" then split
    const base = SMB[drive] || SMB.W;
    return base + segs.map((s) => "/" + encodeURIComponent(s)).join("");
  }
  function fileUrlFor(path) {
    const drive = path[0].toUpperCase();
    const segs = path.slice(3).split(/\\+/).filter(Boolean);
    return "file:///" + drive + ":/" + segs.map(encodeURIComponent).join("/");
  }
  function hrefFor(path) { return isWindows ? fileUrlFor(path) : smbUrlFor(path); }

  function buildLink(path) {
    const a = document.createElement("a");
    a.className = "ic-path-link";
    a.setAttribute("href", hrefFor(path));
    a.setAttribute("rel", "noopener");
    a.dataset.icNative = path;              // raw drive path (Windows open / clipboard)
    a.dataset.icSmb = smbUrlFor(path);      // smb:// URL (Mac/Linux open)
    a.title = (isWindows ? "Open in File Explorer" : "Open in Finder") + " — " + path;
    // Exactly the original text — no icon, no added characters. The href carries
    // the full path even when the cell clips what's visible.
    a.textContent = path;
    return a;
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("ic-path-style")) return;
    const st = document.createElement("style");
    st.id = "ic-path-style";
    st.textContent = `
      /* Linkify in place WITHOUT changing layout: inherit the cell's own text
         flow/clipping and colour so the list looks identical to plain text.
         Only a hover affordance (pointer + blue underline) reveals the link,
         and neither property changes the line box, so rows can't grow. */
      .ic-path-link{cursor:pointer;color:inherit;text-decoration:none;
        white-space:inherit;word-break:inherit;overflow-wrap:inherit}
      .ic-path-link:hover{color:#1a56db;text-decoration:underline}
      .ic-path-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
        z-index:2147483600;background:#1f2937;color:#fff;padding:9px 16px;border-radius:9px;
        font:13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);
        animation:icPathToast .2s ease-out}
      @keyframes icPathToast{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
      #ic-path-card{position:fixed;right:22px;bottom:22px;z-index:2147483601;width:340px;max-width:calc(100vw - 44px);
        background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;
        box-shadow:0 18px 50px rgba(0,0,0,.28);font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
        animation:icPathCard .2s ease-out}
      @keyframes icPathCard{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      #ic-path-card .ic-pc-title{font-size:14px;font-weight:700;margin-bottom:6px}
      #ic-path-card .ic-pc-body{color:#475569;margin-bottom:12px}
      #ic-path-card .ic-pc-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
      #ic-path-card .ic-pc-btn{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:8px;
        padding:6px 12px;font-size:12.5px;font-weight:600;color:#334155}
      #ic-path-card .ic-pc-btn:hover{background:#f1f5f9}
      #ic-path-card .ic-pc-primary{background:#1a56db;border-color:#1a56db;color:#fff}
      #ic-path-card .ic-pc-primary:hover{background:#1646b8}
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
  // Three routes:
  //   • "Open in real app" on  → native helper opens it in Finder/Explorer.
  //   • Mac/Linux (default)     → let the smb:// href navigate (Finder/Files).
  //   • Windows (default)       → background opens a Chrome file-browser tab.
  function onClick(e) {
    if (!enabled) return;
    const a = e.target && e.target.closest && e.target.closest("a.ic-path-link");
    if (!a) return;
    // Let modifier/middle clicks fall through to the browser's own handling.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    if (openNative) {
      e.preventDefault();
      openViaHost(a);
      return;
    }
    if (!isWindows) return;            // default Mac/Linux: smb:// href navigates
    e.preventDefault();                // default Windows: Chrome file-browser tab
    openWinTab(a);
  }

  // "Open in real app": hand the path to the native helper.
  function openViaHost(a) {
    const target = isWindows ? (a.dataset.icNative || "") : (a.dataset.icSmb || a.getAttribute("href"));
    try {
      chrome.runtime.sendMessage({ type: "OPEN_LOCAL_PATH_NATIVE", target }, (resp) => {
        if (chrome.runtime.lastError || !resp) { hostMissing(a); return; }
        if (resp.ok) return;
        if (resp.transportError) { hostMissing(a); return; }
        toast("Couldn't open the folder: " + (resp.error || "unknown error"));
      });
    } catch (err) { hostMissing(a); }
  }

  // Native helper not installed — open the folder the normal way so the user
  // isn't blocked, and point them to Options to set the helper up.
  function hostMissing(a) {
    if (isWindows) copyText(a.dataset.icNative || "");
    else { try { window.location.href = a.dataset.icSmb || a.getAttribute("href"); } catch (e) { /* ignore */ } }
    showCard(
      "Open in your file browser",
      "To open folders in Finder/Explorer and files in their real app, install the " +
        "InnerCider helper, then re-run the installer. You can set it up under " +
        "“Windows file-path links” in Options." +
        (isWindows ? " (The path is copied for now.)" : ""),
      [
        { label: "Open Options", primary: true, onClick: () => {
            try { chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }); } catch (e) { /* ignore */ }
            closeCard();
          } },
        { label: "Dismiss", onClick: closeCard },
      ]
    );
  }

  // Windows default: open the folder as a Chrome file-browser tab.
  function openWinTab(a) {
    const url = a.getAttribute("href");
    const native = a.dataset.icNative || "";
    try {
      chrome.runtime.sendMessage({ type: "OPEN_LOCAL_PATH", url }, (resp) => {
        if (chrome.runtime.lastError || !resp) { copyFallback(native); return; }
        if (resp.ok) return;                       // opened in a tab
        if (resp.needsFileAccess) { promptFileAccess(native); return; }
        copyFallback(native);
      });
    } catch (err) { copyFallback(native); }
  }

  function copyFallback(native) {
    copyText(native);
    toast("Path copied — paste it into a Chrome tab or Explorer");
  }

  // One-time setup guidance when file access is off.
  function promptFileAccess(native) {
    copyText(native); // copied so they can paste meanwhile
    showCard(
      "Open folders in a Chrome tab",
      "Chrome needs file access for this extension — a one-time switch. On the " +
        "extension's settings page, turn on “Allow access to file URLs,” " +
        "then click the path again. (The path is copied to your clipboard for now.)",
      [
        { label: "Open extension settings", primary: true, onClick: () => {
            try { chrome.runtime.sendMessage({ type: "OPEN_EXT_SETTINGS" }); } catch (e) { /* ignore */ }
            closeCard();
          } },
        { label: "Dismiss", onClick: closeCard },
      ]
    );
  }

  function closeCard() { const c = document.getElementById("ic-path-card"); if (c) c.remove(); }
  function showCard(title, body, actions) {
    ensureStyle();
    closeCard();
    const card = document.createElement("div");
    card.id = "ic-path-card";
    const h = document.createElement("div"); h.className = "ic-pc-title"; h.textContent = title;
    const p = document.createElement("div"); p.className = "ic-pc-body"; p.textContent = body;
    const row = document.createElement("div"); row.className = "ic-pc-actions";
    for (const a of actions) {
      const b = document.createElement("button");
      b.className = "ic-pc-btn" + (a.primary ? " ic-pc-primary" : "");
      b.textContent = a.label;
      b.addEventListener("click", a.onClick);
      row.appendChild(b);
    }
    card.append(h, p, row);
    document.body.appendChild(card);
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
