/* InnerCider — MAIN-world Work-Order grid selection reader
 *
 * The meeting scheduler (content/features/meeting-scheduler.js, isolated world)
 * lets a PM schedule a page-turn meeting for the ONE work order they've checked
 * in a WO grid. The selected row's data + the work order's own URL live in the
 * DevExtreme grid instance (page world) — unreachable from the isolated content
 * script — so this MAIN-world companion reads the selection and posts it over
 * window.postMessage (ic-wo-sel). Mirrors change-order-wizard-main.js.
 *
 * Two WO grids: the project grid (#/projects/<id>/workOrders) and the global
 * grid (#/workOrders/grid). We detect a single selected row and extract the
 * work order's link cell (an Innergy link object {Url, DisplayName, ObjectId}),
 * falling back to the selected row's anchor in the DOM. No network, no writes.
 */

(() => {
  "use strict";

  const GRID_RE = /#\/(?:projects\/[0-9a-fA-F-]{20,}\/workOrders|workOrders\/grid)/i;

  function gridInstances() {
    const $ = window.jQuery || window.$;
    if (!$) return [];
    const widgets = Array.from(document.querySelectorAll(".dx-datagrid")).map((el) => el.closest(".dx-widget") || el);
    const out = [];
    for (const w of widgets) {
      const data = $(w).data && $(w).data();
      const key = data && Object.keys(data).find((k) => /datagrid/i.test(k));
      const inst = key ? data[key] : null;
      if (inst && typeof inst.getSelectedRowsData === "function") out.push(inst);
    }
    return out;
  }

  // Find a link-object cell in a row's data: an object carrying a Url plus a
  // display text. Prefer one that points at a work order.
  function linkCell(data) {
    let best = null;
    for (const k of Object.keys(data || {})) {
      const v = data[k];
      if (v && typeof v === "object" && typeof v.Url === "string" && (v.DisplayName || v.Title)) {
        if (/workorder/i.test(v.Url) || /workorder|number|name/i.test(k)) return v;
        if (!best) best = v;
      }
    }
    return best;
  }

  // Display text of a cell value (link object → its DisplayName, else the scalar).
  function textOf(v) {
    if (v == null) return "";
    if (typeof v === "object") return String(v.DisplayName || v.Title || "").trim();
    return String(v).trim();
  }
  function projIdOf(url) { const m = String(url || "").match(/projects\/([0-9a-fA-F-]{20,})/i); return m ? m[1] : ""; }

  // Extract one work order from a grid row. The WO grids expose Name (WO name +
  // detail URL), SequenceIdentifier (WO number) and Project (project name + URL)
  // as Innergy link objects; fall back to the first WO-ish link cell otherwise.
  function woFromRow(d) {
    if (!d || typeof d !== "object") return null;
    const name = d.Name && typeof d.Name === "object" && d.Name.Url ? d.Name : null;
    const seq = d.SequenceIdentifier && typeof d.SequenceIdentifier === "object" ? d.SequenceIdentifier : null;
    const proj = d.Project && typeof d.Project === "object" ? d.Project : null;
    const link = name || linkCell(d);
    if (!link || !link.Url) return null;
    return {
      url: link.Url,
      label: (name && name.DisplayName) || link.DisplayName || link.Title || "Work Order",
      id: (name && name.ObjectId) || link.ObjectId || null,
      number: (seq && textOf(seq)) || "",
      name: (name && name.DisplayName) || link.DisplayName || "",
      project: (proj && textOf(proj)) || "",
      projectId: projIdOf((proj && proj.Url) || link.Url),
    };
  }

  function fromGrid() {
    for (const g of gridInstances()) {
      let sel;
      try { sel = g.getSelectedRowsData(); } catch (e) { continue; }
      if (!Array.isArray(sel) || !sel.length) continue;
      const items = sel.map(woFromRow).filter(Boolean);
      if (!items.length) continue;
      if (items.length === 1) {
        const it = items[0];
        return { url: it.url, label: it.label, id: it.id, number: it.number, name: it.name, project: it.project, projectId: it.projectId };
      }
      // Multiple WOs: only qualify when every one shares the same parent project.
      const pid = items[0].projectId;
      if (!pid || !items.every((it) => it.projectId === pid)) return { multi: items.length, mixed: true };
      return { multi: items.length, items, project: items[0].project, projectId: pid };
    }
    return null;
  }

  // Fallback: DevExtreme marks a checkbox-selected row with .dx-selection. Only
  // handles a single selection; multi-select routes through the grid data above.
  function fromDom() {
    const rows = document.querySelectorAll("tr.dx-data-row.dx-selection, tr.dx-selection");
    if (rows.length !== 1) return rows.length > 1 ? { multi: rows.length } : null;
    const a = rows[0].querySelector('a[href*="workOrder"], a[href*="/workOrders/"], a[href*="#/"]');
    if (a) return { url: a.getAttribute("href"), label: (a.textContent || "Work Order").trim(), id: null, projectId: projIdOf(a.getAttribute("href")) };
    return null;
  }

  function readSelection() {
    if (!GRID_RE.test(location.hash || "")) return null;
    return fromGrid() || fromDom();
  }

  let last = "\u0000";
  function tick() {
    let payload = null;
    try { payload = readSelection(); } catch (e) { /* ignore */ }
    const sig = JSON.stringify(payload);
    if (sig !== last) {
      last = sig;
      window.postMessage({ source: "ic-wo-sel", payload }, "*");
    }
  }

  // Selection changes are user-driven and DevExtreme doesn't emit a DOM mutation
  // we can rely on, so poll cheaply (no-op off the WO grids).
  setInterval(tick, 600);
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "ic-wo-sel-req") tick();
  });
})();
