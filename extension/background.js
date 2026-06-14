/* Innergy PO → Mail — background service worker
 *
 * Watches for the PDF that the content script triggers via "Export Custom PDF",
 * then forwards its on-disk path plus the email subject/body/recipient to the
 * native messaging host (com.innergy.mailer), which drafts the email in Mail.app.
 *
 * MV3 note: this service worker can be terminated while the export download is
 * in flight, which would wipe any in-memory state. So the "armed" payload is
 * persisted in chrome.storage.session and re-read when the download completes.
 */

const NATIVE_HOST = "com.innergy.mailer";
const ARM_TIMEOUT_MS = 120_000; // ignore stale arms older than this
const PENDING_KEY = "pending";

// Mirror background diagnostics to the page console (readable for debugging) as
// well as the worker console.
let debugTabId = null;
function dbg(text, data) {
  console.log("[InnergyMailer]", text, data || "");
  if (debugTabId != null) {
    chrome.tabs.sendMessage(debugTabId, { type: "DEBUG", text, data }, () => {
      void chrome.runtime.lastError;
    });
  }
}

async function setPending(p) {
  await chrome.storage.session.set({ [PENDING_KEY]: p });
}
async function getPending() {
  const obj = await chrome.storage.session.get(PENDING_KEY);
  return obj[PENDING_KEY] || null;
}
async function clearPending() {
  await chrome.storage.session.remove(PENDING_KEY);
}

// Innergy names the exported file with a random GUID (e.g. 6448ef99-….pdf), so
// we cannot validate it against the PO number in the filename. Instead we accept
// the PDF that the export produced: the first download that completes AFTER the
// button arm and is a PDF.
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "EXPORT_AND_MAIL") {
    debugTabId = sender.tab ? sender.tab.id : null;
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
        console.error("[InnergyMailer] Failed to arm:", e);
        sendResponse({ armed: false });
      });
    return true;
  }

  if (msg && msg.type === "GRAPH_AUTH") {
    chrome.storage.local.get("azureClientId", (data) => {
      const clientId = msg.clientId || data.azureClientId;
      if (!clientId) {
        sendResponse({ ok: false, error: "No client ID configured." });
        return;
      }
      // Step 1: start the device flow — returns the user code immediately.
      dbg("auth_start sending");
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "auth_start", clientId }, (r1) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
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

        // Step 2: wait for sign-in to complete (blocks in native host until done).
        dbg("auth_complete sending");
        chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "auth_complete" }, (r2) => {
          chrome.storage.local.remove(["graphAuthCode", "graphAuthUri"]);
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          dbg("auth_complete response", r2);
          sendResponse(r2 || { ok: false, error: "No response from host." });
        });
      });
    });
    return true;
  }

  return false;
});

// Fire on the first COMPLETED download whose filename matches the exact PO
// number. Non-matching downloads (other PDFs / PO numbers) are ignored.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state ? delta.state.current : null;
  dbg("downloads.onChanged", { id: delta.id, state });
  if (state !== "complete") return;
  handleCompletedDownload(delta.id).catch((e) =>
    dbg("onChanged handler error", String(e))
  );
});

async function handleCompletedDownload(downloadId) {
  const pending = await getPending();
  if (!pending) {
    dbg("download completed but NOT armed (no pending state)", { downloadId });
    return;
  }
  if (debugTabId == null) debugTabId = pending.tabId; // worker may have restarted
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

  sendToHost(attachments, pending);
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
  const mailApp = stored.mailApp || "mail";
  const appLabel =
    mailApp === "outlook"         ? "Outlook" :
    mailApp === "outlook_classic" ? "Outlook Classic" :
    mailApp === "outlook_new"     ? "New Outlook" :
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
  dbg("calling sendNativeMessage", { host: NATIVE_HOST, app: mailApp, attachments });
  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
    if (chrome.runtime.lastError) {
      const err = chrome.runtime.lastError.message;
      dbg("native host error", err);
      report(pending.tabId, false, `Couldn't reach the Mail helper: ${err}`);
      return;
    }
    if (response && response.ok) {
      dbg("mail draft created", attachments);
      const extra = attachments.length - 1;
      const suffix = extra > 0 ? ` (+${extra} PO file${extra === 1 ? "" : "s"})` : "";
      const msg = response.message || `${appLabel} draft created${suffix}.`;
      report(pending.tabId, true, msg);
    } else {
      const err = (response && response.error) || "Unknown error.";
      dbg("host reported failure", err);
      report(pending.tabId, false, `${appLabel} draft failed: ${err}`);
    }
  });
}

// Surface the outcome on the Innergy page the user is looking at.
function report(tabId, ok, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "MAIL_RESULT", ok, message }, () => {
    void chrome.runtime.lastError; // tab may have navigated away; ignore
  });
}
