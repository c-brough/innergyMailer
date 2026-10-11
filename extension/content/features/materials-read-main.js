/* InnerCider — MAIN-world reader for the PO Materials grid
 *
 * draft-email.js needs the purchase order's material line items for the email
 * body. Reading them from the rendered DOM is brittle: the grid is a DevExtreme
 * widget whose column order and DOM nesting Innergy changes over time (a deeper
 * nesting is exactly what once broke the old DOM scraper), and the per-line
 * Project / Work Order names aren't rendered as cells at all — they live only in
 * the grid's row data objects.
 *
 * So we read the data objects directly from the DevExtreme instance. That needs
 * the page's own jQuery/DevExtreme, which an isolated content script can't see
 * (separate `window`), so this runs in the MAIN world and answers a
 * READ_MATERIALS request over window.postMessage. The isolated end lives in
 * content/features/draft-email.js ("MAIN-world materials bridge"). Mirrors the
 * export-capture-main.js pattern; like that file it sits outside the
 * window.InnerCider namespace because it can't reach it from this world.
 *
 * Returns null (not []) when it can't read the grid at all, so the isolated side
 * can tell "no materials on this PO" from "couldn't read it" and fall back.
 */

(() => {
  "use strict";

  function displayNames(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map((o) => o && o.DisplayName)
      .filter(Boolean);
  }

  function formatMoney(ext) {
    if (!ext || typeof ext !== "object" || ext.IsEmpty || typeof ext.Value !== "number") return "";
    const symbol = (ext.Currency && ext.Currency.Symbol) || "$";
    return symbol + ext.Value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Pull the row data objects out of a DevExtreme grid instance. Prefer the data
  // source's items() (every loaded row) over getVisibleRows() (only rendered
  // ones, which virtual scrolling can trim).
  function rowDataFromInstance(inst) {
    try {
      const items = inst.getDataSource && inst.getDataSource() && inst.getDataSource().items();
      if (Array.isArray(items) && items.some((it) => it && it.MaterialName)) return items;
    } catch (e) {
      /* fall through */
    }
    try {
      return (inst.getVisibleRows() || [])
        .filter((r) => r.rowType === "data" && r.data)
        .map((r) => r.data);
    } catch (e) {
      return [];
    }
  }

  function readMaterials() {
    const $ = window.jQuery || window.$;
    if (!$) return null;
    const widgets = Array.from(document.querySelectorAll(".dx-datagrid")).map(
      (el) => el.closest(".dx-widget") || el
    );
    for (const w of widgets) {
      const data = $(w).data && $(w).data();
      const key = data && Object.keys(data).find((k) => /datagrid/i.test(k));
      const inst = key ? data[key] : null;
      if (!inst || !inst.getVisibleRows) continue;
      const rows = rowDataFromInstance(inst).filter((x) => x && x.MaterialName);
      if (!rows.length) continue; // not the materials grid (or it's empty) — keep looking
      return rows
        .map((x) => ({
          name: (x.MaterialName && x.MaterialName.DisplayName) || "",
          uom: typeof x.CommonUom === "string" ? x.CommonUom : "",
          qty: x.QuantityOrdered == null ? "" : String(x.QuantityOrdered),
          unitCost: formatMoney(x.UnitCost),
          extendedCost: formatMoney(x.ExtendedCost),
          notes: (x.Notes && x.Notes.Text) || "", // may be HTML; isolated side plain-texts it
          projects: displayNames(x.PreferredProjectNames),
          workOrders: displayNames(x.PreferredWorkOrderNames),
        }))
        .filter((it) => it.name);
    }
    return null; // no materials grid found on the page
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== "innercider" || msg.type !== "READ_MATERIALS") return;
    let items = null;
    try {
      items = readMaterials();
    } catch (e) {
      items = null;
    }
    window.postMessage(
      { source: "innercider-main", type: "MATERIALS_RESULT", requestId: msg.requestId, items },
      location.origin
    );
  });
})();
