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
      "Build the locations and products for this change order, then Commit — it opens the Takeoff and creates them there. Afterward, click Recalculate in the takeoff to update the CO total.";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    current = { co, entry, body: card.querySelector(".ic-cow-body"), statusEl: card.querySelector(".ic-cow-status"), noteEl: card.querySelector(".ic-cow-note") };
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
      (locs || prods ? locs + " new location" + (locs === 1 ? "" : "s") + ", " + prods + " product" + (prods === 1 ? "" : "s") + " ready" : "nothing to commit yet");
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
    // Validate the uncommitted items.
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

    const job = { coId: current.co.id, coName: current.co.name, takeoffId: tid, projectId: current.entry.projectId || projectId(), status: "pending", created: Date.now(), locations };
    loadJobs().then((jobs) => {
      if (jobs[tid] && jobs[tid].status === "running") { alert("A commit for this project's takeoff is already in progress — let it finish first."); return; }
      jobs[tid] = job;
      chrome.storage.local.set({ coCommitJobs: jobs }, () => {
        const w = window.open("https://app.innergy.com/Takeoff/" + tid, "_blank");
        commitNote(w ? "Creating records in the takeoff tab that just opened — keep it open until it reports done, then recalculate." : "Open the takeoff to finish (popup was blocked): /Takeoff/" + tid, "");
      });
    });
  }

  // Reflect commit progress from the takeoff tab (it writes back to coWizard / coCommitJobs).
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !current) return;
    if (c.coWizard && c.coWizard.newValue) {
      const e = c.coWizard.newValue[current.co.id];
      if (e) {
        current.entry = e;
        if (!current.entry.locations || !current.entry.locations.length) current.entry.locations = [blankLocation()];
        renderBody(); updateStatus();
        if (e.pushed) commitNote("Committed to Innergy. Now click “Recalculate direct costs and labor” in the takeoff to update this CO's total.", "ok");
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
