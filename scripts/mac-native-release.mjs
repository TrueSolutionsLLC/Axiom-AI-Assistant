import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const verifyOnly=process.argv.includes('--verify-only');
const packageJson=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const version=String(packageJson.version||'').trim();
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error(`Invalid Axiom package version: ${version||'(empty)'}`);
const required=[
  'src/renderer/public/models/wavlm-base-plus-sv/onnx/model_quantized.onnx',
  'src/renderer/public/models/wavlm-base-plus-sv/config.json',
  'build/entitlements.mac.plist','build/entitlements.mac.inherit.plist','build/axiom-icon.png'
];

function run(command,args){
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command,args,{cwd:root,stdio:'inherit',env:{...process.env,VITE_CONFIG_NATIVE_IGNORE_WARNING:'true'}});
}

if(process.platform!=='darwin')throw new Error('The native Mac release must be created on macOS. Copy this source folder to the Mac and run BUILD-AXIOM-MAC.command.');
if(process.arch!=='arm64')throw new Error(`Apple-silicon arm64 is required; detected ${process.arch}.`);
const nodeMajor=Number(process.versions.node.split('.')[0]);
if(nodeMajor<22)throw new Error(`Node.js 22 or newer is required; detected ${process.versions.node}.`);
run('/usr/bin/xcode-select',['-p']);
for(const relative of required){const file=path.join(root,relative);if(!fs.existsSync(file))throw new Error(`Required release asset is missing: ${relative}`);}
const modelBytes=fs.statSync(path.join(root,required[0])).size;
if(modelBytes<90_000_000)throw new Error(`Bundled WavLM model is incomplete (${modelBytes} bytes).`);
console.log(`Axiom Mac preflight passed · ${os.arch()} · Node ${process.versions.node} · local WavLM ${modelBytes} bytes`);
if(verifyOnly)process.exit(0);
// A zip extracted from Dropbox (or anywhere macOS attaches quarantine/Finder
// metadata) leaves AppleDouble/resource-fork extended attributes on the
// unpacked files. codesign refuses to sign anything carrying them
// ("resource fork, Finder information, or similar detritus not allowed"),
// which otherwise only surfaces after the full build+package run. Strip
// them up front so a signing failure never depends on how the source folder
// happened to get onto this Mac.
run('/usr/bin/xattr',['-cr',root]);
// A real fresh-clone failure: the memory-embedding tests mock the packaged
// app's model path and expect to find it under dist-renderer/models/ — but
// dist-renderer/ is build output, gitignored, and only created by `npm run
// build`. On any machine that already had a stale dist-renderer/ sitting
// around from an earlier build, running `npm test` before building never
// surfaced this; a genuinely fresh clone has no such leftover, and every
// embedding test silently returned "no vector" instead of a real one — not
// a crash, just every affected test failing with no obvious cause. Building
// first (dist:mac below rebuilds it again, which is fast and harmless) is
// what actually guarantees the assets the tests check for exist.
run('npm',['run','build']);
run('npm',['test']);
run('npm',['run','dist:mac']);
const release=path.join(root,'release');
const artifactName=`Axiom-${version}-arm64.dmg`;
const dmg=path.join(release,artifactName);
if(!fs.existsSync(dmg))throw new Error(`The native build finished without producing ${artifactName}.`);
const bytes=fs.statSync(dmg).size,sha256=crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
const manifest=`${path.basename(dmg)}\nbytes=${bytes}\nsha256=${sha256}\nbuilt=${new Date().toISOString()}\nplatform=darwin-arm64\n`;
fs.writeFileSync(path.join(release,`Axiom-${version}-arm64.sha256.txt`),manifest,'utf8');
console.log(`\nNative Apple-silicon release verified:\n${manifest}`);
run('/usr/bin/open',[release]);
