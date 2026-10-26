/* InnerCider — background service worker (entry)
 *
 * Wires the shared native-messaging/session helpers and the two background
 * features (draft-email, graph-auth) behind a single chrome.runtime.onMessage
 * router. Adding a new background feature: give it a handler function, add
 * one line to `handlers` below. See docs/adding-a-feature.md.
 *
 * MV3 note: this worker can be terminated and restarted at any time (e.g.
 * mid-download). ES module imports resolve before this file's top-level code
 * runs, so registering listeners here — synchronously, at module load — is
 * safe on every restart.
 */

import { dbg, setDebugTab } from "./shared/log.js";
import {
  handleExportAndMail,
  handleExportPdfUrl,
  handleCompletedDownload,
} from "./features/draft-email.js";
import { handleGraphAuth } from "./features/graph-auth.js";
import { handleUpdateExtension } from "./features/update.js";
import {
  handleOpenLocalPath,
  handleOpenExtSettings,
  handleOpenPathNative,
  handlePingHost,
  handleOpenOptions,
} from "./features/open-path.js";
import { registerLifecycle } from "./features/lifecycle.js";

registerLifecycle();

const handlers = {
  EXPORT_AND_MAIL: handleExportAndMail,
  EXPORT_PDF_URL: handleExportPdfUrl,
  GRAPH_AUTH: handleGraphAuth,
  UPDATE_EXTENSION: handleUpdateExtension,
  OPEN_LOCAL_PATH: handleOpenLocalPath,
  OPEN_EXT_SETTINGS: handleOpenExtSettings,
  OPEN_LOCAL_PATH_NATIVE: handleOpenPathNative,
  PING_HOST: handlePingHost,
  OPEN_OPTIONS: handleOpenOptions,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  if (msg.type === "EXPORT_AND_MAIL") setDebugTab(sender.tab ? sender.tab.id : null);
  handler(msg, sender, sendResponse);
  return true; // every current handler responds asynchronously
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state ? delta.state.current : null;
  dbg("downloads.onChanged", { id: delta.id, state });
  if (state !== "complete") return;
  handleCompletedDownload(delta.id).catch((e) => dbg("onChanged handler error", String(e)));
});
