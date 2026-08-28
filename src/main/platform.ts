import os from 'node:os';
import type { AxiomPlatform } from '../shared/contracts';

export interface PlatformProfile {
  id:AxiomPlatform;
  label:string;
  secureStorageLabel:string;
  automationLabel:string;
  supportsWinApp:boolean;
  supportsPowerShell:boolean;
}

export function platformProfile(platform:NodeJS.Platform=process.platform):PlatformProfile {
  if(platform==='darwin')return{id:'macos',label:'macOS',secureStorageLabel:'macOS Keychain',automationLabel:'macOS Accessibility',supportsWinApp:false,supportsPowerShell:false};
  if(platform==='win32')return{id:'windows',label:'Windows',secureStorageLabel:'Windows DPAPI',automationLabel:'Microsoft UI Automation',supportsWinApp:true,supportsPowerShell:true};
  return{id:'linux',label:'Linux',secureStorageLabel:'desktop keyring',automationLabel:'desktop accessibility',supportsWinApp:false,supportsPowerShell:false};
}

export const defaultDeviceName=(platform:NodeJS.Platform=process.platform):string=>{
  const profile=platformProfile(platform),host=os.hostname().replace(/\.local$/i,'').trim();
  return `${host||'Axiom'} · ${profile.label}`.slice(0,80);
};
