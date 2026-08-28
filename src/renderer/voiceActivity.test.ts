import{describe,expect,it}from'vitest';
import{audioRms,VoiceActivityDetector}from'./voiceActivity';

describe('hands-free voice activity',()=>{
  it('ignores ambient noise and ends an utterance after natural silence',()=>{const vad=new VoiceActivityDetector(700);let now=0;for(let i=0;i<30;i++){expect(vad.process(.006,now)).toBe('none');now+=20;}expect(vad.process(.06,now)).toBe('none');now+=20;expect(vad.process(.07,now)).toBe('none');now+=20;expect(vad.process(.08,now)).toBe('none');now+=20;expect(vad.process(.08,now)).toBe('speech-start');for(let i=0;i<24;i++){now+=20;vad.process(.045,now);}expect(vad.heardSpeech).toBe(true);let result='none';for(let i=0;i<40;i++){now+=20;result=vad.process(.004,now);}expect(result).toBe('speech-end');});
  it('does not cut a phrase at a brief pause',()=>{const vad=new VoiceActivityDetector(760);let now=0;for(const level of[.05,.06,.07]){now+=20;vad.process(level,now);}for(let i=0;i<20;i++){now+=20;expect(vad.process(.003,now)).not.toBe('speech-end');}now+=20;expect(vad.process(.06,now)).toBe('none');});
  it('computes normalized signal energy',()=>{expect(audioRms(new Uint8Array([128,128,128]))).toBe(0);expect(audioRms(new Uint8Array([0,255]))).toBeGreaterThan(.9);});
  it('does not accept a short click or bump as speech',()=>{const vad=new VoiceActivityDetector(500);let now=0;for(let i=0;i<4;i++){now+=20;vad.process(.09,now);}for(let i=0;i<30;i++){now+=20;vad.process(.003,now);}expect(vad.heardSpeech).toBe(false);});
  it('honors a calibrated floor and speech gate in a noisy room',()=>{const vad=new VoiceActivityDetector({silenceMs:620,noiseFloor:.024,speechThreshold:.071});let now=0;for(let i=0;i<80;i++){now+=20;expect(vad.process(.038,now)).toBe('none');}for(let i=0;i<4;i++){now+=20;vad.process(.082,now);}expect(vad.process(.085,now)).toBe('none');expect(vad.heardSpeech).toBe(false);});
});
