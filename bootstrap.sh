#!/usr/bin/env bash
#
# InnerCider one-line installer for macOS and Linux.
#
# Downloads the extension + native host straight from GitHub (no git needed) and
# runs the platform installer. Public repo, so no sign-in.
#
#   curl -fsSL https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.sh | bash
#
# Pick a branch (default: main):
#   curl -fsSL https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.sh | bash -s -- one-click-installers
#   # or: INNERCIDER_BRANCH=one-click-installers before the command
#
set -euo pipefail

REPO="c-brough/innergyMailer"
BRANCH="${1:-${INNERCIDER_BRANCH:-main}}"

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) echo "This bootstrap is for macOS/Linux. On Windows use bootstrap.ps1." >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH"
echo "Downloading InnerCider ($BRANCH) from GitHub…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/src.zip"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/src.zip" "$URL"
else
  echo "Need curl or wget installed." >&2; exit 1
fi

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP/src.zip" -d "$TMP"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/src.zip" "$TMP"
else
  echo "Need unzip or python3 to extract the download." >&2; exit 1
fi

SRC="$(find "$TMP" -maxdepth 1 -type d -name 'innergyMailer-*' | head -1)"
if [ -z "${SRC:-}" ]; then
  echo "Download/extract failed (is the branch name '$BRANCH' correct?)." >&2; exit 1
fi

echo "Running the installer…"
cd "$SRC"
if [ "$OS" = "mac" ]; then
  bash install.sh
else
  bash install_linux.sh
fi
