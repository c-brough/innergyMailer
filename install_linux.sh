#!/usr/bin/env bash
#
# Installs the InnerCider native messaging host on Linux, including
# Raspberry Pi OS (ARM). Safe to re-run.
#
# Usage:  ./install_linux.sh
#
set -euo pipefail

HOST_NAME="com.innergy.mailer"
EXTENSION_ID="akplcachdkpchhcacbbbnkgbfnfgifbn"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native-host"

# No TCC-style restriction on Linux, but keep the host out of the repo anyway so
# a `git pull` or a moved checkout can't break an install.
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/InnerCider"
HOST_PY="$INSTALL_DIR/innergy_mailer_host_linux.py"
WRAPPER="$INSTALL_DIR/run-host.sh"
VENV_DIR="$INSTALL_DIR/venv"

# 1. Resolve an absolute python3. The browser launches the host with a minimal
#    PATH, so `env python3` cannot be relied on.
SYS_PYTHON="$(command -v python3 || true)"
if [[ -z "$SYS_PYTHON" ]]; then
  echo "ERROR: python3 not found on PATH. Install it:  sudo apt install python3" >&2
  exit 1
fi
SYS_PYTHON="$(cd "$(dirname "$SYS_PYTHON")" && pwd)/$(basename "$SYS_PYTHON")"
echo "Using python3: $SYS_PYTHON"

mkdir -p "$INSTALL_DIR"
cp "$NATIVE_DIR/innergy_mailer_host_linux.py" "$HOST_PY"
chmod +x "$HOST_PY"

# 2. Build a venv for msal + requests. Debian/Raspberry Pi OS (Bookworm and
#    newer) mark the system Python as externally-managed (PEP 668), so
#    `pip install --user msal` fails outright — a venv is the supported route.
#    Only the "Outlook on the web" (Graph) path needs these; the host imports
#    them lazily, so a failure here still leaves the "Default mail client" path
#    working. Don't abort the install over it.
PYTHON_BIN="$SYS_PYTHON"
if ! "$SYS_PYTHON" -c "import venv, ensurepip" >/dev/null 2>&1; then
  echo "WARNING: python3-venv is missing, skipping the Graph dependencies." >&2
  echo "         Install it and re-run:  sudo apt install python3-venv" >&2
else
  echo "Creating venv -> $VENV_DIR"
  "$SYS_PYTHON" -m venv "$VENV_DIR"
  if "$VENV_DIR/bin/pip" install --quiet --upgrade msal requests; then
    PYTHON_BIN="$VENV_DIR/bin/python3"
    echo "Installed msal + requests into the venv"
  else
    echo "WARNING: could not install msal/requests (no network?)." >&2
    echo "         'Outlook on the web' will fail until you re-run this script." >&2
    echo "         The 'Default mail client' option needs no extra packages." >&2
  fi
fi

# 3. Wrapper that invokes the host with that absolute interpreter.
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$PYTHON_BIN" "$HOST_PY"
EOF
chmod +x "$WRAPPER"
echo "Installed host -> $INSTALL_DIR"

# 4. Write the native-messaging manifest for every Chromium-family browser.
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

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# Chromium is the default browser on Raspberry Pi OS, and this script often runs
# before it has ever been launched — create its directory unconditionally rather
# than skipping the one target that matters most.
ALWAYS_DIRS=(
  "$CONFIG_HOME/chromium/NativeMessagingHosts"
)

# The rest only get a manifest if their profile root already exists.
OPTIONAL_DIRS=(
  "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
  "$CONFIG_HOME/google-chrome-beta/NativeMessagingHosts"
  "$CONFIG_HOME/google-chrome-unstable/NativeMessagingHosts"
  "$CONFIG_HOME/microsoft-edge/NativeMessagingHosts"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$CONFIG_HOME/vivaldi/NativeMessagingHosts"
  # Snap and Flatpak Chromium keep their own confined config trees.
  "$HOME/snap/chromium/current/.config/chromium/NativeMessagingHosts"
  "$HOME/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts"
)

install_manifest() {
  mkdir -p "$1"
  printf '%s\n' "$MANIFEST" > "$1/$HOST_NAME.json"
  echo "Installed host manifest -> $1/$HOST_NAME.json"
}

for dir in "${ALWAYS_DIRS[@]}"; do
  install_manifest "$dir"
done

for dir in "${OPTIONAL_DIRS[@]}"; do
  if [[ -d "$(dirname "$dir")" ]]; then
    install_manifest "$dir"
  fi
done

# A confined (Snap/Flatpak) Chromium cannot execute a host under ~/.local/share.
if [[ -d "$HOME/snap/chromium" || -d "$HOME/.var/app/org.chromium.Chromium" ]]; then
  echo
  echo "NOTE: A Snap or Flatpak Chromium was detected. Those sandboxes usually" >&2
  echo "      block launching a native host from outside the sandbox, so the" >&2
  echo "      draft-email feature may not work there. The apt/deb Chromium" >&2
  echo "      (default on Raspberry Pi OS) has no such restriction." >&2
fi

echo
echo "Done. Next steps:"
echo "  1. Open chromium://extensions (or chrome://extensions)."
echo "  2. Enable 'Developer mode'."
echo "  3. 'Load unpacked' and select:  $SCRIPT_DIR/extension"
echo "  4. Confirm the extension ID is: $EXTENSION_ID"
echo "  5. Open the extension's Options page, pick a mail app under 'Linux'."
echo "     'Outlook on the web' also needs an Azure Client ID + one-time Sign in."
echo "  6. Open an Innergy PO page; click 'Draft Email w/ PDF'."
