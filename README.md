# Innergy Mailer

A Chrome extension + native helper that adds a **”Draft Email w/ PDF”** button
next to **Export Custom PDF** on an Innergy purchase-order page. Clicking it:

1. Exports the PO PDF using Innergy’s existing **Export Custom PDF** button.
2. Drafts a new email in **Apple Mail** or **Microsoft Outlook** (your choice)
   with that PDF attached, where:
   - **Subject** = `<PO#> & <vendor name>` (e.g. `PO-100000 & Zepp Framers LLC - Sewell`)
   - **Body** = a brief summary of the line items in the PO’s **Materials** grid.

The draft is left **open and unsent** so you can review and send it yourself.

## Why a native helper is needed

Chrome extensions are sandboxed and cannot attach files to Mail. The extension
therefore talks to a tiny local Python script (a “native messaging host”) that
builds the Outlook/Mail draft. Separate host scripts exist for macOS and Windows.

## Layout

```
extension/                        Chrome extension (load unpacked)
  manifest.json                   MV3 manifest; pins a fixed extension ID via “key”
  content.js                      Injects the button, scrapes PO#/vendor/materials
  background.js                   Captures the download, calls the native host
native-host/
  innergy_mailer_host.py          macOS host — drafts via AppleScript (osascript)
  innergy_mailer_host_win.py      Windows host — drafts via Outlook COM (pywin32)
  run-host.sh                     macOS wrapper (created by install.sh)
  run-host.bat                    Windows wrapper (created by install_windows.ps1)
  com.innergy.mailer.json         Native-messaging manifest (written by installer)
install.sh                        macOS installer
install_windows.ps1               Windows installer
```

## Install — Windows

**Requirement:** Python 3. Classic Outlook uses COM automation (pywin32). New
Outlook uses the Microsoft Graph API (msal + requests) — no desktop Outlook install
required for the New Outlook path.

1. Open PowerShell **as Administrator** (right-click → Run as administrator) and run:
   ```powershell
   cd path\to\innergyEmailer
   .\install_windows.ps1
   ```
   This installs Python dependencies (`pywin32`, `msal`, `requests`), compiles the
   host to an `.exe`, writes the JSON manifest, and registers it in `HKLM`
   (required for system-wide Chrome installs in `Program Files`).

2. Load the extension in Chrome:
   - `chrome://extensions` → **Developer mode** on → **Load unpacked** →
     select the `extension/` folder.
   - Confirm the extension ID is `akplcachdkpchhcacbbbnkgbfnfgifbn`.

3. Open extension Options (right-click icon → **Options**) and select your mail app:
   - **Outlook Classic (Win)** — classic Outlook must be installed.
   - **New Outlook (Win)** — requires a free Azure app registration (see below).

Open any Innergy PO page — the button appears to the left of **Export Custom PDF**.

### New Outlook — Azure App Registration (one-time setup)

New Outlook is web-based and has no COM interface. The extension creates drafts via
the Microsoft Graph API instead. You need a free Azure app registration so the host
can request permission to write to your mailbox.

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory**
   → **App registrations** → **New registration**.
   - Name: anything (e.g. `Innergy Mailer`)
   - Supported account types: **Accounts in any organizational directory and personal
     Microsoft accounts** (the “multi-tenant + personal” option)
   - Redirect URI: leave blank
   - Click **Register**

2. Copy the **Application (client) ID** (a UUID on the overview page).

3. Under **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → add `Mail.ReadWrite`. Click **Grant admin consent**
   if your org requires it (or leave it — the user will consent on first sign-in).

4. In the extension Options page, paste the Client ID and click **Sign in**.
   A browser tab opens with a device-code prompt. Sign in with your Microsoft
   account. The host caches a refresh token next to the exe so you only need to do
   this once.

The draft is created in your mailbox as a draft message and opened in New Outlook via
its `webLink`. The email arrives pre-filled with subject, body, To address, and the
PDF (plus any PO file attachments).

## Install — macOS

```bash
./install.sh
```

By default the draft opens in **Apple Mail**. To use **Microsoft Outlook**,
open the extension’s options (right-click icon → **Options**) and select it.
Outlook must support AppleScript (classic Outlook does).

### Loading the extension (all platforms)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. Confirm the extension ID is `akplcachdkpchhcacbbbnkgbfnfgifbn`
   (the manifest `key` pins it so the native host’s allow-list matches).

> If you get a different extension ID, remove the extension, delete any other
> copies loaded from a different folder, and reload from this folder fresh.

## How it works

- **content.js** waits (via a `MutationObserver`) for
  `button[data-testid=”ExportCustomReportDefault_single”]`, injects our button
  before it, and on click scrapes:
  - PO# from `[data-testid=”purchase-order-header”]` / breadcrumb / title,
  - vendor from the **Vendor (Company - Office)** label’s linked value,
  - materials from the **Materials** `[role=”grid”]` (Material Name, UoM,
    Quantity Ordered, Extended Cost).
- It tells **background.js** to arm a download watcher, then clicks the real
  export button.
- Innergy names the exported file with a random GUID (e.g. `6448ef99-….pdf`), so
  there is no PO number in the filename to validate against. **background.js**
  therefore captures the first download that **completes after the click** and is
  a PDF (by MIME or `.pdf` extension); downloads that began before the click are
  rejected.
- It also fetches the PO’s **Files tab** attachments via the same API the app
  uses (`PurchaseOrderAttachmentsQuery`). Each file’s **`innergyEmailAttach`**
  custom field decides what happens:
  - **Yes** → attached automatically.
  - **No** → skipped.
  - **empty/unset** → the extension shows a checkbox dialog so you can pick which
    of those files to include (the export only runs after you confirm).
  Selected files are downloaded and attached alongside the PDF. It then sends
  `{attachments, subject, body, to, app}` to the native host, which attaches every
  file to the draft.
- **macOS**: `innergy_mailer_host.py` runs AppleScript via `osascript`.
- **Windows**: `innergy_mailer_host_win.py` uses `win32com.client` to drive
  `Outlook.Application` COM automation.

## Troubleshooting

- **”Native host error” in the extension console** — re-run the installer, and
  make sure the loaded extension ID matches `akplcachdkpchhcacbbbnkgbfnfgifbn`.
- **No draft appears** — check `native-host/host.log` (created on first run) for
  errors.
  - Windows: confirm `pywin32` is installed (`pip show pywin32`) and classic
    Outlook is present.
  - macOS: confirm Mail.app or Outlook has at least one account configured.
- **Wrong materials columns** — the scraper reads the Materials grid by column
  position (Name=1, Description=2, UoM=3, Qty Ordered=4, Extended Cost=7). If you
  reorder columns in Innergy’s saved view, update the `COL` map in `content.js`.

## Uninstall

**Windows** (run as Administrator):
```powershell
Remove-Item “HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.innergy.mailer” -ErrorAction SilentlyContinue
Remove-Item “HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.innergy.mailer” -ErrorAction SilentlyContinue
Remove-Item “HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.innergy.mailer” -ErrorAction SilentlyContinue
Remove-Item “C:\innergy” -Recurse -Force -ErrorAction SilentlyContinue
```

**macOS:**
```bash
rm -f “$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.innergy.mailer.json”
# (repeat for other browsers if you use them)
```

Then remove the extension from `chrome://extensions`.
