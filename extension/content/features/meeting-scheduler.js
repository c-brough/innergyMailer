/* InnerCider — Page-turn meeting scheduler (opt-out, on by default)
 *
 * On a Work-Order grid, when the PM checks exactly ONE work order, a floating
 * "Schedule page-turn meeting" button appears. It opens a modal to create a
 * Teams/Outlook meeting via Microsoft Graph (background graph-meetings.js), using
 * the same Microsoft sign-in as the mail features:
 *
 *   • Recipients autocomplete from 365 contacts (People.Read); default attendees
 *     from Options pre-fill every meeting.
 *   • A scheduling-assistant strip shows attendees' + the room's free/busy for the
 *     chosen day (getSchedule); click a cell to set the start time.
 *   • Room picker lists Teams Rooms (Place.Read.All) and books the chosen one.
 *   • The work order's URL is dropped into the invite body.
 *
 * The single-selection + WO URL come from the MAIN-world reader
 * (meeting-scheduler-main.js) over window.postMessage (ic-wo-sel).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const ORIGIN = "https://app.innergy.com";
  const DAY_START = 7, DAY_END = 19, SLOT_MIN = 30; // scheduling-assistant window
  // Higher-contrast but harmonious: green / amber / coral / violet / steel.
  const AV_COLOR = { "0": "#5fb98e", "1": "#f2b441", "2": "#e07a6b", "3": "#9b84cf", "4": "#8098b3" };
  const AV_LABEL = { "0": "Free", "1": "Tentative", "2": "Busy", "3": "Out of office", "4": "Working elsewhere" };
  const DETAIL_RE = /#\/projects\/[0-9a-fA-F-]{20,}\/workOrder\/([0-9a-fA-F-]{20,})\/details/i;

  let enabled = false; // opt-in: off until turned on in Options
  chrome.storage.local.get("meetingSchedulerEnabled", (d) => { enabled = d.meetingSchedulerEnabled === true; apply(); });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && c.meetingSchedulerEnabled) { enabled = c.meetingSchedulerEnabled.newValue === true; apply(); }
  });

  // ---- selection from the MAIN-world reader ----------------------------------
  let selection = null; // {url,label,id} | {multi} | null
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "ic-wo-sel") return;
    selection = e.data.payload;
    apply();
  });

  function fullUrl(u) {
    if (!u) return "";
    if (/^https?:/i.test(u)) return u;
    if (u.charAt(0) === "#") return ORIGIN + "/" + u;
    return u.charAt(0) === "/" ? ORIGIN + u : ORIGIN + "/" + u;
  }

  // ---- subject --------------------------------------------------------------
  // "Page-turn: Project Name - Work Order Name (Work Order Number)", dropping any
  // part we don't have.
  function cleanProject(s) { return String(s || "").replace(/^P-\d+-\d+\s*-\s*/i, "").trim(); }
  function buildSubject(sel, projectName) {
    const proj = cleanProject(projectName || sel.project || "");
    const name = (sel.name || "").trim();
    const num = (sel.number || "").trim();
    const wo = name && num && name !== num ? `${name} (${num})` : (name || num || sel.label || "Work Order");
    return "Page-turn: " + (proj ? proj + " - " : "") + wo;
  }
  function projIdFromHash() { const m = (location.hash || "").match(/projects\/([0-9a-fA-F-]{20,})/); return m ? m[1] : ""; }
  async function fetchProjectName(projId) {
    if (!projId) return "";
    try {
      const r = await fetch(ORIGIN + "/query/run?query=" + encodeURIComponent(JSON.stringify({ $type: "ProjectsPickerQuery" })), { credentials: "include" });
      if (!r.ok) return "";
      const arr = await r.json();
      if (!Array.isArray(arr)) return "";
      const p = arr.find((x) => x && (x.id === projId || x.Id === projId || x.value === projId));
      return p ? String(p.name || p.Name || p.text || "").trim() : "";
    } catch (e) { return ""; }
  }

  // ---- background bridge ------------------------------------------------------
  function send(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("ic-meet-style")) return;
    const s = document.createElement("style");
    s.id = "ic-meet-style";
    s.textContent = `
#ic-meet-fab{position:fixed;left:22px;bottom:22px;z-index:2147483600;display:flex;align-items:center;gap:8px;
  background:#1a56db;color:#fff;border:none;border-radius:24px;cursor:pointer;padding:10px 16px;
  font:13px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;font-weight:600;box-shadow:0 6px 20px rgba(26,86,219,.45)}
#ic-meet-fab:hover{background:#1646b8}
#ic-meet-fab svg{width:18px;height:18px;fill:#fff}
.ic-meet-detail-btn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;
  display:inline-flex;align-items:center;gap:6px;background:#fff;color:#1a56db;border:1px solid #c7d0f8;
  border-radius:16px;cursor:pointer;padding:5px 12px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.08);
  font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif}
.ic-meet-detail-btn:hover{background:#1a56db;color:#fff;border-color:#1a56db}
.ic-meet-detail-btn svg{width:14px;height:14px;fill:currentColor}
#ic-meet-overlay{position:fixed;inset:0;z-index:2147483601;background:rgba(15,23,42,.5);display:flex;align-items:center;
  justify-content:center;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;animation:icMeetFade .18s ease-out}
@keyframes icMeetFade{from{opacity:0}to{opacity:1}}
#ic-meet-card{width:680px;max-width:94vw;max-height:90vh;background:#fff;color:#1f2937;border-radius:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden}
#ic-meet-card .mh{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #e5e7eb}
#ic-meet-card .mh h2{margin:0;font-size:16px;flex:1}
#ic-meet-card .mx{cursor:pointer;border:none;background:#f3f4f6;width:30px;height:30px;border-radius:8px;font-size:17px;color:#374151}
#ic-meet-card .mb{padding:14px 18px;overflow:auto}
#ic-meet-card label.fl{display:block;font-size:12px;font-weight:700;color:#475569;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.03em}
#ic-meet-card input[type=text],#ic-meet-card input[type=date],#ic-meet-card input[type=time],#ic-meet-card select,#ic-meet-card textarea{
  width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #cbd5e1;border-radius:7px;font:13px inherit}
#ic-meet-card .row{display:flex;gap:10px;flex-wrap:wrap}
#ic-meet-card .row>div{flex:1;min-width:120px}
.ic-chips{display:flex;flex-wrap:wrap;gap:6px;border:1px solid #cbd5e1;border-radius:7px;padding:5px;min-height:38px;position:relative}
.ic-chip{display:inline-flex;align-items:center;gap:5px;background:#eef2fd;border:1px solid #c7d0f8;border-radius:12px;padding:2px 6px 2px 9px;font-size:12px;color:#1a3a8a}
.ic-chip b{font-weight:600}
.ic-chip .x{cursor:pointer;font-weight:700;color:#5566aa}
.ic-chips input{border:none;outline:none;flex:1;min-width:140px;font:13px inherit;padding:4px}
.ic-ac{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #cbd5e1;border-top:none;border-radius:0 0 8px 8px;
  box-shadow:0 10px 24px rgba(0,0,0,.14);max-height:220px;overflow:auto;z-index:5;display:none}
.ic-ac.show{display:block}
.ic-ac div{padding:7px 10px;cursor:pointer;font-size:12.5px}
.ic-ac div:hover,.ic-ac div.on{background:#eef2ff}
.ic-ac .nm{font-weight:600}
.ic-ac .em{color:#64748b;font-size:11.5px}
.ic-sa{margin-top:6px;border:1px solid #cbd3dd;border-radius:8px;overflow:auto}
.ic-sa table{border-collapse:collapse;width:100%;font-size:11px}
.ic-sa td,.ic-sa th{border:1px solid #d5dbe3;padding:0;height:22px}
.ic-sa th{position:sticky;top:0;background:#eef2f7;font-weight:700;color:#334155;padding:3px 4px;white-space:nowrap;text-align:left}
.ic-sa .who{position:sticky;left:0;background:#fff;padding:3px 8px;white-space:nowrap;font-weight:700;color:#1f2937;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.ic-sa .cell{width:18px;cursor:pointer}
.ic-sa .cell.sel{box-shadow:inset 0 0 0 2px #1a3a8a}
.ic-sa-legend{display:flex;gap:12px;flex-wrap:wrap;margin:7px 2px 0;font-size:11px;color:#475569}
.ic-sa-legend span{display:inline-flex;align-items:center;gap:5px;font-weight:600}
.ic-sa-legend i{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.18)}
#ic-meet-card .mf{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #e5e7eb}
#ic-meet-card .mf .msg{flex:1;font-size:12.5px}
#ic-meet-card .mf button{cursor:pointer;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;border:1px solid #cbd5e1;background:#fff;color:#334155}
#ic-meet-card .mf button.go{background:#1a56db;border-color:#1a56db;color:#fff}
#ic-meet-card .mf button.go:disabled{opacity:.6;cursor:default}
#ic-meet-card .ctx{font-size:12.5px;color:#475569;background:#f8fafc;border:1px solid #eef1f5;border-radius:7px;padding:8px 10px}
#ic-meet-card .ctx a{color:#1a56db;word-break:break-all}
.ic-done{text-align:center;padding:10px}
.ic-done .j{display:inline-block;margin:8px 6px 0;padding:8px 14px;border-radius:8px;background:#1a56db;color:#fff;text-decoration:none;font-weight:600}
.ic-done .j.alt{background:#fff;color:#1a56db;border:1px solid #1a56db}
`;
    (document.head || document.documentElement).appendChild(s);
  }

  const CAL_SVG = "<svg viewBox='0 0 24 24'><path d='M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm12 6v11H5V8h14z'/></svg>";

  // ---- triggers --------------------------------------------------------------
  function apply() { applyFab(); applyDetailBtn(); }

  // Floating button on a WO grid when exactly one WO is checked.
  function fab() { return document.getElementById("ic-meet-fab"); }
  function applyFab() {
    const single = enabled && selection && selection.url;
    if (!single) { const f = fab(); if (f) f.remove(); return; }
    if (fab()) return;
    ensureStyle();
    const b = document.createElement("button");
    b.id = "ic-meet-fab";
    b.innerHTML = CAL_SVG + "<span>Schedule page-turn meeting</span>";
    b.addEventListener("click", () => openModal());
    document.body.appendChild(b);
  }

  // Discrete button on the WO detail page, centered between Created By / Modified By.
  function commonAncestor(a, b) {
    const anc = []; let p = a;
    while (p) { anc.push(p); p = p.parentElement; }
    p = b; while (p) { if (anc.includes(p)) return p; p = p.parentElement; }
    return null;
  }
  function applyDetailBtn() {
    const on = enabled && DETAIL_RE.test(location.hash || "");
    if (!on) { const e = document.getElementById("ic-meet-detail-btn"); if (e) e.remove(); return; }
    if (document.getElementById("ic-meet-detail-btn")) return; // already placed
    const spans = [...document.querySelectorAll("span.bold")].filter((s) => /created by:|modified by:/i.test(s.textContent || ""));
    if (spans.length < 2) return; // footer not rendered yet
    const row = commonAncestor(spans[0], spans[1]);
    if (!row) return;
    ensureStyle();
    if (getComputedStyle(row).position === "static") row.style.position = "relative";
    const b = document.createElement("button");
    b.id = "ic-meet-detail-btn";
    b.className = "ic-meet-detail-btn";
    b.title = "Schedule a page-turn meeting for this work order";
    b.innerHTML = CAL_SVG + "<span>Schedule page turn</span>";
    b.addEventListener("click", openModalFromDetail);
    row.appendChild(b);
  }

  // Build the meeting context from the WO detail page and open the modal.
  async function openModalFromDetail() {
    const woId = ((location.hash || "").match(DETAIL_RE) || [])[1] || null;
    let number = "", name = "";
    // Header is "<WO number> - <WO name>", e.g. "P-26-1050-003p - desk". The WO
    // number's own hyphens aren't spaced, so split only on a spaced " - ".
    for (const el of document.querySelectorAll("div,span,h1,h2,h3")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim();
      const mm = own.match(/^(P-\d+-\d+\S*)\s+-\s+(.+)$/);
      if (mm && own.length < 70) { number = mm[1]; name = mm[2].trim(); break; }
    }
    const project = await fetchProjectName(projIdFromHash());
    openModal({ url: location.href, label: name || number || "Work Order", id: woId, number, name, project });
  }

  // ---- modal -----------------------------------------------------------------
  let M = null; // modal state

  function pad(n) { return String(n).padStart(2, "0"); }
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function nextHalfHour() { const d = new Date(); d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function tzName() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } }

  function closeModal() { const o = document.getElementById("ic-meet-overlay"); if (o) o.remove(); M = null; }

  async function openModal(ctxArg) {
    const sel = ctxArg && ctxArg.url ? ctxArg : selection;
    if (!sel || !sel.url) return;
    ensureStyle();
    closeModal();
    const woUrl = fullUrl(sel.url);
    const overlay = document.createElement("div");
    overlay.id = "ic-meet-overlay";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    overlay.innerHTML = `
<div id="ic-meet-card">
  <div class="mh"><h2>Schedule page-turn meeting</h2><button class="mx" title="Close">×</button></div>
  <div class="mb">
    <div class="ctx">Work order: <a class="wo" target="_blank" rel="noopener"></a></div>
    <label class="fl">Subject</label>
    <input type="text" class="subj" />
    <div class="row">
      <div><label class="fl">Date</label><input type="date" class="date" /></div>
      <div><label class="fl">Start</label><input type="time" class="time" /></div>
      <div><label class="fl">Duration</label><select class="dur">
        <option value="15">15 min</option><option value="30" selected>30 min</option>
        <option value="60">1 hour</option><option value="90">1.5 hours</option>
        <option value="120">2 hours</option></select></div>
    </div>
    <label class="fl">Attendees</label>
    <div class="ic-chips att"><input type="text" placeholder="Type a name or email…" /><div class="ic-ac"></div></div>
    <label class="fl">Room</label>
    <select class="room"><option value="">(loading rooms…)</option></select>
    <label class="fl">Availability <span style="font-weight:400;text-transform:none;color:#94a3b8">— click a slot to set the start time</span></label>
    <div class="ic-sa"></div>
    <div class="ic-sa-legend"></div>
    <label class="fl">Invite body</label>
    <textarea class="body" rows="4"></textarea>
  </div>
  <div class="mf"><span class="msg"></span><button class="cancel">Cancel</button><button class="go">Create meeting</button></div>
</div>`;
    document.body.appendChild(overlay);

    const q = (c) => overlay.querySelector(c);
    M = {
      overlay, sel, woUrl,
      att: [], rooms: [], schedules: {}, acItems: [], acIndex: -1,
      el: {
        card: q("#ic-meet-card"), subj: q(".subj"), date: q(".date"), time: q(".time"), dur: q(".dur"),
        chips: q(".ic-chips.att"), attInput: q(".ic-chips.att input"), ac: q(".ic-ac"),
        room: q(".room"), sa: q(".ic-sa"), legend: q(".ic-sa-legend"), body: q(".body"),
        msg: q(".mf .msg"), go: q(".mf .go"), woLink: q(".wo"),
      },
    };
    const E = M.el;
    E.woLink.textContent = sel.label || woUrl;
    E.woLink.href = woUrl;
    E.subj.value = buildSubject(sel, sel.project || "");
    E.subj.addEventListener("input", () => { if (M) M.subjEdited = true; });
    // Project name isn't a column on the project-scoped grid — fill it in from the
    // picker, unless the user has already tweaked the subject.
    if (!sel.project) {
      fetchProjectName(projIdFromHash()).then((pn) => {
        if (pn && M && !M.subjEdited) M.el.subj.value = buildSubject(sel, pn);
      });
    }
    E.date.value = todayStr();
    E.time.value = nextHalfHour();
    E.body.value = `Page-turn review for work order ${sel.label || ""}.\n\nWork order: ${woUrl}\n`;

    q(".mx").addEventListener("click", closeModal);
    q(".cancel").addEventListener("click", closeModal);
    E.go.addEventListener("click", createMeeting);
    [E.date, E.time, E.dur].forEach((x) => x.addEventListener("change", () => refreshAssistant()));
    E.room.addEventListener("change", () => refreshAssistant());
    wireAttendees();
    buildLegend();

    // Default attendees from Options.
    const d = await new Promise((r) => chrome.storage.local.get("meetingDefaultAttendees", r));
    for (const em of d.meetingDefaultAttendees || []) addChip(em, em);

    loadRooms();
    refreshAssistant();
  }

  // ---- attendees + autocomplete ----------------------------------------------
  function wireAttendees() {
    const E = M.el;
    E.chips.addEventListener("click", (e) => { if (e.target === E.chips) E.attInput.focus(); });
    let t = null;
    E.attInput.addEventListener("input", () => {
      clearTimeout(t);
      const v = E.attInput.value.trim();
      if (v.length < 2) { hideAC(); return; }
      t = setTimeout(() => searchPeople(v), 250);
    });
    E.attInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (M.acIndex >= 0 && M.acItems[M.acIndex]) { const p = M.acItems[M.acIndex]; addChip(p.email, p.name); }
        else { const v = E.attInput.value.trim(); if (/^[^@\s]+@[^@\s]+$/.test(v)) addChip(v, v); }
        E.attInput.value = ""; hideAC();
      } else if (e.key === "ArrowDown") { e.preventDefault(); moveAC(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveAC(-1); }
      else if (e.key === "Escape") { hideAC(); }
      else if (e.key === "Backspace" && !E.attInput.value && M.att.length) { removeChip(M.att[M.att.length - 1]); }
    });
    document.addEventListener("click", (e) => { if (M && !M.el.chips.contains(e.target)) hideAC(); }, true);
  }

  async function searchPeople(q) {
    const r = await send("MEETING_PEOPLE_SEARCH", { q });
    if (!M) return;
    const people = (r && r.ok && r.people) || [];
    // Drop ones already added.
    M.acItems = people.filter((p) => !M.att.includes(p.email.toLowerCase()));
    M.acIndex = -1;
    const ac = M.el.ac;
    ac.innerHTML = "";
    if (!M.acItems.length) { hideAC(); return; }
    M.acItems.forEach((p, i) => {
      const d = document.createElement("div");
      d.innerHTML = `<div class="nm"></div><div class="em"></div>`;
      d.querySelector(".nm").textContent = p.name;
      d.querySelector(".em").textContent = p.email;
      d.addEventListener("click", () => { addChip(p.email, p.name); M.el.attInput.value = ""; hideAC(); M.el.attInput.focus(); });
      ac.appendChild(d);
    });
    ac.classList.add("show");
  }
  function moveAC(dir) {
    if (!M.acItems.length) return;
    M.acIndex = (M.acIndex + dir + M.acItems.length) % M.acItems.length;
    [...M.el.ac.children].forEach((c, i) => c.classList.toggle("on", i === M.acIndex));
  }
  function hideAC() { if (M) { M.el.ac.classList.remove("show"); M.acIndex = -1; } }

  function addChip(email, name) {
    email = (email || "").trim(); if (!email) return;
    const key = email.toLowerCase();
    if (M.att.includes(key)) return;
    M.att.push(key);
    const chip = document.createElement("span");
    chip.className = "ic-chip";
    chip.dataset.email = key;
    const b = document.createElement("b"); b.textContent = name || email; b.title = email;
    const x = document.createElement("span"); x.className = "x"; x.textContent = "×";
    x.addEventListener("click", () => removeChip(key));
    chip.append(b, x);
    M.el.chips.insertBefore(chip, M.el.attInput);
    scheduleAssistant();
  }
  function removeChip(key) {
    M.att = M.att.filter((e) => e !== key);
    const c = M.el.chips.querySelector(`.ic-chip[data-email="${CSS.escape(key)}"]`);
    if (c) c.remove();
    scheduleAssistant();
  }

  // ---- rooms -----------------------------------------------------------------
  async function loadRooms() {
    const r = await send("MEETING_LIST_ROOMS");
    if (!M) return;
    M.rooms = (r && r.ok && r.rooms) || [];
    const sel = M.el.room;
    sel.innerHTML = "";
    const none = document.createElement("option"); none.value = ""; none.textContent = M.rooms.length ? "(no room)" : "(no rooms available)";
    sel.appendChild(none);
    for (const rm of M.rooms) {
      const o = document.createElement("option");
      o.value = rm.email;
      o.textContent = rm.name + (rm.capacity ? ` (${rm.capacity})` : "") + (rm.floor ? " · " + rm.floor : "");
      sel.appendChild(o);
    }
    if (!r || !r.ok) { none.textContent = "(rooms unavailable — see Options)"; }
  }
  function roomEmail() { return M.el.room.value || ""; }
  function roomName() { const o = M.el.room.selectedOptions[0]; return o ? o.textContent : ""; }

  // ---- scheduling assistant (free/busy) --------------------------------------
  function buildLegend() {
    M.el.legend.innerHTML = Object.keys(AV_LABEL).map((k) =>
      `<span><i style="background:${AV_COLOR[k]}"></i>${AV_LABEL[k]}</span>`).join("");
  }
  let saTimer = null;
  function scheduleAssistant() { clearTimeout(saTimer); saTimer = setTimeout(refreshAssistant, 350); }

  function slotCount() { return Math.round((DAY_END - DAY_START) * 60 / SLOT_MIN); }
  function slotLabel(i) { const mins = DAY_START * 60 + i * SLOT_MIN; const h = Math.floor(mins / 60), m = mins % 60; const ap = h < 12 ? "a" : "p"; const hh = ((h + 11) % 12) + 1; return m === 0 ? `${hh}${ap}` : ""; }

  async function refreshAssistant() {
    if (!M) return;
    const emails = M.att.slice();
    const rm = roomEmail(); if (rm) emails.push(rm);
    const date = M.el.date.value;
    renderAssistant(date, emails, null); // show grid immediately (loading tint)
    if (!emails.length || !date) return;
    const start = `${date}T${pad(DAY_START)}:00:00`;
    const end = `${date}T${pad(DAY_END)}:00:00`;
    const r = await send("MEETING_GET_SCHEDULE", { emails, start, end, interval: SLOT_MIN });
    if (!M || M.el.date.value !== date) return;
    const map = {};
    if (r && r.ok) for (const s of r.schedules || []) map[(s.email || "").toLowerCase()] = s.availabilityView || "";
    renderAssistant(date, emails, map);
  }

  function selectedSlotRange() {
    const [h, m] = (M.el.time.value || "09:00").split(":").map(Number);
    const startIdx = Math.round(((h * 60 + m) - DAY_START * 60) / SLOT_MIN);
    const len = Math.max(1, Math.round(Number(M.el.dur.value) / SLOT_MIN));
    return { startIdx, len };
  }

  function renderAssistant(date, emails, map) {
    const n = slotCount();
    const { startIdx, len } = selectedSlotRange();
    const nameFor = (em) => {
      const chip = M.el.chips.querySelector(`.ic-chip[data-email="${CSS.escape(em.toLowerCase())}"] b`);
      if (chip) return chip.textContent;
      const rm = M.rooms.find((r) => r.email.toLowerCase() === em.toLowerCase());
      return rm ? "🚪 " + rm.name : em;
    };
    let html = "<table><tr><th class='who'>Attendee</th>";
    for (let i = 0; i < n; i++) html += `<th>${slotLabel(i)}</th>`;
    html += "</tr>";
    if (!emails.length) {
      html += `<tr><td class="who" style="color:#94a3b8">Add attendees to see availability</td><td colspan="${n}"></td></tr>`;
    }
    for (const em of emails) {
      const av = map ? (map[em.toLowerCase()] || "") : "";
      html += `<tr><td class="who" title="${em}">${esc(nameFor(em))}</td>`;
      for (let i = 0; i < n; i++) {
        const ch = av.charAt(i);
        const bg = map ? (AV_COLOR[ch] || "#fff") : "#f1f5f9";
        const sel = i >= startIdx && i < startIdx + len ? " sel" : "";
        html += `<td class="cell${sel}" data-i="${i}" style="background:${bg}"></td>`;
      }
      html += "</tr>";
    }
    html += "</table>";
    M.el.sa.innerHTML = html;
    M.el.sa.querySelectorAll("td.cell").forEach((td) => {
      td.addEventListener("click", () => {
        const i = Number(td.dataset.i);
        const mins = DAY_START * 60 + i * SLOT_MIN;
        M.el.time.value = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
        renderAssistant(date, emails, map); // repaint selection
      });
    });
  }

  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ---- create ----------------------------------------------------------------
  function toHtmlBody(text, woUrl) {
    const escd = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");
    return `<div>${escd}</div>`;
  }

  async function createMeeting() {
    if (!M) return;
    const E = M.el;
    if (!M.att.length) { setMsg("Add at least one attendee.", true); return; }
    if (!E.date.value || !E.time.value) { setMsg("Pick a date and start time.", true); return; }
    const startISO = `${E.date.value}T${E.time.value}:00`;
    const startD = new Date(startISO);
    const endD = new Date(startD.getTime() + Number(E.dur.value) * 60000);
    const endISO = `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-${pad(endD.getDate())}T${pad(endD.getHours())}:${pad(endD.getMinutes())}:00`;
    const meeting = {
      subject: E.subj.value.trim() || "Page Turn",
      bodyHtml: toHtmlBody(E.body.value, M.woUrl),
      startISO, endISO, timeZone: tzName(),
      attendees: M.att.map((em) => ({ email: em })),
      roomEmail: roomEmail(), roomName: roomName(),
    };
    E.go.disabled = true; setMsg("Creating the meeting…", false);
    const r = await send("MEETING_CREATE", { meeting });
    if (!M) return;
    E.go.disabled = false;
    if (!r || !r.ok) { setMsg("Couldn't create the meeting: " + ((r && r.error) || "unknown error"), true); return; }
    showDone(r.meeting || {});
  }
  function setMsg(t, err) { if (M) { M.el.msg.textContent = t; M.el.msg.style.color = err ? "#b91c1c" : "#475569"; } }

  function showDone(mtg) {
    const card = M.el.card;
    const body = card.querySelector(".mb");
    body.innerHTML = `<div class="ic-done"><div style="font-size:40px">✅</div>
      <div style="font-size:15px;font-weight:700;margin-top:4px">Meeting created &amp; invites sent</div>
      <div style="color:#475569;margin-top:4px">The Teams invite is on your calendar and sent to the attendees${M.el.room.value ? " and room" : ""}.</div>
      <div></div></div>`;
    const wrap = body.querySelector(".ic-done div:last-child");
    if (mtg.joinUrl) { const a = document.createElement("a"); a.className = "j"; a.href = mtg.joinUrl; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Join Teams meeting"; wrap.appendChild(a); }
    if (mtg.webLink) { const a = document.createElement("a"); a.className = "j alt"; a.href = mtg.webLink; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open in Outlook"; wrap.appendChild(a); }
    card.querySelector(".mf").innerHTML = '<span class="msg" style="flex:1"></span><button class="cancel go2">Done</button>';
    card.querySelector(".go2").addEventListener("click", closeModal);
  }

  // mount: nothing heavy — selection is pushed from the MAIN reader. Re-assert the
  // button after SPA re-renders.
  IC.registerFeature({ id: "meeting-scheduler", mount: apply });
})();
