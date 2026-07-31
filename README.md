# InnerCider

A Chrome extension (+ native helper) with three tools for Innergy:

1. **Draft PO email** — a **”Draft Email w/ PDF”** button next to **Export Custom
   PDF** on a purchase-order page (details below).
2. **Materials total cost** — on the Materials grid, shows the total cost per
   **Default UoM** / **Purchasing UoM** next to each value (unit `Cost` × the
   size’s conversion to the base unit, e.g. `$2.03/SF × 4'×8' = $64.96`).
3. **BOM backlinks** *(optional, off until configured)* — on a work order’s
   **Shipment Items** grid, adds a **`BOM <n> ↗`** chip to each item pushed from
   a BOM app, linking back to the BOM it came from (details below).

## Draft PO email

The **”Draft Email w/ PDF”** button next to **Export Custom PDF** on an Innergy
purchase-order page. Clicking it:

1. Exports the PO PDF using Innergy’s existing **Export Custom PDF** button.
2. Drafts a new email in **Apple Mail** or **Microsoft Outlook** (your choice)
   with that PDF attached, where:
   - **Subject** = `<PO#> & <vendor name>` (e.g. `PO-100000 & Zepp Framers LLC - Sewell`)
   - **Body** = a brief summary of the line items in the PO’s **Materials** grid.

The draft is left **open and unsent** so you can review and send it yourself.

## BOM backlinks

**Off by default.** There is intentionally no built-in BOM app address — this
extension is shared beyond CPW, and a hardcoded default would point other
shops’ installs at someone else’s app. Set the address in the extension’s
Options page (**BOM app backlinks**) to switch the feature on; leave it blank
and the feature never runs — no query, no chips, no network traffic. Only
`http://` and `https://` addresses are accepted.

Once configured: on `#/projects/{projectId}/workOrder/{woId}/shipment-items`,
each shipment item that originated in the BOM app gets a small **`BOM <n> ↗`**
chip next to its name, opening `<your-bom-app>/?bom=<n>` in a new tab.

> The engineering-id format this matches (`cpwbom-{bomId}-asm-{assemblyId}`) is
> currently CPW-BOM’s. A different BOM app would also need `ENG_RE` in
> `extension/content/features/bom-backlinks.js` made configurable.

The link key is already in the data: CPW-BOM pushes one shipment item per BOM
assembly stamped with `InternalEngineeringId: cpwbom-{bomId}-asm-{assemblyId}`,
and that id survives the EngineeringSync staging → work-order promotion, coming
back as the row’s `EngineeringId`. Nothing extra is written to Innergy.

Two things make this less trivial than reading a cell:

- **The id isn’t on the page.** There’s no *Engineering ID* column in the default
  view, and the DevExtreme grid instance isn’t reachable (React bundle, no
  `window.DevExpress`). So the feature re-runs the grid’s own
  `ShipmentItemsListQuery` against `query/run` with the session cookie — the same
  authenticated-fetch pattern the PO-files code uses — and reads `EngineeringId`
  from the response.
- **Rows are matched by name, not position.** The grid’s row order follows
  whatever sort/filter/page the user picked, which an independent fetch doesn’t
  know about; index-matching silently yields *wrong* links (an unsorted fetch
  comes back in a different order than the rendered rows). Matching on
  **Shipment Item Name** is order-independent. If one work order has two rows
  with the same name mapping to *different* BOMs, that name is ambiguous and
  **neither row is annotated** — a missing chip is recoverable, a confidently
  wrong one isn’t.

The result is cached per work order, so the MutationObserver doesn’t re-query on
every DOM change. Rows not pushed by the BOM app are left untouched.

## Privacy

