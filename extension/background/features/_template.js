/* InnerCider — background feature template
 *
 * Copy this file to `your-feature.js`, fill it in, then wire it into
 * extension/background/background.js:
 *   1. import { handleYourMessage } from "./features/your-feature.js";
 *   2. add YOUR_MESSAGE_TYPE: handleYourMessage to the `handlers` map.
 * See docs/adding-a-feature.md for the full checklist.
 *
 * NOT wired in — this file is never loaded as-is.
 */

import { dbg } from "../shared/log.js";
import { sendNative } from "../shared/native.js";
// import { setPending, getPending, clearPending } from "../shared/session.js";
// (only if your feature needs state that survives a service-worker restart)

// chrome.runtime.onMessage handler for YOUR_MESSAGE_TYPE. Called with
// (msg, sender, sendResponse) — call sendResponse(...) when you're done,
// synchronously or asynchronously; background.js's router already returns
// `true` for every recognized message type to keep the channel open.
export function handleYourMessage(msg, sender, sendResponse) {
  // Talking to the native host? Use the shared wrapper — it returns
  // { ok, ...} normally, or { ok:false, error, transportError:true } if the
  // host couldn't be reached at all (distinguish that from "host ran and
  // reported failure" the way features/draft-email.js does).
  //
  //   const response = await sendNative({ action: "your_action", ...msg });

  dbg("handleYourMessage", msg);
  sendResponse({ ok: true });
}
