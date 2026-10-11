#!/usr/bin/env bash
#
# Installs InnerCider on macOS: the native messaging host (so the extension
# can hand the exported PDF to Mail/Outlook) and a copy of the extension itself,
# then opens the browser's Extensions page for the one click Chrome won't let a
# script make. Safe to re-run.
#
# Usage:  ./install.sh    (or double-click "Install InnerCider.command")
#
set -euo pipefail

HOST_NAME="com.innergy.mailer"
EXTENSION_ID="akplcachdkpchhcacbbbnkgbfnfgifbn"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native-host"

# The host must live OUTSIDE ~/Documents (and ~/Desktop, ~/Downloads): those are
# TCC-protected folders, and macOS blocks a GUI app like Chrome from *executing*
# a native-messaging host located inside them — the host "exits" before it can
# run and no draft is created. Install into ~/Library/Application Support, which
# Chrome can launch from without any special permission.
INSTALL_DIR="$HOME/Library/Application Support/InnerCider"
HOST_PY="$INSTALL_DIR/innergy_mailer_host.py"
WRAPPER="$INSTALL_DIR/run-host.sh"

# 1. Resolve an absolute python3 (Chrome launches the host with a minimal PATH,
#    so we cannot rely on `env python3` finding it).
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: python3 not found on PATH. Install Python 3 and re-run." >&2
  exit 1
fi
PYTHON_BIN="$(cd "$(dirname "$PYTHON_BIN")" && pwd)/$(basename "$PYTHON_BIN")"
# On a Mac without the Command Line Tools, /usr/bin/python3 is only a stub that
# offers to install them, so being on PATH doesn't mean it runs.
if ! "$PYTHON_BIN" -c 'import sys' >/dev/null 2>&1; then
  echo "ERROR: $PYTHON_BIN is not usable yet." >&2
  echo "If macOS offered to install developer tools, click Install, let it finish," >&2
  echo "then run this installer again." >&2
  exit 1
fi
echo "Using python3: $PYTHON_BIN"

# 2. Copy the host into the install dir and create a wrapper that invokes it with
#    that absolute interpreter.
mkdir -p "$INSTALL_DIR"
cp "$NATIVE_DIR/innergy_mailer_host.py" "$HOST_PY"
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$PYTHON_BIN" "$HOST_PY"
EOF
chmod +x "$WRAPPER" "$HOST_PY"
echo "Installed host -> $INSTALL_DIR"

# 3. Write the native-messaging manifest into every Chromium-family browser that
#    is installed on this Mac.
read -r -d '' MANIFEST <<EOF || true
{
  "name": "$HOST_NAME",
  "description": "Innergy PO -> Mail native messaging host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

TARGET_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

installed=0
for dir in "${TARGET_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  # Only install where the browser's profile root already exists.
  if [[ -d "$parent" ]]; then
    mkdir -p "$dir"
    printf '%s\n' "$MANIFEST" > "$dir/$HOST_NAME.json"
    echo "Installed host manifest -> $dir/$HOST_NAME.json"
    installed=$((installed + 1))
  fi
done

if [[ "$installed" -eq 0 ]]; then
  echo "WARNING: No supported browser profile directories found." >&2
fi

# 4. Copy the extension next to the host. Chrome won't let a script add an
#    extension that isn't from the Web Store, so "Load unpacked" stays a manual
#    click — but it should point at a folder that outlives this download: a copy
#    loaded straight from ~/Downloads breaks the day that folder is cleaned out.
#    The manifest "key" pins the extension ID, so the folder doesn't affect it.
EXT_DIR="$INSTALL_DIR/extension"
rm -rf "$EXT_DIR"
cp -R "$SCRIPT_DIR/extension" "$EXT_DIR"
echo "Installed extension -> $EXT_DIR"

# 5. Open the Extensions page in the first Chromium-family browser found, with
#    the folder path on the clipboard for the Load unpacked picker.
BROWSER_APP=""
EXT_URL=""
for entry in "Google Chrome|chrome://extensions" \
             "Microsoft Edge|edge://extensions" \
             "Brave Browser|chrome://extensions" \
             "Chromium|chrome://extensions"; do
  app="${entry%%|*}"
  if [[ -d "/Applications/$app.app" || -d "$HOME/Applications/$app.app" ]]; then
    BROWSER_APP="$app"
    EXT_URL="${entry#*|}"
    break
  fi
done

printf '%s' "$EXT_DIR" | pbcopy || true
if [[ -n "$BROWSER_APP" ]]; then
  open -a "$BROWSER_APP" "$EXT_URL" || true
fi

echo
echo "=============================================================="
echo " One last step: add the extension to ${BROWSER_APP:-your browser}"
echo "=============================================================="
if [[ -n "$BROWSER_APP" ]]; then
  echo "$BROWSER_APP is opening its Extensions page. On that page:"
else
  echo "Open chrome://extensions in your browser. On that page:"
fi
echo "  1. Turn on \"Developer mode\"."
echo "  2. Click \"Load unpacked\"."
echo "  3. In the folder picker press Cmd+Shift+G, paste (Cmd+V), press"
echo "     Return, then click \"Select\". The path is on your clipboard:"
echo "       $EXT_DIR"
echo "  4. Check the InnerCider card shows ID $EXTENSION_ID"
echo
echo "Updating an existing install? Skip those steps and click the reload"
echo "arrow on the InnerCider card instead (or quit and reopen the browser)."
echo
echo "Then open an Innergy PO and click \"Draft Email w/ PDF\"."
echo "Drafts open in Apple Mail; to use Outlook, pick it in the extension's"
echo "Options (right-click the InnerCider icon > Options)."
