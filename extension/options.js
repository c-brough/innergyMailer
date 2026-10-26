/* Options page logic */

const ua = navigator.userAgent;
const isWindows = ua.includes("Windows");
// Raspberry Pi OS Chromium reports "X11; Linux aarch64" (or armv7l). Android and
// ChromeOS also carry "Linux" but have neither Linux route available, so exclude
// them. macOS UA carries neither token, so it falls through to the mac branch.
const isLinux = !isWindows && /Linux|X11/.test(ua) && !/Android|CrOS/.test(ua);
const currentOs = isWindows ? "win" : isLinux ? "linux" : "mac";

// Gray out options that don't apply to the current OS.
const OS_OPTION_IDS = {
  mac: ["opt-mail", "opt-outlook-mac"],
  win: ["opt-outlook-classic", "opt-outlook-new"],
  linux: ["opt-outlook-web", "opt-linux-mail"],
};

Object.entries(OS_OPTION_IDS).forEach(([os, ids]) => {
  if (os === currentOs) return;
  ids.forEach((id) => {
    const label = document.getElementById(id);
    label.classList.add("disabled");
    label.querySelector("input").disabled = true;
  });
});

// Both New Outlook (Windows) and Outlook on the web (Linux) draft through the
// Microsoft Graph API, so both need the Azure Client ID + device-code sign-in.
// "outlook_new" is kept as-is rather than renamed: existing Windows installs
// already have that value saved in chrome.storage.local.
const GRAPH_APPS = ["outlook_new", "outlook_web", "outlook_web_modal"];

// Show/hide the Graph API setup panel based on selected app.
const graphFieldset = document.getElementById("fs-graph");
function updateGraphVisibility(value) {
  const needsGraph = GRAPH_APPS.includes(value);
  graphFieldset.style.display = needsGraph ? "block" : "none";
  // The compose-and-send option signs in via chrome.identity on first Send, not
  // the device-code "Sign in" button — hide that button and show a note instead.
  const isModal = value === "outlook_web_modal";
  const authBtn = document.getElementById("auth-btn");
  const owaNote = document.getElementById("owa-signin-note");
  if (authBtn) authBtn.style.display = isModal ? "none" : "";
  if (owaNote) owaNote.style.display = isModal ? "block" : "none";
  if (!needsGraph) {
    document.getElementById("graph-help").style.display = "none";
    resetHelpButtons();
  }
}

// Sensible per-OS default if nothing is saved.
const DEFAULT_APP = { win: "outlook_classic", linux: "outlook_web", mac: "mail" }[currentOs];

// Load saved settings.
chrome.storage.local.get(["mailApp", "azureClientId", "graphAuthed", "bomBaseUrl"], (data) => {
  if (data.bomBaseUrl) {
    document.getElementById("bom-base-url").value = data.bomBaseUrl;
    renderBomUrlStatus(data.bomBaseUrl);
  }
  const value = data.mailApp || DEFAULT_APP;
  const input = document.querySelector(`input[name="mailApp"][value="${value}"]`);
  if (input && !input.disabled) {
    input.checked = true;
  } else {
    // The saved value belongs to another OS (a copied profile, or a settings
    // export). Persist the correction, don't just repaint the radio: sendToHost
    // reads chrome.storage.local directly, and a stale-but-truthy value there
    // skips its own OS default — so the host would be handed e.g. "mail" on
    // Linux and reject it while this page claims a valid option is selected.
    const fallback = document.querySelector(`input[name="mailApp"][value="${DEFAULT_APP}"]`);
    if (fallback) fallback.checked = true;
    chrome.storage.local.set({ mailApp: DEFAULT_APP });
  }
  updateGraphVisibility(input && !input.disabled ? value : DEFAULT_APP);

  if (data.azureClientId) {
    document.getElementById("client-id").value = data.azureClientId;
  }
  if (data.graphAuthed) {
    setAuthStatus("ok", "Signed in -- will use cached token.");
  }
});

// Save mail app on change.
document.querySelectorAll('input[name="mailApp"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    chrome.storage.local.set({ mailApp: e.target.value });
    updateGraphVisibility(e.target.value);
    showSaved();
  });
});

// Which Innergy button produces the PO email's PDF. Default must match
// DEFAULT_PDF_SOURCE in content/features/draft-email.js.
const DEFAULT_PDF_SOURCE = "custom";
chrome.storage.local.get("pdfSource", (data) => {
  const input =
    document.querySelector(`input[name="pdfSource"][value="${data.pdfSource}"]`) ||
    document.querySelector(`input[name="pdfSource"][value="${DEFAULT_PDF_SOURCE}"]`);
  input.checked = true;
});
document.querySelectorAll('input[name="pdfSource"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    chrome.storage.local.set({ pdfSource: e.target.value });
    showSaved();
  });
});

