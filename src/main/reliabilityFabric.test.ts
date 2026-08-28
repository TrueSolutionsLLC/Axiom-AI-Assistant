import { describe,expect,it } from 'vitest';
import { ReliabilityFabric, fuseIdentity, routeIntent } from './reliabilityFabric';

const renderer=(overrides={})=>({reportedAt:new Date().toISOString(),microphone:'ready' as const,transcription:'ready' as const,camera:'locked' as const,speakerEngine:'ready' as const,speakerDecision:'verified' as const,...overrides});

describe('reliability fabric',()=>{
  it('fuses agreeing fresh face and voice evidence',()=>{
    const now=new Date().toISOString();
    expect(fuseIdentity(renderer({faceIdentity:{name:'Robbie',confidence:.94,observedAt:now},speakerIdentity:{name:'Robbie',score:.91,verifiedAt:now}}))).toMatchObject({state:'dual-verified',name:'Robbie'});
  });
  it('locks identity when face and voice disagree',()=>{
    const now=new Date().toISOString();
    expect(fuseIdentity(renderer({faceIdentity:{name:'Robbie',confidence:.94,observedAt:now},speakerIdentity:{name:'Visitor',score:.91,verifiedAt:now}})).state).toBe('conflict');
  });
  it('classifies operational routes',()=>{
    expect(routeIntent('What is the weather?',['web_search'])).toBe('LIVE INTELLIGENCE');
    expect(routeIntent('Show CPU temperature',['get_system_summary'])).toBe('HARDWARE DIAGNOSTICS');
  });
  it('records verified routing and latency without losing probe state',()=>{
    const fabric=new ReliabilityFabric();
    fabric.setBaseProbes([{id:'ai-router',label:'AI',domain:'intelligence',state:'ready',detail:'ready',checkedAt:new Date().toISOString()}]);
    fabric.reportRenderer(renderer());fabric.beginRoute('Check the CPU',['get_system_summary']);fabric.finishRoute([{name:'get_system_summary',status:'verified',summary:'Read live system diagnostics',at:new Date().toISOString()}]);
    fabric.reportLatency({id:'x',at:new Date().toISOString(),input:'voice',sttMs:120,firstTokenMs:400,ttsMs:180,firstAudioMs:610,routeMs:390,recovered:false});
    const local={id:'local',name:'PC',platform:'windows' as const,hostname:'pc',architecture:'x64',appVersion:'2.7.0',firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),lastActiveAt:new Date().toISOString()};
    const snapshot=fabric.snapshot({platform:'windows',localDevice:local});
    expect(snapshot.route.state).toBe('verified');expect(snapshot.route.capability).toBe('get_system_summary');expect(snapshot.latency.latest?.firstAudioMs).toBe(610);expect(snapshot.metrics.total).toBeGreaterThan(1);
  });
});
