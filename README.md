# Innergy PO → Mail

A Chrome extension + macOS native helper that adds a **“Draft Email w/ PDF”**
button next to **Export Custom PDF** on an Innergy purchase-order page. Clicking
it:

1. Exports the PO PDF using Innergy’s existing **Export Custom PDF** button.
2. Drafts a new email in **Apple Mail** or **Microsoft Outlook** (your choice)
   with that PDF attached, where:
   - **Subject** = `<PO#> & <vendor name>` (e.g. `PO-100000 & Zepp Framers LLC - Sewell`)
   - **Body** = a brief summary of the line items in the PO’s **Materials** grid.

The draft is left **open and unsent** so you can review and send it yourself.

## Why a native helper is needed

Chrome extensions are sandboxed and cannot attach files to Mail. The extension
therefore talks to a tiny local Python script (a “native messaging host”) that
runs AppleScript to build the Mail draft. The `install.sh` script registers it.

## Layout

```
extension/                 Chrome extension (load unpacked)
  manifest.json            MV3 manifest; pins a fixed extension ID via "key"
  content.js               Injects the button, scrapes PO#/vendor/materials
  background.js            Captures the download, calls the native host
native-host/
  innergy_mailer_host.py   Reads the message, drafts the email via osascript
  run-host.sh              Wrapper (created by install.sh) with absolute python3
  com.innergy.mailer.json  Reference copy of the native-messaging manifest
install.sh                 Registers the native host for installed browsers
```

## Install

```bash
./install.sh
```

### Choosing the mail app

By default the draft opens in **Apple Mail**. To use **Microsoft Outlook**
instead, open the extension's options:

- `chrome://extensions` → **Innergy PO → Mail** → **Details** → **Extension options**, or
- right-click the extension icon → **Options**.

Pick Apple Mail or Microsoft Outlook (saved instantly). The setting takes effect
on the next click — no reload needed. Outlook must support AppleScript (classic
Outlook does).

### Loading the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. Confirm the extension ID is `akplcachdkpchhcacbbbnkgbfnfgifbn`
   (the manifest `key` pins it so the native host’s allow-list matches).

Open any Innergy PO page and the button appears to the left of **Export Custom PDF**.

> If you load the extension and get a different ID, the native host won’t accept
> it. Re-run `./install.sh` is *not* enough in that case — the ID is pinned by
> the `key` field in `extension/manifest.json`, so just remove any older copy of
> the extension and load this folder fresh.

## How it works

- **content.js** waits (via a `MutationObserver`) for
  `button[data-testid="ExportCustomReportDefault_single"]`, injects our button
  before it, and on click scrapes:
  - PO# from `[data-testid="purchase-order-header"]` / breadcrumb / title,
  - vendor from the **Vendor (Company - Office)** label’s linked value,
  - materials from the **Materials** `[role="grid"]` (Material Name, UoM,
    Quantity Ordered, Extended Cost).
- It tells **background.js** to arm a download watcher, then clicks the real
  export button.
- Innergy names the exported file with a random GUID (e.g. `6448ef99-….pdf`), so
  there is no PO number in the filename to validate against. **background.js**
  therefore captures the first download that **completes after the click** and is
  a PDF (by MIME or `.pdf` extension); downloads that began before the click are
  rejected.
- It also fetches the PO's **Files tab** attachments via the same API the app
  uses (`PurchaseOrderAttachmentsQuery`). Each file's **`innergyEmailAttach`**
  custom field decides what happens:
  - **Yes** → attached automatically.
  - **No** → skipped.
  - **empty/unset** → the extension shows a checkbox dialog so you can pick which
    of those files to include (the export only runs after you confirm).
  Selected files are downloaded and attached alongside the PDF. It then sends
  `{attachments, subject, body, to, app}` to the native host, which attaches every
  file to the draft.
- **innergy_mailer_host.py** runs AppleScript to create the Mail draft.

## Troubleshooting

- **“Native host error” in the extension console** — re-run `./install.sh`, and
  make sure the loaded extension ID matches the one above.
- **No draft appears** — check `native-host/host.log` (created on first run) for
  errors. Confirm Mail.app has at least one account configured.
- **Wrong materials columns** — the scraper reads the Materials grid by column
  position (Name=1, Description=2, UoM=3, Qty Ordered=4, Extended Cost=7). If you
  reorder columns in Innergy’s saved view, update the `COL` map in `content.js`.

## Uninstall

```bash
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.innergy.mailer.json"
# (repeat for other browsers if you use them)
```

Then remove the extension from `chrome://extensions`.