// PO email feature enable (opt-in). Off by default; the content script only adds
// the "Draft Email w/ PDF" button when this is on.
const poEnabledBox = document.getElementById("po-email-enabled");
chrome.storage.local.get("poEmailEnabled", (data) => {
  poEnabledBox.checked = data.poEmailEnabled === true;
});
poEnabledBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ poEmailEnabled: e.target.checked });
  showSaved();
});

// Include line-item pricing (extended cost) in the PO email body. Off by default.
const pricingBox = document.getElementById("include-pricing");
chrome.storage.local.get("includePricing", (data) => {
  pricingBox.checked = data.includePricing === true;
});
pricingBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ includePricing: e.target.checked });
  showSaved();
});

// Email header / footer / signature. The PO details + items + notes are inserted
// between header and footer by the content script. Defaults here must match
// DEFAULT_EMAIL_* in content/features/draft-email.js.
const DEFAULT_EMAIL_HEADER = "Hello,\n\nPlease find the purchase order details below. The full purchase order is attached as a PDF.";
const DEFAULT_EMAIL_FOOTER = "Please confirm receipt of this order and the expected ship date.\n\nThank you,";
const headerArea = document.getElementById("email-header");
const footerArea = document.getElementById("email-footer");
const sigBox = document.getElementById("email-signature");
chrome.storage.local.get(["emailHeader", "emailFooter", "emailSignatureHtml"], (d) => {
  headerArea.value = d.emailHeader != null ? d.emailHeader : DEFAULT_EMAIL_HEADER;
  footerArea.value = d.emailFooter != null ? d.emailFooter : DEFAULT_EMAIL_FOOTER;
  if (d.emailSignatureHtml) sigBox.innerHTML = d.emailSignatureHtml;
});
let tmplTimer;
function saveTmpl() {
  chrome.storage.local.set({
    emailHeader: headerArea.value,
    emailFooter: footerArea.value,
    emailSignatureHtml: sigBox.innerHTML.trim(),
  });
  showSaved();
}
const debouncedTmpl = () => { clearTimeout(tmplTimer); tmplTimer = setTimeout(saveTmpl, 500); };
headerArea.addEventListener("input", debouncedTmpl);
footerArea.addEventListener("input", debouncedTmpl);
sigBox.addEventListener("input", debouncedTmpl);
sigBox.addEventListener("blur", saveTmpl);
document.getElementById("sig-clear").addEventListener("click", () => { sigBox.innerHTML = ""; saveTmpl(); });

// Save client ID as the user types (debounced).
let saveTimer;
document.getElementById("client-id").addEventListener("input", (e) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ azureClientId: e.target.value.trim() });
    showSaved();
  }, 600);
});

// Save the BOM app address as the user types (debounced). There is no default:
// blank means "no BOM app", which turns the backlink feature off entirely.
// Mirrors normalizeBase() in content/features/bom-backlinks.js — anything this
// rejects, the content script also ignores, so flag it here rather than let it
// fail silently on the Innergy page.
function bomUrlIsUsable(raw) {
  if (!raw) return true; // blank is valid: feature off
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function renderBomUrlStatus(raw) {
  const input = document.getElementById("bom-base-url");
  const status = document.getElementById("bom-base-url-status");
  const ok = bomUrlIsUsable(raw);
  input.classList.toggle("invalid", !ok);
  status.textContent = ok ? "" : "Needs a full http:// or https:// address — backlinks stay off until this is valid.";
  return ok;
}

let bomSaveTimer;
document.getElementById("bom-base-url").addEventListener("input", (e) => {
  const raw = e.target.value.trim();
  renderBomUrlStatus(raw);
  clearTimeout(bomSaveTimer);
  bomSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ bomBaseUrl: raw });
    showSaved();
  }, 600);
});

// Help buttons -- one per Graph-backed option (Windows + Linux), both toggling
// the same shared Azure setup instructions.
const helpButtons = document.querySelectorAll(".graph-help-btn");

// Queries fresh rather than closing over `helpButtons`: updateGraphVisibility
// calls this and is defined above that const, so closing over it would risk a
// temporal-dead-zone error if the call order ever changes.
function resetHelpButtons() {
  document.querySelectorAll(".graph-help-btn").forEach((btn) => {
    btn.style.background = "";
    btn.style.borderColor = "";
    btn.style.color = "";
  });
}

helpButtons.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const help = document.getElementById("graph-help");
    const open = help.style.display === "block";
    help.style.display = open ? "none" : "block";
    resetHelpButtons();
    if (!open) {
      btn.style.background = "#dde4ff";
      btn.style.borderColor = "#8899ee";
      btn.style.color = "#1a56db";
    }
  });
});

