/* InnerCider — background: Draft PO Email feature
 *
 * Watches for the PDF that the content script triggers via "Export Custom
 * PDF", then forwards its on-disk path plus the email subject/body/recipient
 * to the native messaging host (com.innergy.mailer), which drafts the email
 * in the user's chosen mail app.
 */

import { dbg, getDebugTab, setDebugTab } from "../shared/log.js";
import { setPending, getPending, clearPending } from "../shared/session.js";
import { sendNative } from "../shared/native.js";

const ARM_TIMEOUT_MS = 120_000; // ignore stale arms older than this

// Innergy names the exported file with a random GUID (e.g. 6448ef99-….pdf), so
// we cannot validate it against the PO number in the filename. Instead we
// accept the PDF that the export produced: the first download that completes
// AFTER the button arm and is a PDF.
function isPdf(item) {
  if (!item) return false;
  if (item.mime && /pdf/i.test(item.mime)) return true;
  return !!item.filename && /\.pdf$/i.test(item.filename);
}

// Best-effort: did the filename happen to include the exact PO number? (Usually
// false for Innergy's GUID-named exports — informational only.)
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

  // Start with the exported PDF, then download any PO files and attach them too.
  const attachments = [path];
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
