import type { Viseme } from './visemes';

export interface MouthKinematics {
  jawDrop: number;
  jawSwing: number;
  upperLift: number;
  width: number;
  height: number;
}

const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));

/** Converts a timed viseme into small, anatomical motion for the photographic mouth layers. */
export function mouthKinematics(viseme:Viseme|undefined,open:number,wide:number,round:number):MouthKinematics{
  const amount=viseme==='rest'||viseme==='closed'?0:clamp(open);
  const rounded=clamp(round),spread=clamp(wide);
  const consonant=viseme==='bite'||viseme==='tongue'||viseme==='narrow';
  return{
    jawDrop:amount*(6.4+rounded*2.8)+(consonant?0.45:0),
    jawSwing:amount*(1.05+rounded*.8),
    upperLift:-amount*(.65+spread*.8),
    width:clamp(1+spread*.095-rounded*.105,.86,1.11),
    height:clamp(1+amount*.055+rounded*.035,.98,1.1),
  };
}
