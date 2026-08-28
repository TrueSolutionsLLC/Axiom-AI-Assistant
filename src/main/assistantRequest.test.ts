import { describe, expect, it } from 'vitest';
import { forwardAssistantRequest } from './assistantRequest';

describe('assistant request perception transport',()=>{
  it('preserves current face and voice verification',()=>{
    const identity={face:{name:'Robbie',confidence:.94,observedAt:'2026-08-21T20:00:00.000Z'},speaker:{name:'Robbie',score:.91,verifiedAt:'2026-08-21T20:00:01.000Z'}};
    const forwarded=forwardAssistantRequest({message:'  Who am I?  ',history:[],identity},'Who am I?');
    expect(forwarded.identity).toEqual(identity);
    expect(forwarded.message).toBe('Who am I?');
  });

  it('preserves the unverified-visitor safety boundary',()=>{
    expect(forwardAssistantRequest({message:'Hello',history:[],untrustedPresence:true},'Hello').untrustedPresence).toBe(true);
  });
});
