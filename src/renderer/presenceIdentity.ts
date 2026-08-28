export interface FaceObservation {
  name:string;
  confidence:number;
  descriptor:number[];
  unknown:boolean;
  observedAt:string;
}

export interface PresenceIdentityDecision {
  kind:'known'|'unknown'|'none'|'uncertain';
  name?:string;
  confidence:number;
  sampledFrames:number;
  faceFrames:number;
  unknownFrames:number;
}

/**
 * Resolve a room identity from several independent camera frames. A single
 * model result is never enough to greet or challenge somebody.
 */
export function resolvePresenceIdentity(frames:FaceObservation[][]):PresenceIdentityDecision{
  const sampledFrames=frames.length,faceFrames=frames.filter((frame)=>frame.length>0).length;
  if(!faceFrames)return{kind:'none',confidence:0,sampledFrames,faceFrames,unknownFrames:0};
  const unknownFrames=frames.filter((frame)=>frame.some((face)=>face.unknown)).length;
  const known=new Map<string,{name:string;frames:number;confidence:number}>();
  for(const frame of frames){
    const names=new Set<string>();
    for(const face of frame){
      if(face.unknown)continue;
      const key=face.name.trim().toLowerCase();if(!key||names.has(key))continue;names.add(key);
      const current=known.get(key)??{name:face.name.trim(),frames:0,confidence:0};
      current.frames+=1;current.confidence+=face.confidence;known.set(key,current);
    }
  }
  // Any repeatedly observed unrecognized face takes precedence, including
  // when the enrolled owner and a visitor are visible together.
  if(unknownFrames>=Math.min(3,Math.max(2,faceFrames)))return{kind:'unknown',confidence:unknownFrames/faceFrames,sampledFrames,faceFrames,unknownFrames};
  const best=[...known.values()].sort((left,right)=>right.frames-left.frames||right.confidence-left.confidence)[0];
  const required=Math.min(3,Math.max(2,faceFrames));
  if(best&&best.frames>=required)return{kind:'known',name:best.name,confidence:Math.max(0,Math.min(1,best.confidence/best.frames)),sampledFrames,faceFrames,unknownFrames};
  return{kind:'uncertain',confidence:best?best.frames/faceFrames:0,sampledFrames,faceFrames,unknownFrames};
}
