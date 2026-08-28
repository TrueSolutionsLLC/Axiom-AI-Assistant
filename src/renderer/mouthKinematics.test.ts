import {describe,expect,it} from 'vitest';
import {mouthKinematics} from './mouthKinematics';

describe('photographic mouth kinematics',()=>{
  it('keeps closed phonemes anatomically shut',()=>expect(mouthKinematics('closed',1,1,1).jawDrop).toBe(0));
  it('rounds vowels without widening the mouth',()=>expect(mouthKinematics('round',.7,.05,1).width).toBeLessThan(1));
  it('spreads wide vowels and lifts the upper mouth',()=>{const pose=mouthKinematics('wide',.8,1,0);expect(pose.width).toBeGreaterThan(1);expect(pose.upperLift).toBeLessThan(0);});
  it('drops the mandible progressively with articulation',()=>expect(mouthKinematics('neutral',.8,.3,0).jawDrop).toBeGreaterThan(mouthKinematics('neutral',.3,.3,0).jawDrop));
});
