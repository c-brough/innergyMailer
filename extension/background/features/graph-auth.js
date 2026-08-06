/* InnerCider — background: Microsoft Graph auth feature
 *
 * Runs the Microsoft Graph device-code OAuth flow through the native host so
 * the "New Outlook" mail path (Windows) can create drafts via the Graph API.
 */

import { dbg } from "../shared/log.js";
import { sendNative } from "../shared/native.js";

// chrome.runtime.onMessage handler for GRAPH_AUTH.
export function handleGraphAuth(msg, sender, sendResponse) {
  chrome.storage.local.get("azureClientId", async (data) => {
    const clientId = msg.clientId || data.azureClientId;
    if (!clientId) {
      sendResponse({ ok: false, error: "No client ID configured." });
      return;
    }
    // Step 1: start the device flow — returns the user code immediately.
    dbg("auth_start sending");
    const r1 = await sendNative({ action: "auth_start", clientId });
    dbg("auth_start response", r1);
    if (!r1 || !r1.ok) {
      sendResponse(r1 || { ok: false, error: "No response from host." });
      return;
    }
    if (r1.alreadySignedIn) {
      sendResponse(r1);
      return;
    }
    // Stash the user code in storage so options.js can display it via onChanged.
    chrome.storage.local.set({ graphAuthCode: r1.userCode, graphAuthUri: r1.verificationUri });
    // The Linux host returns the sign-in URL instead of launching a browser
    // itself; open it here. The macOS/Windows hosts open it on their own and
    // send no openUrl, so this stays a no-op there.
    // active: false keeps focus on the Options page, which is the only place the
    // device code is shown — when the host returns a plain verification_uri (no
    // embedded code), stealing focus would leave the user staring at a prompt for
    // a code they can no longer read.
    if (r1.openUrl) {
      chrome.tabs.create({ url: r1.openUrl, active: false });
    }

    // Step 2: wait for sign-in to complete (blocks in native host until done).
    dbg("auth_complete sending");
    const r2 = await sendNative({ action: "auth_complete" });
    chrome.storage.local.remove(["graphAuthCode", "graphAuthUri"]);
    dbg("auth_complete response", r2);
    sendResponse(r2 || { ok: false, error: "No response from host." });
  });
}