// Watch storage for the user code written by background.js during the device flow.
// background.js can't call sendResponse twice, so it stashes the code in storage instead.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.graphAuthCode && changes.graphAuthCode.newValue) {
    const code = changes.graphAuthCode.newValue;
    const uri  = (changes.graphAuthUri && changes.graphAuthUri.newValue) || "https://microsoft.com/devicelogin";
    const el = document.getElementById("auth-status");
    el.className = "inf";
    el.innerHTML =
      "Enter code &nbsp;<strong style=\"font-size:15px;letter-spacing:2px\">" + code + "</strong>&nbsp; " +
      "at <a href=\"" + uri + "\" target=\"_blank\">" + uri + "</a>, then wait here...";
  }
});

// Sign-in button -- triggers device code auth via the native host.
document.getElementById("auth-btn").addEventListener("click", () => {
  const clientId = document.getElementById("client-id").value.trim();
  if (!clientId) {
    setAuthStatus("err", "Paste your Azure App Client ID first.");
    return;
  }
  const btn = document.getElementById("auth-btn");
  btn.disabled = true;
  setAuthStatus("inf", "Contacting sign-in helper...");

  chrome.runtime.sendMessage({ type: "GRAPH_AUTH", clientId }, (resp) => {
    btn.disabled = false;
    if (chrome.runtime.lastError || !resp) {
      setAuthStatus("err", "No response from helper -- is the extension reloaded?");
      return;
    }
    if (resp.ok) {
      chrome.storage.local.set({ graphAuthed: true });
      setAuthStatus("ok", "Signed in successfully.");
    } else {
      chrome.storage.local.remove("graphAuthed");
      setAuthStatus("err", "Sign-in failed: " + (resp.error || "unknown error"));
    }
  });
});

function setAuthStatus(cls, msg) {
  const el = document.getElementById("auth-status");
  el.className = cls;
  el.textContent = msg;
}

// ---- Outlook-on-the-web (modal) help + redirect URI --------------------------
// The in-page compose option authenticates via chrome.identity, which needs the
// extension's chromiumapp.org redirect URI registered on the Azure app. Show it
// so the user can copy it, and toggle the setup instructions.
(() => {
  const help = document.getElementById("owa-modal-help");
  document.querySelectorAll(".owa-modal-help-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      help.style.display = help.style.display === "block" ? "none" : "block";
    });
  });
  try {
    const uri = chrome.identity.getRedirectURL();
    const el = document.getElementById("owa-redirect-uri");
    if (el) el.textContent = uri;
  } catch (e) {
    /* identity unavailable — leave placeholder */
  }
})();

function showSaved() {
  const el = document.getElementById("status");
  el.textContent = "Saved";
  setTimeout(() => (el.textContent = ""), 1500);
}

// ---- Reload extension + reopen Options + auto-update on startup ---------------
(() => {
  // Reopen this Options page after a reload (opt-out, default on). The background
  // worker reads optionsAutoOpen / optionsReopenPending.
  const autoOpenBox = document.getElementById("options-auto-open");
  chrome.storage.local.get("optionsAutoOpen", (d) => {
    autoOpenBox.checked = d.optionsAutoOpen !== false; // default on
  });
  autoOpenBox.addEventListener("change", (e) => {
    chrome.storage.local.set({ optionsAutoOpen: e.target.checked });
    showSaved();
  });

  // Reload the extension, with a 3-2-1 countdown and a heads-up that this Options
  // page closes (it reopens automatically if the box above is checked).
  const reloadBtn = document.getElementById("reload-ext");
  const reloadStatus = document.getElementById("reload-status");
  let counting = false;
  reloadBtn.addEventListener("click", () => {
    if (counting) return;
    counting = true;
    reloadBtn.disabled = true;
    const willReopen = autoOpenBox.checked;
    const note = willReopen
      ? "This Options page will close and reopen automatically."
      : "This Options page will close — reopen it yourself (right-click the InnerCider icon → Options).";
    let n = 3;
    reloadStatus.style.color = "#b45309";
    reloadStatus.textContent = `${note} Reloading in ${n}…`;
    const tick = setInterval(() => {
      n--;
      if (n > 0) {
        reloadStatus.textContent = `${note} Reloading in ${n}…`;
        return;
      }
      clearInterval(tick);
      reloadStatus.textContent = "Reloading…";
      // Leave a short-lived flag so the worker reopens Options after the reload.
      chrome.storage.local.set({ optionsReopenPending: Date.now() }, () => {
        chrome.runtime.reload();
      });
    }, 1000);
  });

  // Auto-update InnerCider when Chrome is relaunched (opt-in, default off).
  const autoUpdBox = document.getElementById("auto-update-startup");
  chrome.storage.local.get("autoUpdateOnStartup", (d) => {
    autoUpdBox.checked = d.autoUpdateOnStartup === true;
  });
  autoUpdBox.addEventListener("change", (e) => {
    chrome.storage.local.set({ autoUpdateOnStartup: e.target.checked });
    showSaved();
  });
})();

