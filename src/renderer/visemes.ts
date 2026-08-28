import type { SpeechAlignment } from '../shared/contracts';

export type Viseme='rest'|'soft'|'closed'|'bite'|'tongue'|'narrow'|'round'|'wide'|'spread'|'neutral';
export interface SpeechPose { viseme:Viseme; open:number; wide:number; round:number; index:number }

export function speechViseme(text:string,index:number):Viseme{
  const value=String(text||'').toLowerCase(),i=Math.max(0,Math.floor(index)||0),character=value.charAt(i),pair=value.slice(i,i+2),through=value.slice(Math.max(0,i-1),i+1),previous=value.charAt(i-1),next=value.charAt(i+1);
  if(/[,.!?;:'"—–-]/.test(character)||!character)return'rest';
  if(/\s/.test(character))return'soft';
  if(character==='e'&&!/[a-z]/.test(next)&&/[bcdfghjklmnpqrstvwxyz]/.test(previous)){let start=i-1;while(start>=0&&/[a-z]/.test(value.charAt(start)))start--;const word=value.slice(start+1,i+1);if(!/^(?:be|he|me|we|she|the)$/.test(word))return'soft';}
  if(pair==='ph'||through==='ph'||/[fv]/.test(character))return'bite';
  if(/[mbp]/.test(character))return'closed';
  if(pair==='th'||pair==='dh'||through==='th'||through==='dh'||/[ltd]/.test(character))return'tongue';
  if(['sh','ch','zh','ng','ck'].includes(pair)||['sh','ch','zh','ng','ck'].includes(through)||/[nszcjxkgr]/.test(character))return'narrow';
  if(['oo','ou','ow','oa','aw','wh','qu'].includes(pair)||['oo','ou','ow','oa','aw','wh','qu'].includes(through)||/[oquw]/.test(character))return'round';
  if(['ai','ay','au'].includes(pair)||['ai','ay','au'].includes(through)||character==='a')return'wide';
  if(['ee','ea','ie'].includes(pair)||['ee','ea','ie'].includes(through)||/[eiy]/.test(character))return'spread';
  return'neutral';
}

export function visemePose(viseme:Viseme,index=0):SpeechPose{
  const open=viseme==='closed'||viseme==='rest'?0:viseme==='soft'?.13:viseme==='bite'?.16:viseme==='narrow'?.28:viseme==='tongue'?.34:viseme==='spread'?.43:viseme==='round'?.62:viseme==='wide'?.9:.42;
  const wide=viseme==='wide'?.95:viseme==='spread'?.82:viseme==='bite'?.48:viseme==='closed'?.22:viseme==='round'?.06:.38;
  const round=viseme==='round'?.98:viseme==='narrow'?.35:viseme==='soft'?.18:.04;
  return{viseme,open,wide,round,index};
}

export function timedSpeechPose(alignment:SpeechAlignment|undefined,timeSeconds:number):SpeechPose|null{
  if(!alignment?.characters.length)return null;
  const {characters,characterStartTimesSeconds:starts,characterEndTimesSeconds:ends}=alignment,n=Math.min(characters.length,starts.length,ends.length);
  // Fall back to the live audio clock if a provider returns an incomplete
  // alignment. Holding a synthetic rest here made the mouth freeze mid-clip.
  if(!n||timeSeconds<starts[0]-.045||timeSeconds>ends[n-1]+.07)return null;
  let low=0,high=n-1;while(low<high){const middle=(low+high+1)>>1;if(starts[middle]<=timeSeconds)low=middle;else high=middle-1;}
  const text=characters.join(''),index=low,current=visemePose(speechViseme(text,index),index),next=visemePose(speechViseme(text,Math.min(n-1,index+1)),index+1);
  const lead=Math.min(.072,Math.max(.028,(ends[index]-starts[index])*.46)),raw=Math.max(0,Math.min(1,(timeSeconds-(ends[index]-lead))/lead)),blend=raw*raw*(3-2*raw);
  if(!blend)return current;
  return{viseme:blend>.58?next.viseme:current.viseme,open:current.open+(next.open-current.open)*blend,wide:current.wide+(next.wide-current.wide)*blend,round:current.round+(next.round-current.round)*blend,index};
}

export function estimatedSpeechPose(text:string,timeSeconds:number,durationSeconds:number):SpeechPose{
  const value=String(text||''),weights=Array.from(value,(character)=>/[,.!?;:—–-]/.test(character)?2.15:/\s/.test(character)?.52:/[aeiouy]/i.test(character)?1.34:/[mbp]/i.test(character)?.72:.94),total=weights.reduce((sum,weight)=>sum+weight,0)||1,target=Math.max(0,Math.min(1,timeSeconds/Math.max(.1,durationSeconds)))*total;
  let cursor=0,index=0;for(;index<weights.length-1;index++){cursor+=weights[index];if(cursor>=target)break;}
  return visemePose(speechViseme(text,index),index);
}

export function speechMouthTarget(pose:SpeechPose,energy:number,gain=1,timestamped=false):number{
  if(pose.viseme==='closed'||pose.viseme==='rest')return 0;
  const drive=Math.max(timestamped?0:.16,Math.max(0,Math.min(1,energy)));
  const scale=timestamped?.92+drive*.28:.44+drive*.86;
  return Math.max(0,Math.min(1,pose.open*Math.max(.1,gain)*scale));
}
