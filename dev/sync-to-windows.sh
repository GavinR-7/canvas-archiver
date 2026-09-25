#!/usr/bin/env bash
# Copy an extension build onto the Windows filesystem so Chrome can load it.
#
# Chrome on Windows loads unpacked extensions unreliably from \\wsl.localhost\
# UNC paths: it will sometimes accept the folder and then fail to read changed
# files, which produces confusing "why didn't my edit apply" sessions. Staging
# on an NTFS path Chrome can watch natively avoids the whole class of problem.
#
# Usage:  ./dev/sync-to-windows.sh [source-dir]
#         defaults to extension/spike
set -euo pipefail

SOURCE="${1:-extension/spike}"
WIN_USER="${WIN_USER:-gavin}"
DEST_ROOT="/mnt/c/Users/${WIN_USER}/canvas-archiver-ext"
DEST="${DEST_ROOT}/$(basename "${SOURCE}")"

if [[ ! -d "${SOURCE}" ]]; then
  echo "error: no such directory: ${SOURCE}" >&2
  exit 1
fi

mkdir -p "${DEST}"
# --delete so a removed source file does not linger in the loaded extension.
rsync -a --delete \
  --exclude node_modules --exclude '.git' \
  "${SOURCE}/" "${DEST}/"

WIN_PATH="C:\\Users\\${WIN_USER}\\canvas-archiver-ext\\$(basename "${SOURCE}")"
echo "Synced ${SOURCE} -> ${DEST}"
echo
echo "Load this path in Chrome (chrome://extensions -> Load unpacked):"
echo "    ${WIN_PATH}"