See the [Privacy Policy](https://c-brough.github.io/innergyMailer/) — no data is
sent to the developer; the extension only talks to your own Innergy account and
your chosen mail app.

## Why a native helper is needed

Chrome extensions are sandboxed and cannot attach files to Mail. The extension
therefore talks to a tiny local Python script (a “native messaging host”) that
builds the Outlook/Mail draft. Separate host scripts exist for macOS and Windows.

## Layout

```
extension/                        Chrome extension (load unpacked)
  manifest.json                   MV3 manifest; pins a fixed extension ID via “key”
  content/                        Content scripts (see ARCHITECTURE.md for the module map)
    core.js                       Shared window.InnerCider namespace + Innergy access layer
    features/                     One file per content-script feature (draft-email,
                                  materials-cost, bom-backlinks)
    bootstrap.js                  Single MutationObserver that mounts every registered feature
  background/                     Background service worker (ES modules)
    background.js                 Entry point: message router + download watcher
    features/                     One file per background feature (draft-email, graph-auth)
    shared/                       Native-messaging, session storage, logging helpers
native-host/
  innergy_mailer_host.py          macOS host — drafts via AppleScript (osascript)
  innergy_mailer_host_win.py      Windows host — drafts via Outlook COM (pywin32)
  run-host.bat                    Windows wrapper (created by install_windows.ps1)
  com.innergy.mailer.json         Native-messaging manifest (written by installer)
install.sh                        macOS installer
install.bat                       Windows installer — double-click; auto-elevates and runs the .ps1
install_windows.ps1               Windows installer (PowerShell; invoked by install.bat)
```

## Install — Windows

**Requirement:** Python 3. Classic Outlook uses COM automation (pywin32). New
Outlook uses the Microsoft Graph API (msal + requests) — no desktop Outlook install
required for the New Outlook path.

1. **Double-click `install.bat`** in the project folder. Windows will ask for
   Administrator access (a UAC prompt) — click **Yes**. The installer then sets
   everything up: installs Python dependencies (`pywin32`, `msal`, `requests`),
   compiles the host to an `.exe`, writes the JSON manifest, and registers it in
   `HKLM` (required for system-wide Chrome installs in `Program Files`). When it
   finishes, press a key to close the window.

   > Prefer PowerShell? You can run the underlying script directly instead: open
   > PowerShell **as Administrator** and run `.\install_windows.ps1` from the
   > project folder. (`install.bat` just elevates and calls this for you.)

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
   - Name: anything (e.g. `InnerCider`)
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

This copies the native host to `~/Library/Application Support/InnerCider/`
and registers it with every installed Chromium-family browser. The host is
installed there — **not** inside the repo — because `~/Documents`, `~/Desktop`,
and `~/Downloads` are macOS TCC-protected folders that Chrome is not allowed to
*launch* a native-messaging host from; doing so makes the host silently "exit"
and no draft is created.

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

- **content/features/draft-email.js** waits (via the shared bootstrap's
  `MutationObserver`) for `button[data-testid=”ExportCustomReportDefault_single”]`,
  injects our button before it, and on click scrapes:
  - PO# from `[data-testid=”purchase-order-header”]` / breadcrumb / title,
  - vendor from the **Vendor (Company - Office)** label’s linked value,
  - materials from the **Materials** `[role=”grid”]` (Material Name, UoM,
    Quantity Ordered, Extended Cost).
- It tells **background/features/draft-email.js** to arm a download watcher,
  then clicks the real export button.
- Innergy names the exported file with a random GUID (e.g. `6448ef99-….pdf`), so
  there is no PO number in the filename to validate against. The background
  feature therefore captures the first download that **completes after the
  click** and is a PDF (by MIME or `.pdf` extension); downloads that began
  before the click are rejected.
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
- **content/features/bom-backlinks.js** runs only on the work-order
  **Shipment Items** route. It POSTs the grid's own `ShipmentItemsListQuery` to
  `query/run` (session cookie, `text/plain` body to match the app and avoid a
  CORS preflight), keeps a `Shipment Item Name → bomId` map cached per work
  order, and appends a link chip to the **Shipment Item Name** cell — located by
  its `aria-colindex` so reordering columns can't misplace it, and only in the
  scrollable content table, never the pinned `dx-datagrid-content-fixed` gutter.
  Names that map to two different BOMs are skipped rather than guessed.

## Troubleshooting

- **”Native host error” in the extension console** — re-run the installer, and
  make sure the loaded extension ID matches `akplcachdkpchhcacbbbnkgbfnfgifbn`.
- **No draft appears** — check `native-host/host.log` (created on first run) for
  errors.
  - Windows: confirm `pywin32` is installed (`pip show pywin32`) and classic
    Outlook is present.
  - macOS: confirm Mail.app or Outlook has at least one account configured.
- **macOS: "Native host has exited" / nothing opens, PDF just downloads** — the
  host is being blocked by macOS privacy (TCC) protection. Two things to check:
  1. The host must be installed under `~/Library/Application Support/InnerCider/`,
     not inside `~/Documents`. Re-run `./install.sh` (it installs there now).
  2. The host reads the exported PDF from `~/Downloads`. Grant your browser
     **Full Disk Access** (System Settings → Privacy & Security → Full Disk
     Access → add your browser), then **fully quit and reopen** the browser.
  Also make sure PDFs are set to **download** (not open in-browser) at
  `chrome://settings/content/pdfDocuments`, and on first run allow the
  "wants to control Microsoft Outlook" automation prompt.
- **Wrong materials columns** — the scraper reads the Materials grid by column
  position (Name=1, Description=2, UoM=3, Qty Ordered=4, Extended Cost=7). If you
  reorder columns in Innergy’s saved view, update the `COL` map in
  `extension/content/features/draft-email.js`.
- **No `BOM ↗` chips on a work order** — first check the **BOM app backlinks**
  address is set in Options; blank (or not `http(s)://`) keeps the feature off by
  design. Otherwise expected when the shipment items weren’t pushed from the BOM
  app (only rows whose `EngineeringId` matches
  `cpwbom-<bomId>-asm-<assemblyId>` are linked). If they *were* pushed, open the
  console and look for `[InnerCider]` warnings: a failed `query/run` is retried
  after 30s. A chip missing from just one row usually means two rows in that work
  order share a name but came from different BOMs — the extension skips those
  rather than risk linking to the wrong BOM. Rename one of the assemblies in
  CPW-BOM and re-push to resolve it.

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

## Contributing / adding a feature

InnerCider is meant to grow into a toolkit of CPW-specific Innergy tools, not
stay a single-purpose extension. See [ARCHITECTURE.md](ARCHITECTURE.md) for
how the extension and native host are structured, and
[docs/adding-a-feature.md](docs/adding-a-feature.md) for the concrete steps
(with a template file to copy from) to add a new one.