// ---- Time Tracking Tools (opt-in) --------------------------------------------
// Off by default; only turned on for people who edit/approve time. The content
// feature (content/features/time-tracking.js) reads `timeTrackingEnabled`.
const ttBox = document.getElementById("tt-enabled");
chrome.storage.local.get("timeTrackingEnabled", (data) => {
  ttBox.checked = data.timeTrackingEnabled === true;
});
ttBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ timeTrackingEnabled: e.target.checked });
  showSaved();
});

// ---- Notes Enhancements (opt-out; ON by default) -----------------------------
// content/features/notes-enhancements.js reads `notesEnhancementsEnabled`.
const notesBox = document.getElementById("notes-enabled");
chrome.storage.local.get("notesEnhancementsEnabled", (data) => {
  notesBox.checked = data.notesEnhancementsEnabled !== false; // default on
});
notesBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ notesEnhancementsEnabled: e.target.checked });
  showSaved();
});

// ---- Note draft autosave (opt-out; ON by default) ---------------------------
// content/features/note-drafts.js reads `noteDraftsEnabled` and stores drafts in
// `noteDrafts` ({ [baseNotesUrlKey]: [{ts,text,html,url,title}, …] }).
const ndBox = document.getElementById("note-drafts-enabled");
chrome.storage.local.get("noteDraftsEnabled", (data) => {
  ndBox.checked = data.noteDraftsEnabled !== false; // default on
});
ndBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ noteDraftsEnabled: e.target.checked });
  showSaved();
});

const ndList = document.getElementById("nd-list");
const ndClearAll = document.getElementById("nd-clear-all");

function ndRelTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? " min ago" : " mins ago");
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Sanitized rich preview (so uploaded images show in place); falls back to text.
const ND_PREV_TAGS = new Set(["P", "BR", "B", "I", "U", "S", "STRONG", "EM", "SPAN", "DIV",
  "A", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "CODE",
  "HR", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "FIGURE", "FIGCAPTION"]);
const ND_PREV_DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "NOSCRIPT", "TEMPLATE", "SVG"]);
function ndSanitizeInto(srcNode, out) {
  for (const child of [...srcNode.childNodes]) {
    if (child.nodeType === 3) { out.appendChild(document.createTextNode(child.nodeValue)); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (ND_PREV_DROP.has(tag)) continue;
    if (!ND_PREV_TAGS.has(tag)) { ndSanitizeInto(child, out); continue; }
    const el = document.createElement(tag);
    if (tag === "A") {
      const href = child.getAttribute("href") || "";
      if (/^https?:/i.test(href)) { el.setAttribute("href", href); el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
    } else if (tag === "IMG") {
      const src = child.getAttribute("src") || "";
      if (!/^https?:/i.test(src)) continue;
      el.setAttribute("src", src);
      el.style.maxWidth = "100%"; el.style.height = "auto"; el.style.borderRadius = "4px"; el.style.display = "block"; el.style.margin = "4px 0";
      const alt = child.getAttribute("alt"); if (alt) el.setAttribute("alt", alt);
      el.setAttribute("loading", "lazy");
    }
    ndSanitizeInto(child, el);
    out.appendChild(el);
  }
}
function ndFillPreview(prev, draft) {
  prev.innerHTML = "";
  let built = null;
  if (draft.html) {
    try {
      const doc = new DOMParser().parseFromString(draft.html, "text/html");
      const frag = document.createElement("div");
      ndSanitizeInto(doc.body, frag);
      if (frag.childNodes.length) built = frag;
    } catch (e) { built = null; }
  }
  if (built) { prev.style.whiteSpace = "normal"; while (built.firstChild) prev.appendChild(built.firstChild); }
  else { prev.style.whiteSpace = "pre-wrap"; prev.textContent = draft.text || ""; }
}

function ndCopy(draft, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => (btn.textContent = o), 1400); };
  try {
    if (draft.html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const item = new ClipboardItem({
        "text/html": new Blob([draft.html], { type: "text/html" }),
        "text/plain": new Blob([draft.text || ""], { type: "text/plain" }),
      });
      navigator.clipboard.write([item]).then(done, () => navigator.clipboard.writeText(draft.text || "").then(done, () => {}));
      return;
    }
  } catch (e) { /* fall through */ }
  navigator.clipboard.writeText(draft.text || "").then(done, () => {});
}

