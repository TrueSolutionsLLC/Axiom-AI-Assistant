import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Produces release/Axiom-Mac-Source-<version>.zip: the exact source set that
// BUILD-AXIOM-MAC.command needs on the Apple-silicon Mac, and nothing else.
// The Mac cannot be built from Windows, so this bundle is the transfer format.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Axiom package version: ${version || '(empty)'}`);

// Mirrors the preflight in mac-native-release.mjs. Failing here on Windows is
// far cheaper than failing after a 100 MB transfer to the Mac.
const required = [
  ['src/renderer/public/models/wavlm-base-plus-sv/onnx/model_quantized.onnx', 90_000_000],
  ['src/renderer/public/models/wavlm-base-plus-sv/config.json', 0],
  ['src/renderer/public/models/face_landmarker.task', 0],
  ['src/renderer/public/ort/ort-wasm-simd-threaded.jsep.wasm', 0],
  ['build/entitlements.mac.plist', 0],
  ['build/entitlements.mac.inherit.plist', 0],
  ['build/axiom-icon.png', 0],
  ['BUILD-AXIOM-MAC.command', 0],
];

for (const [relative, minimumBytes] of required) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`Required Mac release asset is missing: ${relative}`);
  const bytes = fs.statSync(file).size;
  if (bytes < minimumBytes) throw new Error(`${relative} is incomplete (${bytes} bytes, expected at least ${minimumBytes}).`);
}

// Allowlist, not a denylist: the working tree also holds electron-builder temp
// directories, qa-* Electron profiles, and an unused root public/ duplicate.
const include = [
  'src', 'build', 'scripts', 'docs',
  'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts', 'vitest.config.ts',
  'BUILD-AXIOM-MAC.command',
  ...fs.readdirSync(root).filter((entry) => entry.endsWith('.md')),
];

const skip = new Set(['node_modules', '.vite', '.DS_Store', '.npm-cache']);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mac-source-'));
let files = 0, bytes = 0;

try {
  for (const entry of include) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) { console.warn(`  skipped (absent): ${entry}`); continue; }
    fs.cpSync(from, path.join(stage, entry), {
      recursive: true,
      filter: (source) => {
        if (skip.has(path.basename(source))) return false;
        if (fs.statSync(source).isFile()) { files += 1; bytes += fs.statSync(source).size; }
        return true;
      },
    });
  }

  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const output = path.join(root, 'release', `Axiom-Mac-Source-${version}.zip`);
  fs.rmSync(output, { force: true });
  console.log(`Staged ${files} files (${(bytes / 1e6).toFixed(1)} MB). Compressing…`);

  if (process.platform === 'win32') {
    // Must be System32's bsdtar, not GNU tar: if Git for Windows is ahead on
    // PATH, `tar -a -c -f out.zip` silently writes a TAR named .zip (exit 0).
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
      if (!fs.existsSync(bsdtar)) throw new Error('bsdtar not present');
      execFileSync(bsdtar, ['-a', '-c', '-f', output, '-C', stage, '.'], { stdio: 'inherit' });
    } catch {
      // PowerShell single-quoted strings escape a quote by doubling it, which
      // matters for any user profile path containing an apostrophe.
      const ps = (value) => `'${value.replaceAll("'", "''")}'`;
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path ${ps(`${stage}\\*`)} -DestinationPath ${ps(output)} -Force`], { stdio: 'inherit' });
    }
  } else {
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', stage, output], { stdio: 'inherit' });
  }

  // A bundle the Mac cannot open is worse than no bundle, so prove it is a zip.
  const magic = Buffer.alloc(4);
  const handle = fs.openSync(output, 'r');
  try { fs.readSync(handle, magic, 0, 4, 0); } finally { fs.closeSync(handle); }
  if (magic.toString('hex') !== '504b0304') throw new Error(`${path.basename(output)} is not a ZIP archive (magic ${magic.toString('hex')}). Refusing to publish it.`);

  const zipBytes = fs.statSync(output).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  const manifest = `${path.basename(output)}\nbytes=${zipBytes}\nsha256=${sha256}\nbuilt=${new Date().toISOString()}\nsourceVersion=${version}\n`;
  fs.writeFileSync(path.join(root, 'release', `Axiom-Mac-Source-${version}.sha256.txt`), manifest, 'utf8');

  console.log(`\nMac source bundle ready:\n${manifest}`);
  console.log('On the Mac: unzip, then `chmod +x BUILD-AXIOM-MAC.command && ./BUILD-AXIOM-MAC.command`');
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
