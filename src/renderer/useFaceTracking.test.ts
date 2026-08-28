import { describe,expect,it } from 'vitest';
import { boundingBox,rotationFromFacialMatrix } from './useFaceTracking';

describe('facial transformation matrix pose',()=>{
  it('maps the identity matrix to a neutral head pose',()=>{
    expect(rotationFromFacialMatrix([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])).toEqual({yaw:0,pitch:-0,roll:0});
  });
  it('extracts visible yaw from a rotated face matrix',()=>{
    const angle=.26,c=Math.cos(angle),s=Math.sin(angle);
    const pose=rotationFromFacialMatrix([c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]);
    expect(pose?.yaw).toBeCloseTo(.5,1);
    expect(pose?.pitch).toBeCloseTo(0,3);
  });
  it('rejects malformed matrices',()=>expect(rotationFromFacialMatrix([1,2])).toBeUndefined());
});

describe('detection bounding box — feeds the live-camera overlay',()=>{
  it('pads a tight cluster of landmarks and clamps to the frame edges',()=>{
    const box=boundingBox([{x:.4,y:.4},{x:.6,y:.6}],.1,.1,.1);
    expect(box?.x).toBeCloseTo(.38,2);
    expect(box?.x&&box.x+box.width).toBeCloseTo(.62,2);
    expect(box?.width).toBeGreaterThan(.2);
  });
  it('clamps padding at 0 and 1 instead of drawing off-frame',()=>{
    const box=boundingBox([{x:0,y:0},{x:.05,y:.05}],.5,.5,.5);
    expect(box?.x).toBe(0);
    expect(box?.y).toBe(0);
  });
  it('ignores low-visibility body landmarks so a barely-visible limb does not blow out the box',()=>{
    const box=boundingBox([{x:.4,y:.4,visibility:.9},{x:.6,y:.6,visibility:.9},{x:.99,y:.99,visibility:.05}],0,0,0);
    expect(box?.x).toBeCloseTo(.4,2);
    expect(box&&box.x+box.width).toBeCloseTo(.6,2);
  });
  it('returns undefined when nothing is visible enough to bound',()=>{
    expect(boundingBox([{x:.5,y:.5,visibility:.1}],0,0,0)).toBeUndefined();
  });
});
