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

  // ---- button injection ------------------------------------------------------
  // We can't read the page's DevExtreme grid from this isolated world, so the
  // MAIN-world companion (change-order-wizard-main.js) tags each qualifying Name
  // cell with data-ic-co-id / data-ic-co-name. We just consume those tags here.
  function injectButtons() {
    if (!enabled || !onCOPage()) return;
    for (const td of document.querySelectorAll("td[data-ic-co-id]")) {
      if (td.querySelector("." + BTN_MARK)) continue;
      const co = { id: td.getAttribute("data-ic-co-id"), name: td.getAttribute("data-ic-co-name") || "Change Order" };
      if (!co.id) continue;
      td.insertBefore(makeButton(co), td.firstChild);
    }
    // Drop buttons whose cell is no longer tagged (row de-qualified or re-rendered).
    for (const b of document.querySelectorAll("." + BTN_MARK)) {
      const td = b.closest("td");
      if (!td || !td.hasAttribute("data-ic-co-id")) b.remove();
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

  // A form/document being auto-filled, with a magic sparkle.
  const WAND_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="3" y="5.2" width="11" height="14.6" rx="1.8" stroke="#0a0a0a" stroke-width="1.7"/>' +
    '<path d="M6 9.4H11M6 12.6H11.3M6 15.8H9.4" stroke="#0a0a0a" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M17.3 1 18.7 4.8 22.6 6.2 18.7 7.6 17.3 11.4 15.9 7.6 12 6.2 15.9 4.8Z" fill="#0a0a0a" stroke="#fff" stroke-width="0.8" stroke-linejoin="round"/>' +
    '<path d="M20.8 9.4 21.4 10.9 22.9 11.5 21.4 12.1 20.8 13.6 20.2 12.1 18.7 11.5 20.2 10.9Z" fill="#0a0a0a"/></svg>';

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
      '<div class="ic-cow-sheet"></div>' +
      '<div class="ic-cow-body"></div>' +
      '<div class="ic-cow-foot">' +
        '<button class="ic-cow-addloc" type="button">+ Add line item</button>' +
        '<div class="ic-cow-foot-right">' +
          '<span class="ic-cow-status"></span>' +
          '<button class="ic-cow-commit" type="button">Commit &amp; lock</button>' +
        '</div>' +
      '</div>';
    card.querySelector(".ic-cow-ttl h2").textContent = co.name;
    card.querySelector(".ic-cow-note").textContent =
      "Build the line items (takeoff locations) and products for this change order, then Commit — it opens the Takeoff and creates them there. Afterward, click Recalculate in the takeoff to update the CO total.";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    current = { co, entry, body: card.querySelector(".ic-cow-body"), sheetEl: card.querySelector(".ic-cow-sheet"), statusEl: card.querySelector(".ic-cow-status"), noteEl: card.querySelector(".ic-cow-note"), commitBtn: card.querySelector(".ic-cow-commit"), addLocBtn: card.querySelector(".ic-cow-addloc") };
    current._lastSig = committedSig(entry);
    card.querySelector(".ic-cow-x").addEventListener("click", closeWizard);
    current.addLocBtn.addEventListener("click", () => { entry.locations.push(blankLocation()); renderBody(); persist(); });
    current.commitBtn.addEventListener("click", commitAll);
    renderSheetPanel();
    renderBody();
    updateStatus();
    applySheetLock();
  }

  // ======================= Sheet import (Step 0) =============================
  // A change order's locations/products must be placed on a published Innergy
  // "sheet". The PM uploads a new blueprint here and we drive Innergy's
  // upload → burst/analyze → rename → publish pipeline via same-origin /Drawings/*
  // endpoints (cookie auth, no CSRF token). Until a sheet is published the
  // location/product form stays locked and Commit is disabled. The published
  // sheet is stored on the draft as entry.sheet. See the
  // innergy-sheets-upload-publish-api memory for the full API.

  const SHEET_HOST = "https://app.innergy.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); });
  }
  const okResp = (r) => !!(r && r.ok && r.data && r.data.IsSuccess !== false && (r.data.OutcomeType == null || r.data.OutcomeType === 0));

  function dbgLog(rec) { try { const l = JSON.parse(localStorage.getItem("__icSheetDbg") || "[]"); l.push(rec); localStorage.setItem("__icSheetDbg", JSON.stringify(l.slice(-20))); } catch (e) {} }
  function respSummary(data) { if (!data || typeof data !== "object") return { nonObj: true }; return { IsSuccess: data.IsSuccess, OutcomeType: data.OutcomeType, msg: (data.Messages && data.Messages[0] && data.Messages[0].Message) || null, keys: Object.keys(data).slice(0, 12) }; }
  async function drawingsGet(path, query) {
    const qs = query ? ("?" + new URLSearchParams(query).toString()) : "";
    const r = await fetch(SHEET_HOST + path + qs, { method: "GET", credentials: "include" });
    let data = null; try { data = JSON.parse(await r.text()); } catch (e) { /* non-json */ }
    dbgLog({ m: "GET", path, status: r.status, resp: respSummary(data) });
    return { ok: r.ok, status: r.status, data };
  }
  async function drawingsPost(path, body) {
    const r = await fetch(SHEET_HOST + path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = null; try { data = JSON.parse(await r.text()); } catch (e) { /* non-json */ }
    dbgLog({ m: "POST", path, status: r.status, reqKeys: body ? Object.keys(body) : null, resp: respSummary(data) });
    return { ok: r.ok, status: r.status, data };
  }
  async function drawingsUpload(pid, file) {
    const fd = new FormData();
    fd.append("blueprints", file, file.name);
    // projectType=1 (standard project) is REQUIRED — without it the server accepts
    // the file but never enqueues bursting, so no sheets are ever produced.
    const r = await fetch(SHEET_HOST + "/Drawings/BlueprintsUpload/Upload?projectId=" + encodeURIComponent(pid) + "&projectType=1", { method: "POST", credentials: "include", body: fd });
    let data = null; try { data = JSON.parse(await r.text()); } catch (e) { /* non-json */ }
    return { ok: r.ok, status: r.status, data };
  }

  // "CO-3 - Extra cabinets" → "CO003"; falls back to the trimmed CO name.
  function deriveSheetNumber(coName) {
    const m = String(coName || "").match(/(\d+)/);
    if (m) return "CO" + String(m[1]).slice(0, 3).padStart(3, "0");
    return String(coName || "").trim().slice(0, 20);
  }

  // Full pipeline. onStep(msg) reports progress. Returns the stored entry.sheet.
  async function uploadAndPublish(pid, file, number, onStep) {
    try { localStorage.removeItem("__icSheetDbg"); } catch (e) {}
    onStep("Uploading " + file.name + "…");
    const up = await drawingsUpload(pid, file);
    const batchId = up.data && up.data.batchId;
    if (!up.ok || (up.data && up.data.IsSuccess === false) || !batchId) {
      throw new Error((up.data && up.data.Messages && up.data.Messages[0] && up.data.Messages[0].Message) || "upload failed");
    }

    onStep("Analyzing sheet…");
    const asArray = (d) => Array.isArray(d) ? d : (d && Array.isArray(d.Data) ? d.Data : (d && Array.isArray(d.data) ? d.data : []));
    const fstatus = (f) => (f.status != null ? f.status : (f.Status != null ? f.Status : null));
    const fdone = (f) => { const s = fstatus(f); const pt = f.pagesTotal != null ? f.pagesTotal : f.PagesTotal; const pp = f.pagesProcessed != null ? f.pagesProcessed : f.PagesProcessed; return s === 2 && (pt == null || pp == null || pp >= pt); };
    for (let i = 0; i < 150; i++) { // ~3 min ceiling
      await sleep(1200);
      const st = await drawingsGet("/Drawings/BlueprintsProcessInfo/GetBurstingStatus", { projectId: pid, batchIds: batchId });
      const arr = asArray(st.data);
      const batch = arr.find((b) => b && (b.batchId === batchId || b.BatchId === batchId)) || arr[0];
      const files = (batch && (batch.files || batch.Files)) || [];
      if (files.some((f) => fstatus(f) === 3 || fstatus(f) === 4)) throw new Error("Innergy couldn't process this file (status " + fstatus(files[0]) + ").");
      if (files.length && files.every(fdone)) break;
      // Diagnostic: surface what the poll actually returns so a mismatch is visible.
      const diag = (!st.ok ? ("HTTP " + st.status + " ") : "") + (!arr.length ? "queued" : (!files.length ? "batch, no files" : files.map((f) => "st=" + fstatus(f) + " " + (f.pagesProcessed != null ? f.pagesProcessed : "?") + "/" + (f.pagesTotal != null ? f.pagesTotal : "?")).join(", ")));
      onStep("Analyzing sheet… (" + (i + 1) + ") — " + diag);
      if (i === 149) throw new Error("timed out analyzing (last: " + diag + ").");
    }

    const gd = await drawingsGet("/Drawings/SheetsRenaming/GetData", { batchId, projectId: pid });
    const sheets = (gd.data && gd.data.sheets) || [];
    if (!sheets.length) throw new Error("no sheet was produced from the upload.");
    const sheet = sheets[0]; // one page per CO upload

    // Versioning: warn if a sheet with this number already exists in the project.
    let versionIndex = 0;
    const prev = await drawingsPost("/Drawings/SheetsRenaming/GetPreviousVersions", { projectId: pid, numbers: [number] });
    const existing = prev.data && typeof prev.data === "object" && Object.keys(prev.data).length ? prev.data : null;
    if (existing) {
      if (!confirm('A sheet numbered "' + number + '" already exists in this project.\n\nPublish the uploaded file as a NEW VERSION of it?\n\n(Cancel to stop — you can pick a different number or use the existing sheet.)')) {
        throw new Error("__cancelled__");
      }
      versionIndex = 1; // best-effort next version; exact index TBD (see memory)
    }
    const name = number + "." + versionIndex;

    onStep('Naming sheet "' + name + '"…');
    if (!okResp(await drawingsPost("/Drawings/CommonRenaming/ChangeSheetNumber", { id: sheet.id, number }))) throw new Error("couldn't set the sheet number.");
    if (!okResp(await drawingsPost("/Drawings/CommonRenaming/ChangeSheetName", { id: sheet.id, name }))) throw new Error("couldn't set the sheet name.");

    onStep("Publishing…");
    const d = new Date();
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const pub = await drawingsPost("/Drawings/SheetsRenaming/Publish", {
      sheets: [{ id: sheet.id, name, number, redlineComments: null }],
      version: { id: uuid(), name: number, issueDate: { date: iso }, orderIndex: 0, $type: "SheetVersionSetDto" },
      autoTaggingEnabled: true, autoHyperlinkGenerationEnabled: true, minHyperlinkLength: 3,
      scaleDetectionEnabled: true, projectId: pid, workOrderAction: 3, batchId,
    });
    if (!okResp(pub)) throw new Error((pub.data && pub.data.Messages && pub.data.Messages[0] && pub.data.Messages[0].Message) || "publish failed.");

    return { source: "upload", published: true, sheetId: sheet.id, number, name, width: sheet.width, height: sheet.height, batchId };
  }

  // Is a usable sheet ready? (published/selected, or a legacy already-committed draft.)
  function sheetReady() {
    const e = current && current.entry;
    if (!e) return false;
    if (e.sheet && e.sheet.published && e.sheet.sheetId) return true;
    if ((e.locations || []).some((l) => l.committed)) return true; // pre-sheet-step drafts
    return false;
  }

  // Lock the location/product form + commit until a sheet is ready.
  function applySheetLock() {
    if (!current) return;
    const ready = sheetReady();
    current.body.classList.toggle("ic-cow-locked-form", !ready);
    if (current.commitBtn) current.commitBtn.disabled = !ready;
    if (current.addLocBtn) current.addLocBtn.disabled = !ready;
  }

  function renderSheetPanel() {
    if (!current) return;
    const { entry, sheetEl } = current;
    sheetEl.innerHTML = "";
    const s = entry.sheet;
    const legacyCommitted = !(s && s.published) && (entry.locations || []).some((l) => l.committed);
    if ((s && s.published && s.sheetId) || legacyCommitted) {
      const row = document.createElement("div"); row.className = "ic-cow-sheet-ready";
      const sub = legacyCommitted ? "committed earlier" : (s.source === "existing" ? "existing" : "published");
      row.innerHTML = '<span class="ic-cow-sheet-ic">✓</span><div class="ic-cow-sheet-txt"><b>Sheet ready</b><span>' +
        escapeHtml((s && (s.name || s.number)) || "sheet") + " · " + sub + "</span></div>";
      if (!legacyCommitted && !(entry.locations || []).some((l) => l.committed)) {
        const ch = document.createElement("button"); ch.type = "button"; ch.className = "ic-cow-sheet-change"; ch.textContent = "Change";
        ch.addEventListener("click", () => { entry.sheet = null; persist(); renderSheetPanel(); applySheetLock(); });
        row.appendChild(ch);
      }
      sheetEl.appendChild(row);
      return;
    }
    // Upload form.
    const wrap = document.createElement("div"); wrap.className = "ic-cow-sheet-form";
    wrap.innerHTML =
      '<div class="ic-cow-sheet-hd">Step 1 — attach a sheet for this change order</div>' +
      '<div class="ic-cow-sheet-grid">' +
        '<label class="ic-cow-sheet-file"><input type="file" accept=".pdf,.jpg,.jpeg,.tiff,.tif"><span class="ic-cow-sheet-fname">Choose a sheet (PDF/JPG/TIFF)…</span></label>' +
        '<label class="ic-cow-sheet-numwrap">Sheet #<input type="text" class="ic-cow-sheet-num" spellcheck="false"></label>' +
        '<button type="button" class="ic-cow-sheet-up" disabled>Upload &amp; publish</button>' +
      '</div>' +
      '<div class="ic-cow-sheet-prog" hidden></div>';
    sheetEl.appendChild(wrap);

    const fileInput = wrap.querySelector("input[type=file]");
    const fname = wrap.querySelector(".ic-cow-sheet-fname");
    const numInput = wrap.querySelector(".ic-cow-sheet-num");
    const upBtn = wrap.querySelector(".ic-cow-sheet-up");
    const prog = wrap.querySelector(".ic-cow-sheet-prog");
    numInput.value = entry.sheet && entry.sheet.number ? entry.sheet.number : deriveSheetNumber(entry.coName || (current.co && current.co.name));

    const refreshUp = () => { upBtn.disabled = !(fileInput.files && fileInput.files[0] && numInput.value.trim()); };
    fileInput.addEventListener("change", () => { fname.textContent = (fileInput.files && fileInput.files[0]) ? fileInput.files[0].name : "Choose a sheet (PDF/JPG/TIFF)…"; refreshUp(); });
    numInput.addEventListener("input", refreshUp);

    upBtn.addEventListener("click", async () => {
      const file = fileInput.files && fileInput.files[0];
      const number = numInput.value.trim();
      if (!file || !number) return;
      const pid = entry.projectId || projectId();
      if (!pid) { alert("Couldn't determine the project — reopen the wizard from the Change Orders grid."); return; }
      upBtn.disabled = true; fileInput.disabled = true; numInput.disabled = true;
      prog.hidden = false;
      const onStep = (m) => { prog.innerHTML = '<span class="ic-cow-spin"></span>' + escapeHtml(m); };
      try {
        const sheet = await uploadAndPublish(pid, file, number, onStep);
        entry.sheet = sheet; entry.updated = Date.now(); await saveCO(current.co.id, entry);
        renderSheetPanel(); applySheetLock(); updateStatus();
      } catch (e) {
        const msg = String(e && e.message || e);
        if (msg === "__cancelled__") { renderSheetPanel(); return; }
        prog.innerHTML = '<span class="ic-cow-err-ic">⚠</span>' + escapeHtml("Couldn't finish: " + msg);
        upBtn.disabled = false; fileInput.disabled = false; numInput.disabled = false;
      }
    });
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

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
    const idx = document.createElement("span"); idx.className = "ic-cow-loc-idx"; idx.textContent = "Line Item " + (li + 1);
    head.appendChild(idx);
    if (loc.committed) { const lk = document.createElement("span"); lk.className = "ic-cow-lock"; lk.textContent = "🔒 locked"; head.appendChild(lk); }
    else if (current.entry.locations.length > 1) {
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ic-cow-rm"; rm.textContent = "Remove";
      rm.addEventListener("click", () => { current.entry.locations.splice(li, 1); renderBody(); persist(); updateStatus(); });
      head.appendChild(rm);
    }
    wrap.appendChild(head);

    wrap.appendChild(field("Line Item (takeoff location)", textInput(loc.name, loc.committed, (v) => { loc.name = v; persist(); })));
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
    const pr = document.createElement("input"); pr.type = "text"; pr.className = "ic-cow-pprice"; pr.placeholder = "$0.00";
    pr.disabled = !!p.committed;
    // Show formatted US currency when not being edited; raw number while editing.
    pr.value = formatMoney(p.price);
    pr.addEventListener("focus", () => { if (!pr.disabled) pr.value = (p.price === "" || p.price == null) ? "" : String(p.price); });
    pr.addEventListener("input", () => {
      let v = pr.value.replace(/[^0-9.]/g, "");
      const parts = v.split(".");
      if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
      p.price = v; persist();
    });
    pr.addEventListener("blur", () => {
      const n = parseFloat(p.price);
      if (isNaN(n)) { p.price = ""; pr.value = ""; } else { p.price = String(n); pr.value = formatMoney(p.price); }
    });
    row.appendChild(nm); row.appendChild(pr);
    if (!p.committed && (loc.products.length > 1)) {
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ic-cow-rm sm"; rm.textContent = "×"; rm.title = "Remove product";
      rm.addEventListener("click", () => { loc.products.splice(pi, 1); renderBody(); persist(); updateStatus(); });
      row.appendChild(rm);
    }
    return row;
  }

  // US currency: 2 decimals + thousands separators. "" for blank/invalid.
  function formatMoney(v) {
    if (v === "" || v == null) return "";
    const n = parseFloat(v);
    if (isNaN(n)) return "";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      (locs || prods ? locs + " new line item" + (locs === 1 ? "" : "s") + ", " + prods + " product" + (prods === 1 ? "" : "s") + " ready" : "nothing to commit yet");
    applySheetLock();
  }

  function loadJobs() {
    return new Promise((res) => { try { chrome.storage.local.get("coCommitJobs", (d) => res((d && d.coCommitJobs) || {})); } catch (e) { res({}); } });
  }
  function commitNote(msg, tone) {
    if (!current || !current.noteEl) return;
    current.noteEl.textContent = msg;
    current.noteEl.style.color = tone === "err" ? "#b91c1c" : tone === "ok" ? "#15803d" : "#7c3aed";
  }

  function commitAll() {
    if (!current) return;
    // A published/selected sheet is required before anything can be placed.
    if (!sheetReady()) { alert("Attach a sheet first — upload and publish a sheet (or select an existing one) at the top of the wizard, then commit."); return; }
    // Validate the uncommitted items.
    const problems = [];
    current.entry.locations.forEach((loc, li) => {
      if (loc.committed) return;
      if (!(loc.name || "").trim()) problems.push("Line Item " + (li + 1) + " needs a name");
      (loc.products || []).forEach((p) => {
        if (p.committed) return;
        if ((p.name || "").trim() && !(String(p.price).trim())) problems.push('"' + p.name + '" needs a price');
      });
    });
    if (problems.length) { alert("Please fix:\n\n• " + problems.join("\n• ")); return; }

    const tid = current.entry.takeoffId || takeoffId();
    if (!tid) { alert("Couldn't find this project's Takeoff link on the page, so there's nowhere to push the records. Open the project's Takeoff once, then reopen this wizard."); return; }

    // Build the commit job from new (uncommitted), named items.
    const locations = current.entry.locations
      .filter((l) => !l.committed && (l.name || "").trim())
      .map((l) => ({
        name: (l.name || "").trim(), scope: (l.scope || "").trim(), done: false,
        products: (l.products || []).filter((p) => !p.committed && (p.name || "").trim())
          .map((p) => ({ name: (p.name || "").trim(), price: parseFloat(p.price) || 0, done: false })),
      }));
    if (!locations.length) { alert("Nothing new to commit."); return; }

    const job = { coId: current.co.id, coName: current.co.name, takeoffId: tid, projectId: current.entry.projectId || projectId(), status: "pending", created: Date.now(), locations, sheet: current.entry.sheet || null };
    loadJobs().then((jobs) => {
      // Block only a commit that's genuinely still running. A "running" job older
      // than a few minutes is stale (e.g. the takeoff tab was closed mid-commit) —
      // overwrite it rather than locking the user out forever.
      const ex = jobs[tid];
      const fresh = ex && ex.status === "running" && (Date.now() - (ex.created || 0)) < 90000;
      if (fresh) { alert("A commit for this project's takeoff is already in progress — let it finish first (or wait a couple of minutes and retry)."); return; }
      jobs[tid] = job;
      chrome.storage.local.set({ coCommitJobs: jobs }, () => {
        const w = window.open("https://app.innergy.com/Takeoff/" + tid, "_blank");
        commitNote(w ? "Creating records in the takeoff tab that just opened — keep it open until it reports done, then recalculate." : "Open the takeoff to finish (popup was blocked): /Takeoff/" + tid, "");
      });
    });
  }

  // A fingerprint of the *committed* state only — unchanged by live typing, so we
  // can ignore our own per-keystroke saves and re-render only when the takeoff tab
  // actually locks items (otherwise re-rendering mid-type steals input focus).
  function committedSig(e) {
    let n = e && e.pushed ? 1 : 0;
    for (const l of (e && e.locations) || []) { if (l.committed) n += 1000; for (const p of l.products || []) if (p.committed) n += 1; }
    return n;
  }

  // Reflect commit progress from the takeoff tab (it writes back to coWizard / coCommitJobs).
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !current) return;
    if (c.coWizard && c.coWizard.newValue) {
      const e = c.coWizard.newValue[current.co.id];
      if (e) {
        const sig = committedSig(e);
        if (sig !== current._lastSig) { // a real commit happened — not our own typing
          current._lastSig = sig;
          current.entry = e;
          if (!current.entry.locations || !current.entry.locations.length) current.entry.locations = [blankLocation()];
          renderSheetPanel(); renderBody(); updateStatus();
          if (e.pushed) commitNote("Committed to Innergy. Now click “Recalculate direct costs and labor” in the takeoff to update this CO's total.", "ok");
        }
      }
    }
    if (c.coCommitJobs && c.coCommitJobs.newValue) {
      const j = c.coCommitJobs.newValue[current.entry.takeoffId || takeoffId()];
      if (j && j.status === "failed") commitNote("Commit didn't finish: " + (j.error || "unknown error") + ". Your entries are kept — you can retry.", "err");
    }
  });

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
      .${BTN_MARK}{display:inline-flex;align-items:center;justify-content:center;width:22px;height:18px;
        margin:0 6px 0 0;vertical-align:middle;line-height:0;border:none;background:transparent;cursor:pointer;
        padding:0;flex:none;transition:transform .12s ease}
      .${BTN_MARK}:hover{transform:scale(1.18)}
      .${BTN_MARK} svg{width:18px;height:18px;display:block}
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
      .ic-cow-commit:disabled,.ic-cow-addloc:disabled{opacity:.5;cursor:not-allowed}
      /* Step 0 — sheet import */
      .ic-cow-sheet{padding:0 20px}
      .ic-cow-sheet:empty{display:none}
      .ic-cow-sheet-form{margin:14px 0 2px;border:1px solid #ddd6fe;background:#faf9ff;border-radius:10px;padding:12px 13px}
      .ic-cow-sheet-hd{font-size:12px;font-weight:700;color:#6d28d9;margin-bottom:9px}
      .ic-cow-sheet-grid{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
      .ic-cow-sheet-file{display:inline-flex;align-items:center;gap:8px;cursor:pointer;border:1px dashed #a78bfa;background:#fff;border-radius:7px;padding:7px 11px;font-size:12px;color:#6d28d9;font-weight:600;flex:1;min-width:200px}
      .ic-cow-sheet-file input{display:none}
      .ic-cow-sheet-fname{color:#475569;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ic-cow-sheet-numwrap{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#64748b}
      .ic-cow-sheet-num{width:110px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937}
      .ic-cow-sheet-up{cursor:pointer;border:none;background:#7c3aed;color:#fff;border-radius:7px;padding:8px 14px;font-size:12px;font-weight:700}
      .ic-cow-sheet-up:hover{background:#6d28d9}
      .ic-cow-sheet-up:disabled{opacity:.5;cursor:not-allowed}
      .ic-cow-sheet-prog{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#5b21b6}
      .ic-cow-sheet-ready{display:flex;align-items:center;gap:10px;margin:14px 0 2px;border:1px solid #bbf7d0;background:#f0fdf4;border-radius:10px;padding:10px 13px}
      .ic-cow-sheet-ic{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#16a34a;color:#fff;font-weight:800;font-size:13px;flex:none}
      .ic-cow-sheet-txt{display:flex;flex-direction:column;line-height:1.3;flex:1}
      .ic-cow-sheet-txt b{font-size:13px;color:#166534}
      .ic-cow-sheet-txt span{font-size:11px;color:#15803d}
      .ic-cow-sheet-change{cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:7px;padding:5px 11px;font-size:12px;font-weight:600}
      .ic-cow-sheet-change:hover{background:#f8fafc}
      .ic-cow-err-ic{color:#b91c1c;font-weight:800}
      .ic-cow-locked-form{opacity:.45;pointer-events:none;filter:grayscale(.3)}
      .ic-cow-spin{width:13px;height:13px;border:2px solid #ddd6fe;border-top-color:#7c3aed;border-radius:50%;animation:iccowSpin .7s linear infinite;flex:none}
      @keyframes iccowSpin{to{transform:rotate(360deg)}}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- debounced mount + poll ------------------------------------------------
  // The MAIN-world tagger marks cells via attributes, which the bootstrap
  // observer (childList only) doesn't see — so we also poll briefly while on the
  // Change Orders page to pick up newly-tagged rows.
  let evalTimer = null;
  function scheduleEval() {
    if (evalTimer) return;
    evalTimer = setTimeout(() => { evalTimer = null; try { injectButtons(); } catch (e) { IC.warn("co-wizard", e); } }, EVAL_DEBOUNCE_MS);
  }
  let pollStarted = false;
  function startPoll() {
    if (pollStarted) return;
    pollStarted = true;
    setInterval(() => { if (enabled && onCOPage()) try { injectButtons(); } catch (e) { /* ignore */ } }, 1000);
  }
  window.addEventListener("hashchange", () => { if (!onCOPage()) teardown(); scheduleEval(); });

  IC.registerFeature({ id: "change-order-wizard", mount: () => { startPoll(); scheduleEval(); } });
})();
