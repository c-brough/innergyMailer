/* Innergy PO → Mail — content script
 *
 * Injects a "Draft Email w/ PDF" button immediately to the LEFT of the
 * existing "Export Custom PDF" button on an Innergy purchase-order page.
 *
 * When clicked it:
 *   1. Scrapes the PO number, vendor name, and a summary of the Materials grid.
 *   2. Asks the background worker to start watching for the next download.
 *   3. Clicks the real "Export Custom PDF" button.
 * The background worker then hands the downloaded PDF + subject/body to the
 * native messaging host, which creates the Mail draft.
 */

(() => {
  "use strict";

  const EXPORT_BTN_SELECTOR = 'button[data-testid="ExportCustomReportDefault_single"]';
  const OUR_BTN_ID = "innergy-mailer-draft-btn";

  console.log("[InnergyMailer] content script v4 loaded");

  // ---- DOM scraping ---------------------------------------------------------

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

  function getMaterialsGrid() {
    // Locate the "Materials" section heading, climb to its container, find the grid.
    const nodes = Array.from(document.querySelectorAll("div, span"));
    const heading = nodes.find(
      (el) => el.children.length === 0 && /^materials$/i.test(el.textContent.trim())
    );
    if (!heading) return null;
    let container = heading;
    for (let i = 0; i < 7 && container; i++) container = container.parentElement;
    return container ? container.querySelector('[role="grid"]') : null;
  }

  // Cell index map within a Materials data row (observed Innergy layout).
  const COL = { name: 1, description: 2, uom: 3, qtyOrdered: 4, extendedCost: 7 };

  function getMaterials() {
    const grid = getMaterialsGrid();
    if (!grid) return [];
    const rows = Array.from(grid.querySelectorAll('[role="row"]'));
    const items = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
      if (cells.length <= COL.extendedCost) continue;
      const cell = (i) => (cells[i] ? cells[i].textContent.trim() : "");
      const name = cell(COL.name);
      if (!name) continue; // skip empty / placeholder rows
      items.push({
        name,
        description: cell(COL.description),
        uom: cell(COL.uom),
        qty: cell(COL.qtyOrdered),
        extendedCost: cell(COL.extendedCost),
      });
    }
    return items;
  }

  function buildSummary(items) {
    if (!items.length) return "No materials line items found on the PO page.";
    const lines = items.map((it) => {
      const qty = [it.qty, it.uom].filter(Boolean).join(" ");
      const cost = it.extendedCost ? ` — ${it.extendedCost}` : "";
      return `• ${it.name}${qty ? ` (${qty})` : ""}${cost}`;
    });
    const count = items.length;
    const header = `${count} material line item${count === 1 ? "" : "s"}:`;
    return `${header}\n${lines.join("\n")}`;
  }

  // ---- PO file attachments --------------------------------------------------

  function getPoId() {
    const m = location.hash.match(/purchaseOrders\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
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
      console.warn("[InnergyMailer] Could not fetch PO files:", e);
      return [];
    }
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

  // ---- Button injection -----------------------------------------------------

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
    const exportBtn = document.querySelector(EXPORT_BTN_SELECTOR);
    if (!exportBtn) return;
    if (document.getElementById(OUR_BTN_ID)) return; // already injected
    const btn = makeButton(exportBtn);
    exportBtn.parentElement.insertBefore(btn, exportBtn);
  }

  // ---- Click handler --------------------------------------------------------

  async function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    const exportBtn = document.querySelector(EXPORT_BTN_SELECTOR);
    if (!exportBtn) {
      alert("Innergy Mailer: couldn't find the Export Custom PDF button.");
      return;
    }

    const poNumber = getPoNumber();
    const vendor = getVendorName();
    const to = getVendorContactEmail();
    const items = getMaterials();

    const subject = `${poNumber} - ${vendor}`;
    const body =
      `${poNumber}\nVendor: ${vendor}\n\n` +
      `${buildSummary(items)}\n`;

    if (!to) {
      console.warn(
        "[InnergyMailer] No vendor contact email found; drafting without a recipient."
      );
    }

    const me = ev.currentTarget;
    const original = me.textContent;
    me.textContent = "Checking files…";
    me.disabled = true;

    const resetButton = () => {
      me.textContent = original;
      me.disabled = false;
    };

    const draftContext = { exportBtn, subject, body, to, poNumber, me, original };

    // Collect files attached to the PO and decide per the innergyEmailAttach flag.
    const files = await fetchPoFiles();
    const { include, undecided } = categorizeFiles(files);
    console.log(
      `[InnergyMailer] files: ${files.length} (yes=${include.length}, ask=${undecided.length})`,
      { include: include.map((f) => f.name), undecided: undecided.map((f) => f.name) }
    );

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
    const { exportBtn, subject, body, to, poNumber, me, original } = ctx;
    me.textContent = "Exporting…";
    me.disabled = true;

    const payload = files.map((f) => ({ name: f.name, url: f.url }));
    const msg = { type: "EXPORT_AND_MAIL", subject, body, to, poNumber, files: payload };
    console.log("[InnergyMailer] click → arming", { poNumber, to, subject, files: payload.length });
    chrome.runtime.sendMessage(msg, (resp) => {
      console.log("[InnergyMailer] arm response:", resp, chrome.runtime.lastError && chrome.runtime.lastError.message);
      if (chrome.runtime.lastError || !resp || !resp.armed) {
        me.textContent = original;
        me.disabled = false;
        alert(
          "Innergy Mailer: background worker did not respond. Is the extension loaded correctly?"
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

  // ---- File selection prompt ------------------------------------------------

  function showFilePrompt(files, { onConfirm, onCancel }) {
    // Remove any existing prompt first.
    const prev = document.getElementById("innergy-mailer-prompt");
    if (prev) prev.remove();

    const overlay = document.createElement("div");
    overlay.id = "innergy-mailer-prompt";
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
    const okBtn = mkBtn("Attach selected & Draft", true);

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

  // ---- Outcome banner -------------------------------------------------------

  function showBanner(ok, message) {
    const existing = document.getElementById("innergy-mailer-banner");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "innergy-mailer-banner";
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
    if (msg && msg.type === "MAIL_RESULT") showBanner(msg.ok, msg.message);
    if (msg && msg.type === "DEBUG") console.log("[InnergyMailer][bg]", msg.text, msg.data || "");
  });

  // ---- SPA-aware mounting ---------------------------------------------------
  // Innergy is a single-page app; the toolbar mounts/unmounts on navigation.
  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
