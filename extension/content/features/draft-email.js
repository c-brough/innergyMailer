/* InnerCider — Draft Email feature (purchase orders)
 *
 * Injects a "Draft Email w/ PDF" button immediately to the LEFT of the
 * existing "Export Custom PDF" button on purchase-order pages. Innergy renders
 * the same export button on work-order pages too; the button is deliberately
 * not added there.
 *
 * When clicked it:
 *   1. Scrapes subject/body/recipient from the page (PO number, vendor, vendor
 *      contact email, Materials grid) and offers the PO's own file attachments
 *      for inclusion.
 *   2. Asks the background worker to start watching for the next download.
 *   3. Arms the MAIN-world window.open hook (see export-capture-main.js).
 *   4. Clicks the real export button the user picked in Options: "Generate
 *      PDF" (Innergy's standard PO PDF — the default) or "Export Custom PDF".
 * Either export ends in window.open of the PDF's URL (directly, or via a blank
 * tab it then navigates — see export-capture-main.js); the hook hands that URL
 * back here and we forward it to the background worker, which downloads it
 * and passes the file + subject/body to the native messaging host, which
 * creates the Mail draft. The URL path is what makes this work whether the
 * user's Chrome PDF setting is "download" or "open in Chrome" — the download
 * watcher only ever fires under the former.
 */

