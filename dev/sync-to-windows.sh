#!/usr/bin/env bash
# Copy an extension build onto the Windows filesystem so Chrome can load it.
#
# Chrome on Windows loads unpacked extensions unreliably from \\wsl.localhost\
# UNC paths: it will sometimes accept the folder and then fail to read changed
# files, which produces confusing "why didn't my edit apply" sessions. Staging
# on an NTFS path Chrome can watch natively avoids the whole class of problem.
#
# Usage:  ./dev/sync-to-windows.sh [source-dir] [dest-name]
#   ./dev/sync-to-windows.sh extension/spike
#   ./dev/sync-to-windows.sh extension/.output/chrome-mv3 canvas-archiver
set -euo pipefail

# Work from the repo root regardless of where this was invoked, so the same
# relative source path works from the root and from extension/.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SOURCE="${1:-extension/spike}"
WIN_USER="${WIN_USER:-gavin}"
DEST_ROOT="/mnt/c/Users/${WIN_USER}/canvas-archiver-ext"
# Second argument overrides the destination folder name, so a build output
# directory like extension/.output/chrome-mv3 can land somewhere legible.
DEST_NAME="${2:-$(basename "${SOURCE}")}"
DEST="${DEST_ROOT}/${DEST_NAME}"

if [[ ! -d "${SOURCE}" ]]; then
  echo "error: no such directory: ${SOURCE}" >&2
  exit 1
fi

mkdir -p "${DEST}"
# --delete so a removed source file does not linger in the loaded extension.
rsync -a --delete \
  --exclude node_modules --exclude '.git' \
  "${SOURCE}/" "${DEST}/"

WIN_PATH="C:\\Users\\${WIN_USER}\\canvas-archiver-ext\\${DEST_NAME}"
echo "Synced ${SOURCE} -> ${DEST}"
echo
echo "Load this path in Chrome (chrome://extensions -> Load unpacked):"
echo "    ${WIN_PATH}"
