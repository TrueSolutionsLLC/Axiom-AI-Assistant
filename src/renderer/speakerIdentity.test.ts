import {describe,expect,it} from 'vitest';
import {VoicePrintAccumulator,voicePrintSimilarity} from './speakerIdentity';

function print(fundamental:number,formant:number):number[]{const capture=new VoicePrintAccumulator();capture.reset(0);for(let frame=0;frame<80;frame++){const samples=new Float32Array(2048),spectrum=new Uint8Array(1024);for(let index=0;index<samples.length;index++){const time=index/48000;samples[index]=.15*Math.sin(Math.PI*2*fundamental*time+frame*.03)+.06*Math.sin(Math.PI*4*fundamental*time);}for(let bin=1;bin<spectrum.length;bin++){const hertz=bin/1024*24000,speaker=Math.exp(-Math.pow((hertz-formant)/420,2)),pitch=Math.exp(-Math.pow((hertz-fundamental)/90,2));spectrum[bin]=Math.min(255,Math.round(18+speaker*190+pitch*100));}capture.push(samples,spectrum,48000);}return capture.finish(1500)!.vector;}

describe('local speaker identity',()=>{
  it('builds stable normalized acoustic voiceprints',()=>{const first=print(126,1050),second=print(128,1080);expect(first.length).toBe(28);expect(voicePrintSimilarity(first,second)).toBeGreaterThan(.98);});
  it('separates materially different vocal signatures',()=>{const low=print(112,850),high=print(245,2300);expect(voicePrintSimilarity(low,high)).toBeLessThan(.93);});
});
