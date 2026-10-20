/* InnerCider — MAIN-world tagger for the Change Orders grid
 *
 * The Quick Change Order wizard (content/features/change-order-wizard.js) needs
 * to know which change-order rows qualify for the wizard button (Status Pending
 * and GrandTotalCost $0) and each row's change-order id. Those live only in the
 * DevExtreme grid's row-data objects, readable through the page's own
 * jQuery/DevExtreme — which an isolated content script can't see (separate
 * `window`). So this runs in the MAIN world, finds the grid, and tags each
 * qualifying Name cell in the shared DOM with `data-ic-co-id` / `data-ic-co-name`.
 * The isolated feature watches for those attributes and injects the button + UI
 * (and owns chrome.storage, which this world can't reach). Mirrors the
 * materials-read-main.js / export-capture-main.js pattern; sits outside the
 * window.InnerCider namespace because it can't reach it from this world.
 *
 * No network, no writes — DOM read + tag only.
 */

(() => {
  "use strict";

  const CO_PAGE_RE = /#\/projects\/[0-9a-fA-F-]{20,}\/changeOrders/;

  function qualifies(d) {
    return d && d.Status === "Pending" && d.GrandTotalCost && d.GrandTotalCost.Value === 0;
  }

  // The change-orders dxDataGrid instance (its data has Status + GrandTotalCost).
  function findGrid() {
    const $ = window.jQuery || window.$;
    if (!$) return null;
    const widgets = Array.from(document.querySelectorAll(".dx-datagrid")).map(
      (el) => el.closest(".dx-widget") || el
    );
    for (const w of widgets) {
      const data = $(w).data && $(w).data();
      const key = data && Object.keys(data).find((k) => /datagrid/i.test(k));
      const inst = key ? data[key] : null;
      if (!inst || typeof inst.getVisibleRows !== "function" || typeof inst.getCellElement !== "function") continue;
      try {
        const items = inst.getDataSource && inst.getDataSource() && inst.getDataSource().items();
        if (Array.isArray(items) && items[0] && "GrandTotalCost" in items[0] && "Status" in items[0]) return inst;
      } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function tagCells() {
    if (!CO_PAGE_RE.test(location.hash || "")) return;
    const grid = findGrid();
    if (!grid) return;
    let rows;
    try { rows = grid.getVisibleRows(); } catch (e) { return; }
    for (const r of rows || []) {
      if (!r || r.rowType !== "data" || !r.data) continue;
      const n = r.data.Name || {};
      const id = n.ObjectId;
      let cell;
      try { cell = grid.getCellElement(r.rowIndex, "Name"); } catch (e) { continue; }
      const td = cell && (cell.length ? cell[0] : cell);
      if (!td) continue;
      if (id && qualifies(r.data)) {
        if (td.getAttribute("data-ic-co-id") !== id) {
          td.setAttribute("data-ic-co-id", id);
          td.setAttribute("data-ic-co-name", n.DisplayName || n.Title || "Change Order");
        }
      } else if (td.hasAttribute("data-ic-co-id")) {
        td.removeAttribute("data-ic-co-id");
        td.removeAttribute("data-ic-co-name");
      }
    }
  }

  let timer = null;
  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; try { tagCells(); } catch (e) { /* ignore */ } }, 300); }

  function start() {
    if (!document.body) { setTimeout(start, 200); return; }
    // childList/subtree only (not attributes) so our own tagging can't loop.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }
  start();
})();
