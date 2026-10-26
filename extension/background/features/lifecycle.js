/* InnerCider — background: extension lifecycle (reload / reopen Options / auto-update)
 *
 *  • Reopen the Options page after the extension reloads, unless the user opts
 *    out (optionsAutoOpen, default on). chrome.runtime.reload() fires neither
 *    onInstalled nor onStartup, so the Options "Reload extension" button leaves
 *    a short-lived flag (optionsReopenPending) that this module consumes when the
 *    worker restarts. onInstalled covers first install and the one-click update.
 *  • Auto-update InnerCider when Chrome is relaunched, opt-in
 *    (autoUpdateOnStartup, default off): on onStartup, ask the native host to
 *    pull the latest for the saved branch and reload if the version changed.
 *
 * Wired from background.js: call registerLifecycle() once at module load.
 */

import { sendNative } from "../shared/native.js";

const REOPEN_FLAG = "optionsReopenPending";
let lastOpen = 0; // in-memory de-dupe within one worker lifetime

function openOptionsDeduped() {
  const now = Date.now();
  if (now - lastOpen < 3000) return; // several triggers can fire together
  lastOpen = now;
  try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
}

// Open Options unless the user turned auto-open off.
function openOptionsIfEnabled() {
  chrome.storage.local.get("optionsAutoOpen", (d) => {
    if (d.optionsAutoOpen === false) return;
    openOptionsDeduped();
  });
}

// Consume the flag the Options "Reload extension" button set before reloading.
function consumePendingReopen() {
  chrome.storage.local.get(REOPEN_FLAG, (d) => {
    const ts = d[REOPEN_FLAG];
    if (!ts) return;
    chrome.storage.local.remove(REOPEN_FLAG);
    if (Date.now() - ts < 60000) openOptionsIfEnabled(); // respects the opt-out
  });
}

function autoUpdateOnStartup() {
  chrome.storage.local.get(["autoUpdateOnStartup", "updateBranch"], (d) => {
    if (d.autoUpdateOnStartup !== true) return;
    const current = chrome.runtime.getManifest().version;
    sendNative({ action: "update", branch: d.updateBranch || "main" })
      .then((r) => {
        // Only reload when the download actually changed the version, so we don't
        // reload on every launch. onInstalled(update) then reopens Options.
        if (r && r.ok && r.version && r.version !== current) {
          try { chrome.runtime.reload(); } catch (e) { /* ignore */ }
        }
      })
      .catch(() => {});
  });
}

export function registerLifecycle() {
  // Runs on every worker start — including right after chrome.runtime.reload().
  consumePendingReopen();

  chrome.runtime.onInstalled.addListener((details) => {
    if (details && (details.reason === "install" || details.reason === "update")) {
      openOptionsIfEnabled();
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    consumePendingReopen();
    autoUpdateOnStartup();
  });
}
