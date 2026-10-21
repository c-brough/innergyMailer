/* InnerCider — open a local file:// path in a Chrome tab (Windows)
 *
 * The file-path-links content feature turns W:\…/M:\… paths into links. On
 * Windows we open the folder as Chrome's own built-in directory listing in a
 * new tab (file:///M:/…). A content script on an https page can't navigate to
 * file:// (Chrome blocks it), so it asks us — the background worker — to open
 * the tab instead.
 *
 * Chrome still requires the user to have enabled "Allow access to file URLs"
 * for this extension (a per-extension toggle no API can flip). We check it
 * first and, when it's off, tell the content script to guide the user rather
 * than silently opening a Chrome error page.
 */

function isAllowedFileAccess() {
  return new Promise((resolve) => {
    try {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess((a) => resolve(!!a));
        return;
      }
    } catch (e) { /* fall through */ }
    resolve(true); // API unavailable — assume allowed and let tabs.create try
  });
}

export async function handleOpenLocalPath(msg, sender, sendResponse) {
  const url = String((msg && msg.url) || "");
  if (!/^file:\/\//i.test(url)) {
    sendResponse({ ok: false, error: "not a file URL" });
    return;
  }
  const allowed = await isAllowedFileAccess();
  if (!allowed) {
    sendResponse({ ok: false, needsFileAccess: true });
    return;
  }
  try {
    await chrome.tabs.create({ url });
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
}

// Open this extension's own details page, where "Allow access to file URLs"
// lives, so the user can flip it in one click.
export async function handleOpenExtSettings(msg, sender, sendResponse) {
  try {
    await chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
}
