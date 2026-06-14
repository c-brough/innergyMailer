/* Options page logic */

const isWindows = navigator.userAgent.includes("Windows");

// Gray out options that don't apply to the current OS.
const macIds = ["opt-mail", "opt-outlook-mac"];
const winIds = ["opt-outlook-classic", "opt-outlook-new"];

(isWindows ? macIds : winIds).forEach((id) => {
  const label = document.getElementById(id);
  label.classList.add("disabled");
  label.querySelector("input").disabled = true;
});

// Show/hide the Graph API setup panel based on selected app.
const graphSetup = document.getElementById("graph-setup");
function updateGraphVisibility(value) {
  const isNew = value === "outlook_new";
  graphSetup.style.display = isNew ? "block" : "none";
  if (!isNew) {
    document.getElementById("graph-help").style.display = "none";
    const btn = document.getElementById("graph-help-btn");
    btn.style.background = "";
    btn.style.borderColor = "";
    btn.style.color = "";
  }
}

// Sensible per-OS default if nothing is saved.
const DEFAULT_APP = isWindows ? "outlook_classic" : "mail";

// Load saved settings.
chrome.storage.local.get(["mailApp", "azureClientId", "graphAuthed"], (data) => {
  const value = data.mailApp || DEFAULT_APP;
  const input = document.querySelector(`input[name="mailApp"][value="${value}"]`);
  if (input && !input.disabled) {
    input.checked = true;
  } else {
    const fallback = document.querySelector(`input[name="mailApp"][value="${DEFAULT_APP}"]`);
    if (fallback) fallback.checked = true;
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

// Help button -- toggles Azure setup instructions.
document.getElementById("graph-help-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const help = document.getElementById("graph-help");
  const btn  = document.getElementById("graph-help-btn");
  const open = help.style.display === "block";
  help.style.display = open ? "none" : "block";
  btn.style.background = open ? "" : "#dde4ff";
  btn.style.borderColor = open ? "" : "#8899ee";
  btn.style.color = open ? "" : "#1a56db";
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
      "at <a href=\"" + uri + "\" target=\"_blank\">" + uri + "</a> in Edge, then wait here...";
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
