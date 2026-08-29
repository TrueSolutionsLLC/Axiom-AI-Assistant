#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
VERSION="$(node -p "require('./package.json').version")"
echo "Axiom ${VERSION} · native Apple-silicon builder"
echo "Installing the locked dependency set…"
npm install
# Recent npm versions block a dependency's postinstall script by default
# until it's explicitly approved, as a supply-chain safety measure — a real
# clean clone hit this directly: onnxruntime-node's script (which sets up
# its native binary for the memory-embedding model) never ran, and rather
# than a build error, the model just silently returned nothing later. The
# approval subcommand's own name has changed across real npm versions this
# project has actually hit ("npm approve-scripts" vs "npm install-scripts
# approve") — try the known forms, swallowing whichever doesn't exist on
# this npm, then reinstall so any newly-approved script actually runs.
if npm install-scripts ls >/dev/null 2>&1 || npm approve-scripts --help >/dev/null 2>&1; then
  echo "Approving install scripts for onnxruntime-node, fsevents, and protobufjs (needed on this platform)…"
  npm install-scripts approve onnxruntime-node fsevents protobufjs >/dev/null 2>&1 || true
  npm approve-scripts onnxruntime-node fsevents protobufjs >/dev/null 2>&1 || true
  npm install
fi
if [[ ! -x "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]]; then
  echo "Completing Electron's macOS binary install (npm may have deferred install scripts)…"
  node node_modules/electron/install.js
fi
echo "Verifying this Mac and creating the arm64 DMG…"
npm run release:mac:native
echo "Axiom is ready in the release folder."
read -k 1 "?Press any key to close."
