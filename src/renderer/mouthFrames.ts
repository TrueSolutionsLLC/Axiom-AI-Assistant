const clamp=(value:number)=>Math.max(0,Math.min(1,value));

export interface MouthFrameWeights { closed:number; half:number; opened:number; }

/** Proven three-frame switching curve from Robbie's original Jarvis mod. */
export function mouthFrameWeights(open:number,shut=false):MouthFrameWeights{
  const amount=shut?0:clamp(open);
  if(amount<.27)return{closed:1,half:0,opened:0};
  if(amount<.31){const mix=(amount-.27)/.04;return{closed:1-mix,half:mix,opened:0};}
  if(amount<.65)return{closed:0,half:1,opened:0};
  if(amount<.69){const mix=(amount-.65)/.04;return{closed:0,half:1-mix,opened:mix};}
  return{closed:0,half:0,opened:1};
}
