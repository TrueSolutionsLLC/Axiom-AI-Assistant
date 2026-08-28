import type { CSSProperties, KeyboardEvent } from 'react';
import type { OperationalSnapshot, ToolEvent } from '../shared/contracts';

const compactMs=(value:number|undefined)=>value?value>=1000?`${(value/1000).toFixed(1)}s`:`${value}ms`:'—';

export function OperationalTruth({snapshot,busy,event,onOpen,onRefresh}:{snapshot:OperationalSnapshot|null;busy:boolean;event?:ToolEvent;onOpen:()=>void;onRefresh:()=>void}){
  const overall=snapshot?.overall||'degraded',route=snapshot?.route,identity=snapshot?.identity,latency=snapshot?.latency.latest;
  const ready=snapshot?.metrics.ready??0,total=snapshot?.metrics.total??0,angle=total?Math.round(ready/total*360):0;
  const routeState=busy?'routing':route?.state||'idle';
  const identityLabel=identity?.state==='dual-verified'?`${identity.name||'USER'} / DUAL`:identity?.state==='face-verified'?`${identity.name||'USER'} / FACE`:identity?.state==='voice-verified'?`${identity.name||'USER'} / VOICE`:identity?.state==='conflict'?'IDENTITY CONFLICT':identity?.state==='noise-rejected'?'NOISE REJECTED':'UNVERIFIED';
  const activate=(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onOpen();}};
  return <section className={`operational-truth truth-${overall}`} role="button" tabIndex={0} aria-label="Open operational truth and recovery console" title="Open Runtime Core" onClick={onOpen} onKeyDown={activate}>
    <header><span>CH–03</span><b>OPERATIONAL TRUTH</b><em>{overall.toUpperCase()}</em></header>
    <div className="truth-main">
      <div className="truth-orbit" style={{'--truth-angle':`${angle}deg`} as CSSProperties}><i/><strong>{ready}<small>/{total}</small></strong><span>READY</span></div>
      <div className="truth-routes">
        <div><span>ROUTE</span><b>{busy?'EXECUTING':route?.intent||'CONVERSATION'}</b><em className={routeState}>{routeState.toUpperCase()}</em></div>
        <div><span>PROOF</span><b>{event?.name.replaceAll('_',' ').toUpperCase()||route?.capability?.replaceAll('_',' ').toUpperCase()||'AWAITING ACTION'}</b><em>{event?.status.toUpperCase()||'IDLE'}</em></div>
        <div><span>IDENTITY</span><b>{identityLabel}</b><em className={identity?.state==='conflict'?'failed':''}>{identity?.state==='dual-verified'?'LOCKED':identity?.state==='conflict'?'LOCKOUT':'BOUNDED'}</em></div>
        <div><span>DEVICE</span><b>{snapshot?.activeDevice.name||'LOCAL NODE'}</b><em>{snapshot?.activeDevice.local?'HERE':snapshot?.activeDevice.platform?.toUpperCase()||'PEER'}</em></div>
      </div>
    </div>
    <div className="truth-latency"><span>STT <b>{compactMs(latency?.sttMs)}</b></span><span>AI <b>{compactMs(latency?.firstTokenMs)}</b></span><span>TTS <b>{compactMs(latency?.ttsMs)}</b></span><span>VOICE <b>{compactMs(latency?.firstAudioMs)}</b></span></div>
    <footer><span><i/> {route?.detail||'Startup capability probes are running.'}</span><button onClick={(event)=>{event.stopPropagation();onRefresh();}} aria-label="Refresh capability probes">RE-SCAN</button></footer>
  </section>;
}
