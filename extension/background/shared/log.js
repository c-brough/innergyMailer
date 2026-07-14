/* InnerCider — background shared logging
 *
 * Mirrors diagnostics to the worker console and, when a source tab is known,
 * forwards them to that tab's content-script console via a DEBUG message —
 * useful since the service-worker console is easy to lose track of.
 */

let debugTabId = null;

export function setDebugTab(tabId) {
  debugTabId = tabId;
}

export function getDebugTab() {
  return debugTabId;
}

export function dbg(text, data) {
  console.log("[InnerCider]", text, data || "");
  if (debugTabId != null) {
    chrome.tabs.sendMessage(debugTabId, { type: "DEBUG", text, data }, () => {
      void chrome.runtime.lastError;
    });
  }
}
