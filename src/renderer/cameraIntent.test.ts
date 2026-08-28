import {describe,expect,it} from 'vitest';
import {cameraRequestIntent} from './cameraIntent';

describe('natural-language camera routing',()=>{
  it.each(['Pull up the camera feed','Show me the webcam','Open the live camera',"You can't see me on the camera? Pull up the camera feed."])('opens the visible feed for %s',(text)=>expect(cameraRequestIntent(text).showFeed).toBe(true));
  it.each(['Can you see me on the camera?','What am I wearing on webcam?','Describe who is in the camera feed'])('attaches a camera frame for %s',(text)=>expect(cameraRequestIntent(text).analyze).toBe(true));
  it('does not route an unrelated display request to the webcam',()=>expect(cameraRequestIntent('Show me the weather forecast')).toEqual({showFeed:false,analyze:false}));

  describe('device-name capture (for routing a named camera like Ring, instead of the local webcam)',()=>{
    it.each(['Show me the camera','Show me the webcam','Pull up the camera feed','Open the live camera'])('leaves deviceName undefined for a bare request: %s',(text)=>expect(cameraRequestIntent(text).deviceName).toBeUndefined());
    it.each([
      ['Show me the front door camera','front door'],
      ['Pull up the front door camera','front door'],
      ['Open the backyard camera','backyard'],
      ['Show me the driveway webcam','driveway'],
      ['Show me the front door cam','front door'],
      ['Pull up the back door cam','back door'],
      ['Open the basement door cams','basement door'],
    ])('captures the named device for "%s"',(text,expected)=>expect(cameraRequestIntent(text).deviceName).toBe(expected));
  });
});
