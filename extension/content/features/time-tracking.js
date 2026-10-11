/* InnerCider — Time Tracking Tools (opt-in)
 *
 * On the Time Tracking grid, when a timekeeper selects exactly two adjacent
 * segments for the same employee, InnerCider offers to fill the gap between them
 * (end of the earlier → start of the later):
 *   • ADD SEGMENT  (green) — one segment spanning the whole gap.
 *   • ADD SEGMENTS (blue)  — a card to split the gap into several segments, either
 *                            By hours (decimal, even split, live recalc) or
 *                            By time (explicit Start/End per segment; gaps between
 *                            segments record unpaid breaks, noted on the segment
 *                            before them).
 * Each segment carries an allocation (a generic labor item, or Job → Work Order →
 * Activity). Create via POST /command/run (TimeTrackingActivityLogCreateCommand);
 * Innergy rejects a segment with no labor item, so an allocation is always chosen.
 *
 * When exactly ONE segment is selected, pills appear above (add before) and below
 * (add after) it — shown only where there's room, bounded by the nearest
 * neighbour or midnight. That form (By time) adds segments on the chosen side and
 * can shrink the selected segment to make room, which edits that entry
 * (TimeTrackingActivityLogEditCommand), preserving its allocation.
 *
 * Guards (all required before the buttons are active):
 *   - the feature is enabled in Options (timeTrackingEnabled);
 *   - exactly two rows selected, same EmployeeId, adjacent in the grid;
 *   - a real (positive) gap with no other segment of that employee inside it;
 *   - the grid is sorted by StartTime or EndTime;
 *   - the Status column is NOT filtered — if it is, the buttons render grayed
 *     with a "Clear the status filter" tooltip (a filter could hide a segment
 *     sitting in the gap, so adjacency can't be trusted).
 *
 * Grid facts (selection, sort, filter, the employee's segments) come from the
 * MAIN world via content/features/time-tracking-main.js over window.postMessage;
 * the create POST runs here (same-origin session fetch).
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const ROUTE_RE = /#\/timeTracking\/grid/i;
  const OVERLAY_ID = "innercider-tt-overlay";
  const COMMAND_URL = "https://app.innergy.com/command/run";

  // ---- enabled flag (opt-in) ---------------------------------------------------
  let enabled = false;
  chrome.storage.local.get("timeTrackingEnabled", (d) => {
    enabled = d.timeTrackingEnabled === true;
    scheduleEval();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.timeTrackingEnabled) {
      enabled = c.timeTrackingEnabled.newValue === true;
      scheduleEval();
    }
  });

  // ---- MAIN-world bridge -------------------------------------------------------
  function getState() {
    return new Promise((resolve) => {
      const requestId = "tt_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.source !== "innercider-main" || m.type !== "TT_STATE" || m.requestId !== requestId) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(m.state);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "innercider", type: "TT_GET_STATE", requestId }, location.origin);
      setTimeout(() => { if (!done) { window.removeEventListener("message", onMsg); resolve(null); } }, 1200);
    });
  }
  function refreshGrid() {
    window.postMessage({ source: "innercider", type: "TT_REFRESH" }, location.origin);
  }

  // ---- time helpers -----------------------------------------------------------
  // Grid times are naive wall-clock strings ("2026-10-11T12:00", maybe with
  // seconds), null for running segments. Innergy posts that same wall-clock as
  // "…:00.000Z" (not a real UTC conversion), so we parse naive-as-UTC for the
  // math and emit the wall-clock back with a Z for the command — consistent and
  // reproducing exactly what the app sends.
  function toMs(naive) {
    if (!naive) return NaN;
    let s = String(naive);
    if (/T\d{2}:\d{2}$/.test(s)) s += ":00";
    return Date.parse(s + "Z");
  }
  const toIso = (ms) => new Date(ms).toISOString(); // "…:00.000Z" wall-clock + Z
  const HOUR_MS = 3600000;
  const MIN_MS = 60000;
  // Gaps between segments are unpaid breaks — but only up to 2 hours. A longer
  // gap is off-shift / non-worked time, not a break, so we don't label, note, or
  // count it.
  const MAX_BREAK_MS = 2 * HOUR_MS;
  const isBreak = (gap) => gap >= MIN_MS && gap <= MAX_BREAK_MS;
  const round2 = (n) => Math.round(n * 100) / 100;

  // Midnight (00:00 wall-clock) of the day a timestamp falls on. Our ms are
  // naive-as-UTC, so day math uses the UTC fields.
  function dayStartMs(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  // "4:05 PM" for display.
  function fmtTime(ms) {
    const d = new Date(ms);
    let h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ap = h < 12 ? "AM" : "PM";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${ap}`;
  }
  // "1 hr 30 min" / "45 min" for break durations.
  function fmtDuration(ms) {
    const mins = Math.max(0, Math.round(ms / MIN_MS));
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return `${h} hr ${m} min`;
    if (h) return `${h} hr`;
    return `${m} min`;
  }
  // Parse a loose time string ("4", "4a", "4p", "430pm", "4:32a", "16:00") to an
  // absolute ms on `dStart`'s day. When AM/PM is omitted and the hour is
  // ambiguous (1–12), pick the reading that lands inside [ctxMin, ctxMax]; else
  // the reading closest to ctxMin. Returns null if unparseable.
  function parseTime(text, dStart, ctxMin, ctxMax) {
    let s = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!s) return null;
    let mer = null;
    const mm = s.match(/(am|pm|a|p)\.?$/);
    if (mm) { mer = mm[1][0] === "a" ? "am" : "pm"; s = s.slice(0, s.length - mm[0].length); }
    s = s.replace(/[^\d:]/g, "");
    if (!s) return null;
    let hr, min = 0;
    if (s.includes(":")) {
      const p = s.split(":"); hr = parseInt(p[0], 10); min = parseInt(p[1] || "0", 10);
    } else if (s.length <= 2) {
      hr = parseInt(s, 10);
    } else {
      hr = parseInt(s.slice(0, s.length - 2), 10); min = parseInt(s.slice(-2), 10);
    }
    if (!Number.isFinite(hr) || !Number.isFinite(min) || hr > 23 || min > 59) return null;
    const mk = (h) => dStart + h * HOUR_MS + min * MIN_MS;
    let candidates;
    if (mer) { let h = hr % 12; if (mer === "pm") h += 12; candidates = [mk(h)]; }
    else if (hr === 0 || hr > 12) { candidates = [mk(hr)]; }
    else { candidates = [mk(hr % 12), mk((hr % 12) + 12)]; } // am, pm
    if (candidates.length === 1) return candidates[0];
    const within = candidates.filter((c) => (ctxMin == null || c >= ctxMin) && (ctxMax == null || c <= ctxMax));
    if (within.length) return within[0];
    if (ctxMin != null) return candidates.reduce((a, b) => (Math.abs(b - ctxMin) < Math.abs(a - ctxMin) ? b : a));
    return candidates[0];
  }

  // ---- queries (picker dropdowns) ---------------------------------------------
  // Innergy rejects a segment with no Labor Item, so every gap-fill carries an
  // allocation. Two kinds:
  //   • generic — a company/overhead labor item (Admin, Meetings, …) from
  //     TimeTrackingLaborItemsQuery. Activity DTO = { LaborItemId }.
  //   • job     — Job (Project) → Work Order → Activity. Activity DTO =
  //     { LaborItemId:<activityId>, WorkOrderId, WorkOrderType:2 } (the project
  //     is implied by the work order; WorkOrderType 2 = Project Work Order).
  //
  // fetch that can't hang forever — aborts after `ms`, so a stalled request
  // surfaces as an error instead of a spinner that never resolves.
  function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {})).finally(() => clearTimeout(t));
  }

  // Run a GET /query/run and normalize the common [{ id, name }] picker shape.
  async function runPicker(query, timeout) {
    const r = await fetchWithTimeout(
      "https://app.innergy.com/query/run?query=" + encodeURIComponent(JSON.stringify(query)),
      { credentials: "include" },
      timeout || 12000
    );
    const j = await r.json();
    return Array.isArray(j) ? j.filter((x) => x && x.id).map((x) => ({ id: x.id, name: x.name })) : [];
  }

  // Simple caches: a resolved list is reused; a failure returns [] without
  // caching so the next open retries.
  const WORK_ORDER_TYPE_PROJECT = 2;
  let laborItemsCache = null;
  let activitiesCache = null;
  let projectsCache = null;
  const workOrdersCache = new Map(); // projectId -> [{id,name}]

  async function getLaborItems() {
    if (laborItemsCache) return laborItemsCache;
    try {
      const items = await runPicker({ $type: "TimeTrackingLaborItemsQuery" });
      if (items.length) laborItemsCache = items;
      return items;
    } catch (e) { IC.warn("TT labor items fetch failed", e); return []; }
  }

  async function getActivities() {
    if (activitiesCache) return activitiesCache;
    try {
      const items = await runPicker({ $type: "ActivitiesSelectItemsQuery" });
      if (items.length) activitiesCache = items;
      return items;
    } catch (e) { IC.warn("TT activities fetch failed", e); return []; }
  }

  async function getProjects() {
    if (projectsCache) return projectsCache;
    try {
      const items = await runPicker({ $type: "ProjectsPickerQuery" });
      if (items.length) projectsCache = items;
      return items;
    } catch (e) { IC.warn("TT projects fetch failed", e); return []; }
  }

  async function getWorkOrders(projectId) {
    if (!projectId) return [];
    if (workOrdersCache.has(projectId)) return workOrdersCache.get(projectId);
    try {
      const items = await runPicker({ ProjectId: projectId, $type: "ProjectWorkOrdersInProjectPickerQuery" });
      if (items.length) workOrdersCache.set(projectId, items);
      return items;
    } catch (e) { IC.warn("TT work orders fetch failed", e); return []; }
  }

  // ---- command POST -----------------------------------------------------------
  // alloc is { kind:"generic", laborItemId } or { kind:"job", activityId, workOrderId }.
  function allocToActivity(alloc) {
    if (!alloc) return null;
    if (alloc.kind === "job" && alloc.workOrderId && alloc.activityId) {
      return {
        LaborItemId: alloc.activityId,
        WorkOrderId: alloc.workOrderId,
        WorkOrderType: WORK_ORDER_TYPE_PROJECT,
        $type: "TimeTrackingActivityDto",
      };
    }
    if (alloc.laborItemId) {
      return { LaborItemId: alloc.laborItemId, $type: "TimeTrackingActivityDto" };
    }
    return null;
  }

  function buildCreateCommand(employeeId, startIso, endIso, alloc, note) {
    return {
      UserIds: [employeeId],
      StartEndTime: { StartTime: startIso, EndTime: endIso, $type: "ActivityStartEndTimeCommandDto" },
      DateDuration: null,
      Activity: allocToActivity(alloc),
      Note: note || "",
      $type: "TimeTrackingActivityLogCreateCommand",
    };
  }

  async function postCommand(command) {
    const resp = await fetchWithTimeout(COMMAND_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    }, 20000);
    let body = null;
    try { body = await resp.json(); } catch (e) { /* may be empty */ }
    // /command/run returns HTTP 200 even on failure; the real flag is IsSuccess,
    // and Messages is an array of { Message, Type }.
    const ok = resp.ok && !!body && body.IsSuccess === true;
    const messages =
      body && Array.isArray(body.Messages)
        ? body.Messages.map((m) => (m && m.Message) || "").filter(Boolean).join("; ")
        : "";
    return { ok, status: resp.status, messages, body };
  }

  // Create segments from a list of { startIso, endIso, alloc, note? } and post one
  // command each. Returns { created, failed, firstError }.
  async function createSegments(employeeId, items) {
    let created = 0, failed = 0, firstError = "";
    for (const it of items) {
      try {
        const r = await postCommand(buildCreateCommand(employeeId, it.startIso, it.endIso, it.alloc, it.note));
        if (r.ok) created++;
        else { failed++; if (!firstError) firstError = r.messages || ("HTTP " + r.status); }
      } catch (err) {
        failed++; if (!firstError) firstError = String(err);
      }
    }
    return { created, failed, firstError };
  }

  // ---- edit (shrink/move an existing entry) -----------------------------------
  // Load the editable snapshot of an entry so we can preserve its allocation and
  // note when we only move its boundary. Returns the raw DTO or null.
  async function loadEditDto(employeeId, activityLogId) {
    try {
      const r = await fetchWithTimeout(
        "https://app.innergy.com/query/run?query=" +
          encodeURIComponent(JSON.stringify({ UserId: employeeId, ActivityLogId: activityLogId, $type: "TimeTrackingActivityLogEditQuery" })),
        { credentials: "include" },
        12000
      );
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { IC.warn("TT edit-load failed", e); return null; }
  }
  // Rebuild the write-shape Activity from a loaded edit DTO's Activity.
  function activityFromDto(dto) {
    const a = dto && dto.Activity;
    if (!a || !a.LaborItemId) return null;
    return a.WorkOrderId
      ? { LaborItemId: a.LaborItemId, WorkOrderId: a.WorkOrderId, WorkOrderType: a.WorkOrderType, $type: "TimeTrackingActivityDto" }
      : { LaborItemId: a.LaborItemId, $type: "TimeTrackingActivityDto" };
  }
  // Human label for an entry's current allocation (for the read-only anchor row).
  function allocLabelFromDto(dto) {
    const a = dto && dto.Activity;
    if (!a) return "";
    if (a.WorkOrderId) return `${a.Name || "Activity"} · ${a.WorkOrderSequenceIdentifier || a.WorkOrderName || ""}`.trim();
    return a.Name || "Generic";
  }
  // Edit an entry's time (and optionally note), preserving its allocation.
  async function editSegmentTime(employeeId, dto, startIso, endIso, note) {
    const cmd = {
      Id: dto.Id,
      UserId: employeeId,
      StartEndTime: { StartTime: startIso, EndTime: endIso, $type: "ActivityStartEndTimeCommandDto" },
      DateDuration: null,
      Activity: activityFromDto(dto),
      Note: note != null ? note : (dto.Note || ""),
      $type: "TimeTrackingActivityLogEditCommand",
    };
    try {
      const r = await postCommand(cmd);
      return { ok: r.ok, error: r.ok ? "" : (r.messages || "HTTP " + r.status) };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // ---- DOM: locate the grid's main data rows ----------------------------------
  function mainRowsContent() {
    for (const view of document.querySelectorAll(".dx-datagrid-rowsview")) {
      const content = view.querySelector(".dx-datagrid-content:not(.dx-datagrid-content-fixed)") || view;
      if (content.querySelector("tr.dx-data-row")) return content;
    }
    return null;
  }
  function removeOverlay() {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
  }

  // ---- evaluation -------------------------------------------------------------
  let evalScheduled = false;
  function scheduleEval() {
    if (evalScheduled) return;
    evalScheduled = true;
    setTimeout(() => { evalScheduled = false; reeval().catch((e) => IC.warn("TT reeval", e)); }, 120);
  }

  // The two selected, adjacent data rows in the main (non-fixed) table, or null.
  // positionOverlay re-finds them so the overlay tracks scroll without a re-eval.
  function selectedPair() {
    const content = mainRowsContent();
    if (!content) return null;
    const rows = Array.from(content.querySelectorAll("tr.dx-data-row"));
    const sel = rows.filter((r) => r.classList.contains("dx-selection"));
    if (sel.length !== 2) return null;
    if (Math.abs(rows.indexOf(sel[0]) - rows.indexOf(sel[1])) !== 1) return null; // adjacent only
    return { content, rows: sel };
  }
  function countSelectedRows() {
    const content = mainRowsContent();
    if (!content) return 0;
    return content.querySelectorAll("tr.dx-data-row.dx-selection").length;
  }
  // The single selected data row (for positioning the before/after pills).
  function selectedSingleRow() {
    const content = mainRowsContent();
    if (!content) return null;
    const sel = Array.from(content.querySelectorAll("tr.dx-data-row.dx-selection"));
    if (sel.length !== 1) return null;
    return { content, row: sel[0] };
  }

  async function reeval() {
    if (!enabled || !ROUTE_RE.test(location.hash)) return removeOverlay();
    const nSel = countSelectedRows();
    if (nSel !== 1 && nSel !== 2) return removeOverlay();

    const state = await getState();
    if (!state || !state.ok || !Array.isArray(state.selected)) return removeOverlay();

    if (state.selected.length === 2) return reevalPair(state);
    if (state.selected.length === 1) return reevalSingle(state);
    return removeOverlay();
  }

  // Two adjacent rows → fill the gap between them.
  function reevalPair(state) {
    if (!state.timeSortField) return removeOverlay(); // adjacency must mean time-adjacency
    if (!selectedPair()) return removeOverlay();
    const [s1, s2] = state.selected;
    if (!s1.EmployeeId || s1.EmployeeId !== s2.EmployeeId) return removeOverlay();

    const early = toMs(s1.StartTime) <= toMs(s2.StartTime) ? s1 : s2;
    const late = early === s1 ? s2 : s1;
    const gapStart = toMs(early.EndTime);
    const gapEnd = toMs(late.StartTime);
    if (!(gapEnd > gapStart)) return removeOverlay(); // no positive gap

    // Reject if any OTHER segment of this employee overlaps the gap.
    const blocked = (state.employeeSegments || []).some((seg) => {
      if (seg.Id === early.Id || seg.Id === late.Id) return false;
      return toMs(seg.StartTime) < gapEnd && toMs(seg.EndTime) > gapStart;
    });
    if (blocked) return removeOverlay();

    showOverlay({
      mode: "pair",
      key: early.Id + "|" + late.Id,
      employeeId: early.EmployeeId,
      employeeName: early.EmployeeFullName,
      gapStart, gapEnd,
      earlier: { id: early.Id, startMs: toMs(early.StartTime), endMs: gapStart },
      later: { id: late.Id, startMs: gapEnd, endMs: toMs(late.EndTime) },
      statusFiltered: !!state.statusFiltered,
    });
  }

  // One row → offer adding before (above) and/or after (below), bounded by the
  // nearest neighbour on each side or by midnight. The selected segment may be
  // shrunk to make room, so a side has room whenever there's a usable window on
  // it (gap to the neighbour, or the segment itself is long enough to shrink).
  function reevalSingle(state) {
    const sel = state.selected[0];
    const selStart = toMs(sel.StartTime), selEnd = toMs(sel.EndTime);
    if (!sel.EmployeeId || !Number.isFinite(selStart) || !Number.isFinite(selEnd) || selEnd <= selStart) return removeOverlay();

    const segs = (state.employeeSegments || [])
      .map((s) => ({ Id: s.Id, start: toMs(s.StartTime), end: toMs(s.EndTime) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
    // Nearest neighbour whose end is at/below our start (before) and whose start
    // is at/above our end (after). Ignore the selected row itself.
    let prevEnd = -Infinity, nextStart = Infinity;
    for (const s of segs) {
      if (s.Id === sel.Id) continue;
      if (s.end <= selStart && s.end > prevEnd) prevEnd = s.end;
      if (s.start >= selEnd && s.start < nextStart) nextStart = s.start;
    }
    const dStart = dayStartMs(selStart);
    const beforeLower = prevEnd === -Infinity ? dStart : prevEnd;
    const afterUpper = nextStart === Infinity ? dStart + 24 * HOUR_MS : nextStart;

    // Room if the side's full window (incl. shrinking the selected segment) can
    // hold at least a minimal new segment.
    const roomBefore = selEnd - beforeLower > MIN_MS;
    const roomAfter = afterUpper - selStart > MIN_MS;
    if (!roomBefore && !roomAfter) return removeOverlay();

    showOverlay({
      mode: "single",
      key: "single|" + sel.Id,
      employeeId: sel.EmployeeId,
      employeeName: sel.EmployeeFullName,
      anchor: { id: sel.Id, startMs: selStart, endMs: selEnd },
      beforeLower, afterUpper, roomBefore, roomAfter,
      statusFiltered: !!state.statusFiltered,
    });
  }

  // ---- floating overlay (no layout impact) ------------------------------------
  // A compact pill of two buttons floated over the line between the two selected
  // rows. Fixed-positioned and outside the table, so it never pushes the grid
  // down and grid re-renders don't reflow it.
  function showOverlay(ctx) {
    let ov = document.getElementById(OVERLAY_ID);
    // Rebuild only when the selection or its filtered-state changes.
    if (!ov || ov.dataset.key !== ctx.key || ov.dataset.filtered !== String(ctx.statusFiltered)) {
      if (ov) ov.remove();
      ov = ctx.mode === "single" ? buildSingleOverlay(ctx) : buildOverlay(ctx);
      document.body.appendChild(ov);
    }
    positionOverlay();
  }

  // Shared pill-button factory.
  function mkPillBtn(label, color, statusFiltered) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    Object.assign(b.style, {
      pointerEvents: "auto", height: "19px", lineHeight: "19px", padding: "0 11px",
      fontSize: "10.5px", fontWeight: "700", letterSpacing: ".02em", border: "none",
      borderRadius: "10px", color: "#fff", cursor: "pointer", whiteSpace: "nowrap",
      boxShadow: "0 1px 5px rgba(0,0,0,.28)", background: color,
    });
    if (statusFiltered) {
      b.disabled = true;
      b.style.background = "#9aa3ad";
      b.style.cursor = "not-allowed";
      b.style.boxShadow = "none";
      b.title = "Clear the status filter to add segments";
    }
    return b;
  }

  // Pair mode: one pill floated over the line between the two selected rows.
  function buildOverlay(ctx) {
    const ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.dataset.key = ctx.key;
    ov.dataset.mode = "pair";
    ov.dataset.filtered = String(ctx.statusFiltered);
    Object.assign(ov.style, {
      position: "fixed", zIndex: "2147483646", transform: "translate(-50%, -50%)",
      display: "flex", gap: "6px", alignItems: "center", pointerEvents: "none",
    });
    const gapHours = round2((ctx.gapEnd - ctx.gapStart) / HOUR_MS).toFixed(2);
    const addOne = mkPillBtn("Add Segment", "#1f9d57", ctx.statusFiltered);
    const addMany = mkPillBtn("Add Segments", "#2f6feb", ctx.statusFiltered);
    if (!ctx.statusFiltered) {
      addOne.title = `Fill the ${gapHours} h gap with one segment`;
      addMany.title = `Split the ${gapHours} h gap into multiple segments`;
      addOne.addEventListener("click", (e) => { e.stopPropagation(); openSingleForm(ctx); });
      addMany.addEventListener("click", (e) => { e.stopPropagation(); openSplitForm(ctx); });
    }
    ov.append(addOne, addMany);
    return ov;
  }

  // Single mode: a pill above (add before) and/or below (add after) the row.
  function buildSingleOverlay(ctx) {
    const ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.dataset.key = ctx.key;
    ov.dataset.mode = "single";
    ov.dataset.filtered = String(ctx.statusFiltered);
    Object.assign(ov.style, { position: "fixed", zIndex: "2147483646", top: "0", left: "0", pointerEvents: "none" });

    function mkGroup(side) {
      const g = document.createElement("div");
      g.dataset.side = side;
      Object.assign(g.style, {
        position: "fixed", transform: "translate(-50%, -50%)", display: "flex",
        gap: "6px", alignItems: "center", pointerEvents: "none",
      });
      const arrow = document.createElement("span");
      arrow.textContent = side === "before" ? "▲" : "▼";
      Object.assign(arrow.style, { color: "#555", fontSize: "9px", textShadow: "0 1px 2px rgba(255,255,255,.8)" });
      const many = mkPillBtn("Add Segments", "#2f6feb", ctx.statusFiltered);
      if (!ctx.statusFiltered) {
        const where = side === "before" ? "before (above)" : "after (below)";
        many.title = `Add one or more segments ${where} this one`;
        many.addEventListener("click", (e) => { e.stopPropagation(); openInsertForm(insertCtx(ctx, side)); });
      }
      g.append(arrow, many);
      return g;
    }
    if (ctx.roomBefore) ov.appendChild(mkGroup("before"));
    if (ctx.roomAfter) ov.appendChild(mkGroup("after"));
    return ov;
  }

  // Build the insert-form context for a side from the single-selection ctx.
  // outerLimit is how far the window MAY extend on the open side (the neighbour
  // or midnight); the form chooses between the anchor's original edge and that.
  function insertCtx(ctx, side) {
    return {
      employeeId: ctx.employeeId,
      employeeName: ctx.employeeName,
      side,
      anchor: ctx.anchor,
      outerLimit: side === "before" ? ctx.beforeLower : ctx.afterUpper,
    };
  }

  function positionOverlay() {
    const ov = document.getElementById(OVERLAY_ID);
    if (!ov) return;
    if (ov.dataset.mode === "single") return positionSingleOverlay(ov);
    const pair = selectedPair();
    if (!pair) { ov.style.display = "none"; return; }
    const rects = pair.rows.map((r) => r.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    const boundaryY = (rects[0].bottom + rects[1].top) / 2;
    const rv = pair.content.closest(".dx-datagrid-rowsview") || pair.content;
    const rvRect = rv.getBoundingClientRect();
    // Hide when the boundary is scrolled outside the visible rows area.
    if (boundaryY < rvRect.top + 3 || boundaryY > rvRect.bottom - 3) { ov.style.display = "none"; return; }
    ov.style.display = "flex";
    ov.style.top = boundaryY + "px";
    ov.style.left = rvRect.left + rvRect.width / 2 + "px";
  }

  function positionSingleOverlay(ov) {
    const sr = selectedSingleRow();
    if (!sr) { ov.style.display = "none"; return; }
    ov.style.display = "block";
    const rect = sr.row.getBoundingClientRect();
    const rv = sr.content.closest(".dx-datagrid-rowsview") || sr.content;
    const rvRect = rv.getBoundingClientRect();
    const cx = rvRect.left + rvRect.width / 2;
    for (const g of ov.children) {
      const y = g.dataset.side === "before" ? rect.top : rect.bottom;
      const visible = y > rvRect.top + 3 && y < rvRect.bottom - 3;
      g.style.display = visible ? "flex" : "none";
      g.style.top = y + "px";
      g.style.left = cx + "px";
    }
  }

  // ---- filterable combobox ----------------------------------------------------
  // A type-to-filter picker (native <select> can't filter). The dropdown is
  // appended to <body> with fixed positioning so it never gets clipped by the
  // modal's own scroll. Only one dropdown is open at a time. A required combo
  // with nothing chosen shows a red border/tint so the user sees what's left to
  // fill. Free text is not accepted — on blur the input reverts to the choice.
  let openComboClose = null;
  function mkCombo({ placeholder = "Select…", width, required = false } = {}) {
    let items = [];          // current options
    let loading = false;     // true while awaiting data
    let selectedId = "", selectedName = "";
    let onChangeFn = null, onValidityFn = null;
    let listEl = null, highlight = -1;

    const wrap = document.createElement("div");
    Object.assign(wrap.style, { position: "relative", width: width || "100%" });
    const input = document.createElement("input");
    input.type = "text"; input.autocomplete = "off"; input.placeholder = placeholder;
    Object.assign(input.style, {
      width: "100%", boxSizing: "border-box", padding: "6px 8px", border: "1px solid #ccc",
      borderRadius: "6px", font: "13px -apple-system, system-ui, sans-serif", background: "#fff",
    });
    wrap.appendChild(input);

    function paint() {
      const bad = required && !selectedId && !input.disabled;
      input.style.borderColor = bad ? "#e23b3b" : "#ccc";
      input.style.background = input.disabled ? "#f3f3f3" : bad ? "#fff6f6" : "#fff";
    }
    function filtered() {
      const q = input.value.trim().toLowerCase();
      if (!q || q === selectedName.toLowerCase()) return items;
      return items.filter((it) => it.name.toLowerCase().includes(q));
    }
    function reposition() {
      if (!listEl) return;
      const r = input.getBoundingClientRect();
      // Grow to fit the longest option (work-order names run long), but never
      // narrower than the field and never past the viewport edges.
      listEl.style.minWidth = r.width + "px";
      listEl.style.top = r.bottom + 2 + "px";
      const w = listEl.offsetWidth;
      let left = r.left;
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
      listEl.style.left = left + "px";
    }
    function onDocDown(e) {
      if (wrap.contains(e.target) || (listEl && listEl.contains(e.target))) return;
      closeList();
    }
    function closeList() {
      if (listEl) { listEl.remove(); listEl = null; }
      highlight = -1;
      if (openComboClose === closeList) openComboClose = null;
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDocDown, true);
    }
    function paintHighlight() {
      if (!listEl) return;
      [...listEl.children].forEach((c, i) => { c.style.background = i === highlight ? "#eef3ff" : ""; });
    }
    function renderList() {
      if (!listEl) return;
      listEl.innerHTML = "";
      const opts = filtered();
      if (!opts.length) {
        const empty = document.createElement("div");
        empty.textContent = loading ? "Loading…" : "No matches";
        Object.assign(empty.style, { padding: "8px 10px", color: "#888" });
        listEl.appendChild(empty);
        return;
      }
      opts.forEach((it, i) => {
        const row = document.createElement("div");
        row.textContent = it.name;
        Object.assign(row.style, {
          padding: "7px 10px", cursor: "pointer", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
          background: i === highlight ? "#eef3ff" : "", fontWeight: it.id === selectedId ? "600" : "400",
        });
        row.addEventListener("mouseenter", () => { highlight = i; paintHighlight(); });
        row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(it); });
        listEl.appendChild(row);
      });
    }
    function openList() {
      if (input.disabled) return;
      if (openComboClose && openComboClose !== closeList) openComboClose();
      if (!listEl) {
        listEl = document.createElement("div");
        Object.assign(listEl.style, {
          position: "fixed", zIndex: "2147483647", background: "#fff", border: "1px solid #ccc",
          borderRadius: "6px", boxShadow: "0 6px 20px rgba(0,0,0,.18)", maxHeight: "220px",
          overflowY: "auto", width: "max-content", maxWidth: "min(620px, 92vw)",
          font: "13px -apple-system, system-ui, sans-serif",
        });
        document.body.appendChild(listEl);
        openComboClose = closeList;
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", reposition);
        document.addEventListener("mousedown", onDocDown, true);
      }
      renderList(); reposition();
    }
    function choose(it) {
      const changed = it.id !== selectedId;
      selectedId = it.id; selectedName = it.name; input.value = it.name;
      closeList(); paint();
      if (changed && onChangeFn) onChangeFn(selectedId, selectedName);
      if (onValidityFn) onValidityFn();
    }

    input.addEventListener("focus", () => { input.select(); openList(); });
    input.addEventListener("click", () => openList());
    input.addEventListener("input", () => { highlight = -1; openList(); renderList(); });
    input.addEventListener("blur", () => setTimeout(() => { input.value = selectedName; paint(); }, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!listEl) return openList();
        const n = filtered().length; if (!n) return;
        highlight = e.key === "ArrowDown" ? (highlight + 1) % n : (highlight - 1 + n) % n;
        paintHighlight();
        const el = listEl.children[highlight]; if (el) el.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        const opts = filtered();
        if (listEl && highlight >= 0 && opts[highlight]) { e.preventDefault(); choose(opts[highlight]); }
      } else if (e.key === "Escape") {
        if (listEl) { e.preventDefault(); input.value = selectedName; closeList(); }
      }
    });
    paint();

    return {
      el: wrap,
      loadingState(msg) { loading = true; items = []; selectedId = selectedName = ""; input.value = ""; input.disabled = true; input.placeholder = msg || "Loading…"; paint(); if (listEl) renderList(); },
      blocked(msg) { loading = false; items = []; selectedId = selectedName = ""; input.value = ""; input.disabled = true; input.placeholder = msg || placeholder; paint(); closeList(); },
      ready(next) { loading = false; items = Array.isArray(next) ? next : []; input.disabled = false; input.placeholder = placeholder; paint(); if (listEl) renderList(); },
      clear() { selectedId = selectedName = ""; input.value = ""; paint(); if (listEl) renderList(); if (onValidityFn) onValidityFn(); },
      getValue: () => selectedId,
      getName: () => selectedName,
      setRequired(r) { required = r; paint(); },
      onChange(fn) { onChangeFn = fn; },
      onValidity(fn) { onValidityFn = fn; },
      focusInput() { input.focus(); },
    };
  }

  // ---- time input (quick picker + loose free-text) ----------------------------
  // Type "4a", "430pm", "4:32p", "16:00" — or pick a quarter-hour from the
  // dropdown. AM/PM is resolved from getBounds() when omitted. A required input
  // with no value shows red. `getBounds()` returns { min, max } (absolute ms) and
  // drives both the suggestion list and the AM/PM context; it's read live so the
  // allowed window can depend on neighbouring segments.
  function mkTimeInput({ dayStart, getBounds, required = false, width } = {}) {
    let valueMs = null, onChangeFn = null, onValidityFn = null;
    let listEl = null, highlight = -1;

    const wrap = document.createElement("div");
    Object.assign(wrap.style, { position: "relative", width: width || "120px" });
    const input = document.createElement("input");
    input.type = "text"; input.autocomplete = "off"; input.placeholder = "– : –";
    Object.assign(input.style, {
      width: "100%", boxSizing: "border-box", padding: "6px 8px", border: "1px solid #ccc",
      borderRadius: "6px", font: "13px -apple-system, system-ui, sans-serif", background: "#fff", textAlign: "center",
    });
    wrap.appendChild(input);

    function paint() {
      const bad = required && valueMs == null;
      input.style.borderColor = bad ? "#e23b3b" : "#ccc";
      input.style.background = bad ? "#fff6f6" : "#fff";
    }
    function bounds() { try { return getBounds ? getBounds() : {}; } catch (e) { return {}; } }
    function options() {
      const b = bounds();
      let lo = b.min != null ? b.min : (dayStart);
      let hi = b.max != null ? b.max : (dayStart + 24 * HOUR_MS);
      // snap lo up to the next quarter hour, list through hi inclusive
      const q = 15 * MIN_MS;
      let start = Math.ceil(lo / q) * q;
      const out = [];
      for (let t = start; t <= hi && out.length < 200; t += q) out.push(t);
      // ensure current value is offered even if off-grid
      if (valueMs != null && !out.includes(valueMs)) out.push(valueMs);
      out.sort((a, b2) => a - b2);
      return out;
    }
    function reposition() {
      if (!listEl) return;
      const r = input.getBoundingClientRect();
      listEl.style.minWidth = r.width + "px";
      listEl.style.top = r.bottom + 2 + "px";
      const w = listEl.offsetWidth;
      let left = r.left;
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
      listEl.style.left = left + "px";
    }
    function onDocDown(e) {
      if (wrap.contains(e.target) || (listEl && listEl.contains(e.target))) return;
      closeList();
    }
    function closeList() {
      if (listEl) { listEl.remove(); listEl = null; }
      highlight = -1;
      if (openComboClose === closeList) openComboClose = null;
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDocDown, true);
    }
    function filtered() {
      const q = input.value.trim().toLowerCase();
      const all = options();
      if (!q) return all;
      // match on the formatted label loosely (strip spaces/colon/meridiem dots)
      const norm = (x) => x.toLowerCase().replace(/[\s:]/g, "");
      return all.filter((t) => norm(fmtTime(t)).includes(norm(q)));
    }
    function renderList() {
      if (!listEl) return;
      listEl.innerHTML = "";
      const opts = filtered();
      if (!opts.length) {
        const e = document.createElement("div");
        e.textContent = "Type a time, e.g. 4:30pm";
        Object.assign(e.style, { padding: "8px 10px", color: "#888" });
        listEl.appendChild(e);
        return;
      }
      opts.forEach((t, i) => {
        const row = document.createElement("div");
        row.textContent = fmtTime(t);
        Object.assign(row.style, {
          padding: "6px 12px", cursor: "pointer", whiteSpace: "nowrap", textAlign: "center",
          background: i === highlight ? "#eef3ff" : "", fontWeight: t === valueMs ? "600" : "400",
        });
        row.addEventListener("mouseenter", () => { highlight = i; paintHighlight(); });
        row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(t); });
        listEl.appendChild(row);
      });
    }
    function paintHighlight() {
      if (!listEl) return;
      [...listEl.children].forEach((c, i) => { c.style.background = i === highlight ? "#eef3ff" : ""; });
    }
    function openList() {
      if (input.disabled) return;
      if (openComboClose && openComboClose !== closeList) openComboClose();
      if (!listEl) {
        listEl = document.createElement("div");
        Object.assign(listEl.style, {
          position: "fixed", zIndex: "2147483647", background: "#fff", border: "1px solid #ccc",
          borderRadius: "6px", boxShadow: "0 6px 20px rgba(0,0,0,.18)", maxHeight: "240px",
          overflowY: "auto", width: "max-content", font: "13px -apple-system, system-ui, sans-serif",
        });
        document.body.appendChild(listEl);
        openComboClose = closeList;
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", reposition);
        document.addEventListener("mousedown", onDocDown, true);
      }
      // highlight the option nearest the current value
      renderList(); reposition();
    }
    function setValue(ms, fire) {
      valueMs = ms == null ? null : ms;
      input.value = valueMs == null ? "" : fmtTime(valueMs);
      paint();
      if (fire && onChangeFn) onChangeFn(valueMs);
      if (onValidityFn) onValidityFn();
    }
    function choose(t) { setValue(t, true); closeList(); }
    function commitText() {
      const b = bounds();
      const ms = parseTime(input.value, dayStart, b.min, b.max);
      if (ms == null) { input.value = valueMs == null ? "" : fmtTime(valueMs); paint(); return; }
      setValue(ms, true);
    }

    input.addEventListener("focus", () => { input.select(); openList(); });
    input.addEventListener("click", () => openList());
    input.addEventListener("input", () => { highlight = -1; openList(); renderList(); });
    input.addEventListener("blur", () => setTimeout(commitText, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!listEl) return openList();
        const n = filtered().length; if (!n) return;
        highlight = e.key === "ArrowDown" ? (highlight + 1) % n : (highlight - 1 + n) % n;
        paintHighlight();
        const el = listEl.children[highlight]; if (el) el.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opts = filtered();
        if (listEl && highlight >= 0 && opts[highlight] != null) choose(opts[highlight]);
        else commitText();
        closeList();
      } else if (e.key === "Escape") {
        if (listEl) { e.preventDefault(); input.value = valueMs == null ? "" : fmtTime(valueMs); closeList(); }
      }
    });
    paint();

    return {
      el: wrap,
      getMs: () => valueMs,
      setMs(ms) { setValue(ms, false); },
      setRequired(r) { required = r; paint(); },
      onChange(fn) { onChangeFn = fn; },
      onValidity(fn) { onValidityFn = fn; },
      focusInput() { input.focus(); },
    };
  }

  // ---- allocation picker (Generic labor item OR Job → Work Order → Activity) --
  // Every segment needs an allocation. `getAlloc()` returns the shape
  // createSegments expects, or null when incomplete; `isValid()` mirrors that.
  // Red combos mark what's still required. Data loads lazily (cached) so the
  // modal opens instantly.
  function mkAllocationPicker({ showToggle = true, mode = "generic" } = {}) {
    let onValidityFn = null;
    const fire = () => { if (onValidityFn) onValidityFn(); };

    const el = document.createElement("div");

    // Mode toggle (segmented): Generic | Job
    const toggle = document.createElement("div");
    Object.assign(toggle.style, { display: showToggle ? "inline-flex" : "none", border: "1px solid #ccd", borderRadius: "7px", overflow: "hidden", marginBottom: "10px" });
    function mkSeg(label, val) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.dataset.mode = val;
      Object.assign(b.style, { padding: "5px 14px", border: "none", background: "#fff", cursor: "pointer", font: "13px -apple-system, system-ui, sans-serif", fontWeight: "600", color: "#555" });
      b.addEventListener("click", () => setMode(val));
      return b;
    }
    const segGeneric = mkSeg("Generic", "generic");
    const segJob = mkSeg("Job", "job");
    segJob.style.borderLeft = "1px solid #ccd";
    toggle.append(segGeneric, segJob);

    // Generic section: one labor-item combo.
    const genWrap = document.createElement("div");
    const genCombo = mkCombo({ placeholder: "Select activity…", required: true });
    genWrap.appendChild(labeled("Activity", genCombo.el));

    // Job section: Job → Work Order → Activity.
    const jobWrap = document.createElement("div");
    const projCombo = mkCombo({ placeholder: "Select job…", required: true });
    const woCombo = mkCombo({ placeholder: "Select a job first", required: true });
    const actCombo = mkCombo({ placeholder: "Select activity…", required: true });
    woCombo.blocked("Select a job first");
    jobWrap.append(labeled("Job", projCombo.el), labeled("Work order", woCombo.el), labeled("Activity", actCombo.el));

    [genCombo, projCombo, woCombo, actCombo].forEach((c) => c.onValidity(fire));
    projCombo.onChange((projectId) => {
      woCombo.loadingState("Loading work orders…");
      fire();
      getWorkOrders(projectId).then((wos) => { woCombo.ready(wos); fire(); });
    });

    el.append(toggle, genWrap, jobWrap);

    function setMode(m) {
      mode = m === "job" ? "job" : "generic";
      genWrap.style.display = mode === "generic" ? "block" : "none";
      jobWrap.style.display = mode === "job" ? "block" : "none";
      for (const b of [segGeneric, segJob]) {
        const on = b.dataset.mode === mode;
        b.style.background = on ? "#1a56db" : "#fff";
        b.style.color = on ? "#fff" : "#555";
      }
      fire();
    }
    setMode(mode);

    // Kick off the lazy loads once (cached across opens).
    getLaborItems().then((items) => genCombo.ready(items));
    getProjects().then((items) => projCombo.ready(items));
    getActivities().then((items) => actCombo.ready(items));
    genCombo.loadingState("Loading activities…");
    projCombo.loadingState("Loading jobs…");
    actCombo.loadingState("Loading activities…");

    return {
      el,
      setMode,
      onValidity(fn) { onValidityFn = fn; },
      isValid() {
        if (mode === "generic") return !!genCombo.getValue();
        return !!(projCombo.getValue() && woCombo.getValue() && actCombo.getValue());
      },
      getAlloc() {
        if (mode === "generic") {
          const id = genCombo.getValue();
          return id ? { kind: "generic", laborItemId: id } : null;
        }
        const woId = woCombo.getValue(), actId = actCombo.getValue();
        return woId && actId ? { kind: "job", workOrderId: woId, activityId: actId } : null;
      },
    };
  }

  // A small labeled field block (label above the control).
  function labeled(text, controlEl) {
    const block = document.createElement("div");
    block.style.marginBottom = "10px";
    const lab = document.createElement("div");
    lab.textContent = text;
    Object.assign(lab.style, { color: "#555", fontSize: "12px", fontWeight: "600", marginBottom: "4px" });
    block.append(lab, controlEl);
    return block;
  }

  function modalOverlay() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,.45)", zIndex: "2147483647",
      display: "flex", alignItems: "center", justifyContent: "center", font: "14px -apple-system, system-ui, sans-serif",
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#fff", color: "#1a1a1a", borderRadius: "10px", padding: "18px 20px",
      width: "440px", maxWidth: "92vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,.3)",
    });
    overlay.appendChild(card);
    return { overlay, card };
  }

  // A small confirmation dialog listing exactly what will change to EXISTING
  // entries (resize / note). Stacks on top of the form modal. Resolves true on
  // confirm, false on cancel/backdrop. Used before any save that edits an entry.
  function confirmDialog(title, lines) {
    return new Promise((resolve) => {
      const { overlay, card } = modalOverlay();
      card.style.width = "460px";
      const h = document.createElement("div"); h.textContent = title;
      Object.assign(h.style, { fontWeight: "700", fontSize: "15px", marginBottom: "10px" });
      const body = document.createElement("div");
      Object.assign(body.style, { fontSize: "13px", color: "#333", lineHeight: "1.5" });
      lines.forEach((l) => { const d = document.createElement("div"); d.textContent = "• " + l; d.style.marginBottom = "4px"; body.appendChild(d); });
      const btns = document.createElement("div");
      Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" });
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
      Object.assign(cancel.style, { padding: "8px 14px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f3f3", cursor: "pointer", fontWeight: "600" });
      const ok = document.createElement("button"); ok.type = "button"; ok.textContent = "Confirm & save";
      Object.assign(ok.style, { padding: "8px 14px", borderRadius: "6px", border: "none", background: "#1a56db", color: "#fff", fontWeight: "600", cursor: "pointer" });
      let done = false;
      const finish = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
      cancel.addEventListener("click", () => finish(false));
      ok.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
      btns.append(cancel, ok); card.append(h, body, btns);
      document.body.appendChild(overlay);
    });
  }

  // One gap-filling segment: choose the allocation (generic activity, or
  // Job → Work Order → Activity), then create it. Opens instantly; lists fill in.
  function openSingleForm(ctx) {
    const totalH = round2((ctx.gapEnd - ctx.gapStart) / HOUR_MS).toFixed(2);
    const { overlay, card } = modalOverlay();

    const h = document.createElement("div"); h.textContent = "Add segment";
    Object.assign(h.style, { fontWeight: "700", fontSize: "16px", marginBottom: "2px" });
    const sub = document.createElement("div"); sub.textContent = `${ctx.employeeName} · ${totalH} h`;
    Object.assign(sub.style, { color: "#666", marginBottom: "14px", fontSize: "12.5px" });

    const picker = mkAllocationPicker({ showToggle: true });

    const btns = document.createElement("div");
    Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" });
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
    Object.assign(cancel.style, { padding: "8px 14px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f3f3", cursor: "pointer", fontWeight: "600" });
    const create = document.createElement("button"); create.type = "button"; create.textContent = "Create segment";
    Object.assign(create.style, { padding: "8px 14px", borderRadius: "6px", border: "none", background: "#1f9d57", color: "#fff", fontWeight: "600", cursor: "pointer" });
    const sync = () => { const ok = picker.isValid(); create.disabled = !ok; create.style.opacity = ok ? "1" : "0.5"; create.style.cursor = ok ? "pointer" : "default"; };
    picker.onValidity(sync); sync();

    cancel.addEventListener("click", () => overlay.remove());
    create.addEventListener("click", async () => {
      const alloc = picker.getAlloc();
      if (!alloc) return;
      create.disabled = true; create.textContent = "Creating…";
      const res = await createSegments(ctx.employeeId, [
        { startIso: toIso(ctx.gapStart), endIso: toIso(ctx.gapEnd), alloc },
      ]);
      overlay.remove();
      const ok = res.created && !res.failed;
      banner(ok, ok ? `Added 1 segment for ${ctx.employeeName}.` : `Couldn't add segment: ${res.firstError || "unknown error"}`);
      refreshGrid();
    });

    btns.append(cancel, create);
    card.append(h, sub, picker.el, btns);
    document.body.appendChild(overlay);
  }

  // ---- Split form -------------------------------------------------------------
  // Divide the gap [winStart, winEnd] into several segments. Two layouts:
  //   • By hours — decimal hours, contiguous, must sum to the gap (even split by
  //     default, live recalc).
  //   • By time  — explicit Start/End per segment. Start auto-chains from the
  //     previous End (drag a boundary and the next follows); leaving a gap
  //     between two segments records an unpaid break (not an entry) and stamps
  //     "<duration> unpaid break auto-entered after this segment" on the segment
  //     before it.
  // Each segment picks its own allocation (Generic or Job → WO → Activity).
  function openSplitForm(ctx) {
    const winStart = ctx.gapStart, winEnd = ctx.gapEnd;
    const totalH = round2((winEnd - winStart) / HOUR_MS);
    const dStart = dayStartMs(winStart);
    let timeMode = false;

    function makeSplit() {
      const picker = mkAllocationPicker({ showToggle: true });
      picker.onValidity(renderFooter);
      return { hours: null, locked: false, startMs: null, endMs: null, picker };
    }
    let splits = [];

    const { overlay, card } = modalOverlay();
    card.style.width = "560px";

    const h = document.createElement("div");
    h.textContent = "Split the gap into segments";
    Object.assign(h.style, { fontWeight: "700", fontSize: "16px", marginBottom: "2px" });
    const sub = document.createElement("div");
    Object.assign(sub.style, { color: "#666", marginBottom: "12px", fontSize: "12.5px" });
    function setSub() {
      sub.textContent = timeMode
        ? `${ctx.employeeName} · ${fmtTime(winStart)} – ${fmtTime(winEnd)} (${totalH.toFixed(2)} h)`
        : `${ctx.employeeName} · ${totalH.toFixed(2)} h to divide`;
    }

    // By hours | By time toggle.
    const modeRow = document.createElement("div");
    Object.assign(modeRow.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" });
    const modeLbl = document.createElement("span"); modeLbl.textContent = "Split:";
    Object.assign(modeLbl.style, { color: "#555", fontSize: "12.5px", fontWeight: "600" });
    const modeToggle = document.createElement("div");
    Object.assign(modeToggle.style, { display: "inline-flex", border: "1px solid #ccd", borderRadius: "7px", overflow: "hidden" });
    function mkModeSeg(label, val) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.dataset.m = val;
      Object.assign(b.style, { padding: "5px 14px", border: "none", background: "#fff", cursor: "pointer", font: "13px -apple-system, system-ui, sans-serif", fontWeight: "600", color: "#555" });
      b.addEventListener("click", () => setTimeMode(val === "time"));
      return b;
    }
    const segHours = mkModeSeg("By hours", "hours");
    const segTime = mkModeSeg("By time", "time");
    segTime.style.borderLeft = "1px solid #ccd";
    modeToggle.append(segHours, segTime);
    modeRow.append(modeLbl, modeToggle);

    const list = document.createElement("div");
    const addRow = document.createElement("button");
    const remaining = document.createElement("div");
    const btns = document.createElement("div");
    const cancel = document.createElement("button");
    const create = document.createElement("button");

    // ---- hours mode: even split across the unlocked rows ----
    function recalc() {
      const lockedSum = splits.filter((s) => s.locked).reduce((a, s) => a + (s.hours || 0), 0);
      const unlocked = splits.filter((s) => !s.locked);
      if (unlocked.length) {
        const each = round2(Math.max(0, totalH - lockedSum) / unlocked.length);
        unlocked.forEach((s) => (s.hours = each));
      }
    }
    const allocatedH = () => round2(splits.reduce((a, s) => a + (s.hours || 0), 0));

    function setTimeMode(on) {
      if (on === timeMode) return;
      if (on) {
        // Hours → contiguous times from winStart.
        let cur = winStart;
        splits.forEach((s) => { s.startMs = cur; s.endMs = Math.min(winEnd, cur + Math.round((s.hours || 0) * HOUR_MS)); cur = s.endMs; });
      } else {
        // Times → hours (breaks collapse; hours mode is always contiguous).
        splits.forEach((s) => { if (s.startMs != null && s.endMs != null) { s.hours = round2((s.endMs - s.startMs) / HOUR_MS); s.locked = true; } });
      }
      timeMode = on;
      for (const b of [segHours, segTime]) {
        const active = (b.dataset.m === "time") === timeMode;
        b.style.background = active ? "#1a56db" : "#fff";
        b.style.color = active ? "#fff" : "#555";
      }
      setSub();
      render();
    }

    // ---- full rebuild (add/remove/time edit); picker.el is reused ----
    function render() {
      if (openComboClose) openComboClose();
      list.innerHTML = "";
      splits.forEach((s, i) => {
        const cardRow = document.createElement("div");
        Object.assign(cardRow.style, { border: "1px solid #eee", borderRadius: "8px", padding: "10px 12px", marginBottom: "10px", background: "#fcfcfd" });
        const head = document.createElement("div");
        Object.assign(head.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" });
        const lbl = document.createElement("span");
        lbl.textContent = `${i + 1}.`;
        Object.assign(lbl.style, { width: "18px", color: "#444", fontWeight: "600" });
        head.appendChild(lbl);

        if (!timeMode) {
          const inp = document.createElement("input");
          inp.type = "number"; inp.min = "0"; inp.step = "0.01";
          inp.value = s.hours == null ? "" : String(s.hours);
          Object.assign(inp.style, { width: "72px", padding: "5px 7px", border: "1px solid #ccc", borderRadius: "6px", font: "13px inherit" });
          inp.addEventListener("input", (e) => {
            const v = parseFloat(e.target.value);
            s.hours = Number.isFinite(v) ? v : 0;
            s.locked = e.target.value.trim() !== "";
            recalc();
            renderFooter(true);
          });
          const unit = document.createElement("span"); unit.textContent = "h"; unit.style.color = "#777";
          head.append(inp, unit);
        } else {
          const startIn = mkTimeInput({
            dayStart: dStart, required: true, width: "104px",
            getBounds: () => ({ min: i > 0 ? splits[i - 1].endMs : winStart, max: s.endMs != null ? s.endMs : winEnd }),
          });
          startIn.setMs(s.startMs);
          startIn.onChange((ms) => {
            s.startMs = ms == null ? null : Math.max(winStart, ms);
            if (i > 0 && s.startMs != null && splits[i - 1].endMs > s.startMs) splits[i - 1].endMs = s.startMs; // avoid overlap behind
            render();
          });
          const arrow = document.createElement("span"); arrow.textContent = "→"; arrow.style.color = "#999";
          const endIn = mkTimeInput({
            dayStart: dStart, required: true, width: "104px",
            getBounds: () => ({ min: s.startMs != null ? s.startMs : (i > 0 ? splits[i - 1].endMs : winStart), max: i < splits.length - 1 ? splits[i + 1].startMs : winEnd }),
          });
          endIn.setMs(s.endMs);
          endIn.onChange((ms) => {
            const old = s.endMs;
            s.endMs = ms == null ? null : Math.min(winEnd, ms);
            if (i < splits.length - 1 && s.endMs != null) {
              if (splits[i + 1].startMs === old) splits[i + 1].startMs = s.endMs;      // drag the shared boundary
              else if (s.endMs > splits[i + 1].startMs) s.endMs = splits[i + 1].startMs; // clamp overlap ahead
            }
            render();
          });
          const dur = document.createElement("span");
          const d = s.startMs != null && s.endMs != null ? s.endMs - s.startMs : 0;
          dur.textContent = d > 0 ? fmtDuration(d) : "—";
          Object.assign(dur.style, { color: d > 0 ? "#555" : "#c62828", fontSize: "12px", minWidth: "64px" });
          head.append(startIn.el, arrow, endIn.el, dur);
        }

        const spacer = document.createElement("span"); spacer.style.flex = "1";
        const del = document.createElement("button");
        del.type = "button"; del.textContent = "✕"; del.title = "Remove segment";
        Object.assign(del.style, { border: "none", background: "transparent", color: "#c62828", cursor: "pointer", fontSize: "15px" });
        del.disabled = splits.length <= 1;
        del.style.opacity = splits.length <= 1 ? "0.4" : "1";
        del.addEventListener("click", () => { splits.splice(i, 1); if (!timeMode) recalc(); render(); });
        head.append(spacer, del);

        cardRow.append(head, s.picker.el);
        list.appendChild(cardRow);

        // Break chip (time mode): gap between this segment and the next boundary.
        if (timeMode && s.endMs != null) {
          const nextB = i < splits.length - 1 ? splits[i + 1].startMs : winEnd;
          const gap = (nextB != null ? nextB : winEnd) - s.endMs;
          if (isBreak(gap)) {
            const chip = document.createElement("div");
            chip.textContent = `⏸ ${fmtDuration(gap)} unpaid break`;
            Object.assign(chip.style, { margin: "-4px 0 10px 4px", color: "#8a6d3b", fontSize: "12px", fontWeight: "600" });
            list.appendChild(chip);
          }
        }
      });
      renderFooter();
    }

    // Footer + validity; `keepFocus` avoids reassigning the number input mid-type.
    function renderFooter(keepFocus) {
      if (!timeMode && !keepFocus) {
        const inputs = list.querySelectorAll('input[type="number"]');
        splits.forEach((s, i) => { const inp = inputs[i]; if (inp && document.activeElement !== inp) inp.value = s.hours == null ? "" : String(s.hours); });
      }
      let ok, text, color;
      if (!timeMode) {
        const a = allocatedH();
        ok = Math.abs(a - totalH) < 0.005 && splits.every((s) => (s.hours || 0) > 0 && s.picker.isValid());
        text = `Allocated ${a.toFixed(2)} / ${totalH.toFixed(2)} h`;
        color = ok ? "#2e7d32" : "#c62828";
      } else {
        const timesOk = splits.every((s, i) =>
          s.startMs != null && s.endMs != null && s.startMs >= winStart && s.endMs <= winEnd &&
          s.startMs < s.endMs && (i === 0 || splits[i - 1].endMs <= s.startMs));
        ok = timesOk && splits.every((s) => s.picker.isValid());
        const logged = splits.reduce((a, s) => a + (s.startMs != null && s.endMs != null ? Math.max(0, s.endMs - s.startMs) : 0), 0);
        // Sum only qualifying breaks (gaps 1 min–2 h); a longer gap is off-shift
        // time, not a break.
        let brk = 0, cursor = winStart;
        splits.forEach((s) => {
          if (s.startMs != null) { const g = s.startMs - cursor; if (isBreak(g)) brk += g; }
          if (s.endMs != null) cursor = s.endMs;
        });
        const tail = winEnd - cursor; if (isBreak(tail)) brk += tail;
        text = `Logged ${fmtDuration(logged)}` + (brk >= MIN_MS ? ` · ${fmtDuration(brk)} break` : "") + ` · window ${fmtDuration(winEnd - winStart)}`;
        if (!timesOk) { text = "Fix the times: each must be within the gap, in order, and end after start."; color = "#c62828"; }
        else color = "#555";
      }
      remaining.textContent = text;
      remaining.style.color = color;
      create.disabled = !ok;
      create.style.opacity = ok ? "1" : "0.5";
      create.style.cursor = ok ? "pointer" : "default";
    }

    addRow.type = "button";
    addRow.textContent = "+ Add segment";
    Object.assign(addRow.style, { padding: "6px 10px", border: "1px dashed #aaa", borderRadius: "6px", background: "#fafafa", cursor: "pointer", fontSize: "13px" });
    addRow.addEventListener("click", () => {
      const s = makeSplit();
      if (timeMode) {
        const last = splits[splits.length - 1];
        s.startMs = last && last.endMs != null ? last.endMs : winStart;
        s.endMs = winEnd > s.startMs ? winEnd : s.startMs;
      }
      splits.push(s);
      if (!timeMode) recalc();
      render();
    });

    Object.assign(remaining.style, { marginTop: "12px", fontWeight: "600", fontSize: "13px" });

    Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" });
    cancel.type = "button"; cancel.textContent = "Cancel";
    Object.assign(cancel.style, { padding: "8px 14px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f3f3", cursor: "pointer", fontWeight: "600" });
    cancel.addEventListener("click", () => overlay.remove());
    create.type = "button"; create.textContent = "Create segments";
    Object.assign(create.style, { padding: "8px 14px", borderRadius: "6px", border: "none", background: "#1a56db", color: "#fff", fontWeight: "600" });
    create.addEventListener("click", async () => {
      const items = [];
      // Leading break: a gap between the earlier existing segment and the first
      // new one. Its "prior" segment is that existing entry, so the note goes on
      // it (an edit) — only possible in time mode and when we know the earlier id.
      let leadingNote = "";
      if (timeMode && ctx.earlier && splits.length) {
        const lead = splits[0].startMs - winStart;
        if (isBreak(lead)) leadingNote = `${fmtDuration(lead)} unpaid break auto-entered after this segment`;
      }

      if (leadingNote) {
        const okGo = await confirmDialog("Confirm change to existing time", [
          `A break note will be added to the earlier segment (above): "${leadingNote}".`,
          `${splits.length} new segment${splits.length === 1 ? "" : "s"} will be created.`,
        ]);
        if (!okGo) return;
      }

      create.disabled = true; create.textContent = "Creating…";
      if (!timeMode) {
        // Contiguous ranges; the last ends exactly at winEnd to avoid drift.
        let cursor = winStart;
        splits.forEach((s, i) => {
          const end = i === splits.length - 1 ? winEnd : cursor + Math.round((s.hours || 0) * HOUR_MS);
          items.push({ startIso: toIso(cursor), endIso: toIso(end), alloc: s.picker.getAlloc() });
          cursor = end;
        });
      } else {
        splits.forEach((s, i) => {
          const nextB = i < splits.length - 1 ? splits[i + 1].startMs : winEnd;
          const gap = (nextB != null ? nextB : winEnd) - s.endMs;
          const note = isBreak(gap) ? `${fmtDuration(gap)} unpaid break auto-entered after this segment` : "";
          items.push({ startIso: toIso(s.startMs), endIso: toIso(s.endMs), alloc: s.picker.getAlloc(), note });
        });
      }
      const res = await createSegments(ctx.employeeId, items);
      // Stamp the leading break on the earlier existing segment (time unchanged).
      let leadErr = "";
      if (leadingNote) {
        const dto = await loadEditDto(ctx.employeeId, ctx.earlier.id);
        if (dto && dto.Activity) {
          const note = (dto.Note ? dto.Note + " · " : "") + leadingNote;
          const er = await editSegmentTime(ctx.employeeId, dto, toIso(ctx.earlier.startMs), toIso(ctx.earlier.endMs), note);
          if (!er.ok) leadErr = er.error;
        } else { leadErr = "couldn't load the earlier segment"; }
      }
      overlay.remove();
      if (res.created && !res.failed && !leadErr) {
        banner(true, `Added ${res.created} segment${res.created === 1 ? "" : "s"} for ${ctx.employeeName}.`);
      } else {
        const parts = [];
        if (res.created) parts.push(`added ${res.created}`);
        if (res.failed) parts.push(`${res.failed} failed: ${res.firstError}`);
        if (leadErr) parts.push(`break note not added: ${leadErr}`);
        banner(false, parts.join("; ") || "Couldn't add segments.");
      }
      refreshGrid();
    });

    // Start with two even splits (hours mode).
    splits = [makeSplit(), makeSplit()];
    recalc();
    setTimeMode(false);
    for (const b of [segHours, segTime]) { const active = (b.dataset.m === "time") === timeMode; b.style.background = active ? "#1a56db" : "#fff"; b.style.color = active ? "#fff" : "#555"; }
    setSub();
    render();
    btns.append(cancel, create);
    card.append(h, sub, modeRow, list, addRow, remaining, btns);
    document.body.appendChild(overlay);
  }

  // ---- Insert form (before/after a single selected segment) --------------------
  // Add one or more segments on one side of the selected segment. Starts with one
  // new row ("+ Add segment" adds more). An End/Start toggle chooses the open
  // edge: "Keep original" re-slices within the segment's own time (it shrinks to
  // make room); "Extend" opens the window to an editable clock-out (after) or
  // clock-in (before), defaulting to the neighbour/midnight. The selected segment
  // is a read-only "anchor" row whose inner edge can also be dragged; moving it
  // edits that entry on submit. Gaps between rows are unpaid breaks (≤2 h, noted
  // on the row before them). Time-based only.
  function openInsertForm(ctx) {
    const side = ctx.side;                 // "before" | "after"
    const origStart = ctx.anchor.startMs, origEnd = ctx.anchor.endMs;
    const dStart = dayStartMs(origStart);
    const outerLimit = ctx.outerLimit;     // neighbour/midnight on the open side

    // Window far edge. "constrain" keeps the anchor's original edge (re-slice its
    // own time); "extend" opens the window out to a clock time — a clock-OUT for
    // the after side, a clock-IN for the before side — defaulting to the outer
    // limit (next segment, else midnight = end/start of day).
    let extend = false;
    let clockMs = outerLimit;
    let winStart = origStart, winEnd = origEnd;
    function recomputeWindow() {
      if (side === "after") { winStart = origStart; winEnd = extend ? clockMs : origEnd; }
      else { winEnd = origEnd; winStart = extend ? clockMs : origStart; }
    }

    const anchorRow = { anchor: true, startMs: origStart, endMs: origEnd };
    let anchorDto = null, anchorLabel = "Loading…", anchorLoadFailed = false;
    let newRows = [];
    function makeNewRow() { const picker = mkAllocationPicker({ showToggle: true }); picker.onValidity(renderFooter); return { startMs: null, endMs: null, picker }; }
    const composed = () => (side === "before" ? [...newRows, anchorRow] : [anchorRow, ...newRows]);

    // Even-fill the free window (anchor's inner edge → far edge) with the new rows.
    function relayoutNew() {
      const lo = side === "before" ? winStart : anchorRow.endMs;
      const hi = side === "before" ? anchorRow.startMs : winEnd;
      const n = newRows.length; if (!n) return;
      const span = Math.max(0, hi - lo);
      let cur = lo;
      newRows.forEach((r, i) => { r.startMs = cur; r.endMs = i === n - 1 ? hi : cur + Math.round(span / n); cur = r.endMs; });
    }

    // Lay out anchor + new rows for the current window. The anchor's inner edge
    // resets to its original, then shrinks only if the window leaves no free room
    // (constrain mode) so there's space to add. New rows (and pickers) are kept;
    // only their times are recomputed.
    function relayout() {
      recomputeWindow();
      anchorRow.startMs = origStart; anchorRow.endMs = origEnd;
      if (side === "after") {
        if (winEnd - anchorRow.endMs < MIN_MS) {
          const desired = Math.max(MIN_MS, Math.min(origEnd - origStart - MIN_MS, HOUR_MS));
          anchorRow.endMs = Math.max(origStart + MIN_MS, winEnd - desired);
        }
      } else {
        if (anchorRow.startMs - winStart < MIN_MS) {
          const desired = Math.max(MIN_MS, Math.min(origEnd - origStart - MIN_MS, HOUR_MS));
          anchorRow.startMs = Math.min(origEnd - MIN_MS, winStart + desired);
        }
      }
      relayoutNew();
    }
    newRows = [makeNewRow()]; // default to one; "+ Add segment" adds more
    relayout();

    const anchorMoved = () => (side === "before" ? anchorRow.startMs !== origStart : anchorRow.endMs !== origEnd);

    const { overlay, card } = modalOverlay();
    card.style.width = "560px";

    const h = document.createElement("div");
    h.textContent = side === "before" ? "Add segment(s) before" : "Add segment(s) after";
    Object.assign(h.style, { fontWeight: "700", fontSize: "16px", marginBottom: "2px" });
    const sub = document.createElement("div");
    Object.assign(sub.style, { color: "#666", marginBottom: "12px", fontSize: "12.5px" });
    const setSub = () => { sub.textContent = `${ctx.employeeName} · window ${fmtTime(winStart)} – ${fmtTime(winEnd)}`; };

    // Constrain | Extend toggle for the open edge, with a clock time when extending.
    const edgeWord = side === "after" ? "End" : "Start";
    const clockWord = side === "after" ? "clock-out" : "clock-in";
    const edgeRow = document.createElement("div");
    Object.assign(edgeRow.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "12px" });
    const edgeLbl = document.createElement("span");
    edgeLbl.textContent = edgeWord + ":";
    Object.assign(edgeLbl.style, { color: "#555", fontSize: "12.5px", fontWeight: "600" });
    const toggle = document.createElement("div");
    Object.assign(toggle.style, { display: "inline-flex", border: "1px solid #ccd", borderRadius: "7px", overflow: "hidden" });
    const segKeep = document.createElement("button");
    const segExt = document.createElement("button");
    for (const b of [segKeep, segExt]) {
      b.type = "button";
      Object.assign(b.style, { padding: "5px 12px", border: "none", background: "#fff", cursor: "pointer", font: "12.5px -apple-system, system-ui, sans-serif", fontWeight: "600", color: "#555" });
    }
    segKeep.textContent = `Keep original (${fmtTime(side === "after" ? origEnd : origStart)})`;
    segExt.textContent = `Extend to ${clockWord}`;
    segExt.style.borderLeft = "1px solid #ccd";
    const clockIn = mkTimeInput({
      dayStart: dStart, required: true, width: "110px",
      getBounds: () => side === "after"
        ? { min: origEnd, max: outerLimit }
        : { min: outerLimit, max: origStart },
    });
    clockIn.setMs(clockMs);
    clockIn.el.style.display = "none";
    clockIn.onChange((ms) => { if (ms != null) { clockMs = ms; relayout(); render(); } });
    function paintEdge() {
      for (const [b, on] of [[segKeep, !extend], [segExt, extend]]) {
        b.style.background = on ? "#1a56db" : "#fff";
        b.style.color = on ? "#fff" : "#555";
      }
      clockIn.el.style.display = extend ? "" : "none";
    }
    function setExtend(on) { extend = on; if (on) { clockMs = outerLimit; clockIn.setMs(clockMs); } relayout(); paintEdge(); render(); }
    segKeep.addEventListener("click", () => setExtend(false));
    segExt.addEventListener("click", () => setExtend(true));
    toggle.append(segKeep, segExt);
    edgeRow.append(edgeLbl, toggle, clockIn.el);

    const list = document.createElement("div");
    const addBtn = document.createElement("button");
    const remaining = document.createElement("div");
    const btns = document.createElement("div");
    const cancel = document.createElement("button");
    const create = document.createElement("button");

    // Static time display (for locked edges and the pre-load anchor).
    function staticTime(ms) {
      const s = document.createElement("span");
      s.textContent = ms == null ? "—" : fmtTime(ms);
      Object.assign(s.style, { display: "inline-block", width: "104px", textAlign: "center", padding: "6px 8px", color: "#777", fontSize: "13px" });
      return s;
    }

    function render() {
      if (openComboClose) openComboClose();
      setSub();
      list.innerHTML = "";
      const arr = composed();
      arr.forEach((row, ci) => {
        const isAnchor = !!row.anchor;
        const cardRow = document.createElement("div");
        Object.assign(cardRow.style, {
          border: "1px solid " + (isAnchor ? "#dbe3ef" : "#eee"), borderRadius: "8px",
          padding: "10px 12px", marginBottom: "10px", background: isAnchor ? "#f3f7ff" : "#fcfcfd",
        });
        const head = document.createElement("div");
        Object.assign(head.style, { display: "flex", alignItems: "center", gap: "8px" });

        const tag = document.createElement("span");
        tag.textContent = isAnchor ? "Existing" : `${side === "before" ? ci + 1 : ci}.`;
        Object.assign(tag.style, { minWidth: isAnchor ? "58px" : "18px", color: "#444", fontWeight: "600", fontSize: isAnchor ? "11px" : "13px" });
        head.appendChild(tag);

        // START edge
        const startLocked = isAnchor && side === "after";
        if (startLocked || (isAnchor && !anchorDto)) {
          head.appendChild(staticTime(row.startMs));
        } else {
          const startIn = mkTimeInput({
            dayStart: dStart, required: true, width: "104px",
            getBounds: () => ({ min: ci > 0 ? arr[ci - 1].endMs : winStart, max: row.endMs != null ? row.endMs : winEnd }),
          });
          startIn.setMs(row.startMs);
          startIn.onChange((ms) => {
            row.startMs = ms == null ? row.startMs : Math.max(winStart, Math.min(ms, row.endMs));
            if (ci > 0 && arr[ci - 1].endMs > row.startMs) arr[ci - 1].endMs = row.startMs;
            render();
          });
          head.appendChild(startIn.el);
        }

        const arrow = document.createElement("span"); arrow.textContent = "→"; arrow.style.color = "#999";
        head.appendChild(arrow);

        // END edge
        const endLocked = isAnchor && side === "before";
        if (endLocked || (isAnchor && !anchorDto)) {
          head.appendChild(staticTime(row.endMs));
        } else {
          const endIn = mkTimeInput({
            dayStart: dStart, required: true, width: "104px",
            getBounds: () => ({ min: row.startMs != null ? row.startMs : (ci > 0 ? arr[ci - 1].endMs : winStart), max: ci < arr.length - 1 ? arr[ci + 1].startMs : winEnd }),
          });
          endIn.setMs(row.endMs);
          endIn.onChange((ms) => {
            const old = row.endMs;
            row.endMs = ms == null ? row.endMs : Math.min(winEnd, Math.max(ms, row.startMs));
            const next = arr[ci + 1];
            if (next) { if (next.startMs === old) next.startMs = row.endMs; else if (row.endMs > next.startMs) row.endMs = next.startMs; }
            render();
          });
          head.appendChild(endIn.el);
        }

        const dur = document.createElement("span");
        const d = row.startMs != null && row.endMs != null ? row.endMs - row.startMs : 0;
        dur.textContent = d > 0 ? fmtDuration(d) : "—";
        Object.assign(dur.style, { color: d > 0 ? "#555" : "#c62828", fontSize: "12px", minWidth: "60px" });
        head.appendChild(dur);

        const spacer = document.createElement("span"); spacer.style.flex = "1"; head.appendChild(spacer);

        if (!isAnchor) {
          const del = document.createElement("button");
          del.type = "button"; del.textContent = "✕"; del.title = "Remove segment";
          Object.assign(del.style, { border: "none", background: "transparent", color: "#c62828", cursor: "pointer", fontSize: "15px" });
          del.disabled = newRows.length <= 1;
          del.style.opacity = newRows.length <= 1 ? "0.4" : "1";
          del.addEventListener("click", () => { const idx = newRows.indexOf(row); if (idx >= 0) newRows.splice(idx, 1); relayoutNew(); render(); });
          head.appendChild(del);
        }

        cardRow.appendChild(head);

        if (isAnchor) {
          const info = document.createElement("div");
          const dlt = anchorDelta();
          info.textContent = anchorLoadFailed ? "Couldn't load this segment — it can't be resized." : `${anchorLabel}${dlt ? ` · will ${dlt.verb} by ${fmtDuration(dlt.amount)}` : ""}`;
          Object.assign(info.style, { marginTop: "6px", color: anchorLoadFailed ? "#c62828" : "#5a6b86", fontSize: "12px" });
          cardRow.appendChild(info);
        } else {
          cardRow.appendChild(row.picker.el);
        }
        list.appendChild(cardRow);

        // Break chip after this row (gap to the next boundary).
        const nextB = ci < arr.length - 1 ? arr[ci + 1].startMs : winEnd;
        if (row.endMs != null && nextB != null && isBreak(nextB - row.endMs) && !(isAnchor && side === "before")) {
          const chip = document.createElement("div");
          chip.textContent = `⏸ ${fmtDuration(nextB - row.endMs)} unpaid break`;
          Object.assign(chip.style, { margin: "-4px 0 10px 4px", color: "#8a6d3b", fontSize: "12px", fontWeight: "600" });
          list.appendChild(chip);
        }
      });
      renderFooter();
    }

    function renderFooter() {
      const arr = composed();
      const timesOk = arr.every((row, i) =>
        row.startMs != null && row.endMs != null && row.startMs >= winStart && row.endMs <= winEnd &&
        row.startMs < row.endMs && (i === 0 || arr[i - 1].endMs <= row.startMs));
      const pickersOk = newRows.every((r) => r.picker.isValid());
      const needDto = anchorMoved() || anchorNoteText() !== "";
      const dtoOk = !needDto || (!!anchorDto && !anchorLoadFailed);
      const ok = timesOk && pickersOk && dtoOk;
      const added = newRows.reduce((a, r) => a + Math.max(0, (r.endMs || 0) - (r.startMs || 0)), 0);
      const delta = anchorDelta();
      let text = `Adding ${fmtDuration(added)}` + (delta ? ` · existing ${delta.verb}s ${fmtDuration(delta.amount)}` : "");
      let color = "#555";
      if (!timesOk) { text = "Fix the times: each must be within the window, in order, and end after start."; color = "#c62828"; }
      else if (!dtoOk) { text = anchorLoadFailed ? "Can't shrink the existing segment (load failed)." : "Loading the existing segment…"; color = "#c62828"; }
      remaining.textContent = text; remaining.style.color = color;
      create.disabled = !ok; create.style.opacity = ok ? "1" : "0.5"; create.style.cursor = ok ? "pointer" : "default";
    }

    // Break note that belongs on the anchor (only possible after it in "after").
    function anchorNoteText() {
      if (side !== "after") return "";
      const first = newRows[0];
      if (!first || first.startMs == null) return "";
      const gap = first.startMs - anchorRow.endMs;
      return isBreak(gap) ? `${fmtDuration(gap)} unpaid break auto-entered after this segment` : "";
    }
    // Describe how the anchor will be resized, or null if unchanged.
    function anchorDelta() {
      if (!anchorMoved()) return null;
      const origDur = origEnd - origStart, newDur = anchorRow.endMs - anchorRow.startMs;
      return { verb: newDur < origDur ? "shrink" : "grow", amount: Math.abs(newDur - origDur) };
    }

    addBtn.type = "button";
    addBtn.textContent = "+ Add segment";
    Object.assign(addBtn.style, { padding: "6px 10px", border: "1px dashed #aaa", borderRadius: "6px", background: "#fafafa", cursor: "pointer", fontSize: "13px" });
    addBtn.addEventListener("click", () => { newRows.push(makeNewRow()); relayoutNew(); render(); });

    Object.assign(remaining.style, { marginTop: "12px", fontWeight: "600", fontSize: "13px" });
    Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" });
    cancel.type = "button"; cancel.textContent = "Cancel";
    Object.assign(cancel.style, { padding: "8px 14px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f3f3", cursor: "pointer", fontWeight: "600" });
    cancel.addEventListener("click", () => overlay.remove());
    create.type = "button"; create.textContent = "Create";
    Object.assign(create.style, { padding: "8px 14px", borderRadius: "6px", border: "none", background: "#1f9d57", color: "#fff", fontWeight: "600" });
    create.addEventListener("click", async () => {
      // Confirm anything that touches the EXISTING segment (resize and/or note).
      const willEdit = (anchorMoved() || anchorNoteText()) && anchorDto;
      if (willEdit) {
        const lines = [];
        const delta = anchorDelta();
        if (delta) {
          lines.push(`Existing segment will ${delta.verb} by ${fmtDuration(delta.amount)}: ${fmtTime(origStart)}–${fmtTime(origEnd)} → ${fmtTime(anchorRow.startMs)}–${fmtTime(anchorRow.endMs)}.`);
        }
        if (anchorNoteText()) lines.push(`A break note will be added to the existing segment.`);
        lines.push(`${newRows.length} new segment${newRows.length === 1 ? "" : "s"} will be created.`);
        const okGo = await confirmDialog("Confirm changes to existing time", lines);
        if (!okGo) return;
      }
      create.disabled = true; create.textContent = "Saving…";
      const arr = composed();
      // New-segment create items, with break notes for gaps that follow them.
      const items = newRows.map((r) => {
        const ci = arr.indexOf(r);
        const nextB = ci < arr.length - 1 ? arr[ci + 1].startMs : winEnd;
        const gap = nextB - r.endMs;
        const note = isBreak(gap) ? `${fmtDuration(gap)} unpaid break auto-entered after this segment` : "";
        return { startIso: toIso(r.startMs), endIso: toIso(r.endMs), alloc: r.picker.getAlloc(), note };
      });
      const res = await createSegments(ctx.employeeId, items);
      // Edit the anchor if it shrank or needs a trailing break note.
      let anchorErr = "";
      if ((anchorMoved() || anchorNoteText()) && anchorDto) {
        const note = anchorNoteText() ? ((anchorDto.Note ? anchorDto.Note + " · " : "") + anchorNoteText()) : (anchorDto.Note || "");
        const er = await editSegmentTime(ctx.employeeId, anchorDto, toIso(anchorRow.startMs), toIso(anchorRow.endMs), note);
        if (!er.ok) anchorErr = er.error;
      }
      overlay.remove();
      if (res.created && !res.failed && !anchorErr) {
        banner(true, `Added ${res.created} segment${res.created === 1 ? "" : "s"} ${side} for ${ctx.employeeName}.`);
      } else {
        const parts = [];
        if (res.created) parts.push(`added ${res.created}`);
        if (res.failed) parts.push(`${res.failed} failed: ${res.firstError}`);
        if (anchorErr) parts.push(`existing segment not updated: ${anchorErr}`);
        banner(false, parts.join("; ") || "Nothing was saved.");
      }
      refreshGrid();
    });

    // No room to extend past a flush neighbour — disable that choice.
    const canExtend = side === "after" ? (outerLimit - origEnd > MIN_MS) : (origStart - outerLimit > MIN_MS);
    if (!canExtend) {
      segExt.disabled = true;
      segExt.style.opacity = "0.5";
      segExt.style.cursor = "not-allowed";
      segExt.title = "No room to extend (adjacent segment is right there)";
    }

    setSub();
    paintEdge();
    render();
    btns.append(cancel, create);
    card.append(h, sub, edgeRow, list, addBtn, remaining, btns);
    document.body.appendChild(overlay);

    // Load the anchor's allocation so we can preserve it when editing.
    loadEditDto(ctx.employeeId, ctx.anchor.id).then((dto) => {
      if (dto && dto.Activity) { anchorDto = dto; anchorLabel = allocLabelFromDto(dto) || "existing segment"; }
      else { anchorLoadFailed = true; anchorLabel = "existing segment"; }
      render();
    });
  }

  // ---- banner -----------------------------------------------------------------
  function banner(ok, message) {
    document.getElementById("innercider-tt-banner")?.remove();
    const el = document.createElement("div");
    el.id = "innercider-tt-banner";
    el.textContent = (ok ? "✓ " : "✗ ") + message;
    Object.assign(el.style, {
      position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
      padding: "10px 14px", borderRadius: "6px", font: "13px -apple-system, system-ui, sans-serif",
      color: "#fff", boxShadow: "0 2px 10px rgba(0,0,0,.25)", background: ok ? "#2e7d32" : "#c62828",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ok ? 5000 : 12000);
  }

  // ---- mount: react to selection + grid re-renders ----------------------------
  IC.registerFeature({ id: "time-tracking", mount: scheduleEval });
  // Selection toggles a class (attribute change) the bootstrap childList observer
  // won't catch, so also watch clicks and attribute mutations on the grid.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".dx-datagrid")) scheduleEval();
  }, true);
  new MutationObserver(scheduleEval).observe(document.documentElement, {
    subtree: true, attributes: true, attributeFilter: ["class"],
  });
  // Keep the floating overlay glued to the row boundary as the grid scrolls or
  // the window resizes (cheap, sync — no re-eval). Capture to catch the grid's
  // own inner scroll container.
  window.addEventListener("scroll", positionOverlay, true);
  window.addEventListener("resize", positionOverlay);
})();
