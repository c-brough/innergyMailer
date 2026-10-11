/* InnerCider — background: self-update feature
 *
 * The Options page can't rewrite the extension's own files (MV3 forbids remote
 * code), but the native host can: it downloads the latest `extension/` from the
 * public GitHub repo and overwrites the unpacked folder it was installed next
 * to. The Options page then calls chrome.runtime.reload() to pick up the new
 * files. This handler just relays the request to the host and returns its reply.
 *
 * Reply shape from the host: { ok: true, version } or { ok: false, error }.
 * A transport failure (old host without update support, or host not installed)
 * comes back tagged transportError so Options can tell the user to re-run the
 * installer once.
 */

import { sendNative } from "../shared/native.js";

export function handleUpdateExtension(msg, sender, sendResponse) {
  sendNative({ action: "update", branch: (msg && msg.branch) || "main" }).then((r) =>
    sendResponse(r || { ok: false, error: "No response from host." })
  );
}
