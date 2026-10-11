/* InnerCider — MAIN-world reader for the Time Tracking grid
 *
 * The Time Tracking Tools feature (content/features/time-tracking.js, isolated
 * world) needs facts that only live on the page's DevExtreme grid instance:
 * which rows are selected, whether the grid is time-sorted, whether the Status
 * column is filtered, and the selected employee's loaded segments (to prove the
 * two picked rows are truly adjacent with an empty gap). An isolated content
 * script can't see the page's jQuery/DevExtreme, so this runs in the MAIN world
 * and answers over window.postMessage. Mirrors export-capture-main.js /
 * materials-read-main.js. It only ever READS and refreshes the grid; the create
 * POST is done from the isolated side.
 */

(() => {
  "use strict";

  function findGrid() {
    const $ = window.jQuery || window.$;
    if (!$) return null;
    for (const el of document.querySelectorAll(".dx-datagrid")) {
      const w = el.closest(".dx-widget") || el;
      const data = $(w).data && $(w).data();
      const key = data && Object.keys(data).find((k) => /datagrid/i.test(k));
      const inst = key ? data[key] : null;
      // Identify the time grid by columns that actually exist on it. (EmployeeId
      // is only a row-data field, not a column, so don't key off it.)
      if (inst && inst.getSelectedRowsData && inst.columnOption) {
        try {
          if (inst.columnOption("StartTime") && inst.columnOption("EndTime")) return inst;
        } catch (e) {
          /* keep looking */
        }
      }
    }
    return null;
  }

  // Does the applied filter touch the Status column? Walks the combined filter
  // expression (nested arrays) looking for a "Status" field reference.
  function statusIsFiltered(inst) {
    let f = null;
    try {
      f = inst.getCombinedFilter ? inst.getCombinedFilter(true) : null;
    } catch (e) {
      f = null;
    }
    let found = false;
    (function walk(node) {
      if (found || !Array.isArray(node)) return;
      if (typeof node[0] === "string" && /(^|\.)Status$/i.test(node[0])) {
        found = true;
        return;
      }
      node.forEach((n) => Array.isArray(n) && walk(n));
    })(f);
    return found;
  }

  // Is the grid sorted by StartTime or EndTime (either direction)? That's the
  // guarantee that "adjacent rows" means adjacent in time.
  function timeSortField(inst) {
    for (const field of ["StartTime", "EndTime"]) {
      try {
        if (inst.columnOption(field, "sortOrder")) return field;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  // Grid times are { dateTime: "2026-10-11T12:00" } (naive wall-clock, no zone;
  // may be null for a running segment). Hand the isolated side the plain string.
  function gridNaive(v) {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object" && typeof v.dateTime === "string") return v.dateTime;
    return null;
  }

  function pick(row) {
    if (!row) return null;
    return {
      Id: row.Id,
      EmployeeId: row.EmployeeId,
      EmployeeFullName:
        row.EmployeeFullName && row.EmployeeFullName.DisplayName
          ? row.EmployeeFullName.DisplayName
          : row.EmployeeFullName || "",
      StartTime: gridNaive(row.StartTime),
      EndTime: gridNaive(row.EndTime),
      Status: row.Status,
    };
  }

  // Every loaded segment for one employee (across expanded groups), so the
  // isolated side can confirm nothing sits between the two selected rows.
  function employeeSegments(inst, employeeId) {
    const out = [];
    try {
      for (const vr of inst.getVisibleRows() || []) {
        if (vr.rowType === "data" && vr.data && vr.data.EmployeeId === employeeId) {
          out.push({ Id: vr.data.Id, StartTime: gridNaive(vr.data.StartTime), EndTime: gridNaive(vr.data.EndTime) });
        }
      }
    } catch (e) {
      /* ignore */
    }
    return out;
  }

  function getState() {
    const inst = findGrid();
    if (!inst) return { ok: false, gridPresent: false };
    let selected = [];
    try {
      selected = (inst.getSelectedRowsData() || []).map(pick).filter(Boolean);
    } catch (e) {
      selected = [];
    }
    const empId = selected.length ? selected[0].EmployeeId : null;
    return {
      ok: true,
      gridPresent: true,
      selected,
      statusFiltered: statusIsFiltered(inst),
      timeSortField: timeSortField(inst),
      employeeSegments: empId ? employeeSegments(inst, empId) : [],
    };
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== "innercider") return;
    if (msg.type === "TT_GET_STATE") {
      let state;
      try {
        state = getState();
      } catch (e) {
        state = { ok: false, error: String(e) };
      }
      window.postMessage(
        { source: "innercider-main", type: "TT_STATE", requestId: msg.requestId, state },
        location.origin
      );
    } else if (msg.type === "TT_REFRESH") {
      const inst = findGrid();
      try {
        inst && inst.refresh();
      } catch (e) {
        /* ignore */
      }
    }
  });
})();
