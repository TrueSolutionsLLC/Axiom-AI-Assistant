import type { ChatMessage } from '../shared/contracts';

const cleanName=(value:string):string=>value.trim().replace(/[^\p{L}\p{N}'’ .-]/gu,'').replace(/\s+/g,' ').slice(0,48);

export function introducedName(text:string):string|undefined{
  const match=/\b(?:my name is|call me|remember me as)\s+([^\r\n,.!?]{1,48})/iu.exec(text);
  const name=match?cleanName(match[1]):'';return name||undefined;
}

export function storedIdentityName(text:string):string|undefined{
  const match=/\b(?:the user's name is|primary user is|recognizes)\s+([^\r\n,.!?]{1,48})/iu.exec(text);
  const name=match?cleanName(match[1].replace(/\s+by\s+(?:face|enrolled neural voice embedding).*$/iu,'')):'';return name||undefined;
}

export function faceEnrollmentIntent(text:string,history:Pick<ChatMessage,'role'|'text'>[],fallbackName=''):{requested:boolean;name?:string}{
  const requested=/\b(?:remember|recognize|learn|save|enroll)\b[\s\S]{0,80}\b(?:my\s+)?face\b|\b(?:my\s+)?face\b[\s\S]{0,60}\b(?:remember|recognize|learn|save|enroll)\b/iu.test(text)||/\bremember\s+(?:me|this person)\s+as\b/iu.test(text);
  if(!requested)return{requested:false};
  const name=introducedName(text)||[...history].reverse().filter((item)=>item.role==='user').map((item)=>introducedName(item.text)).find(Boolean)||cleanName(fallbackName)||undefined;
  return{requested:true,name};
}
