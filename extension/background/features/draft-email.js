/* InnerCider — background: Draft PO Email feature
 *
 * Gets the PDF that the content script triggered via "Export Custom PDF" onto
 * disk, then forwards its path plus the email subject/body/recipient to the
 * native messaging host (com.innergy.mailer), which drafts the email in the
 * user's chosen mail app.
 *
 * Two ways the PDF arrives, both ending in deliver():
 *   • EXPORT_PDF_URL — the normal path. The content script's MAIN-world hook
 *     caught Innergy's window.open(<pdf url>) and handed us the URL, so we
 *     fetch it ourselves with chrome.downloads.download(). That works under
 *     either Chrome PDF setting, because the "open PDFs in Chrome" preference
 *     governs navigations, not the downloads API.
 *   • downloads.onChanged — the original path, now only a fallback. It cannot
 *     race the path above: a captured export is suppressed before it ever
 *     reaches the network stack, so no download event exists to see. It fires
 *     only if the hook misses the export entirely (Innergy switching away from
 *     window.open, say) AND the user's setting is "download PDFs" — the one
 *     combination that still produces a download on its own.
 * Whichever runs claims the pending job by clearing it first, so the file
 * downloads that follow (the PDF itself, then any PO attachments) find nothing
 * pending and are ignored rather than re-entering the flow.
 */

import { dbg, getDebugTab, setDebugTab } from "../shared/log.js";
import { setPending, getPending, clearPending } from "../shared/session.js";
import { sendNative } from "../shared/native.js";

const ARM_TIMEOUT_MS = 120_000; // ignore stale arms older than this

// Fallback-path matching only (the EXPORT_PDF_URL path knows exactly which file
// it fetched). A download event carries no link back to the click that caused
// it, so we accept the first PDF that completes AFTER the button arm.
function isPdf(item) {
  if (!item) return false;
  if (item.mime && /pdf/i.test(item.mime)) return true;
  return !!item.filename && /\.pdf$/i.test(item.filename);
}

// Best-effort log detail: did the filename include the exact PO number?
// (Innergy's export names it e.g. PO-100005_INNERGYDefault_….pdf, but a report
// layout could name it otherwise — informational only, never a gate.)
function filenameContainsPo(poNumber, path) {
  if (!path || !poNumber) return false;
  const escaped = String(poNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped + "(?!\\d)", "i").test(path.split(/[\\/]/).pop());
}

// chrome.runtime.onMessage handler for EXPORT_AND_MAIL, arms the download watch.
export function handleExportAndMail(msg, sender, sendResponse) {
  setPending({
    subject: msg.subject,
    body: msg.body,
    to: msg.to || "",
    poNumber: msg.poNumber || "",
    files: Array.isArray(msg.files) ? msg.files : [],
    tabId: sender.tab ? sender.tab.id : null,
    ts: Date.now(),
  })
    .then(() => {
      dbg("armed for PO", msg.poNumber);
      sendResponse({ armed: true });
    })
    .catch((e) => {
      console.error("[InnerCider] Failed to arm:", e);
      sendResponse({ armed: false });
    });
}

// chrome.downloads.onChanged handler entry point, called for every completed download.
export async function handleCompletedDownload(downloadId) {
  const pending = await getPending();
  if (!pending) {
    dbg("download completed but NOT armed (no pending state)", { downloadId });
    return;
  }
  if (getDebugTab() == null) setDebugTab(pending.tabId); // worker may have restarted
  if (Date.now() - pending.ts > ARM_TIMEOUT_MS) {
    dbg("pending arm is stale; clearing");
    await clearPending();
    return;
  }

  const results = await chrome.downloads.search({ id: downloadId });
  const item = results && results[0];
  const path = item && item.filename;
  const startedMs = item && item.startTime ? Date.parse(item.startTime) : NaN;
  dbg("completed download", {
    path,
    mime: item && item.mime,
    startTime: item && item.startTime,
    expectedPo: pending.poNumber,
  });

  if (!isPdf(item)) {
    dbg("ignored: not a PDF", path);
    return;
  }
  // Reject downloads that began before we armed (a 2s grace covers clock skew).
  if (!Number.isNaN(startedMs) && startedMs < pending.ts - 2000) {
    dbg("ignored: download predates the button click", path);
    return;
  }

  await clearPending();
  dbg(
    filenameContainsPo(pending.poNumber, path)
      ? "matched PDF (filename contains PO)"
      : "matched PDF (export download after click; GUID filename)",
    path
  );

  await deliver(path, pending);
}

