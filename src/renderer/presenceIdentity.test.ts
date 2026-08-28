import {describe,expect,it} from 'vitest';
import {resolvePresenceIdentity,type FaceObservation} from './presenceIdentity';

const face=(name:string,unknown=false,confidence=.9):FaceObservation=>({name,unknown,confidence,descriptor:Array(128).fill(.1),observedAt:new Date().toISOString()});

describe('multi-frame room identity',()=>{
  it('requires repeated matches before verifying the owner',()=>{
    expect(resolvePresenceIdentity([[face('Robbie')],[],[face('Robbie')],[face('Robbie')]]).kind).toBe('known');
    expect(resolvePresenceIdentity([[face('Robbie')],[],[],[]]).kind).toBe('uncertain');
  });
  it('treats a repeated unknown visitor as unknown',()=>{
    expect(resolvePresenceIdentity([[face('Unknown person',true)],[face('Unknown person',true)],[],[face('Unknown person',true)]])).toMatchObject({kind:'unknown',unknownFrames:3});
  });
  it('does not overlook a visitor merely because Robbie is also visible',()=>{
    const decision=resolvePresenceIdentity([[face('Robbie'),face('Unknown person',true)],[face('Robbie'),face('Unknown person',true)],[face('Robbie'),face('Unknown person',true)]]);
    expect(decision.kind).toBe('unknown');
  });
});
