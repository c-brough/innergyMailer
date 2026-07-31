/* InnerCider — Materials total-cost feature
 *
 * On the Materials list grid, the "Cost" column is the unit cost per Base UoM
 * (e.g. $2.03/SF). Next to the Default UoM and Purchasing UoM values (e.g.
 * "4'x8'") we show the total cost for one of those units — unit cost × the
 * conversion factor. Innergy stores no separate factor: for size-based UoM
 * groups it derives the factor from the dimensional size name itself
 * (SF: W'×H'; LF: length; EA: 1), which is exactly what we replicate.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const IC_MARK = "innercider-total";

  function icParseMoney(txt) {
    if (!txt) return null;
    const m = txt.replace(/[, ]/g, "").match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  // Conversion factor from a common-size name to the base unit, or null if it
  // can't be determined (then we don't annotate rather than show a wrong value).
  function icFactor(sizeName, baseCode) {
    const s = (sizeName || "").trim();
    const b = (baseCode || "").trim().toUpperCase();
    if (!s || !b) return null;
    if (s.toUpperCase() === b) return 1; // e.g. LF size in an LF group
    const norm = s.replace(/[’′]/g, "'").replace(/[”″]/g, '"');
    // Square feet: "W'xH'" -> W*H
    const area = norm.match(/^(\d+(?:\.\d+)?)\s*'?\s*[x×]\s*(\d+(?:\.\d+)?)\s*'?$/i);
    if (area && b === "SF") return parseFloat(area[1]) * parseFloat(area[2]);
    // Linear feet: single dimension "L'" -> L
    const len = norm.match(/^(\d+(?:\.\d+)?)\s*'?$/);
    if (len && b === "LF") return parseFloat(len[1]);
    if (b === "EA") return 1;
    return null;
  }

  function icMoney(v) {
    return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function icAnnotateCell(cell, cost, base) {
    const existing = cell.querySelector("." + IC_MARK);
    // The pure size name: stored when we first annotated (survives our own span);
    // otherwise the cell's current text (no span yet).
    const sizeName = existing && cell.dataset.icSize != null
      ? cell.dataset.icSize
      : cell.textContent.trim();
    const factor = icFactor(sizeName, base);
    if (factor == null) {
      if (existing) existing.remove();
      return;
    }
    cell.dataset.icSize = sizeName;
    const text = icMoney(cost * factor);
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    const span = document.createElement("span");
    span.className = IC_MARK;
    span.textContent = text;
    // Small modern chip that blends with the grid styling.
    Object.assign(span.style, {
      display: "inline-block",
      marginLeft: "6px",
      padding: "0 6px",
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "15px",
      color: "#1e7e34",
      background: "#eef7f0",
      border: "1px solid #cfe8d5",
      borderRadius: "4px",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
    });
    cell.appendChild(span);
  }

  function annotateMaterialsGrid() {
    if (!/#\/materials\/materials\//.test(location.hash)) return;
    // Find the main materials grid's header row (there are other dx grids on the
    // page, e.g. the navigation tree).
    let header = null;
    for (const r of document.querySelectorAll("tr.dx-header-row")) {
      if (/\bCost\b/.test(r.textContent) && /UoM/i.test(r.textContent)) { header = r; break; }
    }
    if (!header) return;
    // Map header label -> aria-colindex (robust to column reordering).
    const col = {};
    for (const td of header.children) {
      const t = td.textContent.trim();
      const ci = td.getAttribute("aria-colindex");
      if (t && ci) col[t] = ci;
    }
    const ciCost = col["Cost"], ciBase = col["Base UoM"];
    const targets = [col["Default UoM"], col["Purchasing UoM"]].filter(Boolean);
    if (!ciCost || !ciBase || !targets.length) return;
    const grid = header.closest(".dx-datagrid");
    if (!grid) return;
    for (const row of grid.querySelectorAll("tr.dx-data-row")) {
      const costCell = row.querySelector(`td[aria-colindex="${ciCost}"]`);
      const baseCell = row.querySelector(`td[aria-colindex="${ciBase}"]`);
      if (!costCell || !baseCell) continue;
      const cost = icParseMoney(costCell.textContent);
      const base = baseCell.textContent.trim();
      if (cost == null) continue;
      for (const ci of targets) {
        for (const cell of row.querySelectorAll(`td[aria-colindex="${ci}"]`)) {
          icAnnotateCell(cell, cost, base);
        }
      }
    }
  }

  let icScheduled = false;
  function scheduleAnnotate() {
    if (icScheduled) return;
    icScheduled = true;
    setTimeout(() => {
      icScheduled = false;
      try {
        annotateMaterialsGrid();
      } catch (e) {
        IC.warn("materials-cost annotate threw", e);
      }
    }, 250);
  }

  IC.registerFeature({ id: "materials-cost", mount: scheduleAnnotate });
})();