// chrome.runtime.onMessage handler for EXPORT_PDF_URL: the content script's
// window.open hook caught the export's PDF URL, so download it directly rather
// than waiting for a download event that only fires under one PDF setting.
export async function handleExportPdfUrl(msg, sender, sendResponse) {
  const pending = await getPending();
  if (!pending) {
    dbg("export URL arrived but NOT armed (no pending state)", { url: msg.url });
    sendResponse({ ok: false });
    return;
  }
  if (getDebugTab() == null) setDebugTab(pending.tabId); // worker may have restarted
  if (Date.now() - pending.ts > ARM_TIMEOUT_MS) {
    dbg("pending arm is stale; clearing");
    await clearPending();
    sendResponse({ ok: false });
    return;
  }
  let url;
  try {
    url = new URL(msg.url);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") {
    dbg("ignored: export URL is not https", { url: msg.url });
    sendResponse({ ok: false });
    return;
  }

  // Claim the job before the slow part so the downloads watcher can't also run it.
  await clearPending();
  dbg("matched PDF (captured from window.open)", msg.url);
  sendResponse({ ok: true });

  try {
    // No filename: Chrome derives it from the URL path, which already carries
    // the PO / work-order number (e.g. PO-100005_INNERGYDefault_….pdf).
    const path = await downloadAndWait(msg.url);
    if (!path) throw new Error("download produced no file");
    await deliver(path, pending);
  } catch (e) {
    dbg("exported PDF download failed", String(e));
    report(pending.tabId, false, `Couldn't download the exported PDF: ${e.message || e}`);
  }
}

// Attach any PO files alongside the exported PDF, then hand the lot to the host.
async function deliver(pdfPath, pending) {
  const attachments = [pdfPath];
  const files = pending.files || [];
  if (files.length) {
    dbg(`downloading ${files.length} PO file(s)`, files.map((f) => f.name));
    for (const f of files) {
      try {
        const fpath = await downloadAndWait(f.url, f.name);
        if (fpath) {
          attachments.push(fpath);
          dbg("PO file downloaded", fpath);
        }
      } catch (e) {
        dbg("PO file download failed (skipping)", { name: f.name, error: String(e) });
      }
    }
  }

  await sendToHost(attachments, pending);
}

// Download a file by URL and resolve with its on-disk path once complete.
function downloadAndWait(url, name) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: name || undefined, conflictAction: "uniquify" },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "no id"));
          return;
        }
        const finish = () =>
          chrome.downloads.search({ id }, (res) =>
            resolve(res && res[0] ? res[0].filename : null)
          );
        const onChanged = (delta) => {
          if (delta.id !== id) return;
          if (delta.state && delta.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            finish();
          } else if (delta.error) {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error.current));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
        // In case it completed before the listener attached.
        chrome.downloads.search({ id }, (res) => {
          if (res && res[0] && res[0].state === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            finish();
          }
        });
      }
    );
  });
}

async function sendToHost(attachments, pending) {
  const stored = await chrome.storage.local.get(["mailApp", "azureClientId"]);
  // Match options.js: when nothing is saved yet, the default is OS-appropriate
  // (Windows → Outlook Classic, Linux → Outlook on the web, else Apple Mail).
  // Without this the label wrongly read "Apple Mail" on Windows. The UA checks
  // mirror options.js exactly — keep the two in sync.
  const ua = navigator.userAgent;
  const isWindows = ua.includes("Windows");
  const isLinux = !isWindows && /Linux|X11/.test(ua) && !/Android|CrOS/.test(ua);
  const os = isWindows ? "win" : isLinux ? "linux" : "mac";
  const defaultApp = { win: "outlook_classic", linux: "outlook_web", mac: "mail" }[os];
  // A saved value from another OS (copied profile, settings export) would be
  // truthy but unusable — the host would reject it with a confusing error. Treat
  // anything outside this OS's set as unset rather than forwarding it.
  const OS_APPS = {
    win: ["outlook_classic", "outlook_new"],
    linux: ["outlook_web", "linux_mail"],
    mac: ["mail", "outlook"],
  };
  const mailApp = OS_APPS[os].includes(stored.mailApp) ? stored.mailApp : defaultApp;
  const appLabel =
    mailApp === "outlook"         ? "Microsoft Outlook (Mac)" :
    mailApp === "outlook_classic" ? "Outlook Classic" :
    mailApp === "outlook_new"     ? "New Outlook" :
    mailApp === "outlook_web"     ? "Outlook on the web" :
    mailApp === "linux_mail"      ? "Default mail client" :
                                    "Apple Mail";
  const payload = {
    attachments,
    pdfPath: attachments[0],
    subject: pending.subject,
    body: pending.body,
    to: pending.to,
    app: mailApp,
    clientId: stored.azureClientId || "",
  };
  dbg("calling sendNativeMessage", { app: mailApp, attachments });
  const response = await sendNative(payload);
  if (response.transportError) {
    dbg("native host error", response.error);
    report(pending.tabId, false, `Couldn't reach the Mail helper: ${response.error}`);
    return;
  }
  if (response && response.ok) {
    dbg("mail draft created", attachments);
    // The Linux host never opens a browser itself (a host spawned by Chromium has
    // no reliable claim on DISPLAY) — it hands back the draft's webLink instead.
    if (response.openUrl) {
      chrome.tabs.create({ url: response.openUrl });
    }
    const extra = attachments.length - 1;
    const suffix = extra > 0 ? ` (+${extra} PO file${extra === 1 ? "" : "s"})` : "";
    const message = response.message || `${appLabel} draft created${suffix}.`;
    report(pending.tabId, true, message);
  } else {
    const err = (response && response.error) || "Unknown error.";
    dbg("host reported failure", err);
    report(pending.tabId, false, `${appLabel} draft failed: ${err}`);
  }
}

// Surface the outcome on the Innergy page the user is looking at.
function report(tabId, ok, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "MAIL_RESULT", ok, message }, () => {
    void chrome.runtime.lastError; // tab may have navigated away; ignore
  });
}
