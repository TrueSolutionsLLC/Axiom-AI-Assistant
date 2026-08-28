import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface UpdateArtifact { url:string; sha256:string; bytes:number }
export interface UpdateManifest {
  schema:1;
  channel:'stable'|'beta';
  latestVersion:string;
  minimumSupportedVersion:string;
  publishedAt:string;
  notesUrl?:string;
  notes?:string;
  artifacts:{ win?:UpdateArtifact; mac?:UpdateArtifact };
}

/**
 * Compares two `x.y.z` version strings. Axiom's version is validated to this
 * exact shape at release time (see mac-native-release.mjs), so a general semver
 * library with prerelease/build-metadata parsing would be unused complexity.
 */
export function compareVersions(a:string,b:string):number{
  const parse=(v:string)=>v.trim().split('.').map((part)=>Number(part));
  const [aMajor,aMinor,aPatch]=parse(a),[bMajor,bMinor,bPatch]=parse(b);
  if([aMajor,aMinor,aPatch,bMajor,bMinor,bPatch].some((n)=>!Number.isFinite(n)))throw new Error(`Invalid version comparison: "${a}" vs "${b}".`);
  return aMajor!==bMajor?aMajor-bMajor:aMinor!==bMinor?aMinor-bMinor:aPatch-bPatch;
}

function validateManifest(value:unknown):UpdateManifest{
  if(!value||typeof value!=='object')throw new Error('Update manifest is not an object.');
  const manifest=value as Partial<UpdateManifest>;
  if(manifest.schema!==1)throw new Error('Unsupported update manifest schema.');
  if(typeof manifest.latestVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.latestVersion))throw new Error('Update manifest has an invalid latestVersion.');
  if(typeof manifest.minimumSupportedVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.minimumSupportedVersion))throw new Error('Update manifest has an invalid minimumSupportedVersion.');
  const artifacts=manifest.artifacts;
  if(!artifacts||typeof artifacts!=='object')throw new Error('Update manifest is missing artifacts.');
  for(const platform of ['win','mac'] as const){
    const artifact=artifacts[platform];if(!artifact)continue;
    if(typeof artifact.url!=='string')throw new Error(`${platform} artifact is missing a URL.`);
    requireSecureUrl(artifact.url,`${platform} artifact URL`);
    if(typeof artifact.sha256!=='string'||!/^[a-f\d]{64}$/i.test(artifact.sha256))throw new Error(`${platform} artifact is missing a valid sha256.`);
    if(typeof artifact.bytes!=='number'||artifact.bytes<=0)throw new Error(`${platform} artifact is missing a valid byte size.`);
  }
  return manifest as UpdateManifest;
}

export interface UpdateCheckResult {
  currentVersion:string;
  updateAvailable:boolean;
  mustUpdate:boolean;
  manifest:UpdateManifest;
  artifact?:UpdateArtifact;
}

/**
 * A loopback address has no network path to intercept, so it is exempted from
 * the HTTPS requirement — this is what lets the update pipeline be exercised
 * against a real local HTTP server in tests without weakening the production
 * rule, which is enforced for every real host.
 */
function requireSecureUrl(value:string,label:string):URL{
  const url=new URL(value);
  const loopback=['127.0.0.1','localhost','::1'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))throw new Error(`The ${label} must use an explicit HTTPS address.`);
  return url;
}

/** Fetches and validates the update feed; never trusts an unvalidated shape. */
export async function checkForUpdate(feedUrl:string,currentVersion:string,platform:'win'|'mac'):Promise<UpdateCheckResult>{
  requireSecureUrl(feedUrl,'update feed URL');
  const response=await fetch(feedUrl,{signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`Update feed request failed (${response.status}).`);
  const manifest=validateManifest(await response.json());
  const artifact=manifest.artifacts[platform];
  const updateAvailable=compareVersions(manifest.latestVersion,currentVersion)>0;
  const mustUpdate=compareVersions(currentVersion,manifest.minimumSupportedVersion)<0;
  return{currentVersion,updateAvailable,mustUpdate,manifest,artifact};
}

/**
 * Downloads an installer and refuses to hand back a path unless its SHA-256
 * matches the manifest exactly. A partial or tampered download is deleted, not
 * silently offered — Axiom does not run unverified executables.
 */
export async function downloadVerifiedUpdate(artifact:UpdateArtifact,destinationDir:string,onProgress?:(receivedBytes:number,totalBytes:number)=>void):Promise<string>{
  requireSecureUrl(artifact.url,'update artifact URL');
  fs.mkdirSync(destinationDir,{recursive:true});
  const target=path.join(destinationDir,path.basename(new URL(artifact.url).pathname)||'axiom-update');
  const temporary=`${target}.download`;
  const response=await fetch(artifact.url,{signal:AbortSignal.timeout(600_000)});
  if(!response.ok||!response.body)throw new Error(`Update download failed (${response.status}).`);

  const hash=crypto.createHash('sha256');let received=0;
  const nodeStream=Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  nodeStream.on('data',(chunk:Buffer)=>{hash.update(chunk);received+=chunk.length;onProgress?.(received,artifact.bytes);});
  await pipeline(nodeStream,fs.createWriteStream(temporary));

  const digest=hash.digest('hex');
  if(digest!==artifact.sha256.toLowerCase()){
    fs.rmSync(temporary,{force:true});
    throw new Error(`Downloaded update failed integrity verification (expected ${artifact.sha256.slice(0,12)}…, got ${digest.slice(0,12)}…). The file was deleted rather than offered for installation.`);
  }
  if(received!==artifact.bytes){fs.rmSync(temporary,{force:true});throw new Error(`Downloaded update is ${received} bytes; the manifest declared ${artifact.bytes}. The file was deleted.`);}
  fs.renameSync(temporary,target);
  return target;
}
