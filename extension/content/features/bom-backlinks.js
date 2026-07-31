/* InnerCider — BOM backlinks on work-order shipment items
 *
 * CPW-BOM pushes one Innergy shipment item per BOM assembly, stamping each with
 * `InternalEngineeringId: cpwbom-{bomId}-asm-{assemblyId}`. That id survives the
 * EngineeringSync staging → work-order promotion and comes back as the row's
 * `EngineeringId`, so it's a usable backlink key: we turn it into a chip linking
 * to `<base>/?bom={bomId}` next to each shipment item's name.
 *
 * The BOM app's address is a required user setting with no default — see
 * "Options" below. Until it's set the feature is inert, so installs at other
 * companies (which have no CPW-BOM and no `cpwbom-…` engineering ids) simply
 * never see it. If this ever needs to serve a different BOM app, `ENG_RE` is
 * the other CPW-specific piece and would have to become configurable too.
 *
 * The id is NOT rendered in the grid (no "Engineering ID" column in the default
 * view) and the DevExtreme grid instance isn't reachable from the page (React
 * bundle, no `window.DevExpress`). So we re-run the grid's own query ourselves —
 * same `ShipmentItemsListQuery` the page uses, same session cookie — and match
 * rows BY NAME.
 *
 * Why by name and not by position: the grid's row order follows whatever sort /
 * filter / page the user has chosen, which our independent fetch doesn't know
 * about. Index-zipping silently produces wrong links (verified: an unsorted
 * fetch came back reversed relative to the rendered rows). Names are
 * order-independent. When two rows in one work order share a name but map to
 * different BOMs, the name is ambiguous and we annotate neither — a missing
 * chip is recoverable, a confidently wrong one is not.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;

  const MARK = "innercider-bom-link";
  // Shipment items pushed by CPW-BOM; the capture is the BOM's integer id.
  const ENG_RE = /^cpwbom-(\d+)-asm-(\d+)$/;
  const ROUTE_RE = /#\/projects\/([0-9a-f-]+)\/workOrder\/([0-9a-f-]+)\/shipment-items/i;
  // A work order with more rows than this would need paging; we log instead of
  // silently linking only the first page.
  const PAGE_SIZE = 1000;
  const RETRY_AFTER_MS = 30_000;
  const REFRESH_THROTTLE_MS = 15_000;

  // ---- Options ---------------------------------------------------------------
  // There is deliberately NO default BOM app address. This extension is shared
  // outside CPW, and a hardcoded default would point other companies' installs
  // at someone else's app. Unconfigured means the feature stays dormant: no
  // query, no chips, nothing to notice.

  let baseUrl = null; // null = not configured
  let baseLoaded = false;

  // Returns a usable origin+path prefix, or null. Restricted to http(s) so a
  // pasted `javascript:` (or similar) can't become a chip's href.
  function normalizeBase(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) return null;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return raw;
  }

  chrome.storage.local.get("bomBaseUrl", (data) => {
    baseUrl = normalizeBase(data && data.bomBaseUrl);
    baseLoaded = true;
    // The storage read races the first mount(); re-run once we know the answer.
    if (baseUrl) schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.bomBaseUrl) return;
    baseUrl = normalizeBase(changes.bomBaseUrl.newValue);
    // Drop existing chips: rebuilt against the new base, or gone for good if the
    // setting was cleared or made invalid.
    for (const el of document.querySelectorAll("." + MARK)) el.remove();
    if (baseUrl) schedule();
  });

  // ---- Grid lookup -----------------------------------------------------------

  // The shipment-items grid, identified by its header (the page has other dx
  // grids — filter menus, the nav tree).
  function findGrid() {
    for (const row of document.querySelectorAll("tr.dx-header-row")) {
      if (/Shipment Item Name/i.test(row.textContent)) return row.closest(".dx-datagrid");
    }
    return null;
  }

  // Name cells live in the scrollable content table. The grid renders a second,
  // mirrored `.dx-datagrid-content-fixed` table for the pinned checkbox/action
  // gutter — annotating that one would put chips in the wrong column.
  function mainRows(grid) {
    return grid.querySelectorAll(
      ".dx-datagrid-content:not(.dx-datagrid-content-fixed) tr.dx-data-row"
    );
  }

  // Column position rather than a hardcoded index, so reordering columns in a
  // saved view doesn't move the chips onto the wrong cell.
  function nameColIndex(grid) {
    for (const td of grid.querySelectorAll("tr.dx-header-row td")) {
      if (td.textContent.trim() === "Shipment Item Name") return td.getAttribute("aria-colindex");
    }
    return null;
  }

  // The cell's own text once we've appended a chip to it, so re-annotation
  // doesn't match against "Cabinet 1BOM 1 ↗".
  function cellName(cell) {
    return cell.dataset.icBomName != null ? cell.dataset.icBomName : cell.textContent.trim();
  }

  // ---- Data ------------------------------------------------------------------

  // Returns { map, names }:
  //   map   — Map<shipmentItemName, bomId | null>; a null value marks a name that
  //           maps to more than one BOM in this work order (ambiguous, so left
  //           unannotated).
  //   names — every shipment item name the query returned, including rows with no
  //           CPW-BOM id. Used to tell "this row isn't from CPW-BOM" (in `names`,
  //           absent from `map`) apart from "this row appeared after we last
  //           queried" (absent from both) — see the staleness check in mount().
  async function fetchBomMap(projectId, workOrderId) {
    const body = {
      ProjectId: projectId,
      WorkOrderId: workOrderId,
      ShipmentId: null,
      WoIsOpen: null,
      $type: "ShipmentItemsListQuery",
      LoadOptions: {
        requireTotalCount: true,
        isCountQuery: false,
        skip: 0,
        take: PAGE_SIZE,
        sort: null,
        group: null,
        totalSummary: null,
        remoteGrouping: true,
        primaryKey: null,
        defaultSort: null,
        $type: "DataSourceLoadOptionsDto",
      },
    };
    // The app posts this as text/plain; matching it avoids a CORS preflight.
    const resp = await fetch("https://app.innergy.com/query/run", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`query/run returned ${resp.status}`);
    const json = await resp.json();
    const rows = json.data || [];
    if (typeof json.totalCount === "number" && json.totalCount > rows.length) {
      IC.warn(
        `shipment items truncated at ${rows.length} of ${json.totalCount}; ` +
          "rows beyond the first page won't get BOM links"
      );
    }

    const map = new Map();
    const names = new Set();
    for (const row of rows) {
      const name = String(row.ShipmentItemName || "").trim();
      if (!name) continue;
      names.add(name);
      const match = ENG_RE.exec(String(row.EngineeringId || "").trim());
      if (!match) continue; // not pushed by CPW-BOM
      const bomId = match[1];
      if (map.has(name) && map.get(name) !== bomId) map.set(name, null);
      else map.set(name, bomId);
    }
    return { map, names };
  }

  // ---- Rendering -------------------------------------------------------------

  function annotateCell(cell, bomId) {
    const existing = cell.querySelector("." + MARK);
    const href = `${baseUrl}/?bom=${encodeURIComponent(bomId)}`;
    if (existing) {
      if (existing.getAttribute("href") !== href) existing.setAttribute("href", href);
      return;
    }
    cell.dataset.icBomName = cell.textContent.trim();

    const link = document.createElement("a");
    link.className = MARK;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `BOM ${bomId} ↗`;
    link.title = `Open BOM #${bomId}`;
    // Clicking a cell selects/opens the grid row; keep the link to itself.
    link.addEventListener("click", (ev) => ev.stopPropagation());
    // Matches the Materials total-cost chip, in a link blue rather than green.
    Object.assign(link.style, {
      display: "inline-block",
      marginLeft: "6px",
      padding: "0 6px",
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "15px",
      color: "#1a56db",
      background: "#eef2fd",
      border: "1px solid #c7d0f8",
      borderRadius: "4px",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      textDecoration: "none",
    });
    cell.appendChild(link);
  }

  function annotate(grid, map) {
    const colIndex = nameColIndex(grid);
    if (!colIndex) return;
    for (const row of mainRows(grid)) {
      const cell = row.querySelector(`td[aria-colindex="${colIndex}"]`);
      if (!cell) continue;
      const bomId = map.get(cellName(cell));
      if (!bomId) continue; // absent, or ambiguous (null)
      annotateCell(cell, bomId);
    }
  }

  // ---- Mount -----------------------------------------------------------------

  // Cached per work order: mount() runs on every DOM mutation, and this one
  // costs a network round trip rather than pure DOM math.
  let cache = { key: null, map: null, names: null, state: "idle" }; // idle | loading | ready | error
  let retryAt = 0;
  let refreshAt = 0;

  // A rendered row whose name the query never returned means the work order
  // gained shipment items since we built the map — someone re-pushed from
  // CPW-BOM and promoted the new rows while this tab stayed open. Rows that
  // simply aren't from CPW-BOM don't trigger this: they're in `names` (the
  // query returned them) even though they're absent from `map`.
  function hasUnknownRow(grid, names) {
    const colIndex = nameColIndex(grid);
    if (!colIndex) return false;
    for (const row of mainRows(grid)) {
      const cell = row.querySelector(`td[aria-colindex="${colIndex}"]`);
      if (!cell) continue;
      const name = cellName(cell);
      if (name && !names.has(name)) return true;
    }
    return false;
  }

  function load(key, projectId, workOrderId) {
    cache = { key, map: null, names: null, state: "loading" };
    fetchBomMap(projectId, workOrderId)
      .then(({ map, names }) => {
        if (cache.key !== key) return; // navigated away mid-flight
        cache = { key, map, names, state: "ready" };
        schedule();
      })
      .catch((e) => {
        if (cache.key !== key) return;
        cache = { key, map: null, names: null, state: "error" };
        retryAt = Date.now() + RETRY_AFTER_MS;
        IC.warn("could not load shipment items for BOM backlinks", e);
      });
  }

  function mount() {
    // No BOM app configured (or not read from storage yet) — do nothing at all,
    // including no query. Installs without a BOM app never touch the network.
    if (!baseLoaded || !baseUrl) return;
    const route = ROUTE_RE.exec(location.hash);
    if (!route) return;
    const [, projectId, workOrderId] = route;
    const key = `${projectId}:${workOrderId}`;
    if (cache.key !== key) cache = { key, map: null, names: null, state: "idle" };

    if (cache.state === "ready") {
      const grid = findGrid();
      if (!grid) return;
      annotate(grid, cache.map);
      if (Date.now() >= refreshAt && hasUnknownRow(grid, cache.names)) {
        refreshAt = Date.now() + REFRESH_THROTTLE_MS;
        load(key, projectId, workOrderId);
      }
      return;
    }
    if (cache.state === "loading") return;
    if (cache.state === "error" && Date.now() < retryAt) return;

    // Wait for the grid to actually have rows — mounting fires during the SPA's
    // empty-shell render too, and there's no point querying before then.
    const grid = findGrid();
    if (!grid || !mainRows(grid).length) return;
    load(key, projectId, workOrderId);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        mount();
      } catch (e) {
        IC.warn("bom-backlinks mount threw", e);
      }
    }, 250);
  }

  IC.registerFeature({ id: "bom-backlinks", mount: schedule });
})();
