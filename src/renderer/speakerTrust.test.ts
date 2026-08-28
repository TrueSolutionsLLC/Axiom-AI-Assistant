import { describe,expect,it } from 'vitest';
import type { SpeakerMatch,SpeakerProfile } from '../shared/contracts';
import { canBridgeBorderlineMatch,combineSpeakerEvidence,createSpeakerTrust,matchingFaceProfile,speakerEvidenceQuality,speakerSessionValid } from './speakerTrust';

const now=Date.parse('2026-08-23T20:00:00.000Z');
const face=(name='Robbie',unknown=false)=>({name,unknown,confidence:.72,observedAt:new Date(now-500).toISOString()});
const profile:SpeakerProfile={id:'robbie',name:'Robbie',model:'wavlm-base-plus-sv',sampleCount:4,primary:true,threshold:.74,createdAt:'',updatedAt:''};
const evidence=(speechMs:number,value:number)=>({vector:Array(512).fill(value),speechFrames:Math.round(speechMs/20),durationMs:speechMs+120,speechMs,snrDb:14,clippingRatio:.002});

describe('continuous speaker trust',()=>{
  it('labels short neural evidence usable but not strong',()=>{expect(speakerEvidenceQuality(evidence(520,.04))).toMatchObject({usable:true,strong:false});expect(speakerEvidenceQuality(evidence(1_500,.04))).toMatchObject({usable:true,strong:true});});
  it('combines several short utterances into strong rolling evidence',()=>{const merged=combineSpeakerEvidence([evidence(520,.04),evidence(680,.03)]);expect(merged).not.toBeNull();expect(speakerEvidenceQuality(merged)).toMatchObject({strong:true});expect(merged!.vector).toHaveLength(512);});
  it('keeps a verified conversation alive while Robbie remains present',()=>{const session=createSpeakerTrust('Robbie',.82,'voice',now);expect(speakerSessionValid(session,face(),now+20_000)).toBe(true);expect(speakerSessionValid(session,face('Unknown person',true),now+20_000)).toBe(false);});
  it('uses the enrolled face only when it is current and names the same profile',()=>{expect(matchingFaceProfile([profile],face(),now)?.name).toBe('Robbie');expect(matchingFaceProfile([profile],face('Visitor'),now)).toBeUndefined();});
  it('bridges a borderline score but never a clear stranger mismatch',()=>{const session=createSpeakerTrust('Robbie',.82,'voice',now),borderline:SpeakerMatch={accepted:false,enrolled:true,score:.68,threshold:.74,reason:'rejected'},stranger={...borderline,score:.41};expect(canBridgeBorderlineMatch(borderline,session,face(),now+5_000)).toBe(true);expect(canBridgeBorderlineMatch(stranger,session,face(),now+5_000)).toBe(false);});
});
