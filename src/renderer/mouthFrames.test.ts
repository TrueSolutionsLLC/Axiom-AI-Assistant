import {describe,expect,it} from 'vitest';
import {mouthFrameWeights} from './mouthFrames';

describe('Jarvis photographic mouth-frame gates',()=>{
  it('shows one complete skull frame outside the two narrow transitions',()=>{
    expect(mouthFrameWeights(.1)).toEqual({closed:1,half:0,opened:0});
    expect(mouthFrameWeights(.4)).toEqual({closed:0,half:1,opened:0});
    expect(mouthFrameWeights(.8)).toEqual({closed:0,half:0,opened:1});
  });
  it('never stacks opacity above one',()=>{for(let index=0;index<=100;index++){const weights=mouthFrameWeights(index/100);expect(weights.closed+weights.half+weights.opened).toBeCloseTo(1,8);}});
  it('forces a closed mouth for rest and closed visemes',()=>expect(mouthFrameWeights(1,true)).toEqual({closed:1,half:0,opened:0}));
});
