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
const DEFAULT_PDF_SOURCE = "generate";
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

// Include line-item pricing (extended cost) in the PO email body. Off by default.
const pricingBox = document.getElementById("include-pricing");
chrome.storage.local.get("includePricing", (data) => {
  pricingBox.checked = data.includePricing === true;
});
pricingBox.addEventListener("change", (e) => {
  chrome.storage.local.set({ includePricing: e.target.checked });
  showSaved();
});

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

// ---- Settings search ---------------------------------------------------------
// Filters the collapsible categories: a query shows only the categories whose
// text matches, opens them, and scrolls the first match into view. Clearing
// restores the default (first category open, the rest collapsed).
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
