#!/bin/bash
#
# Double-click this file in Finder to install InnerCider on a Mac.
# It runs install.sh in a Terminal window and keeps the window open so the
# final "Load unpacked" step stays on screen.
#
cd "$(dirname "$0")" || exit 1
bash ./install.sh
status=$?
echo
if [[ $status -ne 0 ]]; then
  echo "Install did not finish -- see the messages above."
fi
read -r -n 1 -s -p "Press any key to close this window..."
echo
exit $status
