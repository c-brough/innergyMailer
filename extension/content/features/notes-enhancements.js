/* InnerCider — Notes Enhancements (opt-out, on by default)
 *
 * On an Innergy Notes view (#/…/notes[/<noteId>]):
 *   • If the URL points at a specific note (trailing GUID), scroll that note into
 *     view, centered, and give its own card (not the whole reply thread) a 2px
 *     orange border with a pulsing orange shadow that stops on hover. (A note's
 *     <figure> wraps its reply <figure>s, so the border goes on the note's own
 *     <blockquote> child.) The note id isn't in the DOM
 *     and the app doesn't mark the deep-linked note, so we fetch the note list
 *     (ProjectWorkOrderNotesQuery / ProjectNotesQuery), read the target's body,
 *     and match it to its rendered <figure>. Notes are lazy-rendered, so if it
 *     isn't on screen yet we scroll the list a bounded number of times to load
 *     it.
 *   • Highlight every mention of the CURRENT user's full name (from
 *     AppProfileQuery) as bold red text — a text-node walk, so it's independent
 *     of Innergy's (hashed, build-specific) CSS classes.
 *
 * Enabled unless the user opts out in Options (notesEnhancementsEnabled).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const NOTE_RE = new RegExp("#.*/notes/(" + GUID + ")");
  const WO_RE = new RegExp("/workOrder/(" + GUID + ")");
  const PROJ_RE = new RegExp("/projects/(" + GUID + ")");
  const RED = "#c62828";
  const HL_CLASS = "ic-note-mention";
  const TARGET_CLASS = "ic-note-target";

  // Orange border + a 6px pulsing orange shadow that stops once the mouse is
  // inside the note. Injected once.
  function ensureStyle() {
    if (document.getElementById("ic-note-style")) return;
    const st = document.createElement("style");
    st.id = "ic-note-style";
    st.textContent =
      "@keyframes icNotePulse{0%{box-shadow:0 0 0 0 rgba(245,124,0,.65)}50%{box-shadow:0 0 0 6px rgba(245,124,0,.22)}100%{box-shadow:0 0 0 0 rgba(245,124,0,0)}}" +
      "." + TARGET_CLASS + "{border:2px solid #f57c00 !important;border-radius:6px !important;animation:icNotePulse 1.4s ease-in-out infinite}" +
      "." + TARGET_CLASS + ".ic-note-stop{animation:none !important;box-shadow:none !important}";
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- enabled flag (opt-out) --------------------------------------------------
  let enabled = true;
  chrome.storage.local.get("notesEnhancementsEnabled", (d) => {
    enabled = d.notesEnhancementsEnabled !== false;
    schedule();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.notesEnhancementsEnabled) {
      enabled = c.notesEnhancementsEnabled.newValue !== false;
      if (!enabled) teardown();
      schedule();
    }
  });

  // ---- current user's full name ------------------------------------------------
  let fullName = "";
  let namePromise = null;
  function ensureName() {
    if (fullName) return Promise.resolve(fullName);
    if (namePromise) return namePromise;
    namePromise = fetch(
      "https://app.innergy.com/query/run?query=" + encodeURIComponent(JSON.stringify({ $type: "AppProfileQuery" })),
      { credentials: "include" }
    )
      .then((r) => r.json())
      .then((j) => {
        const u = j && j.user;
        if (u) fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        return fullName;
      })
      .catch((e) => { IC.warn("notes: name fetch failed", e); return ""; });
    return namePromise;
  }

  // ---- mention highlighting ----------------------------------------------------
  function isWordChar(ch) { return !!ch && /[A-Za-z0-9]/.test(ch); }

  function highlightIn(root, name) {
    if (!name) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf(name) === -1) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains(HL_CLASS)) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) wrapName(node, name);
  }

  function wrapName(textNode, name) {
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0, idx, wrapped = false;
    while ((idx = text.indexOf(name, i)) !== -1) {
      const before = text[idx - 1], after = text[idx + name.length];
      if (isWordChar(before) || isWordChar(after)) {
        // Part of a longer name (e.g. "Chris Broughton") — leave it.
        if (idx + name.length > i) { frag.appendChild(document.createTextNode(text.slice(i, idx + name.length))); i = idx + name.length; continue; }
      }
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const s = document.createElement("span");
      s.className = HL_CLASS;
      s.textContent = name;
      s.style.fontWeight = "700";
      s.style.color = RED;
      frag.appendChild(s);
      i = idx + name.length;
      wrapped = true;
    }
    if (!wrapped) return;
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
  }

  // ---- target note: border + center scroll ------------------------------------
  let scrolledNoteId = null; // scroll only once per target
  let locating = false;
  const notesCache = { key: "", list: null };

  function entityQuery(hash) {
    const wo = hash.match(WO_RE);
    if (wo) return { key: "wo:" + wo[1], query: { WorkOrderId: wo[1], $type: "ProjectWorkOrderNotesQuery" } };
    const pr = hash.match(PROJ_RE);
    if (pr) return { key: "pr:" + pr[1], query: { ProjectId: pr[1], $type: "ProjectNotesQuery" } };
    return null;
  }

  async function fetchNotes(eq) {
    if (notesCache.key === eq.key && notesCache.list) return notesCache.list;
    try {
      const r = await fetch("https://app.innergy.com/query/run?query=" + encodeURIComponent(JSON.stringify(eq.query)), { credentials: "include" });
      if (!r.ok) return null;
      const j = await r.json();
      const list = Array.isArray(j) ? j : null;
      if (list) { notesCache.key = eq.key; notesCache.list = list; }
      return list;
    } catch (e) { return null; }
  }

  // The most distinctive chunk of a note's body, for matching it in the DOM.
  function probeFromBody(body) {
    const text = String(body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const words = text.split(" ").filter((w) => w.length >= 7);
    if (words.length) return words.sort((a, b) => b.length - a.length)[0];
    return text.slice(0, 24);
  }

  function findFigureByText(probe) {
    if (!probe) return null;
    const matches = [...document.querySelectorAll("figure")].filter((f) => (f.textContent || "").includes(probe));
    if (!matches.length) return null;
    // Innermost match: a reply is a <figure> nested in its parent note's
    // <figure>, and both contain the probe — pick the one with no descendant
    // figure that also matches, so the border lands on the exact note.
    for (const f of matches) {
      const hasInner = [...f.querySelectorAll("figure")].some((d) => matches.includes(d));
      if (!hasInner) return f;
    }
    return matches[0];
  }

  function getScroller() {
    const fig = document.querySelector("figure");
    if (!fig) return null;
    let p = fig.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 20) return p;
      p = p.parentElement;
    }
    return null;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Notes are lazy-rendered; scroll the list (bounded) until the target appears.
  async function scrollSearch(probe) {
    const scroller = getScroller();
    if (!scroller) return null;
    for (let i = 0; i < 14; i++) {
      scroller.scrollTop += Math.round(scroller.clientHeight * 0.9);
      await sleep(260);
      const fig = findFigureByText(probe);
      if (fig) return fig;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5) break;
    }
    return findFigureByText(probe);
  }

  // A note's own card is the figure's direct child without nested reply figures
  // (the <blockquote>); the sibling holds the reply thread. Border just the card.
  function cardOf(fig) {
    return [...fig.children].find((c) => !c.querySelector("figure")) || fig;
  }
  function clearBorder() {
    for (const el of document.querySelectorAll("." + TARGET_CLASS)) el.classList.remove(TARGET_CLASS, "ic-note-stop");
  }
  function markBorder(fig) {
    ensureStyle();
    const card = cardOf(fig);
    if (!card || card.classList.contains(TARGET_CLASS)) return card;
    clearBorder();
    card.classList.add(TARGET_CLASS);
    card.addEventListener("mouseenter", () => card.classList.add("ic-note-stop"), { once: true });
    return card;
  }

  async function handleTarget() {
    const hash = location.hash || "";
    const m = hash.match(NOTE_RE);
    if (!m) { clearBorder(); scrolledNoteId = null; return; }
    if (locating) return;
    const noteId = m[1];
    const eq = entityQuery(hash);
    if (!eq) return;
    locating = true;
    try {
      const list = await fetchNotes(eq);
      const note = list && list.find((n) => n.id === noteId);
      if (!note) return;
      const probe = probeFromBody(note.body);
      let fig = findFigureByText(probe);
      if (!fig) fig = await scrollSearch(probe);
      if (fig) {
        const card = markBorder(fig);
        if (scrolledNoteId !== noteId) {
          scrolledNoteId = noteId;
          (card || fig).scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    } finally {
      locating = false;
    }
  }

  // ---- teardown (on opt-out) ---------------------------------------------------
  function teardown() {
    clearBorder();
    for (const s of document.querySelectorAll("span." + HL_CLASS)) {
      const t = document.createTextNode(s.textContent);
      if (s.parentNode) { s.parentNode.replaceChild(t, s); t.parentNode && t.parentNode.normalize(); }
    }
  }

  // ---- pass orchestration ------------------------------------------------------
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; pass().catch((e) => IC.warn("notes pass", e)); }, 200);
  }

  async function pass() {
    if (!enabled) return;
    if ((location.hash || "").indexOf("/notes") === -1) return; // only on notes views
    const figs = document.querySelectorAll("figure");
    if (!figs.length) return; // notes not rendered yet
    const name = await ensureName();
    if (name) for (const f of figs) highlightIn(f, name);
    await handleTarget();
  }

  IC.registerFeature({ id: "notes-enhancements", mount: schedule });
  window.addEventListener("hashchange", () => { scrolledNoteId = null; schedule(); });
})();
