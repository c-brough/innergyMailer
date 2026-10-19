/* InnerCider — Note draft autosave (opt-out, on by default)
 *
 * While composing a note (a new "CREATE NOTE" post or a "Reply") on an Innergy
 * Notes view, this quietly snapshots the rich-text editor's contents so you can
 * recover them if the field is lost (accidental navigation, a reload, a failed
 * submit, etc.). It never touches what you're typing.
 *
 * NO NETWORK: this feature makes zero requests to Innergy (or anywhere). It only
 * reads the DOM and reads/writes chrome.storage.local. It cannot cause server
 * traffic or rate-limiting. (The crash-safety rules below are about keeping the
 * renderer light, not the network.)
 *
 * The compose field is a Lexical editor — `div[data-lexical-editor="true"]`
 * (= `.ContentEditable__root`); several can be open at once. We read plain text
 * with `.innerText` and rich HTML with `.innerHTML`. (The top "Master Note" box
 * is a plain <textarea>, not rich text, so it's out of scope.)
 *
 * Saving: on every carriage return (Enter) and at least every 5 minutes, deduped.
 * We keep the last 3 drafts per base notes URL (`#/…/notes`, trailing /<noteId>
 * stripped) in chrome.storage.local under `noteDrafts`.
 *
 * Recovery UI: a small blue "draft" icon sits at the bottom of a notes page once
 * a recoverable draft exists; hovering expands it into a banner (× collapses it
 * back to the icon). Clicking anywhere but × opens a ~75%-width card with the
 * latest draft prominent and older ones collapsible — each with Copy / Delete.
 *
 * PERFORMANCE: the bootstrap observer calls mount() on EVERY DOM mutation (the
 * Lexical editor mutates per keystroke), so mount() must be nearly free. We keep
 * drafts in an in-memory cache (storage is read once, then only on change),
 * debounce every re-evaluation, and never read storage or force layout in the
 * hot path. Enabled unless you opt out in Options (noteDraftsEnabled).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const STORE_KEY = "noteDrafts";
  const MAX_DRAFTS = 3;         // snapshots kept per notes page
  const MAX_PAGES = 25;         // distinct notes pages kept (prunes oldest)
  const MAX_HTML = 60000;       // cap per-draft HTML so storage can't balloon
  const SAVE_INTERVAL_MS = 5 * 60 * 1000;
  const EVAL_DEBOUNCE_MS = 300; // coalesce mutation-driven re-evaluations
  const EDITOR_SEL = '[data-lexical-editor="true"], .ContentEditable__root';
  const PREFIX_LEN = 120;       // chars compared for "already in an editor"

  // ---- enabled flag (opt-out) ------------------------------------------------
  let enabled = true;
  chrome.storage.local.get("noteDraftsEnabled", (d) => {
    enabled = d.noteDraftsEnabled !== false;
    if (!enabled) teardown(); else scheduleEval();
  });

  // ---- in-memory draft cache (storage read once, then only on change) --------
  let cache = {};
  let cacheReady = false;
  chrome.storage.local.get(STORE_KEY, (d) => {
    cache = (d && d[STORE_KEY]) || {};
    cacheReady = true;
    scheduleEval();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.noteDraftsEnabled) {
      enabled = c.noteDraftsEnabled.newValue !== false;
      if (!enabled) teardown(); else scheduleEval();
    }
    if (c[STORE_KEY]) {
      cache = c[STORE_KEY].newValue || {};
      cacheReady = true;
      if (enabled) scheduleEval();
    }
  });

  function persist() {
    try { chrome.storage.local.set({ [STORE_KEY]: cache }); } catch (e) { /* ignore */ }
  }

  // ---- base-URL key ----------------------------------------------------------
  // "#/projects/<p>/workOrder/<w>/notes/<noteId>" -> "projects/<p>/workOrder/<w>/notes"
  function baseKey(hash) {
    const h = hash || location.hash || "";
    const m = h.match(/#\/?(.*?\/notes)(?:\/|$)/);
    return m ? m[1] : null;
  }
  function onNotesView() {
    return (location.hash || "").indexOf("/notes") !== -1 && !!baseKey();
  }
  function draftsFor(key) { const a = cache[key]; return Array.isArray(a) ? a : []; }
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // ---- snapshotting ----------------------------------------------------------
  function pageTitle() { return (document.title || "").trim() || "Notes"; }

  function saveDraft(editor) {
    if (!enabled || !editor || !cacheReady) return;
    const key = baseKey();
    if (!key) return;
    const text = (editor.innerText || "").replace(/ /g, " ").trimEnd();
    if (!norm(text)) return;
    const arr = draftsFor(key).slice();
    if (arr[0] && norm(arr[0].text) === norm(text)) return; // identical to latest

    arr.unshift({ ts: Date.now(), text, html: String(editor.innerHTML || "").slice(0, MAX_HTML), url: location.href, title: pageTitle() });
    cache[key] = arr.slice(0, MAX_DRAFTS);
    prunePages();
    persist();
    scheduleEval();
  }

  // Keep only the most-recently-touched MAX_PAGES notes pages.
  function prunePages() {
    const keys = Object.keys(cache);
    if (keys.length <= MAX_PAGES) return;
    keys.sort((a, b) => ((cache[b][0] && cache[b][0].ts) || 0) - ((cache[a][0] && cache[a][0].ts) || 0));
    for (const k of keys.slice(MAX_PAGES)) delete cache[k];
  }

  // Debounced per-editor save on Enter (let the newline register first).
  const pending = new WeakMap();
  function scheduleSave(editor) {
    if (pending.get(editor)) clearTimeout(pending.get(editor));
    pending.set(editor, setTimeout(() => { pending.delete(editor); saveDraft(editor); }, 120));
  }

  function editorsOnPage() {
    return [...document.querySelectorAll(EDITOR_SEL)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  // Don't nag while the latest draft is still live in an open editor (active
  // composition): true if an open editor shares a long prefix with the draft.
  function draftIsLive(draft) {
    const d = norm(draft && draft.text);
    if (!d) return true;
    const dHead = d.slice(0, PREFIX_LEN);
    for (const ed of editorsOnPage()) {
      const e = norm(ed.innerText || "");
      if (!e) continue;
      if (e.startsWith(dHead) || d.startsWith(e.slice(0, PREFIX_LEN))) return true;
    }
    return false;
  }

  // ---- submit-clear heuristic ------------------------------------------------
  // A submitted note's editor clears. We can't read Innergy's command result, so
  // on a SUBMIT click we remember open editors' text and, shortly after, drop
  // any draft whose text matches an editor that's now gone (it posted). A
  // validation failure leaves the text in place, so nothing is dropped then.
  function onDocClick(e) {
    if (!enabled) return;
    const btn = e.target && e.target.closest && e.target.closest("button, a, [role='button']");
    if (!btn || (btn.textContent || "").trim().toLowerCase() !== "submit") return;
    const key = baseKey();
    if (!key) return;
    const before = editorsOnPage().map((ed) => norm(ed.innerText || "")).filter(Boolean);
    if (!before.length) return;
    setTimeout(() => {
      const after = editorsOnPage().map((ed) => norm(ed.innerText || ""));
      const submitted = before.filter((b) => !after.some((a) => a && (a.startsWith(b.slice(0, PREFIX_LEN)) || b.startsWith(a.slice(0, PREFIX_LEN)))));
      if (!submitted.length) return;
      const arr = draftsFor(key);
      const kept = arr.filter((d) => !submitted.some((s) => norm(d.text).startsWith(s.slice(0, PREFIX_LEN)) || s.startsWith(norm(d.text).slice(0, PREFIX_LEN))));
      if (kept.length === arr.length) return;
      if (kept.length) cache[key] = kept; else delete cache[key];
      persist();
      stickyCollapsed = false;
      scheduleEval();
    }, 1500);
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("ic-draft-style")) return;
    const st = document.createElement("style");
    st.id = "ic-draft-style";
    st.textContent = `
      #ic-draft-fab{position:fixed;right:22px;bottom:22px;z-index:2147483600;display:flex;
        align-items:center;height:44px;background:#1a56db;color:#fff;border:2px solid #1a56db;
        border-radius:24px;cursor:pointer;overflow:hidden;user-select:none;
        box-shadow:0 6px 20px rgba(26,86,219,.45);
        font:13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;
        transition:box-shadow .18s ease;animation:icFabIn .25s ease-out}
      @keyframes icFabIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      #ic-draft-fab:hover{box-shadow:0 8px 26px rgba(26,86,219,.6)}
      #ic-draft-fab .ic-fab-ico{flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center}
      #ic-draft-fab .ic-fab-ico svg{width:20px;height:20px;display:block}
      #ic-draft-fab .ic-fab-badge{position:absolute;top:2px;right:2px;min-width:16px;height:16px;
        padding:0 3px;border-radius:9px;background:#fff;color:#1a56db;font-size:10px;font-weight:800;
        display:flex;align-items:center;justify-content:center;box-sizing:border-box;transition:opacity .15s}
      #ic-draft-fab.ic-open .ic-fab-badge{opacity:0}
      #ic-draft-fab .ic-fab-label{max-width:0;opacity:0;white-space:nowrap;overflow:hidden;
        transition:max-width .22s ease,opacity .18s ease,padding .22s ease;padding:0}
      #ic-draft-fab.ic-open .ic-fab-label{max-width:340px;opacity:1;padding:0 4px 0 2px}
      #ic-draft-fab .ic-fab-title{font-weight:700}
      #ic-draft-fab .ic-fab-sub{font-size:11px;opacity:.85}
      #ic-draft-fab .ic-fab-x{flex:none;width:0;opacity:0;height:26px;margin-right:0;border-radius:50%;
        display:flex;align-items:center;justify-content:center;font-size:15px;overflow:hidden;
        background:rgba(255,255,255,.2);transition:width .2s ease,opacity .18s ease,margin .2s ease}
      #ic-draft-fab.ic-open .ic-fab-x{width:26px;opacity:1;margin-right:8px}
      #ic-draft-fab .ic-fab-x:hover{background:rgba(255,255,255,.38)}

      #ic-draft-overlay{position:fixed;inset:0;z-index:2147483601;background:rgba(15,23,42,.5);
        display:flex;align-items:center;justify-content:center;
        font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;animation:icDraftFade .18s ease-out}
      @keyframes icDraftFade{from{opacity:0}to{opacity:1}}
      #ic-draft-card{width:75vw;max-width:980px;max-height:82vh;background:#fff;color:#1f2937;
        border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden}
      #ic-draft-card .ic-dc-head{display:flex;align-items:center;gap:10px;padding:15px 20px;border-bottom:1px solid #e5e7eb}
      #ic-draft-card .ic-dc-head h2{margin:0;font-size:16px;font-weight:700;flex:1}
      #ic-draft-card .ic-dc-close{cursor:pointer;border:none;background:#f3f4f6;width:30px;height:30px;border-radius:8px;font-size:17px;color:#374151}
      #ic-draft-card .ic-dc-close:hover{background:#e5e7eb}
      #ic-draft-card .ic-dc-body{padding:14px 20px 20px;overflow:auto}
      .ic-dc-section{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin:4px 0 8px}
      .ic-dc-draft{border:1px solid #e5e7eb;border-radius:10px;margin-bottom:12px;overflow:hidden}
      .ic-dc-draft.ic-latest{border-color:#bcd0f7;box-shadow:0 2px 10px rgba(26,86,219,.12)}
      .ic-dc-draft .ic-dc-bar{display:flex;align-items:center;gap:10px;padding:9px 13px;background:#f8fafc;border-bottom:1px solid #eef2f7}
      .ic-dc-draft.ic-collapsed .ic-dc-bar{border-bottom:none}
      .ic-dc-draft .ic-dc-chev{flex:none;transition:transform .15s ease;color:#94a3b8;font-size:11px}
      .ic-dc-draft.ic-collapsed .ic-dc-chev{transform:rotate(-90deg)}
      .ic-dc-draft .ic-dc-when{flex:1;font-size:12px;color:#475569;font-weight:600}
      .ic-dc-draft .ic-dc-tag{flex:none;font-size:10px;font-weight:800;color:#1a56db;background:#e8f0fe;border-radius:6px;padding:2px 7px;text-transform:uppercase;letter-spacing:.03em}
      .ic-dc-draft .ic-dc-btn{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:4px 11px;font-size:12px;font-weight:600;color:#334155}
      .ic-dc-draft .ic-dc-btn:hover{background:#f1f5f9}
      .ic-dc-draft .ic-dc-btn.ic-del{color:#b91c1c;border-color:#fecaca}
      .ic-dc-draft .ic-dc-btn.ic-del:hover{background:#fef2f2}
      .ic-dc-draft .ic-dc-prev{padding:12px 14px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;color:#1f2937;background:#fff}
      .ic-dc-draft.ic-collapsed .ic-dc-prev{display:none}
      #ic-draft-card .ic-dc-empty{color:#64748b;text-align:center;padding:28px}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function relTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " min ago" : " mins ago");
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  const DRAFT_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M6 3h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>' +
    '<path d="M13 3v5h5" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>' +
    '<path d="M8 13h8M8 16.5h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>';

  // ---- the floating icon/banner (built once) ---------------------------------
  let stickyCollapsed = false;  // user clicked × while hovered — stay an icon until mouse leaves
  const dismissed = new Set();  // signatures dismissed (not used to hide, only reset on new draft)

  function fabEl() { return document.getElementById("ic-draft-fab"); }
  function removeFab() { const f = fabEl(); if (f) f.remove(); }

  function ensureFab() {
    let f = fabEl();
    if (f) return f;
    ensureStyle();
    f = document.createElement("div");
    f.id = "ic-draft-fab";
    f.title = "Saved note drafts";
    f.innerHTML =
      '<div class="ic-fab-ico">' + DRAFT_SVG + '<span class="ic-fab-badge"></span></div>' +
      '<div class="ic-fab-label"><div class="ic-fab-title"></div><div class="ic-fab-sub"></div></div>' +
      '<div class="ic-fab-x" title="Collapse">×</div>';
    f.addEventListener("mouseenter", () => { if (!stickyCollapsed) f.classList.add("ic-open"); });
    f.addEventListener("mouseleave", () => { f.classList.remove("ic-open"); stickyCollapsed = false; });
    const x = f.querySelector(".ic-fab-x");
    x.addEventListener("click", (e) => { e.stopPropagation(); f.classList.remove("ic-open"); stickyCollapsed = true; });
    f.addEventListener("click", (e) => { if (e.target === x || x.contains(e.target)) return; openPopup(); });
    document.body.appendChild(f);
    return f;
  }

  // ---- evaluate (debounced): decide whether the icon shows, update its text --
  let evalTimer = null;
  function scheduleEval() {
    if (evalTimer) return;
    evalTimer = setTimeout(() => { evalTimer = null; try { evaluate(); } catch (e) { IC.warn("note-drafts eval", e); } }, EVAL_DEBOUNCE_MS);
  }

  function evaluate() {
    if (!enabled || !cacheReady || !onNotesView()) { removeFab(); return; }
    const arr = draftsFor(baseKey());
    if (!arr.length || draftIsLive(arr[0])) { removeFab(); return; }
    const f = ensureFab();
    const n = arr.length;
    const badge = f.querySelector(".ic-fab-badge");
    const title = f.querySelector(".ic-fab-title");
    const sub = f.querySelector(".ic-fab-sub");
    badge.textContent = String(n);
    title.textContent = n === 1 ? "1 saved draft on this page" : n + " saved drafts on this page";
    sub.textContent = "Last saved " + relTime(arr[0].ts) + " · click to view";
  }

  // ---- popup -----------------------------------------------------------------
  function closePopup() { const o = document.getElementById("ic-draft-overlay"); if (o) o.remove(); }

  function openPopup() {
    ensureStyle();
    closePopup();
    const key = baseKey();
    const overlay = document.createElement("div");
    overlay.id = "ic-draft-overlay";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePopup(); });
    const card = document.createElement("div");
    card.id = "ic-draft-card";
    const head = document.createElement("div"); head.className = "ic-dc-head";
    const h2 = document.createElement("h2"); h2.textContent = "Saved drafts for this note page";
    const close = document.createElement("button"); close.className = "ic-dc-close"; close.textContent = "×";
    close.addEventListener("click", closePopup);
    head.appendChild(h2); head.appendChild(close);
    const body = document.createElement("div"); body.className = "ic-dc-body";
    card.appendChild(head); card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function render() {
      const arr = draftsFor(key);
      body.innerHTML = "";
      if (!arr.length) {
        const e = document.createElement("div"); e.className = "ic-dc-empty";
        e.textContent = "No saved drafts for this page.";
        body.appendChild(e);
        evaluate();
        return;
      }
      const del = (i) => () => {
        const a = draftsFor(key).slice();
        a.splice(i, 1);
        if (a.length) cache[key] = a; else delete cache[key];
        persist(); render(); scheduleEval();
      };
      // Latest draft — prominent, always expanded.
      const latest = document.createElement("div"); latest.className = "ic-dc-section"; latest.textContent = "Latest draft";
      body.appendChild(latest);
      body.appendChild(draftRow(arr[0], 0, { expanded: true, latest: true, onDelete: del(0) }));
      // Older drafts — collapsible, collapsed by default.
      if (arr.length > 1) {
        const older = document.createElement("div"); older.className = "ic-dc-section";
        older.textContent = "Earlier drafts (" + (arr.length - 1) + ")";
        body.appendChild(older);
        for (let i = 1; i < arr.length; i++) body.appendChild(draftRow(arr[i], i, { expanded: false, onDelete: del(i) }));
      }
    }
    render();
  }

  function draftRow(draft, i, opts) {
    const row = document.createElement("div");
    row.className = "ic-dc-draft" + (opts.latest ? " ic-latest" : "") + (opts.expanded ? "" : " ic-collapsed");
    const bar = document.createElement("div"); bar.className = "ic-dc-bar";
    if (!opts.latest) { const chev = document.createElement("span"); chev.className = "ic-dc-chev"; chev.textContent = "▼"; bar.appendChild(chev); }
    const when = document.createElement("div"); when.className = "ic-dc-when"; when.textContent = "Saved " + relTime(draft.ts);
    bar.appendChild(when);
    if (opts.latest) { const tag = document.createElement("span"); tag.className = "ic-dc-tag"; tag.textContent = "Latest"; bar.appendChild(tag); }
    const copy = document.createElement("button"); copy.className = "ic-dc-btn"; copy.textContent = "Copy";
    copy.addEventListener("click", (e) => { e.stopPropagation(); doCopy(draft, copy); });
    const del = document.createElement("button"); del.className = "ic-dc-btn ic-del"; del.textContent = "Delete";
    del.addEventListener("click", (e) => { e.stopPropagation(); opts.onDelete(); });
    bar.appendChild(copy); bar.appendChild(del);
    const prev = document.createElement("div"); prev.className = "ic-dc-prev"; prev.textContent = draft.text || "";
    row.appendChild(bar); row.appendChild(prev);
    // Collapsible older rows: clicking the bar (not a button) toggles.
    if (!opts.latest) bar.addEventListener("click", (e) => { if (e.target.closest(".ic-dc-btn")) return; row.classList.toggle("ic-collapsed"); });
    return row;
  }

  function doCopy(draft, btn) {
    const done = () => { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => (btn.textContent = o), 1400); };
    try {
      if (draft.html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([draft.html], { type: "text/html" }),
          "text/plain": new Blob([draft.text || ""], { type: "text/plain" }),
        });
        navigator.clipboard.write([item]).then(done, () => fallbackCopy(draft.text, done));
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(draft.text, done);
  }
  function fallbackCopy(text, done) {
    try { navigator.clipboard.writeText(text || "").then(done, () => {}); }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = text || "";
      ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta);
      ta.select(); try { document.execCommand("copy"); done(); } catch (_) {}
      ta.remove();
    }
  }

  // ---- teardown --------------------------------------------------------------
  function teardown() { removeFab(); closePopup(); }

  // ---- one-time global wiring ------------------------------------------------
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    document.addEventListener("keydown", (e) => {
      if (!enabled || e.key !== "Enter") return;
      const ed = e.target && e.target.closest && e.target.closest(EDITOR_SEL);
      if (ed) scheduleSave(ed);
    }, true);
    document.addEventListener("click", onDocClick, true);
    setInterval(() => {
      if (!enabled || !onNotesView()) return;
      for (const ed of editorsOnPage()) if (norm(ed.innerText || "")) saveDraft(ed);
    }, SAVE_INTERVAL_MS);
    window.addEventListener("hashchange", () => { stickyCollapsed = false; closePopup(); scheduleEval(); });
  }

  // mount() runs on every DOM mutation — keep it to init-once + a debounced eval.
  IC.registerFeature({ id: "note-drafts", mount: () => { init(); scheduleEval(); } });
})();
