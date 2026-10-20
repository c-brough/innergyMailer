/* InnerCider — Quick Change Order wizard (Phase 1: UI + detection, no writes)
 *
 * On a project's Change Orders grid (#/projects/<projId>/changeOrders), adds a
 * small wizard button to the left of each change order that is **Pending** with a
 * **$0 grand total cost** (fixed-price COs keep $0 cost even after priced products
 * are added, so the button stays available while the CO is pending — including on
 * revisit). Clicking it opens a wizard to build up **Locations** (name + scope),
 * each containing **Products** (name + price).
 *
 * PHASE 1 scope: the full UI, qualification detection, and local persistence only.
 * "Commit & lock" currently just locks the items in this wizard's own storage and
 * shows them read-only on revisit — it does NOT yet create records in Innergy.
 * Phase 2 wires commit to the Takeoff API (create location/product/price) and
 * Phase 3 auto-runs the takeoff recalc so the CO total populates. The mapping and
 * commands are documented in the innergy-changeorder-takeoff-api memory.
 *
 * Reads the project's takeoffId now (from the header TAKEOFF link) and stores it
 * with each CO's draft, ready for Phase 2.
 *
 * On by default; opt out in Options (changeOrderWizardEnabled). No network calls.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const CO_PAGE_RE = new RegExp("#/projects/(" + GUID + ")/changeOrders");
  const STORE_KEY = "coWizard"; // { [coId]: { coName, projectId, takeoffId, updated, locations:[…] } }
  const BTN_MARK = "ic-cow-btn";
  const EVAL_DEBOUNCE_MS = 400;

  // ---- enabled flag (opt-out) ------------------------------------------------
  let enabled = true;
  chrome.storage.local.get("changeOrderWizardEnabled", (d) => {
    enabled = d.changeOrderWizardEnabled !== false;
    if (!enabled) teardown(); else scheduleEval();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.changeOrderWizardEnabled) {
      enabled = c.changeOrderWizardEnabled.newValue !== false;
      if (!enabled) teardown(); else scheduleEval();
    }
  });

  // ---- page context ----------------------------------------------------------
  function projectId() {
    const m = (location.hash || "").match(CO_PAGE_RE);
    return m ? m[1] : null;
  }
  function onCOPage() { return !!projectId(); }

  // The project header's TAKEOFF link is `…/GoToTakeoff?id=<takeoffId>`.
  function takeoffId() {
    const a = document.querySelector('a[href*="GoToTakeoff"]');
    if (!a) return null;
    const m = (a.getAttribute("href") || "").match(/[?&]id=([0-9a-fA-F-]{20,})/);
    return m ? m[1] : null;
  }

  // ---- the change-orders grid (DevExtreme, via jQuery) -----------------------
  // The dxDataGrid instance is attached (via jQuery data) to the widget-root
  // `.dx-widget` div, not the inner `.dx-datagrid`. Scan widget roots and pick
  // the one whose data source holds change-order records.
  function findGrid() {
    const $ = window.jQuery;
    if (!$) return null;
    let grid = null;
    $(".dx-widget").each(function () {
      if (grid) return;
      const data = $(this).data();
      if (!data) return;
      for (const k in data) {
        const inst = data[k];
        if (inst && typeof inst.getVisibleRows === "function" && typeof inst.getCellElement === "function" && typeof inst.getDataSource === "function") {
          try {
            const items = inst.getDataSource().items();
            if (items && items[0] && "GrandTotalCost" in items[0] && "Status" in items[0]) { grid = inst; return; }
          } catch (e) { /* not this one */ }
        }
      }
    });
    return grid;
  }

  function qualifies(data) {
    return data && data.Status === "Pending" && data.GrandTotalCost && data.GrandTotalCost.Value === 0;
  }
  function coInfo(data) {
    const n = data.Name || {};
    return { id: n.ObjectId || null, name: n.DisplayName || n.Title || "Change Order" };
  }

  // ---- button injection ------------------------------------------------------
  function injectButtons() {
    if (!enabled || !onCOPage()) return;
    const grid = findGrid();
    if (!grid) return;
    let rows;
    try { rows = grid.getVisibleRows(); } catch (e) { return; }
    for (const r of rows || []) {
      if (!r || r.rowType !== "data" || !qualifies(r.data)) continue;
      const co = coInfo(r.data);
      if (!co.id) continue;
      let cell;
      try { cell = grid.getCellElement(r.rowIndex, "Name"); } catch (e) { cell = null; }
      const td = cell && (cell.length ? cell[0] : cell);
      if (!td || td.querySelector("." + BTN_MARK)) continue;
      td.insertBefore(makeButton(co), td.firstChild);
    }
  }

  function makeButton(co) {
    ensureStyle();
    const b = document.createElement("button");
    b.type = "button";
    b.className = BTN_MARK;
    b.title = "Quick Change Order wizard";
    b.innerHTML = WAND_SVG;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openWizard(co); });
    return b;
  }

  const WAND_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M5 19l9-9M14.5 6.5l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M16 3l.6 1.6L18 5l-1.4.6L16 7l-.6-1.4L14 5l1.4-.4L16 3zM6 7l.5 1.3L8 9l-1.5.6L6 11l-.5-1.4L4 9l1.5-.6L6 7z" fill="currentColor"/></svg>';

  // ---- storage ---------------------------------------------------------------
  function loadAll() {
    return new Promise((res) => {
      try { chrome.storage.local.get(STORE_KEY, (d) => res((d && d[STORE_KEY]) || {})); }
      catch (e) { res({}); }
    });
  }
  function saveCO(coId, entry) {
    return loadAll().then((all) => {
      all[coId] = entry;
      return new Promise((res) => { try { chrome.storage.local.set({ [STORE_KEY]: all }, res); } catch (e) { res(); } });
    });
  }

  function blankLocation() { return { name: "", scope: "", committed: false, products: [blankProduct()] }; }
  function blankProduct() { return { name: "", price: "", committed: false }; }

  // ---- wizard modal ----------------------------------------------------------
  let current = null; // { co, entry, root }

  async function openWizard(co) {
    ensureStyle();
    closeWizard();
    const all = await loadAll();
    const entry = all[co.id] || { coName: co.name, projectId: projectId(), takeoffId: takeoffId(), updated: 0, locations: [blankLocation()] };
    // keep context fresh
    entry.coName = co.name; entry.projectId = projectId(); entry.takeoffId = takeoffId() || entry.takeoffId || null;
    if (!entry.locations || !entry.locations.length) entry.locations = [blankLocation()];

    const overlay = document.createElement("div");
    overlay.id = "ic-cow-overlay";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeWizard(); });

    const card = document.createElement("div");
    card.id = "ic-cow-card";
    card.innerHTML =
      '<div class="ic-cow-head">' +
        '<div class="ic-cow-ttl"><span class="ic-cow-kicker">Quick Change Order</span><h2></h2></div>' +
        '<button class="ic-cow-x" type="button" title="Close">×</button>' +
      '</div>' +
      '<div class="ic-cow-note"></div>' +
      '<div class="ic-cow-body"></div>' +
      '<div class="ic-cow-foot">' +
        '<button class="ic-cow-addloc" type="button">+ Add location</button>' +
        '<div class="ic-cow-foot-right">' +
          '<span class="ic-cow-status"></span>' +
          '<button class="ic-cow-commit" type="button">Commit &amp; lock</button>' +
        '</div>' +
      '</div>';
    card.querySelector(".ic-cow-ttl h2").textContent = co.name;
    card.querySelector(".ic-cow-note").textContent =
      "Build the locations and products for this change order. Phase 1: Commit locks them here; pushing to Innergy comes next.";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    current = { co, entry, body: card.querySelector(".ic-cow-body"), statusEl: card.querySelector(".ic-cow-status") };
    card.querySelector(".ic-cow-x").addEventListener("click", closeWizard);
    card.querySelector(".ic-cow-addloc").addEventListener("click", () => { entry.locations.push(blankLocation()); renderBody(); persist(); });
    card.querySelector(".ic-cow-commit").addEventListener("click", commitAll);
    renderBody();
    updateStatus();
  }

  function renderBody() {
    if (!current) return;
    const { entry, body } = current;
    body.innerHTML = "";
    entry.locations.forEach((loc, li) => body.appendChild(renderLocation(loc, li)));
  }

  function renderLocation(loc, li) {
    const wrap = document.createElement("div");
    wrap.className = "ic-cow-loc" + (loc.committed ? " ic-locked" : "");
    const head = document.createElement("div"); head.className = "ic-cow-loc-head";
    const idx = document.createElement("span"); idx.className = "ic-cow-loc-idx"; idx.textContent = "Location " + (li + 1);
    head.appendChild(idx);
    if (loc.committed) { const lk = document.createElement("span"); lk.className = "ic-cow-lock"; lk.textContent = "🔒 locked"; head.appendChild(lk); }
    else if (current.entry.locations.length > 1) {
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ic-cow-rm"; rm.textContent = "Remove";
      rm.addEventListener("click", () => { current.entry.locations.splice(li, 1); renderBody(); persist(); updateStatus(); });
      head.appendChild(rm);
    }
    wrap.appendChild(head);

    wrap.appendChild(field("Location name", textInput(loc.name, loc.committed, (v) => { loc.name = v; persist(); })));
    wrap.appendChild(field("Scope", textArea(loc.scope, loc.committed, (v) => { loc.scope = v; persist(); })));

    const prods = document.createElement("div"); prods.className = "ic-cow-prods";
    const plabel = document.createElement("div"); plabel.className = "ic-cow-sublabel"; plabel.textContent = "Products";
    prods.appendChild(plabel);
    (loc.products || []).forEach((p, pi) => prods.appendChild(renderProduct(loc, p, pi)));
    if (!loc.committed) {
      const addp = document.createElement("button"); addp.type = "button"; addp.className = "ic-cow-addprod"; addp.textContent = "+ Add product";
      addp.addEventListener("click", () => { loc.products.push(blankProduct()); renderBody(); persist(); updateStatus(); });
      prods.appendChild(addp);
    }
    wrap.appendChild(prods);
    return wrap;
  }

  function renderProduct(loc, p, pi) {
    const row = document.createElement("div"); row.className = "ic-cow-prod" + (p.committed ? " ic-locked" : "");
    const nm = textInput(p.name, p.committed, (v) => { p.name = v; persist(); }); nm.placeholder = "Product name";
    nm.classList.add("ic-cow-pname");
    const pr = document.createElement("input"); pr.type = "text"; pr.className = "ic-cow-pprice"; pr.placeholder = "$ price";
    pr.value = p.price === "" || p.price == null ? "" : String(p.price);
    pr.disabled = !!p.committed;
    pr.addEventListener("input", () => { p.price = pr.value.replace(/[^0-9.]/g, ""); persist(); });
    row.appendChild(nm); row.appendChild(pr);
    if (!p.committed && (loc.products.length > 1)) {
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ic-cow-rm sm"; rm.textContent = "×"; rm.title = "Remove product";
      rm.addEventListener("click", () => { loc.products.splice(pi, 1); renderBody(); persist(); updateStatus(); });
      row.appendChild(rm);
    }
    return row;
  }

  // ---- small input helpers ---------------------------------------------------
  function field(label, inputEl) {
    const w = document.createElement("label"); w.className = "ic-cow-field";
    const l = document.createElement("span"); l.className = "ic-cow-flabel"; l.textContent = label;
    w.appendChild(l); w.appendChild(inputEl); return w;
  }
  function textInput(val, disabled, onInput) {
    const i = document.createElement("input"); i.type = "text"; i.className = "ic-cow-input"; i.value = val || ""; i.disabled = !!disabled;
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }
  function textArea(val, disabled, onInput) {
    const t = document.createElement("textarea"); t.className = "ic-cow-textarea"; t.rows = 2; t.value = val || ""; t.disabled = !!disabled;
    t.addEventListener("input", () => onInput(t.value));
    return t;
  }

  // ---- persistence / status --------------------------------------------------
  let persistTimer = null;
  function persist() {
    if (!current) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      current.entry.updated = Date.now();
      saveCO(current.co.id, current.entry);
      updateStatus();
    }, 250);
  }

  function countPending() {
    let locs = 0, prods = 0;
    for (const loc of current.entry.locations) {
      const named = (loc.name || "").trim();
      if (!loc.committed && named) locs++;
      for (const p of (loc.products || [])) if (!p.committed && (p.name || "").trim()) prods++;
    }
    return { locs, prods };
  }
  function updateStatus() {
    if (!current) return;
    const committed = current.entry.locations.filter((l) => l.committed).length;
    const { locs, prods } = countPending();
    current.statusEl.textContent =
      (committed ? committed + " locked · " : "") +
      (locs || prods ? locs + " new location" + (locs === 1 ? "" : "s") + ", " + prods + " product" + (prods === 1 ? "" : "s") + " ready" : "nothing to commit yet");
  }

  function commitAll() {
    if (!current) return;
    // Phase 1: validate, then lock locally (no Innergy write yet).
    const problems = [];
    current.entry.locations.forEach((loc, li) => {
      if (loc.committed) return;
      if (!(loc.name || "").trim()) problems.push("Location " + (li + 1) + " needs a name");
      (loc.products || []).forEach((p) => {
        if (p.committed) return;
        if ((p.name || "").trim() && !(String(p.price).trim())) problems.push('"' + p.name + '" needs a price');
      });
    });
    if (problems.length) { alert("Please fix:\n\n• " + problems.join("\n• ")); return; }
    for (const loc of current.entry.locations) {
      if ((loc.name || "").trim()) loc.committed = true;
      loc.products = (loc.products || []).filter((p) => (p.name || "").trim());
      for (const p of loc.products) p.committed = true;
    }
    current.entry.updated = Date.now();
    saveCO(current.co.id, current.entry).then(() => { renderBody(); updateStatus(); });
  }

  function closeWizard() { const o = document.getElementById("ic-cow-overlay"); if (o) o.remove(); current = null; }

  // ---- teardown --------------------------------------------------------------
  function teardown() {
    closeWizard();
    for (const b of document.querySelectorAll("." + BTN_MARK)) b.remove();
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("ic-cow-style")) return;
    const st = document.createElement("style");
    st.id = "ic-cow-style";
    st.textContent = `
      .${BTN_MARK}{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
        margin-right:7px;vertical-align:middle;border:1px solid #c4b5fd;border-radius:6px;background:#f5f3ff;
        color:#6d28d9;cursor:pointer;padding:0;flex:none}
      .${BTN_MARK}:hover{background:#ede9fe;border-color:#a78bfa}
      .${BTN_MARK} svg{width:14px;height:14px}
      #ic-cow-overlay{position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,42,.5);
        display:flex;align-items:center;justify-content:center;
        font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}
      #ic-cow-card{width:72vw;max-width:900px;max-height:85vh;background:#fff;color:#1f2937;border-radius:14px;
        box-shadow:0 24px 70px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden}
      .ic-cow-head{display:flex;align-items:flex-start;gap:12px;padding:16px 20px;border-bottom:1px solid #e5e7eb}
      .ic-cow-ttl{flex:1}
      .ic-cow-kicker{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7c3aed}
      .ic-cow-ttl h2{margin:2px 0 0;font-size:17px;font-weight:700}
      .ic-cow-x{cursor:pointer;border:none;background:#f3f4f6;width:30px;height:30px;border-radius:8px;font-size:17px;color:#374151;flex:none}
      .ic-cow-x:hover{background:#e5e7eb}
      .ic-cow-note{padding:10px 20px;font-size:12px;color:#64748b;background:#faf9ff;border-bottom:1px solid #f1eefe}
      .ic-cow-body{padding:14px 20px;overflow:auto}
      .ic-cow-loc{border:1px solid #e5e7eb;border-radius:10px;padding:12px 13px;margin-bottom:12px;background:#fff}
      .ic-cow-loc.ic-locked{background:#f8fafc;border-color:#e2e8f0}
      .ic-cow-loc-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
      .ic-cow-loc-idx{font-size:12px;font-weight:700;color:#334155;flex:1}
      .ic-cow-lock{font-size:11px;font-weight:700;color:#0f766e;background:#ccfbf1;border-radius:6px;padding:2px 8px}
      .ic-cow-rm{cursor:pointer;border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:3px 9px;font-size:12px;font-weight:600}
      .ic-cow-rm:hover{background:#fef2f2}
      .ic-cow-rm.sm{padding:0;width:24px;height:24px;flex:none;font-size:14px;line-height:1}
      .ic-cow-field{display:block;margin-bottom:8px}
      .ic-cow-flabel{display:block;font-size:11px;font-weight:600;color:#64748b;margin-bottom:3px}
      .ic-cow-input,.ic-cow-textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;
        padding:7px 9px;font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#fff}
      .ic-cow-input:disabled,.ic-cow-textarea:disabled,.ic-cow-pname:disabled,.ic-cow-pprice:disabled{background:#f1f5f9;color:#475569}
      .ic-cow-textarea{resize:vertical}
      .ic-cow-prods{margin-top:8px;padding-top:8px;border-top:1px dashed #e5e7eb}
      .ic-cow-sublabel{font-size:11px;font-weight:700;color:#475569;margin-bottom:6px}
      .ic-cow-prod{display:flex;align-items:center;gap:8px;margin-bottom:6px}
      .ic-cow-pname{flex:1}
      .ic-cow-pprice{width:110px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;font:13px -apple-system,Segoe UI,Roboto,sans-serif}
      .ic-cow-addprod,.ic-cow-addloc{cursor:pointer;border:1px dashed #a78bfa;background:#f5f3ff;color:#6d28d9;border-radius:7px;padding:6px 11px;font-size:12px;font-weight:600}
      .ic-cow-addprod:hover,.ic-cow-addloc:hover{background:#ede9fe}
      .ic-cow-foot{display:flex;align-items:center;gap:12px;padding:13px 20px;border-top:1px solid #e5e7eb;background:#fafafa}
      .ic-cow-foot-right{margin-left:auto;display:flex;align-items:center;gap:12px}
      .ic-cow-status{font-size:12px;color:#64748b}
      .ic-cow-commit{cursor:pointer;border:none;background:#7c3aed;color:#fff;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700}
      .ic-cow-commit:hover{background:#6d28d9}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- debounced mount -------------------------------------------------------
  let evalTimer = null;
  function scheduleEval() {
    if (evalTimer) return;
    evalTimer = setTimeout(() => { evalTimer = null; try { injectButtons(); } catch (e) { IC.warn("co-wizard", e); } }, EVAL_DEBOUNCE_MS);
  }
  window.addEventListener("hashchange", () => { if (!onCOPage()) teardown(); scheduleEval(); });

  IC.registerFeature({ id: "change-order-wizard", mount: scheduleEval });
})();
