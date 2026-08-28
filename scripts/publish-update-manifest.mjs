import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Builds release/update-manifest.json from whatever installers are actually
// present in release/. This is the file the "Updates" panel checks against —
// see src/main/updater.ts. It does not sign anything; a real release still
// needs the installer itself signed and notarized before this manifest is
// published, or Axiom is just pointing users at an executable Windows/macOS
// will refuse to run.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Axiom package version: ${version || '(empty)'}`);

const baseUrlArg = process.argv.find((arg) => arg.startsWith('--base-url='));
const baseUrl = baseUrlArg ? baseUrlArg.slice('--base-url='.length).replace(/\/$/, '') : '';
if (!baseUrl) throw new Error('Pass --base-url=https://your-download-host.example/axiom, the HTTPS location these installers will be hosted at.');
if (!/^https:\/\//i.test(baseUrl)) throw new Error('--base-url must be HTTPS: the app refuses to check or download from a non-HTTPS feed.');

const notesArg = process.argv.find((arg) => arg.startsWith('--notes='));
const minimumArg = process.argv.find((arg) => arg.startsWith('--minimum-supported='));
const channelArg = process.argv.find((arg) => arg.startsWith('--channel='));

function hashFile(file) {
  return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size };
}

const winInstaller = path.join(root, 'release', `Axiom-Setup-${version}.exe`);
const macInstaller = path.join(root, 'release', `Axiom-${version}-arm64.dmg`);
const artifacts = {};
if (fs.existsSync(winInstaller)) artifacts.win = { url: `${baseUrl}/${path.basename(winInstaller)}`, ...hashFile(winInstaller) };
if (fs.existsSync(macInstaller)) artifacts.mac = { url: `${baseUrl}/${path.basename(macInstaller)}`, ...hashFile(macInstaller) };
if (!Object.keys(artifacts).length) throw new Error(`No installer found for version ${version}. Expected ${path.basename(winInstaller)} and/or ${path.basename(macInstaller)} in release/.`);

const manifest = {
  schema: 1,
  channel: channelArg ? channelArg.slice('--channel='.length) : 'stable',
  latestVersion: version,
  minimumSupportedVersion: minimumArg ? minimumArg.slice('--minimum-supported='.length) : version,
  publishedAt: new Date().toISOString(),
  notes: notesArg ? notesArg.slice('--notes='.length) : undefined,
  artifacts,
};

const output = path.join(root, 'release', 'update-manifest.json');
fs.writeFileSync(output, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Wrote ${output}`);
console.log(JSON.stringify(manifest, null, 2));
console.log(`\nUpload every artifact in release/ alongside this manifest to ${baseUrl}/, then set the Updates panel's feed URL to ${baseUrl}/update-manifest.json.`);
console.log('This does not sign the installers. An unsigned .exe/.dmg published here will still be blocked by SmartScreen/Gatekeeper on the receiving machine.');
