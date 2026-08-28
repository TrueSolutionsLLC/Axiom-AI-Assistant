import { describe,expect,it } from 'vitest';
import { estimatedSpeechPose,speechMouthTarget,speechViseme,timedSpeechPose,visemePose } from './visemes';

describe('timestamped viseme motion',()=>{
  it('maps closed, rounded, wide, and dental mouth shapes',()=>{
    expect(speechViseme('move',0)).toBe('closed');
    expect(speechViseme('moon',1)).toBe('round');
    expect(speechViseme('cat',1)).toBe('wide');
    expect(speechViseme('face',0)).toBe('bite');
  });
  it('gives punctuation more time than adjacent consonants in estimated speech',()=>{
    const phrase='ma, ma';
    expect(estimatedSpeechPose(phrase,.48,1).viseme).toBe('rest');
  });
  it('uses provider timestamps instead of guessing from audio energy',()=>{
    const alignment={characters:['m','o','v','e'],characterStartTimesSeconds:[0,.1,.2,.3],characterEndTimesSeconds:[.1,.2,.3,.4]};
    expect(timedSpeechPose(alignment,.02)?.viseme).toBe('closed');
    expect(timedSpeechPose(alignment,.13)?.viseme).toBe('round');
    expect(timedSpeechPose(alignment,.23)?.viseme).toBe('bite');
    expect(timedSpeechPose(alignment,.8)).toBeNull();
  });
  it('keeps untimestamped speech articulated through low-energy audio frames',()=>{
    expect(speechMouthTarget(visemePose('wide'),0,1,false)).toBeGreaterThan(0);
    expect(speechMouthTarget(visemePose('closed'),1,1,false)).toBe(0);
  });
});
