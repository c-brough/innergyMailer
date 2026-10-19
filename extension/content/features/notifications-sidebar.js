/* InnerCider — Notifications sidebar (opt-in)
 *
 * A right-docked panel that mirrors the user's Innergy notifications
 * (#/account/notifications/list) without leaving the page. Fetches same-origin
 * so the session cookie always works.
 *
 *   • Status filter (unread / read / all) + quick search + type filters
 *     (Notes / Tasks / Reports / Other). Defaults come from Options and seed a
 *     freshly-opened panel; you can change them live per session.
 *   • Click a notification → go to the linked note/task/report; a separate chip
 *     links the project/work-order "context".
 *   • For note-reply/mention notifications, a "Preview" shows the note's text
 *     inline (fetched from the notes query).
 *   • Mark one read / mark all read — real writes to Innergy
 *     (NotificationItemToggleReadCommand / NotificationItemsMarkAsReadCommand).
 *
 * Internal API: see memory innergy-notifications-api.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const ORIGIN = "https://app.innergy.com";
  const PAGE = 30;
  const TYPES = ["mentioned", "replies", "assigned", "reports", "other"];
  const TYPE_LABEL = { mentioned: "Mentioned", replies: "Replies", assigned: "Assigned", reports: "Reports", other: "Other" };
  // Innergy task/quest status id → label + pill color.
  const STATUS_COLOR = { 1: "#8a93a0", 2: "#1a56db", 3: "#e08600", 4: "#7b4fd1", 5: "#2e9e5b", 6: "#c62828" };

  // ---- settings (opt-in + default filters) -------------------------------------
  const settings = { enabled: false, defaultStatus: "unread", types: { notes: true, tasks: true, reports: true, other: true } };
  function loadSettings(cb) {
    chrome.storage.local.get(["notifSidebarEnabled", "notifDefaultStatus", "notifTypes"], (d) => {
      settings.enabled = d.notifSidebarEnabled === true;
      settings.defaultStatus = d.notifDefaultStatus || "unread";
      if (d.notifTypes && typeof d.notifTypes === "object") for (const t of TYPES) settings.types[t] = d.notifTypes[t] !== false;
      if (cb) cb();
    });
  }
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.notifSidebarEnabled || c.notifDefaultStatus || c.notifTypes) loadSettings(() => { applyEnabled(); });
  });

  // ---- data layer (same-origin) ------------------------------------------------
  async function runQuery(query, post) {
    const opt = { credentials: "include" };
    let url = ORIGIN + "/query/run";
    if (post) { opt.method = "POST"; opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(query); }
    else url += "?query=" + encodeURIComponent(JSON.stringify(query));
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function runCommand(command) {
    const r = await fetch(ORIGIN + "/command/run", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
    let b = null; try { b = await r.json(); } catch (e) {}
    return { ok: r.ok && b && b.IsSuccess === true, messages: b && Array.isArray(b.Messages) ? b.Messages.map((m) => m.Message).join("; ") : "" };
  }
  function statusFilter(status) {
    if (status === "unread") return [["IsRead", "=", false]];
    if (status === "read") return [["IsRead", "=", true]];
    return null;
  }
  async function fetchPage(status, skip) {
    const loadOptions = { skip, take: PAGE, requireTotalCount: true, sort: [{ selector: "CreatedOn", desc: true }] };
    const f = statusFilter(status); if (f) loadOptions.filter = f;
    const j = await runQuery({ loadOptions, $type: "NotificationGridQuery" }, true);
    return { rows: (j && j.data) || [], total: j && j.totalCount };
  }
  async function unreadCount() {
    try {
      const j = await runQuery({ loadOptions: { take: 0, requireTotalCount: true, filter: [["IsRead", "=", false]] }, $type: "NotificationGridQuery" }, true);
      return j && j.totalCount || 0;
    } catch (e) { return null; }
  }

  function model(row) {
    const b = row.NotificationBody || {}, c = row.Context || {};
    return {
      id: row.Id, isRead: row.IsRead, created: row.CreatedOn,
      body: b.DisplayName || "", bodyUrl: b.Url || "", bodyType: b.ObjectType || "", bodyNewTab: !!b.OpenInNewTab,
      context: c.DisplayName || "", contextUrl: c.Url || "", contextNewTab: !!c.OpenInNewTab,
    };
  }
  function category(it) {
    const t = (it.body || "").toLowerCase();
    if (/mention/.test(t)) return "mentioned";
    if (it.bodyType === "ProjectWorkOrderNote" || it.bodyType === "ProjectNote") return "replies";
    if (/assigned/.test(t)) return "assigned";
    if (/report|generat/.test(t)) return "reports";
    return "other";
  }
  const isNote = (it) => it.bodyType === "ProjectWorkOrderNote" || it.bodyType === "ProjectNote";
  const isTask = (it) => it.bodyType === "Quest" && /assigned|task/i.test(it.body || "");
  function questId(it) { const m = (it.bodyUrl || "").match(/[?&]id=([0-9a-fA-F-]{36})/); return m ? m[1] : null; }

  // ---- project names (number → descriptive name) -------------------------------
  let projByNum = null, projPromise = null;
  function ensureProjects() {
    if (projByNum) return Promise.resolve(projByNum);
    if (projPromise) return projPromise;
    projPromise = runQuery({ $type: "ProjectsPickerQuery" })
      .then((arr) => {
        projByNum = {};
        if (Array.isArray(arr)) for (const p of arr) { const m = (p.name || "").match(/^(P-\d+-\d+)/i); if (m) projByNum[m[1].toUpperCase()] = p.name; }
        return projByNum;
      })
      .catch(() => (projByNum = {}));
    return projPromise;
  }
  function projectNameForContext(contextText) {
    if (!projByNum || !contextText) return "";
    const m = contextText.match(/^(P-\d+-\d+)/i);
    if (!m) return "";
    const full = projByNum[m[1].toUpperCase()];
    return full ? full.replace(/^P-\d+-\d+\s*-\s*/i, "").trim() : "";
  }

  // ---- task due date + status (lazy, cached) -----------------------------------
  const questCache = {}; // qid -> {dueDate, statusId, statusName} | "loading"
  async function fetchQuest(qid) {
    if (questCache[qid] && questCache[qid] !== "loading") return questCache[qid];
    questCache[qid] = "loading";
    try {
      const j = await runQuery({ Id: qid, $type: "QuestEditQuery" });
      const statuses = (j && j.availableStatuses) || [];
      const sn = (statuses.find((s) => s.id === j.status) || {}).name || "";
      const info = { dueDate: j && j.dueDate && j.dueDate.dateTime, statusId: j && j.status, statusName: sn };
      questCache[qid] = info;
      return info;
    } catch (e) { questCache[qid] = null; return null; }
  }

  function fullUrl(u) {
    if (!u) return null;
    if (/^https?:/i.test(u)) return u;
    return u.charAt(0) === "/" ? ORIGIN + u : ORIGIN + "/" + u;
  }
  function go(u, newTab) {
    const full = fullUrl(u); if (!full) return;
    if (newTab) window.open(full, "_blank"); else location.href = full;
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(typeof iso === "object" && iso.dateTime ? iso.dateTime : iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // ---- state -------------------------------------------------------------------
  const state = { status: "unread", types: {}, search: "", items: [], skip: 0, total: 0, loading: false, open: false };

  // ---- UI ----------------------------------------------------------------------
  let el = null; // cached elements
  function ensureStyle() {
    if (document.getElementById("ic-notif-style")) return;
    const s = document.createElement("style");
    s.id = "ic-notif-style";
    s.textContent = `
#ic-notif-toggle{position:fixed;top:10px;right:120px;z-index:2147483600;width:30px;height:30px;border-radius:50%;background:#f57c00;border:none;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:0}
#ic-notif-toggle svg{width:17px;height:17px;display:block;fill:#1a56db}
@keyframes icnBellPulse{0%{box-shadow:0 2px 8px rgba(0,0,0,.28),0 0 0 0 rgba(245,124,0,.7)}50%{box-shadow:0 2px 8px rgba(0,0,0,.28),0 0 0 6px rgba(245,124,0,.3)}100%{box-shadow:0 2px 8px rgba(0,0,0,.28),0 0 0 0 rgba(245,124,0,0)}}
#ic-notif-toggle.has-unread{animation:icnBellPulse 1.5s ease-in-out infinite}
#ic-notif-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#e23b3b;color:#fff;font:700 10px -apple-system,system-ui,sans-serif;display:none;align-items:center;justify-content:center;box-sizing:border-box}
#ic-notif-badge.show{display:flex}
#ic-notif-panel{position:fixed;top:0;right:0;height:100vh;width:380px;max-width:94vw;background:#fff;color:#1a1a1a;z-index:2147483601;box-shadow:-4px 0 24px rgba(0,0,0,.22);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;font:13px -apple-system,system-ui,sans-serif}
#ic-notif-panel.open{transform:translateX(0)}
.icn-head{padding:12px 14px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px;flex:0 0 auto}
.icn-head b{font-size:15px;flex:1}
.icn-ibtn{border:none;background:#f3f3f3;border-radius:6px;cursor:pointer;padding:5px 8px;font-size:12.5px;color:#333}
.icn-ibtn:hover{background:#e8ecf7}
.icn-tools{padding:10px 14px;border-bottom:1px solid #eee;flex:0 0 auto;display:flex;flex-direction:column;gap:8px}
.icn-search{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:7px;font:13px inherit}
.icn-seg{display:inline-flex;border:1px solid #ccd;border-radius:7px;overflow:hidden}
.icn-seg button{border:none;background:#fff;cursor:pointer;padding:5px 12px;font:600 12.5px inherit;color:#555}
.icn-seg button.on{background:#1a56db;color:#fff}
.icn-filter-pop{border:1px solid #ddd;border-radius:8px;padding:8px 10px;background:#fafafa;display:none}
.icn-filter-pop.show{display:block}
.icn-filter-pop label{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.icn-list{flex:1 1 auto;overflow:auto}
.icn-item{padding:10px 14px;border-bottom:1px solid #f0f0f0;cursor:pointer;position:relative}
.icn-item:hover{background:#f7f9ff}
.icn-item.unread{background:#fffdf5}
.icn-item.unread:hover{background:#fdf7ea}
.icn-dot{position:absolute;left:5px;top:14px;width:7px;height:7px;border-radius:50%;background:#f57c00}
.icn-body{font-size:12.8px;line-height:1.4;margin-left:4px}
.icn-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 0 4px;font-size:11.5px;color:#777}
.icn-ctx{margin:6px 0 0 4px}
.icn-chip{display:inline-block;background:#eef2fd;border:1px solid #c7d0f8;border-radius:10px;padding:2px 8px;color:#1a3a8a;cursor:pointer;max-width:100%;line-height:1.35;font-size:12px;white-space:normal;word-break:break-word}
.icn-task{margin:6px 0 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.icn-pill{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px;font-weight:700}
.icn-due{font-size:11.5px;color:#777}
.icn-act{color:#1a56db;cursor:pointer}
.icn-more{padding:10px;text-align:center;color:#1a56db;cursor:pointer;font-size:12.5px}
.icn-empty{padding:24px 14px;text-align:center;color:#999}
.icn-status{padding:8px 14px;font-size:12px;min-height:16px;color:#555;flex:0 0 auto}
#ic-note-pop{position:fixed;inset:0;z-index:2147483602;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center}
#ic-note-pop.show{display:flex}
#ic-note-pop .card{background:#fff;border-radius:10px;padding:16px 18px;width:520px;max-width:92vw;max-height:80vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.3);font-size:13px;line-height:1.5}
#ic-note-pop h3{margin:0 0 8px;font-size:15px}
#ic-note-pop .parent{border-left:3px solid #ccd;padding:4px 10px;color:#666;margin-bottom:10px;white-space:pre-wrap}
#ic-note-pop .body{white-space:pre-wrap}
#ic-note-pop .meta{color:#888;font-size:12px;margin-top:8px}
#ic-note-pop .x{float:right;cursor:pointer;color:#888;font-size:16px}
`;
    (document.head || document.documentElement).appendChild(s);
  }

  function build() {
    ensureStyle();
    const toggle = document.createElement("button");
    toggle.id = "ic-notif-toggle"; toggle.title = "Innergy notifications";
    toggle.innerHTML =
      "<svg viewBox='0 0 24 24'><path d='M12 2a6 6 0 0 0-6 6v3.6l-1.3 2.6A1 1 0 0 0 5.6 16h12.8a1 1 0 0 0 .9-1.4L18 11.6V8a6 6 0 0 0-6-6zm0 20a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22z'/></svg>" +
      "<span id='ic-notif-badge'></span>";
    toggle.addEventListener("click", () => togglePanel());

    const panel = document.createElement("div");
    panel.id = "ic-notif-panel";
    panel.innerHTML = `
<div class="icn-head"><b>Notifications</b>
  <button class="icn-ibtn" data-a="markall">Mark all read</button>
  <button class="icn-ibtn" data-a="refresh" title="Refresh">↻</button>
  <button class="icn-ibtn" data-a="close" title="Close">✕</button>
</div>
<div class="icn-tools">
  <input class="icn-search" placeholder="Search notifications…" />
  <div style="display:flex;align-items:center;gap:8px">
    <div class="icn-seg" data-seg="status">
      <button data-s="unread">Unread</button><button data-s="read">Read</button><button data-s="all">All</button>
    </div>
    <span style="flex:1"></span>
    <button class="icn-ibtn" data-a="filter">Filters ▾</button>
  </div>
  <div class="icn-filter-pop">${TYPES.map((t) => `<label><input type="checkbox" data-t="${t}"> ${TYPE_LABEL[t]}</label>`).join("")}</div>
</div>
<div class="icn-status"></div>
<div class="icn-list"></div>`;

    const pop = document.createElement("div");
    pop.id = "ic-note-pop";
    pop.innerHTML = `<div class="card"></div>`;
    pop.addEventListener("click", (e) => { if (e.target === pop) pop.classList.remove("show"); });

    document.body.append(toggle, panel, pop);
    el = {
      toggle, badge: toggle.querySelector("#ic-notif-badge"), panel, pop,
      search: panel.querySelector(".icn-search"),
      seg: panel.querySelector('[data-seg="status"]'),
      filterPop: panel.querySelector(".icn-filter-pop"),
      list: panel.querySelector(".icn-list"),
      status: panel.querySelector(".icn-status"),
    };

    panel.querySelector(".icn-head").addEventListener("click", (e) => {
      const a = e.target.getAttribute("data-a"); if (!a) return;
      if (a === "close") togglePanel(false);
      else if (a === "refresh") load(true);
      else if (a === "markall") markAll();
    });
    panel.querySelector('[data-a="filter"]').addEventListener("click", () => el.filterPop.classList.toggle("show"));
    el.seg.addEventListener("click", (e) => { const s = e.target.getAttribute("data-s"); if (s) { state.status = s; paintSeg(); load(true); } });
    el.search.addEventListener("input", () => { state.search = el.search.value.trim().toLowerCase(); render(); });
    el.filterPop.addEventListener("change", (e) => { const t = e.target.getAttribute("data-t"); if (t) { state.types[t] = e.target.checked; render(); } });
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("resize", positionToggle);
    window.addEventListener("hashchange", () => setTimeout(positionToggle, 400));
    positionToggle();
    setTimeout(positionToggle, 700); setTimeout(positionToggle, 1800); // header may render late
  }

  // Innergy's header notifications bell is a FontAwesome "fa-bell-o" icon (stable
  // class). Sit our button over it; fall back to a fixed top-right spot.
  function findBell() {
    for (const i of document.querySelectorAll(".fa-bell-o, i[class*='fa-bell']")) {
      const r = i.getBoundingClientRect();
      if (r.width > 0 && r.top < 60) return r; // top header icon
    }
    return null;
  }
  function positionToggle() {
    if (!el) return;
    const r = findBell();
    const t = el.toggle.style;
    if (r) { t.top = Math.round(r.top + r.height / 2 - 15) + "px"; t.left = Math.round(r.left + r.width / 2 - 15) + "px"; t.right = "auto"; t.bottom = "auto"; }
    else { t.top = "10px"; t.right = "120px"; t.left = "auto"; t.bottom = "auto"; }
  }

  function paintSeg() {
    el.seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-s") === state.status));
  }
  function paintFilters() {
    el.filterPop.querySelectorAll("input[data-t]").forEach((cb) => (cb.checked = state.types[cb.getAttribute("data-t")] !== false));
  }

  // Close the panel when clicking anywhere outside it (but not the toggle or the
  // note popup).
  function onDocDown(e) {
    if (!state.open || !el) return;
    if (el.panel.contains(e.target) || el.toggle.contains(e.target) || el.pop.contains(e.target)) return;
    togglePanel(false);
  }

  async function togglePanel(force) {
    const open = force === undefined ? !state.open : force;
    state.open = open;
    el.panel.classList.toggle("open", open);
    if (open) {
      // Fresh open: seed filters from the saved defaults.
      state.status = settings.defaultStatus;
      state.types = Object.assign({}, settings.types);
      state.search = ""; el.search.value = "";
      paintSeg(); paintFilters();
      refreshBadge();
      await load(true);
    } else {
      refreshBadge(); // reflect anything just marked read
    }
  }

  async function load(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.items = []; state.skip = 0; el.list.innerHTML = ""; }
    el.status.textContent = "Loading…";
    try {
      const [page] = await Promise.all([fetchPage(state.status, state.skip), ensureProjects()]);
      const { rows, total } = page;
      state.total = total;
      state.skip += rows.length;
      state.items = state.items.concat(rows.map(model));
      render();
    } catch (e) {
      el.status.textContent = "Couldn't load notifications: " + (e.message || e);
    } finally {
      state.loading = false;
    }
  }

  function visibleItems() {
    return state.items.filter((it) => {
      if (state.types[category(it)] === false) return false;
      if (state.search && (it.body + " " + it.context).toLowerCase().indexOf(state.search) === -1) return false;
      return true;
    });
  }

  function render() {
    if (!el) return;
    const items = visibleItems();
    el.list.innerHTML = "";
    if (!items.length) {
      el.list.innerHTML = `<div class="icn-empty">No ${state.status === "all" ? "" : state.status + " "}notifications${state.search ? " match your search" : ""}.</div>`;
    } else {
      for (const it of items) el.list.appendChild(itemEl(it));
    }
    if (state.items.length < state.total) {
      const more = document.createElement("div");
      more.className = "icn-more"; more.textContent = `Load more (${state.items.length} of ${state.total})`;
      more.addEventListener("click", () => load(false));
      el.list.appendChild(more);
    }
    const shown = items.length, loaded = state.items.length;
    el.status.textContent = `${shown} shown · ${loaded}/${state.total} loaded`;
    paintFilters();
  }

  function itemEl(it) {
    const row = document.createElement("div");
    row.className = "icn-item" + (it.isRead ? "" : " unread");
    if (!it.isRead) { const dot = document.createElement("div"); dot.className = "icn-dot"; row.appendChild(dot); }
    const body = document.createElement("div");
    body.className = "icn-body"; body.textContent = it.body;
    body.addEventListener("click", () => go(it.bodyUrl, it.bodyNewTab));
    row.appendChild(body);

    // Context line: project name (left) + the project/work-order link.
    if (it.context) {
      const line = document.createElement("div");
      line.className = "icn-ctx";
      const chip = document.createElement("span");
      chip.className = "icn-chip";
      const pn = projectNameForContext(it.context);
      chip.textContent = (pn ? pn + "  ·  " : "") + it.context;
      chip.title = "Open " + chip.textContent;
      chip.addEventListener("click", (e) => { e.stopPropagation(); go(it.contextUrl, it.contextNewTab); });
      line.appendChild(chip);
      row.appendChild(line);
    }

    // Task notifications: current due date + a status pill (fetched lazily).
    if (isTask(it)) {
      const qid = questId(it);
      if (qid) {
        const wrap = document.createElement("div");
        wrap.className = "icn-task";
        wrap.innerHTML = `<span class="icn-pill" style="background:#eee;color:#888">loading…</span>`;
        row.appendChild(wrap);
        fetchQuest(qid).then((info) => {
          if (!info) { wrap.remove(); return; }
          wrap.innerHTML = "";
          const s = document.createElement("span");
          s.className = "icn-pill"; s.textContent = info.statusName || "—";
          s.style.background = STATUS_COLOR[info.statusId] || "#777"; s.style.color = "#fff";
          wrap.appendChild(s);
          if (info.dueDate) {
            const due = document.createElement("span");
            due.className = "icn-due"; due.textContent = "Due " + fmtTime(info.dueDate);
            wrap.appendChild(due);
          }
        });
      }
    }

    const meta = document.createElement("div");
    meta.className = "icn-meta";
    meta.appendChild(Object.assign(document.createElement("span"), { textContent: fmtTime(it.created) }));
    if (isNote(it)) {
      const prev = document.createElement("span");
      prev.className = "icn-act"; prev.textContent = "Preview";
      prev.addEventListener("click", (e) => { e.stopPropagation(); showNotePopup(it); });
      meta.appendChild(prev);
    }
    const mark = document.createElement("span");
    mark.className = "icn-act"; mark.textContent = it.isRead ? "Mark unread" : "Mark read";
    mark.addEventListener("click", (e) => { e.stopPropagation(); toggleRead(it); });
    meta.appendChild(mark);
    row.appendChild(meta);
    return row;
  }

  // ---- actions (writes) --------------------------------------------------------
  async function toggleRead(it) {
    const next = !it.isRead;
    const r = await runCommand({ Id: it.id, MarkAsRead: next, $type: "NotificationItemToggleReadCommand" });
    if (r.ok) { it.isRead = next; render(); refreshBadge(); }
    else el.status.textContent = "Couldn't update: " + (r.messages || "error");
  }
  async function markAll() {
    const ids = state.items.filter((it) => !it.isRead).map((it) => it.id);
    if (!ids.length) return;
    el.status.textContent = "Marking all read…";
    const r = await runCommand({ Ids: ids, $type: "NotificationItemsMarkAsReadCommand" });
    if (r.ok) { state.items.forEach((it) => (it.isRead = true)); if (state.status === "unread") load(true); else render(); refreshBadge(); }
    else el.status.textContent = "Couldn't mark all read: " + (r.messages || "error");
  }

  // ---- note-context popup ------------------------------------------------------
  const GUID = "[0-9a-fA-F-]{36}";
  async function showNotePopup(it) {
    const card = el.pop.querySelector(".card");
    card.innerHTML = `<span class="x">✕</span><h3>Note</h3><div>Loading…</div>`;
    card.querySelector(".x").addEventListener("click", () => el.pop.classList.remove("show"));
    el.pop.classList.add("show");
    try {
      const route = it.bodyUrl;
      const noteId = (route.match(new RegExp("notes/(" + GUID + ")")) || [])[1];
      const woId = (route.match(new RegExp("workOrder/(" + GUID + ")")) || [])[1];
      const projId = (route.match(new RegExp("projects/(" + GUID + ")")) || [])[1];
      if (!noteId) throw new Error("no note id");
      let list = null;
      if (woId) list = await runQuery({ WorkOrderId: woId, $type: "ProjectWorkOrderNotesQuery" });
      else if (projId) list = await runQuery({ ProjectId: projId, $type: "ProjectNotesQuery" });
      if (!Array.isArray(list)) throw new Error("couldn't load the note");
      const note = list.find((n) => n.id === noteId);
      if (!note) throw new Error("note not found");
      const parent = note.parentId && list.find((n) => n.id === note.parentId);
      const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      card.innerHTML =
        `<span class="x">✕</span><h3>Note — ${esc(note.authorName || "")}</h3>` +
        (parent ? `<div class="parent"><b>${esc(parent.authorName || "")}:</b> ${esc(IC.htmlToText(parent.body || "").slice(0, 400))}</div>` : "") +
        `<div class="body">${esc(IC.htmlToText(note.body || ""))}</div>` +
        `<div class="meta">${fmtTime(note.created)}</div>` +
        `<div style="margin-top:12px"><button class="icn-ibtn" data-open>Open in notes</button></div>`;
      card.querySelector(".x").addEventListener("click", () => el.pop.classList.remove("show"));
      card.querySelector("[data-open]").addEventListener("click", () => { el.pop.classList.remove("show"); go(it.bodyUrl, it.bodyNewTab); });
    } catch (e) {
      card.innerHTML = `<span class="x">✕</span><h3>Note</h3><div>Couldn't load the note (${esc2(e.message || e)}). <a href="#" data-open>Open in notes</a></div>`;
      card.querySelector(".x").addEventListener("click", () => el.pop.classList.remove("show"));
      card.querySelector("[data-open]").addEventListener("click", (ev) => { ev.preventDefault(); el.pop.classList.remove("show"); go(it.bodyUrl, it.bodyNewTab); });
    }
  }
  function esc2(s) { return String(s || "").replace(/</g, "&lt;"); }

  // ---- badge -------------------------------------------------------------------
  async function refreshBadge() {
    if (!el) return;
    const n = await unreadCount();
    if (n == null) return;
    el.badge.textContent = n > 99 ? "99+" : String(n);
    el.badge.classList.toggle("show", n > 0);
    el.toggle.classList.toggle("has-unread", n > 0); // pulse the bell when unread
  }

  // ---- enable / mount ----------------------------------------------------------
  let badgeTimer = null;
  function applyEnabled() {
    if (settings.enabled) {
      if (!el) build();
      el.toggle.style.display = "flex";
      refreshBadge();
      if (!badgeTimer) badgeTimer = setInterval(refreshBadge, 45000);
    } else if (el) {
      el.toggle.style.display = "none";
      togglePanel(false);
      if (badgeTimer) { clearInterval(badgeTimer); badgeTimer = null; }
    }
  }

  // The toggle/panel are appended to <body> once and survive SPA navigation, so
  // mount just has to re-assert them if Innergy ever replaces <body>'s children.
  function mount() {
    if (settings.enabled && (!el || !document.body.contains(el.toggle))) { el = null; build(); applyEnabled(); }
  }

  IC.registerFeature({ id: "notifications-sidebar", mount });
  loadSettings(() => applyEnabled());
})();
