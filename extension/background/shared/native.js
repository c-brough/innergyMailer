/* InnerCider — native messaging host wrapper
 *
 * Thin promise-based wrapper around chrome.runtime.sendNativeMessage,
 * targeting the InnerCider native host. The host's registered name
 * (com.innergy.mailer) is intentionally left unchanged from "Innergy Mailer"
 * so existing installs' native-messaging manifests keep matching — renaming
 * it would require every user to re-run the installer.
 *
 * On a transport-level failure (chrome.runtime.lastError — e.g. the host
 * isn't installed/registered) the resolved object is tagged
 * `transportError: true` so callers can tell "couldn't reach the host" apart
 * from "the host ran and reported failure" and show the right message.
 */

export const NATIVE_HOST = "com.innergy.mailer";

export function sendNative(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message, transportError: true });
        return;
      }
      resolve(response || { ok: false, error: "No response from host." });
    });
  });
}
