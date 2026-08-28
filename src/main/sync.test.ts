import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SyncPayload } from '../shared/contracts';
import { decryptSyncPayload, encryptSyncPayload, SyncManager } from './sync';
import type { AppStore } from './store';

const payload:SyncPayload={schema:1,writtenAt:'2026-08-20T12:00:00.000Z',device:{id:'device-a',name:'Robbie PC',platform:'windows',hostname:'pc',architecture:'x64',appVersion:'2.0.0',firstSeenAt:'2026-08-20T11:00:00.000Z',lastSeenAt:'2026-08-20T12:00:00.000Z',lastActiveAt:'2026-08-20T11:59:00.000Z'},history:[],memories:[],goals:[],skills:[],agents:[],commitments:[],voiceProfiles:[],speakerProfiles:[],knownPeople:[{id:'person-a',name:'Robbie',descriptor:Array(128).fill(.01),primary:true,createdAt:'2026-08-20T11:00:00.000Z'}],appearance:{value:{color:'teal',emotion:'neutral',accentHex:'#20ffd3',glowIntensity:1,motionProfile:'adaptive',density:'balanced'},updatedAt:'2026-08-20T12:00:00.000Z'},tombstones:[]};

describe('encrypted cross-device sync envelope',()=>{
  it('round trips without exposing profile content',()=>{const encrypted=encryptSyncPayload(payload,'a-strong-shared-secret');expect(encrypted).not.toContain('Robbie PC');expect(decryptSyncPayload(encrypted,'a-strong-shared-secret')).toEqual(payload);});
  it('rejects the wrong passphrase',()=>{const encrypted=encryptSyncPayload(payload,'correct-shared-secret');expect(()=>decryptSyncPayload(encrypted,'wrong-shared-secret')).toThrow();});
});

describe('sync resilience to an unreadable peer shard',()=>{
  const passphrase='a-strong-shared-secret';
  const makeStore=(folder:string)=>{
    const merged:string[]=[];let lastError='';let succeeded=false;
    const store={
      syncConfiguration:()=>({enabled:true,folder,passphrase}),
      mergeSyncPayload:(value:SyncPayload)=>{merged.push(value.device.id);},
      exportSyncPayload:()=>({...payload,device:{...payload.device,id:'this-device'}}),
      recordSyncSuccess:()=>{succeeded=true;},
      recordSyncError:(message:string)=>{lastError=message;},
      syncStatus:()=>({state:'ready'}),
    } as unknown as AppStore;
    return{store,merged,read:()=>({lastError,succeeded})};
  };

  it('still publishes this device when a peer shard cannot be unlocked',async()=>{
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'axiom-sync-'));
    const directory=path.join(folder,'.axiom-sync','v1');
    fs.mkdirSync(directory,{recursive:true});
    // One good peer, one written with a different passphrase, one truncated by a
    // cloud provider mid-download.
    fs.writeFileSync(path.join(directory,'peer-good.axsync'),encryptSyncPayload({...payload,device:{...payload.device,id:'peer-good'}},passphrase),'utf8');
    fs.writeFileSync(path.join(directory,'peer-otherpass.axsync'),encryptSyncPayload(payload,'a-different-secret'),'utf8');
    fs.writeFileSync(path.join(directory,'peer-truncated.axsync'),'{"schema":1,"algorithm":"aes-256-gcm+scr','utf8');

    const {store,merged,read}=makeStore(folder);
    await new SyncManager(store).syncNow();

    // The readable peer merged, and this device's shard was written anyway.
    expect(merged).toContain('peer-good');
    expect(fs.existsSync(path.join(directory,'this-device.axsync'))).toBe(true);
    expect(read().succeeded).toBe(true);
    // The failure is reported truthfully rather than silently swallowed.
    expect(read().lastError).toMatch(/2 peer shard\(s\) could not be unlocked/);
    expect(read().lastError).toMatch(/published successfully/);
    fs.rmSync(folder,{recursive:true,force:true});
  });

  it('names a passphrase mismatch when no peer shard can be read',async()=>{
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'axiom-sync-'));
    const directory=path.join(folder,'.axiom-sync','v1');
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'peer.axsync'),encryptSyncPayload(payload,'a-different-secret'),'utf8');
    const {store,read}=makeStore(folder);
    await new SyncManager(store).syncNow();
    expect(read().lastError).toMatch(/different sync passphrase/i);
    expect(fs.existsSync(path.join(directory,'this-device.axsync'))).toBe(true);
    fs.rmSync(folder,{recursive:true,force:true});
  });
});
