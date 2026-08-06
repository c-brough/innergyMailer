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
const GRAPH_APPS = ["outlook_new", "outlook_web"];

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

function showSaved() {
  const el = document.getElementById("status");
  el.textContent = "Saved";
  setTimeout(() => (el.textContent = ""), 1500);
}