function renderDrafts() {
  chrome.storage.local.get("noteDrafts", (d) => {
    const store = (d && d.noteDrafts) || {};
    const keys = Object.keys(store).filter((k) => Array.isArray(store[k]) && store[k].length);
    ndList.innerHTML = "";
    ndClearAll.style.display = keys.length ? "" : "none";
    if (!keys.length) {
      const e = document.createElement("div");
      e.style.cssText = "font-size:12px;color:#777;padding:6px 0";
      e.textContent = "No saved drafts yet.";
      ndList.appendChild(e);
      return;
    }
    // Most-recently-updated page first.
    keys.sort((a, b) => (store[b][0].ts || 0) - (store[a][0].ts || 0));
    for (const key of keys) {
      const group = document.createElement("div");
      group.style.cssText = "border:1px solid #e2e5ea;border-radius:9px;margin-bottom:12px;overflow:hidden";
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 11px;background:#f6f7f9;border-bottom:1px solid #edeff2";
      const title = document.createElement("a");
      title.textContent = store[key][0].title || key;
      title.href = store[key][0].url || "#";
      title.target = "_blank";
      title.style.cssText = "flex:1;font-size:12.5px;font-weight:600;color:#1a56db;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      head.appendChild(title);
      group.appendChild(head);

      store[key].forEach((draft, i) => {
        const row = document.createElement("div");
        row.style.cssText = "padding:8px 11px;border-top:" + (i ? "1px solid #f0f1f4" : "none");
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:5px";
        const when = document.createElement("div");
        when.style.cssText = "flex:1;font-size:11.5px;color:#667;font-weight:600";
        when.textContent = "Saved " + ndRelTime(draft.ts);
        const copy = document.createElement("button");
        copy.type = "button"; copy.textContent = "Copy";
        copy.style.cssText = "cursor:pointer;border:1px solid #cbd2db;background:#fff;border-radius:6px;padding:2px 9px;font-size:11.5px;font-weight:600;color:#334155";
        copy.addEventListener("click", () => ndCopy(draft, copy));
        const del = document.createElement("button");
        del.type = "button"; del.textContent = "Delete";
        del.style.cssText = "cursor:pointer;border:1px solid #fbd0d0;background:#fff;border-radius:6px;padding:2px 9px;font-size:11.5px;font-weight:600;color:#b91c1c";
        del.addEventListener("click", () => {
          chrome.storage.local.get("noteDrafts", (dd) => {
            const s = (dd && dd.noteDrafts) || {};
            const a = Array.isArray(s[key]) ? s[key] : [];
            a.splice(i, 1);
            if (a.length) s[key] = a; else delete s[key];
            chrome.storage.local.set({ noteDrafts: s }, renderDrafts);
          });
        });
        bar.appendChild(when); bar.appendChild(copy); bar.appendChild(del);
        const prev = document.createElement("div");
        prev.style.cssText = "word-break:break-word;font-size:12px;color:#222;max-height:160px;overflow:auto;background:#fff;border:1px solid #eef0f3;border-radius:6px;padding:7px 9px";
        ndFillPreview(prev, draft);
        row.appendChild(bar); row.appendChild(prev);
        group.appendChild(row);
      });
      ndList.appendChild(group);
    }
  });
}

ndClearAll.addEventListener("click", () => {
  if (!confirm("Delete all saved note drafts?")) return;
  chrome.storage.local.set({ noteDrafts: {} }, renderDrafts);
});
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.noteDrafts) renderDrafts(); });
renderDrafts();

// ---- Quick Change Order wizard (opt-out; ON by default) ---------------------
// content/features/change-order-wizard.js reads `changeOrderWizardEnabled`.
const coWizBox = document.getElementById("co-wizard-enabled");
chrome.storage.local.get("changeOrderWizardEnabled", (data) => {
  coWizBox.checked = data.changeOrderWizardEnabled !== false; // default on
});
coWizBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ changeOrderWizardEnabled: e.target.checked });
  showSaved();
});

// ---- Windows file-path links (opt-out; ON by default) -----------------------
// content/features/file-path-links.js reads `filePathLinksEnabled`.
const fpBox = document.getElementById("file-paths-enabled");
chrome.storage.local.get("filePathLinksEnabled", (data) => {
  fpBox.checked = data.filePathLinksEnabled !== false; // default on
});
fpBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ filePathLinksEnabled: e.target.checked });
  showSaved();
});

// "Open in real app" — route clicks through the native helper (opt-in).
const fpNativeBox = document.getElementById("file-paths-native");
chrome.storage.local.get("filePathOpenNative", (data) => {
  fpNativeBox.checked = data.filePathOpenNative === true;
});
fpNativeBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ filePathOpenNative: e.target.checked });
  showSaved();
});