(() => {
  "use strict";

  const IC = window.InnerCider;
  const EXPORT_BTN_SELECTOR = 'button[data-testid="ExportCustomReportDefault_single"]';
  const GENERATE_BTN_SELECTOR = 'button[data-testid="generate_pdf"]';
  const OUR_BTN_ID = "innercider-draft-email-btn";

  // ---- PDF source setting --------------------------------------------------------
  // Which Innergy button produces the attached PDF. Stored as `pdfSource` in
  // chrome.storage.local by the Options page: "generate" (the default) or
  // "custom". Cached here so the click handler can read it synchronously.

  const PDF_SOURCES = {
    generate: { label: "Generate PDF", find: () => document.querySelector(GENERATE_BTN_SELECTOR) },
    custom: { label: "Export Custom PDF", find: () => document.querySelector(EXPORT_BTN_SELECTOR) },
  };
  const DEFAULT_PDF_SOURCE = "generate";
  let pdfSource = DEFAULT_PDF_SOURCE;

  chrome.storage.local.get("pdfSource", (data) => {
    if (PDF_SOURCES[data.pdfSource]) pdfSource = data.pdfSource;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.pdfSource) return;
    const next = changes.pdfSource.newValue;
    pdfSource = PDF_SOURCES[next] ? next : DEFAULT_PDF_SOURCE;
  });

  // ---- Pricing setting -----------------------------------------------------------
  // Whether to include each line item's extended cost in the email body. Stored
  // as `includePricing` in chrome.storage.local by the Options page; OFF by
  // default. Cached so buildSummary can read it synchronously.

  let includePricing = false;
  chrome.storage.local.get("includePricing", (data) => {
    includePricing = data.includePricing === true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.includePricing) return;
    includePricing = changes.includePricing.newValue === true;
  });

  // ---- Mail-app setting (cached) --------------------------------------------------
  // Only the "outlook_web_modal" value changes behavior here: it pops a compose
  // modal and sends via Graph. Every other value keeps the hand-off-to-host flow.
  let mailApp = "";
  chrome.storage.local.get("mailApp", (data) => { mailApp = data.mailApp || ""; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.mailApp) mailApp = changes.mailApp.newValue || "";
  });

  // The button to click for this draft: the chosen source, falling back to the
  // other one if Innergy isn't showing it, so the feature still produces a PDF.
  function findSourceBtn() {
    const chosen = PDF_SOURCES[pdfSource];
    const btn = chosen.find();
    if (btn) return { btn, label: chosen.label };
    const otherKey = pdfSource === "generate" ? "custom" : "generate";
    const other = PDF_SOURCES[otherKey];
    const fallback = other.find();
    if (fallback) {
      IC.warn(`"${chosen.label}" button not found; using "${other.label}" instead.`);
      return { btn: fallback, label: other.label };
    }
    return null;
  }

  // ---- DOM scraping -----------------------------------------------------------

  function getPoNumber() {
    // Prefer the page header, then the breadcrumb, then the tab title.
    const header = document.querySelector('[data-testid="purchase-order-header"]');
    const candidates = [
      header && header.textContent,
      document.querySelector('[data-testid="breadcrumbs"]')?.textContent,
      document.title,
    ];
    for (const text of candidates) {
      const m = text && text.match(/PO-\d+/i);
      if (m) return m[0];
    }
    return "PO";
  }

  function getVendorName() {
    // Find the "Vendor (Company - Office)" label, then the nearest link value.
    const labels = Array.from(document.querySelectorAll("label, span, div"));
    const label = labels.find(
      (el) => el.children.length === 0 && /Vendor\s*\(Company/i.test(el.textContent)
    );
    if (label) {
      let group = label;
      for (let i = 0; i < 5 && group; i++) {
        group = group.parentElement;
        const link = group && group.querySelector("a");
        if (link && link.textContent.trim()) return link.textContent.trim();
      }
    }
    // Fallback: first link tagged data-testid="link".
    const fallback = document.querySelector('a[data-testid="link"]');
    return fallback ? fallback.textContent.trim() : "Vendor";
  }

  function getVendorContactEmail() {
    // Prefer the email anchored to the "Contact Phone # and Email" label so we
    // don't grab some unrelated mailto link elsewhere on the page.
    const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const nodes = Array.from(document.querySelectorAll("label, span, div"));
    const label = nodes.find(
      (el) => el.children.length === 0 && /Contact Phone\s*#?\s*and Email/i.test(el.textContent)
    );
    if (label) {
      let group = label;
      for (let i = 0; i < 5 && group; i++) {
        group = group.parentElement;
        const m = group && group.textContent.match(emailRe);
        if (m) return m[0];
      }
    }
    // Fallback: first mailto link on the page.
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) {
      const href = mailto.getAttribute("href").replace(/^mailto:/i, "").trim();
      if (href) return href;
    }
    return "";
  }

  // Materials line items. Primary source is the MAIN-world reader
  // (materials-read-main.js): it pulls them straight from the DevExtreme grid's
  // row data, which is robust to Innergy's column/DOM changes and is the only
  // place the per-line Project and Work Order names exist. If that can't answer
  // (jQuery/DevExtreme internals changed, grid not ready), fall back to scraping
  // the rendered grid by its column headers.

  const MATERIALS_TIMEOUT_MS = 1500;

  function requestMaterialsFromMain() {
    return new Promise((resolve) => {
      const requestId = "mat_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMsg);
        resolve(val);
      };
      function onMsg(ev) {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.source !== "innercider-main" || m.type !== "MATERIALS_RESULT") return;
        if (m.requestId !== requestId) return;
        finish(Array.isArray(m.items) ? m.items : null);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "innercider", type: "READ_MATERIALS", requestId }, location.origin);
      setTimeout(() => finish(null), MATERIALS_TIMEOUT_MS);
    });
  }

  // Fallback DOM scrape: map columns by header label -> aria-colindex (robust to
  // reordering and to the grid being nested more deeply than before), then read
  // each data row's cells by that index. Project/Work Order aren't rendered as
  // cells, so they're left empty here — only the MAIN-world reader has them.
  function scrapeMaterialsFromDom() {
    const headers = Array.from(document.querySelectorAll('[role="columnheader"]'));
    const col = {};
    for (const h of headers) {
      const label = h.textContent.trim();
      const ci = h.getAttribute("aria-colindex");
      if (label && ci && !(label in col)) col[label] = ci;
    }
    const nameCi = col["Material Name"];
    if (!nameCi) return [];
    const grid = Array.from(document.querySelectorAll('[role="grid"]')).find((g) =>
      g.querySelector(`[role="gridcell"][aria-colindex="${nameCi}"]`)
    );
    if (!grid) return [];
    const items = [];
    for (const row of grid.querySelectorAll('[role="row"]')) {
      const read = (label) => {
        const ci = col[label];
        const c = ci && row.querySelector(`[role="gridcell"][aria-colindex="${ci}"]`);
        return c ? c.textContent.trim() : "";
      };
      const name = read("Material Name");
      if (!name) continue;
      items.push({
        name,
        uom: read("UoM"),
        qty: read("Quantity Ordered"),
        unitCost: read("Expected Unit Cost"),
        extendedCost: read("Extended Cost"),
        notes: read("Notes"),
        projects: [],
        workOrders: [],
      });
    }
    return items;
  }

  async function getMaterials() {
    const fromMain = await requestMaterialsFromMain();
    if (fromMain && fromMain.length) return fromMain;
    return scrapeMaterialsFromDom();
  }

  function buildSummary(items, withPricing) {
    if (!items.length) return "No materials line items found on the PO page.";
    const lines = items.map((it) => {
      // Quantity (with UoM) always shows; unit + extended price only with pricing on.
      let inside = [it.qty, it.uom].filter(Boolean).join(" ");
      if (withPricing) {
        if (it.unitCost) inside += ` @ ${it.unitCost}`;
        if (it.extendedCost) inside += ` = ${it.extendedCost}`;
      }
      const qtyPart = inside ? ` (${inside})` : "";
      const projects = (it.projects || []).filter(Boolean);
      const workOrders = (it.workOrders || []).filter(Boolean);
      let tags = "";
      if (projects.length) tags += ` — Project: ${projects.join(", ")}`;
      if (workOrders.length) tags += ` — WO: ${workOrders.join(", ")}`;
      let line = `• ${it.name}${qtyPart}${tags}`;
      const note = IC.htmlToText(it.notes || "");
      if (note) line += `\n    Note: ${note.replace(/\n/g, "\n    ")}`;
      return line;
    });
    const count = items.length;
    const header = `${count} material line item${count === 1 ? "" : "s"}:`;
    return `${header}\n${lines.join("\n")}`;
  }

  // When every line item shares the same project(s) AND the same work order(s),
  // return "Project - WorkOrder" (dropping whichever is empty) for the subject;
  // otherwise "" (values are mixed across lines, so nothing is added).
  function commonLineTag(items) {
    if (!items.length) return "";
    const commonOf = (key) => {
      const sigs = items.map((it) => (it[key] || []).filter(Boolean).slice().sort().join(", "));
      const first = sigs[0];
      return first && sigs.every((s) => s === first) ? first : "";
    };
    return [commonOf("projects"), commonOf("workOrders")].filter(Boolean).join(" - ");
  }

  // Decide which files to attach from the innergyEmailAttach flag:
  //   yes -> attach, no -> skip, anything else -> ask the user.
  function categorizeFiles(files) {
    const include = [];
    const undecided = [];
    for (const f of files) {
      if (f.flag === "yes") include.push(f);
      else if (f.flag === "no") continue;
      else undecided.push(f);
    }
    return { include, undecided };
  }

  // ---- MAIN-world bridge -------------------------------------------------------
  // export-capture-main.js patches window.open inside the page's own world and
  // posts the export PDF's URL back here. See that file for why it has to live
  // there. We keep our own arm window rather than trusting the message: it
  // arrives over window.postMessage, which the page itself could send, so this
  // only ever relays a URL we asked for and only while we're expecting one.
  // Mirrors the hook's own timeout — an export that never fires disarms both.

  const CAPTURE_TIMEOUT_MS = 60_000;
  let captureArmedUntil = 0;

  function armExportCapture() {
    captureArmedUntil = Date.now() + CAPTURE_TIMEOUT_MS;
    window.postMessage({ source: "innercider", type: "ARM_EXPORT_CAPTURE" }, location.origin);
  }

  function disarmExportCapture() {
    captureArmedUntil = 0;
    window.postMessage({ source: "innercider", type: "DISARM_EXPORT_CAPTURE" }, location.origin);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== "innercider-main" || msg.type !== "EXPORT_PDF_URL") return;
    if (Date.now() >= captureArmedUntil) return;
    captureArmedUntil = 0;
    IC.log("captured export PDF url", msg.url);
    chrome.runtime.sendMessage({ type: "EXPORT_PDF_URL", url: msg.url }, () => {
      void chrome.runtime.lastError; // worker may have restarted; background re-checks state
    });
  });

  // ---- Button injection -------------------------------------------------------

  function makeButton(exportBtn) {
    const btn = document.createElement("button");
    btn.id = OUR_BTN_ID;
    btn.type = "button";
    btn.textContent = "Draft Email w/ PDF";
    // Borrow the export button's classes so it matches the toolbar styling.
    btn.className = exportBtn.className;
    btn.style.marginRight = "6px";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function injectButton() {
    // Purchase orders only — the same export button also appears on work-order
    // pages. Remove ours if the SPA navigated away from a PO without replacing
    // the toolbar.
    if (!IC.innergy.getPoId()) {
      document.getElementById(OUR_BTN_ID)?.remove();
      return;
    }
    // Anchor on Export Custom PDF where it exists (the button's long-standing
    // spot), else next to Generate PDF.
    const anchor =
      document.querySelector(EXPORT_BTN_SELECTOR) || document.querySelector(GENERATE_BTN_SELECTOR);
    if (!anchor) return;
    if (document.getElementById(OUR_BTN_ID)) return; // already injected
    const btn = makeButton(anchor);
    anchor.parentElement.insertBefore(btn, anchor);
  }

  // ---- Click handler ------------------------------------------------------------

  async function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    const source = findSourceBtn();
    if (!source) {
      alert(`InnerCider: couldn't find the ${PDF_SOURCES[pdfSource].label} button.`);
      return;
    }
    const exportBtn = source.btn;
    IC.log(`PDF source: ${source.label}`);

    const me = ev.currentTarget;
    const original = me.textContent;
    me.disabled = true;

    const resetButton = () => {
      me.textContent = original;
      me.disabled = false;
    };

    const poNumber = getPoNumber();
    const vendor = getVendorName();
    const to = getVendorContactEmail();
    const items = await getMaterials();
    const poNotes = await IC.innergy.fetchPoNotes();

    const tag = commonLineTag(items);
    const subject = tag ? `${poNumber} - ${vendor} - ${tag}` : `${poNumber} - ${vendor}`;
    const body =
      `Hello,\n\n` +
      `Please find attached purchase order ${poNumber}${vendor ? ` for ${vendor}` : ""}. ` +
      `A summary of the ordered items is below, with the full purchase order attached as a PDF.\n\n` +
      `Purchase Order:  ${poNumber}\n` +
      (vendor ? `Vendor:          ${vendor}\n` : "") +
      `\nItems\n` +
      `${buildSummary(items, includePricing)}\n` +
      (poNotes ? `\nNotes\n${poNotes}\n` : "") +
      `\nPlease confirm receipt of this order and the expected ship date.\n\n` +
      `Thank you,\n`;

    if (!to) {
      IC.warn("No vendor contact email found; drafting without a recipient.");
    }

    me.textContent = "Checking files…";

    const draftContext = {
      exportBtn,
      subject,
      body,
      recipients: to ? [to] : [],
      docNumber: poNumber,
      me,
      original,
    };

    // Collect files attached to the PO and decide per the innergyEmailAttach flag.
    const files = await IC.innergy.fetchPoFiles();
    const { include, undecided } = categorizeFiles(files);
    IC.log(
      `files: ${files.length} (yes=${include.length}, ask=${undecided.length})`,
      { include: include.map((f) => f.name), undecided: undecided.map((f) => f.name) }
    );

    // Compose-and-send option: open a compose modal (To/Subject/Body editable,
    // PO PDF attached automatically) and send via Graph on click. The Send click
    // is the user gesture the export download needs.
    if (mailApp === "outlook_web_modal") {
      openComposeModal(draftContext, undecided, {
        onSend: (edited, checked) => {
          draftContext.subject = edited.subject;
          draftContext.body = edited.body;
          draftContext.recipients = edited.recipients;
          startDraft(draftContext, include.concat(checked));
        },
        onCancel: resetButton,
      });
      return;
    }

    if (undecided.length === 0) {
      // Nothing to ask — proceed. (Still within the user gesture window.)
      startDraft(draftContext, include);
      return;
    }

    // Some files have no innergyEmailAttach value: ask which to include. The
    // export is triggered from the dialog's confirm click so the browser still
    // sees a user gesture (required for the export download to fire).
    showFilePrompt(undecided, {
      onConfirm: (checked) => startDraft(draftContext, include.concat(checked)),
      onCancel: resetButton,
    });
  }

  // Arm the background watcher and trigger the real export. `files` is the final
  // list of { name, url } to attach alongside the exported PDF.
  function startDraft(ctx, files) {
    const { exportBtn, subject, body, recipients, docNumber, me, original } = ctx;
    me.textContent = "Exporting…";
    me.disabled = true;

    // Arm the window.open hook first: the background round-trip below gives the
    // MAIN world's message listener time to run before the export can fire.
    armExportCapture();

    const payload = files.map((f) => ({ name: f.name, url: f.url }));
    const msg = { type: "EXPORT_AND_MAIL", subject, body, recipients, docNumber, files: payload };
    IC.log("click → arming", {
      docNumber,
      recipients: recipients.length,
      subject,
      files: payload.length,
    });
    chrome.runtime.sendMessage(msg, (resp) => {
      IC.log("arm response:", resp);
      if (chrome.runtime.lastError || !resp || !resp.armed) {
        disarmExportCapture();
        me.textContent = original;
        me.disabled = false;
        alert(
          "InnerCider: background worker did not respond. Is the extension loaded correctly?"
        );
        return;
      }
      // Trigger the real export.
      exportBtn.click();
      me.textContent = "Drafting…";
      setTimeout(() => {
        me.textContent = original;
        me.disabled = false;
      }, 4000);
    });
  }

  // ---- File selection prompt ---------------------------------------------------

  function showFilePrompt(files, { onConfirm, onCancel }) {
    // Remove any existing prompt first.
    const prev = document.getElementById("innercider-file-prompt");
    if (prev) prev.remove();

    const overlay = document.createElement("div");
    overlay.id = "innercider-file-prompt";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,.45)",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      font: "14px -apple-system, system-ui, sans-serif",
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#fff",
      color: "#1a1a1a",
      borderRadius: "10px",
      padding: "20px 22px",
      width: "420px",
      maxWidth: "90vw",
      maxHeight: "80vh",
      overflowY: "auto",
      boxShadow: "0 8px 30px rgba(0,0,0,.3)",
    });

    const h = document.createElement("div");
    h.textContent = "Attach PO files?";
    Object.assign(h.style, { fontWeight: "700", fontSize: "16px", marginBottom: "4px" });

    const sub = document.createElement("div");
    sub.textContent =
      "These files have no innergyEmailAttach setting. Check the ones to include:";
    Object.assign(sub.style, { color: "#666", marginBottom: "14px" });

    const list = document.createElement("div");
    const checkboxes = files.map((f) => {
      const row = document.createElement("label");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "7px 0",
        cursor: "pointer",
      });
      const cb = document.createElement("input");
      cb.type = "checkbox";
      Object.assign(cb.style, { width: "16px", height: "16px" });
      const span = document.createElement("span");
      span.textContent = f.name;
      row.appendChild(cb);
      row.appendChild(span);
      list.appendChild(row);
      return { cb, file: f };
    });

    const btns = document.createElement("div");
    Object.assign(btns.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "18px",
    });
    const mkBtn = (label, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      Object.assign(b.style, {
        padding: "8px 14px",
        borderRadius: "6px",
        border: primary ? "none" : "1px solid #ccc",
        background: primary ? "#2e7d32" : "#f3f3f3",
        color: primary ? "#fff" : "#1a1a1a",
        fontWeight: "600",
        cursor: "pointer",
      });
      return b;
    };
    const cancelBtn = mkBtn("Cancel", false);
    const okBtn = mkBtn("Draft Email", true);

    // Button reads "Draft Email" until files are checked, then reflects the count.
    const updateOkLabel = () => {
      const n = checkboxes.filter((c) => c.cb.checked).length;
      okBtn.textContent = n === 0 ? "Draft Email" : `Attach ${n} & Draft`;
    };
    checkboxes.forEach((c) => c.cb.addEventListener("change", updateOkLabel));
    updateOkLabel();

    const close = () => overlay.remove();
    cancelBtn.addEventListener("click", () => {
      close();
      if (onCancel) onCancel();
    });
    okBtn.addEventListener("click", () => {
      const checked = checkboxes.filter((c) => c.cb.checked).map((c) => c.file);
      close();
      onConfirm(checked);
    });

    btns.appendChild(cancelBtn);
    btns.appendChild(okBtn);
    card.appendChild(h);
    card.appendChild(sub);
    card.appendChild(list);
    card.appendChild(btns);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ---- Compose modal (Outlook on the web — compose & send here) ----------------
  // When a result arrives for an open compose modal it's routed here instead of
  // the corner banner, so the modal can show "Sending…/Sent" and clear itself.
  let composeOnResult = null;

  // A desktop-style recipient field: valid addresses become removable chips when
  // the user presses space/comma/enter/tab (or blurs). Clicking a chip puts it
  // back into the text box to edit; Backspace in an empty box edits the last.
  function buildRecipientField(initial) {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let recips = (initial || []).slice();

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px",
      padding: "5px 7px", border: "1px solid #ccc", borderRadius: "6px",
      minHeight: "34px", boxSizing: "border-box", cursor: "text", background: "#fff",
    });
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = recips.length ? "" : "recipient@example.com";
    Object.assign(input.style, {
      flex: "1", minWidth: "160px", border: "none", outline: "none",
      font: "13px -apple-system, system-ui, sans-serif", padding: "3px 2px",
    });

    function flashInvalid() {
      wrap.style.borderColor = "#e23b3b";
      setTimeout(() => { wrap.style.borderColor = "#ccc"; }, 900);
    }
    function render() {
      wrap.querySelectorAll(".ic-chip").forEach((c) => c.remove());
      recips.forEach((email) => {
        const chip = document.createElement("span");
        chip.className = "ic-chip";
        Object.assign(chip.style, {
          display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "100%",
          padding: "2px 6px 2px 9px", background: "#eef2fd", border: "1px solid #c7d0f8",
          borderRadius: "12px", fontSize: "12.5px", color: "#1a3a8a",
        });
        const label = document.createElement("span");
        label.textContent = email; label.title = "Click to edit";
        Object.assign(label.style, { cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        label.addEventListener("mousedown", (e) => { e.preventDefault(); edit(email); });
        const x = document.createElement("span");
        x.textContent = "✕"; x.title = "Remove";
        Object.assign(x.style, { cursor: "pointer", color: "#6b7aa8", fontSize: "11px" });
        x.addEventListener("mousedown", (e) => { e.preventDefault(); remove(email); });
        chip.append(label, x);
        wrap.insertBefore(chip, input);
      });
      input.placeholder = recips.length ? "" : "recipient@example.com";
    }
    function commit(text) {
      const t = (text || "").trim().replace(/[,;]+$/, "").trim();
      if (!t) return true;
      if (EMAIL_RE.test(t)) { if (!recips.includes(t)) recips.push(t); render(); return true; }
      return false;
    }
    function remove(email) { recips = recips.filter((r) => r !== email); render(); input.focus(); }
    function edit(email) {
      // Commit whatever's typed, then pull the chosen chip back into the box.
      if (input.value.trim() && !commit(input.value)) { flashInvalid(); return; }
      recips = recips.filter((r) => r !== email);
      input.value = email; render(); input.focus();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === " " || e.key === ";" || e.key === "Tab") {
        if (!input.value.trim()) return; // let Tab move on when empty
        e.preventDefault();
        if (commit(input.value)) input.value = "";
        else flashInvalid();
      } else if (e.key === "Backspace" && input.value === "" && recips.length) {
        e.preventDefault();
        edit(recips[recips.length - 1]);
      }
    });
    input.addEventListener("blur", () => { if (input.value.trim() && !commit(input.value)) return; if (EMAIL_RE.test(input.value.trim())) input.value = ""; });
    input.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (text && /[,;\s]/.test(text)) {
        e.preventDefault();
        text.split(/[,;\s]+/).forEach((p) => commit(p));
        input.value = "";
      }
    });
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) { e.preventDefault(); input.focus(); } });

    wrap.appendChild(input);
    render();
    return {
      el: wrap,
      focus: () => input.focus(),
      getRecipients: () => { commit(input.value) && (input.value = ""); return recips.slice(); },
    };
  }

  function openComposeModal(ctx, undecidedFiles, { onSend, onCancel }) {
    document.getElementById("innercider-compose")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "innercider-compose";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,.45)", zIndex: "2147483647",
      display: "flex", alignItems: "center", justifyContent: "center",
      font: "14px -apple-system, system-ui, sans-serif",
    });
    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#fff", color: "#1a1a1a", borderRadius: "10px", padding: "18px 22px",
      width: "75vw", height: "75vh", maxWidth: "75vw", maxHeight: "75vh",
      boxShadow: "0 8px 30px rgba(0,0,0,.3)", display: "flex", flexDirection: "column",
    });

    const h = document.createElement("div");
    h.textContent = "New email — Outlook on the web";
    Object.assign(h.style, { fontWeight: "700", fontSize: "16px", marginBottom: "12px", flex: "0 0 auto" });

    const mkField = (labelText, el, grow) => {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, grow
        ? { marginBottom: "10px", flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: "0" }
        : { marginBottom: "10px", flex: "0 0 auto" });
      const lab = document.createElement("div");
      lab.textContent = labelText;
      Object.assign(lab.style, { fontSize: "12px", fontWeight: "600", color: "#555", marginBottom: "4px" });
      wrap.append(lab, el);
      return wrap;
    };
    const inputStyle = {
      width: "100%", boxSizing: "border-box", padding: "7px 9px", border: "1px solid #ccc",
      borderRadius: "6px", font: "13px -apple-system, system-ui, sans-serif",
    };
    const toField = buildRecipientField(ctx.recipients);
    const subjIn = document.createElement("input");
    subjIn.type = "text"; subjIn.value = ctx.subject || ""; Object.assign(subjIn.style, inputStyle);
    const bodyIn = document.createElement("textarea");
    bodyIn.value = ctx.body || "";
    Object.assign(bodyIn.style, inputStyle, { flex: "1 1 auto", minHeight: "120px", resize: "none", fontFamily: "ui-monospace, monospace", fontSize: "12.5px", lineHeight: "1.5" });

    const att = document.createElement("div");
    Object.assign(att.style, { margin: "4px 0 2px", fontSize: "12.5px", color: "#3a5a44", flex: "0 0 auto" });
    att.textContent = "📎 The PO PDF attaches automatically.";
    const checks = [];
    if (undecidedFiles && undecidedFiles.length) {
      const sub = document.createElement("div");
      sub.textContent = "Also attach:"; Object.assign(sub.style, { fontSize: "12px", fontWeight: "600", color: "#555", margin: "8px 0 2px" });
      att.appendChild(sub);
      for (const f of undecidedFiles) {
        const row = document.createElement("label");
        Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", cursor: "pointer", color: "#333" });
        const cb = document.createElement("input"); cb.type = "checkbox"; Object.assign(cb.style, { width: "15px", height: "15px" });
        const span = document.createElement("span"); span.textContent = f.name;
        row.append(cb, span); att.appendChild(row);
        checks.push({ cb, file: f });
      }
    }

    const status = document.createElement("div");
    Object.assign(status.style, { minHeight: "16px", fontSize: "12.5px", margin: "10px 0 0", flex: "0 0 auto" });

    const btns = document.createElement("div");
    Object.assign(btns.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "12px", flex: "0 0 auto" });
    const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "Discard";
    Object.assign(discard.style, { padding: "8px 14px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f3f3", cursor: "pointer", fontWeight: "600" });
    const send = document.createElement("button"); send.type = "button"; send.textContent = "Send";
    Object.assign(send.style, { padding: "8px 16px", borderRadius: "6px", border: "none", background: "#2f6feb", color: "#fff", cursor: "pointer", fontWeight: "700" });

    let closed = false;
    const close = () => { if (closed) return; closed = true; composeOnResult = null; overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const cancel = () => { close(); if (onCancel) onCancel(); };
    function onKey(e) { if (e.key === "Escape") cancel(); }

    discard.addEventListener("click", cancel);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cancel(); });
    document.addEventListener("keydown", onKey, true);

    send.addEventListener("click", () => {
      const recipients = toField.getRecipients();
      if (!recipients.length) {
        status.textContent = "Add at least one recipient."; status.style.color = "#c62828";
        return;
      }
      send.disabled = true; send.style.opacity = "0.6"; send.textContent = "Sending…";
      discard.disabled = true;
      status.textContent = "Sending via Outlook on the web…"; status.style.color = "#555";
      // Route the eventual MAIL_RESULT to this modal.
      composeOnResult = (ok, message) => {
        if (ok) {
          status.textContent = "✓ " + (message || "Sent."); status.style.color = "#2e7d32";
          send.textContent = "Sent"; composeOnResult = null;
          setTimeout(close, 1200);
        } else {
          status.textContent = "✗ " + (message || "Send failed."); status.style.color = "#c62828";
          send.disabled = false; send.style.opacity = "1"; send.textContent = "Send";
          discard.disabled = false; composeOnResult = null;
        }
      };
      const checked = checks.filter((c) => c.cb.checked).map((c) => c.file);
      onSend({ recipients, subject: subjIn.value, body: bodyIn.value }, checked);
    });

    card.append(h, mkField("To", toField.el), mkField("Subject", subjIn), mkField("Body", bodyIn, true), att, status, btns);
    btns.append(discard, send);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    toField.focus();
  }

  // ---- Outcome banner -----------------------------------------------------------

  function showBanner(ok, message) {
    const existing = document.getElementById("innercider-banner");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "innercider-banner";
    el.textContent = (ok ? "✓ " : "✗ ") + message;
    Object.assign(el.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      padding: "10px 14px",
      borderRadius: "6px",
      font: "13px -apple-system, system-ui, sans-serif",
      color: "#fff",
      boxShadow: "0 2px 10px rgba(0,0,0,.25)",
      background: ok ? "#2e7d32" : "#c62828",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ok ? 5000 : 12000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "MAIL_RESULT") {
      if (composeOnResult) composeOnResult(msg.ok, msg.message);
      else showBanner(msg.ok, msg.message);
    }
    if (msg && msg.type === "DEBUG") console.log("[InnerCider][bg]", msg.text, msg.data || "");
  });

  IC.registerFeature({ id: "draft-email", mount: injectButton });
})();
