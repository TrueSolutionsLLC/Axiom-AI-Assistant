#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
VERSION="$(node -p "require('./package.json').version")"
echo "Axiom ${VERSION} · native Apple-silicon builder"
echo "Installing the locked dependency set…"
npm install
if [[ ! -x "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]]; then
  echo "Completing Electron's macOS binary install (npm may have deferred install scripts)…"
  node node_modules/electron/install.js
fi
echo "Verifying this Mac and creating the arm64 DMG…"
npm run release:mac:native
echo "Axiom is ready in the release folder."
read -k 1 "?Press any key to close."
