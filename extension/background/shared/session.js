/* InnerCider — background shared session storage
 *
 * MV3 note: the service worker can be killed while the export download is in
 * flight, wiping in-memory state. So the "armed" job is persisted in
 * chrome.storage.session (survives worker restarts, cleared when the browser
 * closes) and re-read when the download completes.
 */

const PENDING_KEY = "pending";

export async function setPending(p) {
  await chrome.storage.session.set({ [PENDING_KEY]: p });
}

export async function getPending() {
  const obj = await chrome.storage.session.get(PENDING_KEY);
  return obj[PENDING_KEY] || null;
}

export async function clearPending() {
  await chrome.storage.session.remove(PENDING_KEY);
}