// Installer one-liner for the current OS + a helper reachability check.
(() => {
  const ONE_LINERS = {
    mac: "curl -fsSL https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.sh | bash",
    linux: "curl -fsSL https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.sh | bash",
    win: "irm https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.ps1 | iex",
  };
  const NOTES = {
    mac: "Paste into Terminal and press Return, then follow the prompts.",
    linux: "Paste into a terminal and press Enter, then follow the prompts.",
    win: "Paste into Windows PowerShell and press Enter, then follow the prompts.",
  };
  const cmd = ONE_LINERS[currentOs] || ONE_LINERS.mac;
  const box = document.getElementById("fp-oneliner");
  const note = document.getElementById("fp-oneliner-note");
  if (box) box.textContent = cmd;
  if (note) note.textContent = NOTES[currentOs] || "";

  const copyBtn = document.getElementById("fp-copy-cmd");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(cmd).then(
        () => { const o = copyBtn.textContent; copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = o), 1400); },
        () => {}
      );
    });
  }

  const checkBtn = document.getElementById("fp-check-helper");
  const status = document.getElementById("fp-helper-status");
  if (checkBtn && status) {
    checkBtn.addEventListener("click", () => {
      status.style.color = "#667";
      status.textContent = "Checking…";
      checkBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "PING_HOST" }, (resp) => {
        checkBtn.disabled = false;
        if (chrome.runtime.lastError || !resp) {
          status.style.color = "#b91c1c";
          status.textContent = "Couldn't reach the extension worker — reload the extension.";
          return;
        }
        if (resp.ok && resp.pong) {
          status.style.color = "#157347";
          status.textContent = "Helper is installed and reachable ✓";
        } else if (resp.transportError) {
          status.style.color = "#b45309";
          status.textContent = "Helper not found — run the installer above, then check again.";
        } else {
          status.style.color = "#b91c1c";
          status.textContent = "Helper error: " + (resp.error || "unknown");
        }
      });
    });
  }
})();

// ---- Notifications sidebar (opt-in) + default filters ------------------------
// content/features/notifications-sidebar.js reads notifSidebarEnabled,
// notifDefaultStatus and notifTypes ({notes,tasks,reports,other}).
const NOTIF_TYPES = ["mentioned", "replies", "assigned", "reports", "other"];
const notifBox = document.getElementById("notif-enabled");
const notifStatus = document.getElementById("notif-default-status");
const notifTypeBoxes = NOTIF_TYPES.map((t) => document.getElementById("notif-type-" + t));
chrome.storage.local.get(["notifSidebarEnabled", "notifDefaultStatus", "notifTypes"], (d) => {
  notifBox.checked = d.notifSidebarEnabled === true;
  notifStatus.value = d.notifDefaultStatus || "unread";
  const types = d.notifTypes || {};
  NOTIF_TYPES.forEach((t, i) => { notifTypeBoxes[i].checked = types[t] !== false; }); // default all on
});
function saveNotifTypes() {
  const types = {};
  NOTIF_TYPES.forEach((t, i) => { types[t] = notifTypeBoxes[i].checked; });
  chrome.storage.local.set({ notifTypes: types });
  showSaved();
}
notifBox.addEventListener("change", (e) => { chrome.storage.local.set({ notifSidebarEnabled: e.target.checked }); showSaved(); });
notifStatus.addEventListener("change", (e) => { chrome.storage.local.set({ notifDefaultStatus: e.target.value }); showSaved(); });
notifTypeBoxes.forEach((cb) => cb.addEventListener("change", saveNotifTypes));

// ---- Settings search ---------------------------------------------------------
// Filters the collapsible categories: a query shows only the categories whose
// text matches, opens them, and scrolls the first match into view. Clearing
// restores the default (all collapsed).
(() => {
  const search = document.getElementById("opt-search");
  const noResults = document.getElementById("no-results");
  const cats = Array.from(document.querySelectorAll("details.cat"));
  const defaultOpen = new Map(cats.map((c) => [c, c.open]));

  function apply() {
    const q = search.value.trim().toLowerCase();
    if (!q) {
      cats.forEach((c) => {
        c.hidden = false;
        c.open = defaultOpen.get(c);
      });
      noResults.style.display = "none";
      return;
    }
    let first = null;
    for (const c of cats) {
      const match = c.textContent.toLowerCase().includes(q);
      c.hidden = !match;
      c.open = match;
      if (match && !first) first = c;
    }
    noResults.style.display = first ? "none" : "block";
    if (first) first.scrollIntoView({ block: "nearest" });
  }

  search.addEventListener("input", apply);
})();

