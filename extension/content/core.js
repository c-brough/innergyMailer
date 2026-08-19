/* InnerCider — content script core
 *
 * Shared namespace for all Innergy content-script features. Loaded first (see
 * manifest.json content_scripts order); every feature file attaches to
 * `window.InnerCider` instead of keeping its own IIFE-local globals, so
 * features can share the Innergy access layer and register with the single
 * SPA-aware bootstrap observer (bootstrap.js).
 *
 * MV3 content scripts can't cleanly ES-`import` a shared module without a
 * bundler, so this uses the standard no-build equivalent: ordered files in
 * the manifest, sharing one global namespace. See ARCHITECTURE.md — this
 * converts to real `import`s 1:1 whenever a bundler is introduced.
 */

(() => {
  "use strict";

  if (window.InnerCider) return; // already initialized (re-injection guard)

  const features = [];

  function log(text, data) {
    console.log("[InnerCider]", text, data || "");
  }

  function warn(text, data) {
    console.warn("[InnerCider]", text, data || "");
  }

  // ---- Shared Innergy access layer -------------------------------------------
  // Every feature that needs PO / work-order / employee data from Innergy should
  // go through here rather than re-implementing its own fetch/query logic.

  function getPoId() {
    const m = location.hash.match(/purchaseOrders\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  // Work-order pages live at #/projects/{projectId}/workOrder/{woId}/…
  // Returns null on any other page, which is how features tell the two
  // document types apart — don't infer it from a missing PO number, since
  // getPoNumber() falls back to a literal string.
  function getWorkOrderIds() {
    const m = location.hash.match(/projects\/([0-9a-f-]+)\/workOrder\/([0-9a-f-]+)/i);
    return m ? { projectId: m[1], workOrderId: m[2] } : null;
  }

  // Run one of Innergy's own queries against the session the user already has.
  // GET carries the query in the URL; POST is for the grid-style queries that
  // take DevExtreme LoadOptions. Resolves to null on any problem — callers
  // decide what a missing answer means.
  async function runQuery(query, { method = "GET" } = {}) {
    try {
      const resp =
        method === "POST"
          ? await fetch("https://app.innergy.com/query/run", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(query),
            })
          : await fetch(
              "https://app.innergy.com/query/run?query=" + encodeURIComponent(JSON.stringify(query)),
              { credentials: "include" }
            );
      if (!resp.ok) {
        warn(`query ${query.$type} failed: HTTP ${resp.status}`);
        return null;
      }
      return await resp.json();
    } catch (e) {
      warn(`query ${query.$type} threw:`, e);
      return null;
    }
  }

  // The work order's own number and name, e.g. { sequenceIdentifier:
  // "P-26-1084-001p", name: "Test WO 1" }, plus the same for its project.
  async function fetchWorkOrderInfo() {
    const ids = getWorkOrderIds();
    if (!ids) return null;
    const [wo, project] = await Promise.all([
      runQuery({ Id: ids.workOrderId, $type: "WorkOrderNumberAndNameQuery" }),
      runQuery({ ProjectId: ids.projectId, $type: "ProjectNumberAndNameQuery" }),
    ]);
    if (!wo) return null;
    return {
      ...ids,
      number: wo.sequenceIdentifier || "",
      name: wo.name || "",
      projectNumber: (project && project.sequenceIdentifier) || "",
      projectName: (project && project.name) || "",
    };
  }

  // Email addresses of every active member of an Innergy employee group.
  //
  // This is how a shared recipient list stays centrally editable: the list IS
  // the group's membership, maintained in Innergy under Human Resources →
  // Employee Groups. Everyone's extension reads it live, so adding or removing
  // someone takes effect on the next draft with no extension update.
  //
  // Innergy has no "one group's members" query, so this pulls the employee list
  // (one request, every employee carries its EmployeeGroups) and filters. That
  // is what the Employees grid itself does.
  async function fetchEmployeeGroupEmails(groupName) {
    const wanted = String(groupName || "").trim().toLowerCase();
    if (!wanted) return [];
    const json = await runQuery(
      {
        InactiveOnly: false,
        $type: "EmployeeListQuery",
        LoadOptions: {
          requireTotalCount: false,
          isCountQuery: false,
          skip: 0,
          take: 1000,
          sort: [{ selector: "FirstName", desc: false }],
          group: null,
          remoteGrouping: true,
          primaryKey: null,
          defaultSort: null,
          $type: "DataSourceLoadOptionsDto",
        },
      },
      { method: "POST" }
    );
    const rows = (json && json.data) || [];
    const emails = [];
    const seen = new Set();
    for (const row of rows) {
      if (row.Status !== "Active") continue;
      const inGroup = (row.EmployeeGroups || []).some(
        (g) => String(g && g.DisplayName || "").trim().toLowerCase() === wanted
      );
      if (!inGroup) continue;
      const mail = (row.LoginEmail && row.LoginEmail.Mail ? row.LoginEmail.Mail : "").trim();
      // Innergy stores addresses as typed, so members can differ only by case.
      if (!mail || seen.has(mail.toLowerCase())) continue;
      seen.add(mail.toLowerCase());
      emails.push(mail);
    }
    return emails;
  }

  // Fetch the files attached to this PO via the same API the Files tab uses.
  // Returns [{ name, url, flag }] for real files (folders and entries without a
  // download URL are skipped). `flag` is the innergyEmailAttach custom field
  // value ("yes" | "no" | "" if unset). Resolves to [] on any problem.
  async function fetchPoFiles() {
    const poId = getPoId();
    if (!poId) return [];
    const query = JSON.stringify({
      PurchaseOrderId: poId,
      $type: "PurchaseOrderAttachmentsQuery",
    });
    const url = "https://app.innergy.com/query/run?query=" + encodeURIComponent(query);
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return [];
      const json = await resp.json();
      return (json.data || [])
        .filter((it) => it && it.IsFolder === false && it.Name && it.Name.Url)
        .map((it) => ({
          name: (it.Name.DisplayName || it.Name.Title || "attachment").trim(),
          url: it.Name.Url,
          flag: String((it.CustomFields && it.CustomFields.innergyEmailAttach) || "")
            .trim()
            .toLowerCase(),
        }));
    } catch (e) {
      warn("Could not fetch PO files:", e);
      return [];
    }
  }

  // ---- Feature registry -------------------------------------------------------
  // Each feature file calls InnerCider.registerFeature({ id, mount }). `mount()`
  // must be cheap and idempotent — it runs on every SPA navigation/DOM mutation
  // (see bootstrap.js) and once on initial load. See docs/adding-a-feature.md.
  function registerFeature(feature) {
    features.push(feature);
  }

  window.InnerCider = {
    log,
    warn,
    innergy: {
      getPoId,
      getWorkOrderIds,
      fetchPoFiles,
      fetchWorkOrderInfo,
      fetchEmployeeGroupEmails,
    },
    registerFeature,
    _features: features,
  };
})();
