import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncPayload, SyncStatus } from '../shared/contracts';
import type { AppStore } from './store';

interface EncryptedEnvelope { schema:1; algorithm:'aes-256-gcm+scrypt'; salt:string; iv:string; tag:string; ciphertext:string; }

export function encryptSyncPayload(payload:SyncPayload,passphrase:string):string{
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.scryptSync(passphrase,salt,32),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const plaintext=Buffer.from(JSON.stringify(payload),'utf8'),ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const envelope:EncryptedEnvelope={schema:1,algorithm:'aes-256-gcm+scrypt',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  return JSON.stringify(envelope);
}

export function decryptSyncPayload(serialized:string,passphrase:string):SyncPayload{
  const envelope=JSON.parse(serialized) as Partial<EncryptedEnvelope>;
  if(envelope.schema!==1||envelope.algorithm!=='aes-256-gcm+scrypt'||!envelope.salt||!envelope.iv||!envelope.tag||!envelope.ciphertext)throw new Error('Unsupported Axiom sync file.');
  const key=crypto.scryptSync(passphrase,Buffer.from(envelope.salt,'base64'),32),decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'),payload=JSON.parse(plaintext) as SyncPayload;
  if(payload.schema!==1||!payload.device?.id||!Array.isArray(payload.history)||!Array.isArray(payload.memories))throw new Error('Invalid Axiom sync payload.');
  return payload;
}

export class SyncManager {
  private syncing=false;
  private timer?:NodeJS.Timeout;
  private activitySync?:NodeJS.Timeout;
  constructor(private readonly store:AppStore){}

  start():void{this.stop();this.timer=setInterval(()=>{if(this.store.syncConfiguration().enabled)void this.syncNow().catch(()=>{});},12_000);this.timer.unref();setTimeout(()=>{if(this.store.syncConfiguration().enabled)void this.syncNow().catch(()=>{});},1800).unref();}
  stop():void{if(this.timer)clearInterval(this.timer);if(this.activitySync)clearTimeout(this.activitySync);this.timer=undefined;this.activitySync=undefined;}
  status():SyncStatus{return this.store.syncStatus(this.syncing);}
  noteActivity():SyncStatus{this.store.noteDeviceActivity();if(this.store.syncConfiguration().enabled&&!this.activitySync){this.activitySync=setTimeout(()=>{this.activitySync=undefined;void this.syncNow().catch(()=>{});},450);this.activitySync.unref();}return this.status();}

  async syncNow():Promise<SyncStatus>{
    if(this.syncing)return this.status();
    const config=this.store.syncConfiguration();
    if(!config.enabled)throw new Error('Axiom Sync is turned off.');
    if(!config.folder||!config.passphrase)throw new Error('Choose a shared folder and save the same sync passphrase on both computers.');
    this.syncing=true;
    try{
      const directory=path.join(config.folder,'.axiom-sync','v1');await fs.mkdir(directory,{recursive:true});
      const entries=(await fs.readdir(directory,{withFileTypes:true})).filter((item)=>item.isFile()).map((item)=>item.name);
      const files=entries.filter((name)=>name.endsWith('.axsync'));
      // A crash between write and rename strands a .tmp file in the user's cloud
      // folder; sweep ones old enough that no write could still be in flight.
      for(const name of entries.filter((item)=>item.endsWith('.tmp'))){
        try{const stat=await fs.stat(path.join(directory,name));if(Date.now()-stat.mtimeMs>10*60_000)await fs.rm(path.join(directory,name),{force:true});}catch{/* another device may have cleaned it */}
      }
      const devices=[],unreadable:string[]=[];
      for(const file of files){
        // One bad shard must not stop this device from publishing its own data.
        // A file can be unreadable for benign reasons — a cloud provider still
        // streaming it down, or a stale shard from a device that used an older
        // passphrase — and aborting here previously froze sync permanently.
        try{const payload=decryptSyncPayload(await fs.readFile(path.join(directory,file),'utf8'),config.passphrase);this.store.mergeSyncPayload(payload);devices.push(payload.device);}
        catch{unreadable.push(file);}
      }
      const now=new Date().toISOString(),payload=this.store.exportSyncPayload(now),target=path.join(directory,`${payload.device.id}.axsync`),temporary=`${target}.${process.pid}.tmp`;
      // Writing our own shard never overwrites a peer's: each device owns one file.
      await fs.writeFile(temporary,encryptSyncPayload(payload,config.passphrase),{encoding:'utf8',mode:0o600});await fs.rename(temporary,target);
      devices.push(payload.device);this.store.recordSyncSuccess(now,devices);
      if(unreadable.length){
        // Reported truthfully, but as a degraded state rather than a failure that
        // hides the fact that this device did publish successfully.
        const everyPeerFailed=unreadable.length===files.length;
        this.store.recordSyncError(`This device published successfully, but ${unreadable.length} peer shard(s) could not be unlocked: ${unreadable.slice(0,3).join(', ')}${unreadable.length>3?'…':''}.${everyPeerFailed?' No peer file could be read, which usually means the other computer is using a different sync passphrase.':' They may still be downloading, or were written with a different passphrase.'}`);
      }
      return this.status();
    }catch(reason){const message=reason instanceof Error?reason.message:String(reason);this.store.recordSyncError(message);throw reason;}
    finally{this.syncing=false;}
  }
}
