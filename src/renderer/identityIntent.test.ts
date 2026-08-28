import { describe, expect, it } from 'vitest';
import { faceEnrollmentIntent, introducedName, storedIdentityName } from './identityIntent';

describe('natural identity enrollment language',()=>{
  it('extracts a direct introduction',()=>expect(introducedName('My name is Robbie')).toBe('Robbie'));
  it('extracts the primary name from durable identity memory',()=>expect(storedIdentityName("The user's name is Robbie.")).toBe('Robbie'));
  it('uses the recent introduction when a later voice transcript asks to remember a face',()=>{
    const history=[{role:'user' as const,text:'My name is Robbie'},{role:'assistant' as const,text:'Nice to meet you, Robbie.'}];
    expect(faceEnrollmentIntent('Can you remember that? My face in my',history)).toEqual({requested:true,name:'Robbie'});
  });
  it('does not treat an ordinary memory request as face enrollment',()=>expect(faceEnrollmentIntent('Remember that I like coffee',[])).toEqual({requested:false}));
});