// ---- Updates (check GitHub, show changelog, one-click update) -----------------
// The extension is loaded unpacked from a fixed folder the native host can write
// to, so "Update now" = ask the host to download the latest from GitHub, then
// chrome.runtime.reload() to pick up the new files. The check + changelog are
// plain fetches against the public repo (no auth).
(() => {
  const REPO = "c-brough/innergyMailer";
  const DEFAULT_BRANCH = "main";
  const RAW = (branch, path) =>
    `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/${path}?t=${Date.now()}`;

  const installed = chrome.runtime.getManifest().version;
  const banner = document.getElementById("update-banner");
  const ubVersions = document.getElementById("ub-versions");
  const ubUpdate = document.getElementById("ub-update");
  const ubChangelog = document.getElementById("ub-changelog");
  const updateStatus = document.getElementById("update-status");
  const branchSel = document.getElementById("update-branch");
  const checkNow = document.getElementById("check-now");
  const viewChangelog = document.getElementById("view-changelog");
  const updatesStatus = document.getElementById("updates-status");
  const updTag = document.getElementById("upd-tag");
  document.getElementById("installed-version").textContent = "v" + installed;

  let currentBranch = DEFAULT_BRANCH;
  let latestVersion = null;

  // "1.8.0" > "1.7.1" by numeric segments.
  function semverGt(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  async function fetchText(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 10000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } finally { clearTimeout(t); }
  }

  async function populateBranches() {
    try {
      const txt = await fetchText(`https://api.github.com/repos/${REPO}/branches?per_page=100`, 10000);
      const names = JSON.parse(txt).map((b) => b.name);
      if (!names.includes(currentBranch)) names.unshift(currentBranch);
      branchSel.innerHTML = "";
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n; if (n === currentBranch) o.selected = true;
        branchSel.appendChild(o);
      }
    } catch (e) {
      // Fall back to just the stored/default branch if the API is unreachable.
      branchSel.innerHTML = "";
      const o = document.createElement("option");
      o.value = currentBranch; o.textContent = currentBranch; o.selected = true;
      branchSel.appendChild(o);
    }
  }

  async function check(quiet) {
    if (!quiet) updatesStatus.textContent = "Checking…";
    try {
      const txt = await fetchText(RAW(currentBranch, "extension/manifest.json"), 10000);
      latestVersion = JSON.parse(txt).version;
      updTag.textContent = "v" + latestVersion;
      if (semverGt(latestVersion, installed)) {
        ubVersions.textContent = `v${installed} → v${latestVersion} (${currentBranch})`;
        banner.classList.add("show");
        updatesStatus.textContent = `Update available: v${latestVersion}.`;
      } else {
        banner.classList.remove("show");
        updatesStatus.textContent = semverGt(installed, latestVersion)
          ? `You're ahead of ${currentBranch} (installed v${installed}, branch v${latestVersion}).`
          : `Up to date (v${installed}).`;
      }
    } catch (e) {
      banner.classList.remove("show");
      updatesStatus.textContent = "Couldn't check for updates: " + e.message;
    }
  }

  // ---- changelog modal ----
  const clOverlay = document.getElementById("cl-overlay");
  const clBody = document.getElementById("cl-body");
  document.getElementById("cl-close").addEventListener("click", () => clOverlay.classList.remove("show"));
  clOverlay.addEventListener("click", (e) => { if (e.target === clOverlay) clOverlay.classList.remove("show"); });

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inlineCode = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  // Parse "## [x.y.z] - date" sections into { version, date, body }.
  function parseChangelog(md) {
    const out = [];
    const re = /^##\s*\[([0-9][0-9.]*)\]\s*-?\s*(.*)$/gm;
    let m, prev = null;
    while ((m = re.exec(md))) {
      if (prev) prev.body = md.slice(prev._end, m.index).trim();
      prev = { version: m[1], date: (m[2] || "").trim(), _end: re.lastIndex };
      out.push(prev);
    }
    if (prev) prev.body = md.slice(prev._end).trim();
    return out;
  }

  function renderEntry(e) {
    let html = `<h3>v${esc(e.version)}${e.date ? " — " + esc(e.date) : ""}</h3>`;
    let inList = false;
    for (const raw of e.body.split("\n")) {
      const line = raw.trimEnd();
      const h = line.match(/^###\s+(.*)$/);
      const li = line.match(/^[-*]\s+(.*)$/);
      if (h) { if (inList) { html += "</ul>"; inList = false; } html += `<div class="cl-kind">${esc(h[1])}</div>`; }
      else if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inlineCode(li[1])}</li>`; }
      else if (line && !inList) { html += `<div>${inlineCode(line)}</div>`; }
    }
    if (inList) html += "</ul>";
    return html;
  }

  async function showChangelog(onlyNewer) {
    clBody.innerHTML = "Loading…";
    clOverlay.classList.add("show");
    try {
      const md = await fetchText(RAW(currentBranch, "CHANGELOG.md"), 10000);
      let entries = parseChangelog(md);
      if (onlyNewer) {
        const newer = entries.filter((e) => semverGt(e.version, installed));
        if (newer.length) entries = newer;
      }
      entries = entries.slice(0, 20);
      clBody.innerHTML = entries.length ? entries.map(renderEntry).join("") : "No changelog entries found.";
    } catch (e) {
      clBody.innerHTML = "Couldn't load the changelog: " + esc(e.message);
    }
  }

  // ---- update now ----
  function doUpdate() {
    ubUpdate.disabled = true;
    updateStatus.textContent = "Downloading the latest version…";
    chrome.runtime.sendMessage({ type: "UPDATE_EXTENSION", branch: currentBranch }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        ubUpdate.disabled = false;
        updateStatus.textContent = "Couldn't reach the updater. Re-run the installer to enable one-click updates.";
        return;
      }
      if (resp.transportError) {
        ubUpdate.disabled = false;
        updateStatus.textContent = "Update helper not reachable — re-run the installer once to enable one-click updates.";
        return;
      }
      if (resp.ok) {
        updateStatus.textContent = `Updated to v${resp.version || latestVersion}. Reloading…`;
        setTimeout(() => chrome.runtime.reload(), 900);
      } else {
        ubUpdate.disabled = false;
        updateStatus.textContent = "Update failed: " + (resp.error || "unknown error");
      }
    });
  }

  ubUpdate.addEventListener("click", doUpdate);
  ubChangelog.addEventListener("click", () => showChangelog(true));
  viewChangelog.addEventListener("click", () => showChangelog(false));
  checkNow.addEventListener("click", () => check(false));
  branchSel.addEventListener("change", () => {
    currentBranch = branchSel.value;
    chrome.storage.local.set({ updateBranch: currentBranch });
    check(false);
  });

  chrome.storage.local.get("updateBranch", async (data) => {
    currentBranch = data.updateBranch || DEFAULT_BRANCH;
    await populateBranches();
    check(true);
  });
})();

// ---- Category status (green = in use) + expand/collapse all -------------------
// A green dot + soft tint on a category whose feature is enabled/configured, so
// you can see what's in use while everything is collapsed.
(() => {
  const cats = Array.from(document.querySelectorAll("details.cat"));
  // Prepend a status dot to each summary (the ▸ triangle is a ::before pseudo,
  // so it still renders first).
  cats.forEach((c) => {
    const summary = c.querySelector("summary");
    if (summary && !summary.querySelector(".cat-dot")) {
      const dot = document.createElement("span");
      dot.className = "cat-dot";
      summary.insertBefore(dot, summary.firstChild);
    }
  });

  // The Mail app is only meaningful once a compose email feature is on, so move
  // it to the end of the feature list and gray it out until PO email is enabled.
  const mailCat = document.querySelector('details.cat[data-cat="mail"]');
  const ttCat = document.querySelector('details.cat[data-cat="time-tracking"]');
  const mailNote = document.getElementById("mail-disabled-note");
  if (mailCat && ttCat) ttCat.after(mailCat);
  // Block expanding Mail app while it's disabled.
  if (mailCat) {
    const sum = mailCat.querySelector("summary");
    if (sum) sum.addEventListener("click", (e) => { if (mailCat.classList.contains("cat--disabled")) e.preventDefault(); });
  }

  // A "compose email" feature is enabled (today: PO email) — the only thing that
  // makes the mail-app choice relevant.
  const composeOn = (data) => data.poEmailEnabled === true;

  // Is this category configured / in use? Keyed by data-cat.
  function isOn(cat, data) {
    switch (cat.dataset.cat) {
      case "mail": return composeOn(data) && !!data.mailApp;
      case "po-email": return data.poEmailEnabled === true;
      case "bom": return !!(data.bomBaseUrl && data.bomBaseUrl.trim());
      case "time-tracking": return data.timeTrackingEnabled === true;
      case "notes": return data.notesEnhancementsEnabled !== false; // on by default
      case "note-drafts": return data.noteDraftsEnabled !== false;  // on by default
      case "co-wizard": return data.changeOrderWizardEnabled !== false; // on by default
      case "file-paths": return data.filePathLinksEnabled !== false; // on by default
      case "notifications": return data.notifSidebarEnabled === true;
      default: return false;                     // Updates: neutral
    }
  }
  function refresh() {
    chrome.storage.local.get(["mailApp", "poEmailEnabled", "bomBaseUrl", "timeTrackingEnabled", "notesEnhancementsEnabled", "noteDraftsEnabled", "changeOrderWizardEnabled", "filePathLinksEnabled", "notifSidebarEnabled"], (data) => {
      cats.forEach((c) => c.classList.toggle("cat--on", isOn(c, data)));
      // Mail app gating.
      if (mailCat) {
        const enabled = composeOn(data);
        mailCat.classList.toggle("cat--disabled", !enabled);
        if (!enabled) mailCat.open = false;
        if (mailNote) mailNote.style.display = enabled ? "none" : "block";
      }
    });
  }
  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.mailApp || changes.poEmailEnabled || changes.bomBaseUrl || changes.timeTrackingEnabled || changes.notesEnhancementsEnabled || changes.noteDraftsEnabled || changes.changeOrderWizardEnabled || changes.filePathLinksEnabled || changes.notifSidebarEnabled)) refresh();
  });

  // Expand / collapse all (only categories currently shown; never expand a
  // disabled one).
  const setAll = (open) => cats.forEach((c) => {
    if (c.hidden) return;
    if (open && c.classList.contains("cat--disabled")) return;
    c.open = open;
  });
  const ea = document.getElementById("expand-all");
  const ca = document.getElementById("collapse-all");
  if (ea) ea.addEventListener("click", () => setAll(true));
  if (ca) ca.addEventListener("click", () => setAll(false));
})();
