import type { SpeakerMatch, SpeakerProfile } from '../shared/contracts';

export interface SpeakerEvidence {
  vector:number[];
  speechFrames:number;
  durationMs:number;
  speechMs?:number;
  snrDb?:number;
  clippingRatio?:number;
}

export interface FaceIdentityEvidence { name:string; confidence:number; unknown:boolean; observedAt:string; }
export type SpeakerTrustSource='voice'|'rolling-voice'|'multimodal'|'session'|'voice-face-confirmed';
export interface SpeakerTrustSession { name:string; score:number; verifiedAt:string; expiresAt:number; source:SpeakerTrustSource; }

const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
const freshFace=(face:FaceIdentityEvidence|null|undefined,now:number)=>Boolean(face&&!face.unknown&&Number.isFinite(Date.parse(face.observedAt))&&now-Date.parse(face.observedAt)<5_000);

export function speakerEvidenceQuality(print:SpeakerEvidence|null|undefined):{usable:boolean;strong:boolean;detail:string}{
  if(!print||print.vector.length!==512||print.vector.some((value)=>!Number.isFinite(value)))return{usable:false,strong:false,detail:'No neural speaker embedding'};
  const speechMs=print.speechMs??print.speechFrames*20,snr=print.snrDb??12,clipping=print.clippingRatio??0;
  const usable=speechMs>=360&&snr>=2&&clipping<=.12;
  const strong=usable&&speechMs>=1_100&&print.speechFrames>=45&&snr>=6&&clipping<=.04;
  return{usable,strong,detail:`${Math.round(speechMs)} ms speech · ${snr.toFixed(1)} dB SNR · ${(clipping*100).toFixed(1)}% clipped`};
}

export function combineSpeakerEvidence(samples:SpeakerEvidence[]):SpeakerEvidence|null{
  const usable=samples.filter((sample)=>speakerEvidenceQuality(sample).usable);
  if(!usable.length)return null;
  const dimensions=usable[0].vector.length;if(!dimensions||usable.some((sample)=>sample.vector.length!==dimensions))return null;
  const sum=new Array<number>(dimensions).fill(0);let totalWeight=0,totalFrames=0,totalDuration=0,totalSpeech=0,weightedSnr=0,maxClipping=0;
  for(const sample of usable){const weight=Math.max(1,sample.speechMs??sample.speechFrames*20);totalWeight+=weight;totalFrames+=sample.speechFrames;totalDuration+=sample.durationMs;totalSpeech+=sample.speechMs??sample.speechFrames*20;weightedSnr+=(sample.snrDb??12)*weight;maxClipping=Math.max(maxClipping,sample.clippingRatio??0);for(let index=0;index<dimensions;index++)sum[index]+=sample.vector[index]*weight;}
  const magnitude=Math.sqrt(sum.reduce((total,value)=>total+value*value,0));if(magnitude<1e-9)return null;
  return{vector:sum.map((value)=>value/magnitude),speechFrames:totalFrames,durationMs:totalDuration,speechMs:totalSpeech,snrDb:weightedSnr/totalWeight,clippingRatio:maxClipping};
}

export function matchingFaceProfile(profiles:SpeakerProfile[],face:FaceIdentityEvidence|null|undefined,now=Date.now()):SpeakerProfile|undefined{
  if(!freshFace(face,now))return undefined;
  return profiles.find((profile)=>profile.name.localeCompare(face!.name,undefined,{sensitivity:'accent'})===0||profile.name.toLowerCase()===face!.name.toLowerCase());
}

export function speakerSessionValid(session:SpeakerTrustSession|null|undefined,face:FaceIdentityEvidence|null|undefined,now=Date.now()):boolean{
  if(!session||session.expiresAt<=now||face?.unknown)return false;
  if(freshFace(face,now))return face!.name.toLowerCase()===session.name.toLowerCase();
  // Without a current camera observation, retain only a short conversational
  // bridge. This prevents a brief face-tracker blink from forcing repetition.
  return now-Date.parse(session.verifiedAt)<90_000;
}

export function canBridgeBorderlineMatch(match:SpeakerMatch,session:SpeakerTrustSession|null|undefined,face:FaceIdentityEvidence|null|undefined,now=Date.now()):boolean{
  return Boolean(!match.accepted&&speakerSessionValid(session,face,now)&&match.score>=Math.max(.5,match.threshold-.08));
}

export function createSpeakerTrust(name:string,score:number,source:SpeakerTrustSource,now=Date.now()):SpeakerTrustSession{
  // voice-face-confirmed is the strongest evidence Axiom can produce — voice
  // matched AND the camera independently agrees — so it earns the longest
  // window. multimodal here means a weaker bridging case (borderline voice
  // reinforced by face) and stays conservative on purpose.
  const lifetime=source==='voice-face-confirmed'?15*60_000:source==='multimodal'?2*60_000:10*60_000;
  return{name,score:clamp(score),source,verifiedAt:new Date(now).toISOString(),expiresAt:now+lifetime};
}
