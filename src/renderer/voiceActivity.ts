export type VoiceActivityEvent='none'|'speech-start'|'speech-end'|'max-duration';

export interface VoiceActivityOptions{silenceMs?:number;maxSpeechMs?:number;noiseFloor?:number;speechThreshold?:number}

export class VoiceActivityDetector{
  private noiseFloor=.006;
  private configuredThreshold=0;
  private speechFrames=0;
  private speechStartedAt=0;
  private silenceStartedAt=0;
  private speaking=false;
  private evidenceMs=0;
  private lastSampleAt=0;
  private readonly silenceMs:number;
  private readonly maxSpeechMs:number;
  constructor(options:VoiceActivityOptions|number=620,maxSpeechMs=30_000){if(typeof options==='number'){this.silenceMs=options;this.maxSpeechMs=maxSpeechMs;}else{this.silenceMs=options.silenceMs??620;this.maxSpeechMs=options.maxSpeechMs??30_000;this.noiseFloor=Math.max(.001,Math.min(.2,options.noiseFloor??.006));this.configuredThreshold=Math.max(0,Math.min(.3,options.speechThreshold??0));}}
  get heardSpeech():boolean{return this.evidenceMs>=240;}
  get ambientFloor():number{return this.noiseFloor;}
  process(rms:number,now:number):VoiceActivityEvent{
    const level=Math.max(0,Math.min(1,Number.isFinite(rms)?rms:0));
    const elapsed=this.lastSampleAt?Math.max(0,Math.min(50,now-this.lastSampleAt)):0;this.lastSampleAt=now;
    if(!this.speaking){
      if(level<.08)this.noiseFloor=this.noiseFloor*.96+level*.04;
      const threshold=Math.max(this.configuredThreshold||.014,Math.min(.09,this.noiseFloor*2.6+.004));
      this.speechFrames=level>threshold?this.speechFrames+1:Math.max(0,this.speechFrames-1);
      if(this.speechFrames>=4){this.speaking=true;this.speechStartedAt=now;this.silenceStartedAt=0;return'speech-start';}
      return'none';
    }
    if(now-this.speechStartedAt>=this.maxSpeechMs)return'max-duration';
    const releaseThreshold=Math.max(.011,Math.min(.04,this.noiseFloor*1.7+.003));
    if(level>releaseThreshold){this.evidenceMs+=elapsed;this.silenceStartedAt=0;return'none';}
    if(!this.silenceStartedAt)this.silenceStartedAt=now;
    if(now-this.silenceStartedAt>=this.silenceMs&&now-this.speechStartedAt>=280)return'speech-end';
    return'none';
  }
}

export function audioRms(samples:Uint8Array):number{
  if(!samples.length)return 0;let sum=0;
  for(const sample of samples){const normalized=(sample-128)/128;sum+=normalized*normalized;}
  return Math.sqrt(sum/samples.length);
}
