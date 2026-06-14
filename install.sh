#!/usr/bin/env bash
#
# Installs the Innergy PO -> Mail native messaging host so the Chrome extension
# can hand off the exported PDF to Mail.app. Safe to re-run.
#
# Usage:  ./install.sh
#
set -euo pipefail

HOST_NAME="com.innergy.mailer"
EXTENSION_ID="akplcachdkpchhcacbbbnkgbfnfgifbn"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native-host"
HOST_PY="$NATIVE_DIR/innergy_mailer_host.py"
WRAPPER="$NATIVE_DIR/run-host.sh"

# 1. Resolve an absolute python3 (Chrome launches the host with a minimal PATH,
#    so we cannot rely on `env python3` finding it).
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: python3 not found on PATH. Install Python 3 and re-run." >&2
  exit 1
fi
PYTHON_BIN="$(cd "$(dirname "$PYTHON_BIN")" && pwd)/$(basename "$PYTHON_BIN")"
echo "Using python3: $PYTHON_BIN"

# 2. Create a wrapper that invokes the host with that absolute interpreter.
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$PYTHON_BIN" "$HOST_PY"
EOF
chmod +x "$WRAPPER" "$HOST_PY"

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

echo
echo "Done. Next steps:"
echo "  1. Open your browser's extensions page (e.g. chrome://extensions)."
echo "  2. Enable 'Developer mode'."
echo "  3. 'Load unpacked' and select:  $SCRIPT_DIR/extension"
echo "  4. Confirm the extension ID is: $EXTENSION_ID"
echo "  5. Open an Innergy PO page; click 'Draft Email w/ PDF'."
