/* InnerCider — Note draft autosave (opt-out, on by default)
 *
 * While composing a note (a new "CREATE NOTE" post or a "Reply") on an Innergy
 * Notes view, this quietly snapshots the rich-text editor's contents so you can
 * recover them if the field is lost (accidental navigation, a reload, a failed
 * submit, etc.). It never touches what you're typing.
 *
 * The compose field is a Lexical editor — `div[data-lexical-editor="true"]`
 * (= `.ContentEditable__root`); several can be open at once. We read plain text
 * with `.innerText` and rich HTML with `.innerHTML`. (The top "Master Note" box
 * is a plain <textarea>, not a rich-text field, so it's out of scope.)
 *
 * Saving:
 *   • on every carriage return (Enter) in an editor, and
 *   • at least every 5 minutes for any non-empty editor,
 *   deduped against the last snapshot. We keep the **last 3** drafts per base
 *   notes URL (`#/…/notes`, with any trailing /<noteId> stripped) — not per note
 *   id — in chrome.storage.local under `noteDrafts`.
 *
 * Recovery UI:
 *   • a dismissible blue banner hovers at the bottom of a notes page when a
 *     saved draft exists that isn't already in an open editor;
 *   • clicking the banner (anywhere but ×) opens a ~75%-width floating card
 *     listing this page's drafts, each with its contents and Copy / Delete.
 *
 * Options also lists every saved draft across all pages (copy / delete there
 * too). Enabled unless you opt out in Options (noteDraftsEnabled).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const STORE_KEY = "noteDrafts";
  const MAX_DRAFTS = 3;
  const MAX_HTML = 100000; // cap per-draft HTML so storage can't balloon
  const SAVE_INTERVAL_MS = 5 * 60 * 1000;
  const EDITOR_SEL = '[data-lexical-editor="true"], .ContentEditable__root';
  const PREFIX_LEN = 120; // chars compared when deciding "already in an editor"

  // ---- enabled flag (opt-out) ------------------------------------------------
  let enabled = true;
  chrome.storage.local.get("noteDraftsEnabled", (d) => {
    enabled = d.noteDraftsEnabled !== false;
    if (!enabled) teardown();
    else evaluate();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.noteDraftsEnabled) {
      enabled = c.noteDraftsEnabled.newValue !== false;
      if (!enabled) teardown();
      else evaluate();
    }
    // Another tab/Options changed the drafts — re-evaluate the banner.
    if (c[STORE_KEY] && enabled) evaluate();
  });

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

  // ---- storage helpers -------------------------------------------------------
  function loadStore() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get(STORE_KEY, (d) => res((d && d[STORE_KEY]) || {}));
      } catch (e) { res({}); }
    });
  }
  function saveStore(store) {
    return new Promise((res) => {
      try { chrome.storage.local.set({ [STORE_KEY]: store }, () => res()); }
      catch (e) { res(); }
    });
  }

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // ---- snapshotting ----------------------------------------------------------
  async function saveDraft(editor) {
    if (!enabled || !editor) return;
    const key = baseKey();
    if (!key) return;
    const text = (editor.innerText || "").replace(/ /g, " ").trimEnd();
    if (!norm(text)) return; // nothing to save
    const html = String(editor.innerHTML || "").slice(0, MAX_HTML);

    const store = await loadStore();
    const arr = Array.isArray(store[key]) ? store[key] : [];
    if (arr[0] && norm(arr[0].text) === norm(text)) return; // identical to latest

    arr.unshift({ ts: Date.now(), text, html, url: location.href, title: pageTitle() });
    store[key] = arr.slice(0, MAX_DRAFTS);
    await saveStore(store);
    evaluate();
  }

  function pageTitle() {
    const t = (document.title || "").trim();
    return t || "Notes";
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

  // ---- "already in an open editor?" (don't nag during active composition) ----
  function draftIsLive(draft) {
    const d = norm(draft.text);
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
  // When a note is Submitted its editor clears. We can't see Innergy's command
  // result from here, so: on a SUBMIT click, remember the open editors' text;
  // shortly after, drop any draft whose text matches an editor that's now gone
  // (i.e. it posted). Validation failures leave the text in place, so nothing
  // is dropped then.
  function onDocClick(e) {
    if (!enabled) return;
    const btn = e.target && e.target.closest && e.target.closest("button, a, [role='button']");
    if (!btn) return;
    if ((btn.textContent || "").trim().toLowerCase() !== "submit") return;
    const key = baseKey();
    if (!key) return;
    const before = editorsOnPage().map((ed) => norm(ed.innerText || "")).filter(Boolean);
    if (!before.length) return;
    setTimeout(async () => {
      const after = editorsOnPage().map((ed) => norm(ed.innerText || ""));
      const submitted = before.filter((b) => !after.some((a) => a && (a.startsWith(b.slice(0, PREFIX_LEN)) || b.startsWith(a.slice(0, PREFIX_LEN)))));
      if (!submitted.length) return;
      const store = await loadStore();
      const arr = Array.isArray(store[key]) ? store[key] : [];
      const kept = arr.filter((d) => !submitted.some((s) => norm(d.text).startsWith(s.slice(0, PREFIX_LEN)) || s.startsWith(norm(d.text).slice(0, PREFIX_LEN))));
      if (kept.length === arr.length) return;
      if (kept.length) store[key] = kept; else delete store[key];
      await saveStore(store);
      dismissed.clear();
      evaluate();
    }, 1500);
  }

  // ---- banner ----------------------------------------------------------------
  const dismissed = new Set(); // signatures dismissed this page view
  function sigOf(arr) { return (baseKey() || "") + "|" + (arr && arr[0] ? arr[0].ts : 0); }

  function ensureStyle() {
    if (document.getElementById("ic-draft-style")) return;
    const st = document.createElement("style");
    st.id = "ic-draft-style";
    st.textContent = `
      #ic-draft-banner{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
        z-index:2147483600;display:flex;align-items:center;gap:12px;max-width:560px;
        background:#1a56db;color:#fff;padding:11px 14px;border-radius:10px;cursor:pointer;
        box-shadow:0 8px 28px rgba(26,86,219,.45);font:13px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;
        animation:icDraftIn .25s ease-out}
      @keyframes icDraftIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
      #ic-draft-banner .ic-db-ico{font-size:17px;line-height:1}
      #ic-draft-banner .ic-db-txt{flex:1}
      #ic-draft-banner .ic-db-txt b{font-weight:700}
      #ic-draft-banner .ic-db-sub{opacity:.85;font-size:11.5px}
      #ic-draft-banner .ic-db-x{flex:none;width:22px;height:22px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;font-size:15px;
        background:rgba(255,255,255,.18)}
      #ic-draft-banner .ic-db-x:hover{background:rgba(255,255,255,.34)}
      #ic-draft-overlay{position:fixed;inset:0;z-index:2147483601;background:rgba(15,23,42,.5);
        display:flex;align-items:center;justify-content:center;
        font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;animation:icDraftFade .18s ease-out}
      @keyframes icDraftFade{from{opacity:0}to{opacity:1}}
      #ic-draft-card{width:75vw;max-width:980px;max-height:82vh;background:#fff;color:#1f2937;
        border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden}
      #ic-draft-card .ic-dc-head{display:flex;align-items:center;gap:10px;padding:15px 20px;
        border-bottom:1px solid #e5e7eb}
      #ic-draft-card .ic-dc-head h2{margin:0;font-size:16px;font-weight:700;flex:1}
      #ic-draft-card .ic-dc-close{cursor:pointer;border:none;background:#f3f4f6;width:30px;height:30px;
        border-radius:8px;font-size:17px;color:#374151}
      #ic-draft-card .ic-dc-close:hover{background:#e5e7eb}
      #ic-draft-card .ic-dc-body{padding:14px 20px 20px;overflow:auto}
      .ic-dc-draft{border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px;overflow:hidden}
      .ic-dc-draft .ic-dc-bar{display:flex;align-items:center;gap:10px;padding:9px 13px;background:#f8fafc;border-bottom:1px solid #eef2f7}
      .ic-dc-draft .ic-dc-when{flex:1;font-size:12px;color:#475569;font-weight:600}
      .ic-dc-draft .ic-dc-btn{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;
        padding:4px 11px;font-size:12px;font-weight:600;color:#334155}
      .ic-dc-draft .ic-dc-btn:hover{background:#f1f5f9}
      .ic-dc-draft .ic-dc-btn.ic-del{color:#b91c1c;border-color:#fecaca}
      .ic-dc-draft .ic-dc-btn.ic-del:hover{background:#fef2f2}
      .ic-dc-draft .ic-dc-prev{padding:12px 14px;max-height:230px;overflow:auto;white-space:pre-wrap;
        word-break:break-word;font-size:13px;color:#1f2937;background:#fff}
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
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function removeBanner() {
    const b = document.getElementById("ic-draft-banner");
    if (b) b.remove();
  }

  async function evaluate() {
    if (!enabled || !onNotesView()) { removeBanner(); return; }
    const key = baseKey();
    const store = await loadStore();
    const arr = Array.isArray(store[key]) ? store[key] : [];
    if (!arr.length) { removeBanner(); return; }
    const sig = sigOf(arr);
    // Hide while the latest draft is already live in an open editor, or dismissed.
    if (dismissed.has(sig) || draftIsLive(arr[0])) { removeBanner(); return; }
    showBanner(arr, sig);
  }

  function showBanner(arr, sig) {
    ensureStyle();
    let b = document.getElementById("ic-draft-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "ic-draft-banner";
      document.body.appendChild(b);
    }
    const n = arr.length;
    b.innerHTML = "";
    const ico = document.createElement("span"); ico.className = "ic-db-ico"; ico.textContent = "💾";
    const txt = document.createElement("div"); txt.className = "ic-db-txt";
    const strong = document.createElement("b");
    strong.textContent = n === 1 ? "A saved note draft is available" : n + " saved note drafts are available";
    const sub = document.createElement("div"); sub.className = "ic-db-sub";
    sub.textContent = "Last saved " + relTime(arr[0].ts) + " · click to view, copy or delete";
    txt.appendChild(strong); txt.appendChild(sub);
    const x = document.createElement("div"); x.className = "ic-db-x"; x.textContent = "×"; x.title = "Dismiss";
    b.appendChild(ico); b.appendChild(txt); b.appendChild(x);
    b.onclick = (e) => {
      if (e.target === x || x.contains(e.target)) { dismissed.add(sig); removeBanner(); return; }
      openPopup();
    };
  }

  // ---- popup -----------------------------------------------------------------
  function closePopup() {
    const o = document.getElementById("ic-draft-overlay");
    if (o) o.remove();
  }

  async function openPopup() {
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

    async function render() {
      const store = await loadStore();
      const arr = Array.isArray(store[key]) ? store[key] : [];
      body.innerHTML = "";
      if (!arr.length) {
        const e = document.createElement("div"); e.className = "ic-dc-empty";
        e.textContent = "No saved drafts for this page.";
        body.appendChild(e);
        removeBanner();
        return;
      }
      arr.forEach((draft, i) => body.appendChild(draftRow(draft, i, async () => {
        const s = await loadStore();
        const a = Array.isArray(s[key]) ? s[key] : [];
        a.splice(i, 1);
        if (a.length) s[key] = a; else delete s[key];
        await saveStore(s);
        render();
        evaluate();
      })));
    }
    await render();
  }

  function draftRow(draft, i, onDelete) {
    const row = document.createElement("div"); row.className = "ic-dc-draft";
    const bar = document.createElement("div"); bar.className = "ic-dc-bar";
    const when = document.createElement("div"); when.className = "ic-dc-when";
    when.textContent = "Saved " + relTime(draft.ts);
    const copy = document.createElement("button"); copy.className = "ic-dc-btn"; copy.textContent = "Copy";
    copy.addEventListener("click", () => doCopy(draft, copy));
    const del = document.createElement("button"); del.className = "ic-dc-btn ic-del"; del.textContent = "Delete";
    del.addEventListener("click", onDelete);
    bar.appendChild(when); bar.appendChild(copy); bar.appendChild(del);
    const prev = document.createElement("div"); prev.className = "ic-dc-prev";
    prev.textContent = draft.text || ""; // plain-text view (safe; no HTML injected)
    row.appendChild(bar); row.appendChild(prev);
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
  function teardown() { removeBanner(); closePopup(); }

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
    window.addEventListener("hashchange", () => { dismissed.clear(); closePopup(); evaluate(); });
  }

  IC.registerFeature({ id: "note-drafts", mount: () => { init(); evaluate(); } });
})();
