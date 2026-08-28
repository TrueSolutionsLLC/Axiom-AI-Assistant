import { useEffect, useMemo, useState } from 'react';
import type { SystemTelemetry } from '../shared/contracts';

type VitalSample={cpu:number;gpu:number;memory:number;network:number};
const clamp=(value:number)=>Math.max(0,Math.min(100,value));
const ring=(value:number,radius:number)=>{const circumference=2*Math.PI*radius,active=circumference*clamp(value)/100;return`${active} ${circumference-active}`;};
const points=(values:number[],width=102,height=22)=>{const range=Math.max(1,values.length-1);return values.map((value,index)=>`${index/range*width},${height-clamp(value)/100*height}`).join(' ');};
const temperature=(value:number|null|undefined)=>value===null||value===undefined?'—':`${Math.round(value)}°`;
const rate=(value:number|null|undefined)=>{if(value===null||value===undefined)return'—';if(value>=1024**2)return`${(value/1024**2).toFixed(1)}M`;if(value>=1024)return`${Math.round(value/1024)}K`;return`${Math.round(value)}B`;};

export function VitalArray({telemetry,onOpen}:{telemetry:SystemTelemetry|null;onOpen:()=>void}){
  const gpu=telemetry?.gpus?.find((item)=>item.loadPercent!==null||item.temperatureC!==null)||telemetry?.gpus?.[0];
  const disk=telemetry?.disks?.[0];
  const network=telemetry?.networks?.find((item)=>item.default)||telemetry?.networks?.[0];
  const networkRate=(network?.rxBytesPerSecond??0)+(network?.txBytesPerSecond??0);
  const [history,setHistory]=useState<VitalSample[]>([]);
  useEffect(()=>{if(!telemetry)return;setHistory((current)=>[...current,{cpu:telemetry.cpuPercent,gpu:gpu?.loadPercent??0,memory:telemetry.memoryPercent,network:Math.min(100,Math.log10(networkRate+1)*16)}].slice(-30));},[telemetry?.collectedAt,telemetry?.cpuPercent,telemetry?.memoryPercent,gpu?.loadPercent,networkRate]);
  const traces=useMemo(()=>({cpu:points(history.map((item)=>item.cpu)),gpu:points(history.map((item)=>item.gpu)),memory:points(history.map((item)=>item.memory)),network:points(history.map((item)=>item.network))}),[history]);
  const hottest=Math.max(telemetry?.cpu?.temperatureC??0,gpu?.temperatureC??0),pressure=Math.max(telemetry?.cpuPercent??0,telemetry?.memoryPercent??0,gpu?.loadPercent??0,disk?.usedPercent??0);
  const state=hottest>=90||pressure>=95?'critical':hottest>=76||pressure>=80?'loaded':'nominal';
  const stateLabel=state==='critical'?'THERMAL ALERT':state==='loaded'?'HIGH LOAD':'NOMINAL';
  return <section className={`system-array vital-reactor ${state}`} onClick={onOpen} onKeyDown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onOpen();}}} role="button" tabIndex={0} title="Open complete computer diagnostics" aria-label="Open live computer diagnostics">
    <header><span>CH–02</span><b>VITAL REACTOR</b><em>{stateLabel}</em></header>
    <div className="reactor-grid">
      <div className="reactor-core" aria-label={`CPU ${telemetry?.cpuPercent??0} percent, memory ${telemetry?.memoryPercent??0} percent, GPU ${gpu?.loadPercent??0} percent`}>
        <svg viewBox="0 0 84 84" aria-hidden="true">
          <circle className="reactor-track outer" cx="42" cy="42" r="34"/><circle className="reactor-ring cpu-ring" cx="42" cy="42" r="34" strokeDasharray={ring(telemetry?.cpuPercent??0,34)}/>
          <circle className="reactor-track" cx="42" cy="42" r="26"/><circle className="reactor-ring memory-ring" cx="42" cy="42" r="26" strokeDasharray={ring(telemetry?.memoryPercent??0,26)}/>
          <circle className="reactor-track" cx="42" cy="42" r="18"/><circle className="reactor-ring gpu-ring" cx="42" cy="42" r="18" strokeDasharray={ring(gpu?.loadPercent??0,18)}/>
          <path className="reactor-cross" d="M42 1v7M42 76v7M1 42h7M76 42h7"/>
        </svg>
        <div><strong>{telemetry?Math.round(telemetry.cpuPercent):'—'}</strong><small>CPU LOAD</small><i/></div>
      </div>
      <div className="reactor-traces">
        {([['CPU',telemetry?.cpuPercent,traces.cpu],['GPU',gpu?.loadPercent,traces.gpu],['RAM',telemetry?.memoryPercent,traces.memory],['NET',networkRate?Math.min(100,Math.log10(networkRate+1)*16):0,traces.network]] as [string,number|null|undefined,string][]).map(([label,value,line])=><div key={label} className={`trace trace-${label.toLowerCase()}`}><span>{label}</span><svg viewBox="0 0 102 22" preserveAspectRatio="none"><path d="M0 21.5H102"/><polyline points={line||'0,22 102,22'}/></svg><b>{label==='NET'?rate(networkRate):value===null||value===undefined?'—':`${Math.round(value)}%`}</b></div>)}
      </div>
    </div>
    <div className="reactor-sensors">
      <div><span>CPU TEMP</span><b>{temperature(telemetry?.cpu?.temperatureC)}</b><i className={telemetry?.cpu?.temperatureC===null?'unavailable':''}/></div>
      <div><span>GPU TEMP</span><b>{temperature(gpu?.temperatureC)}</b><i className={gpu?.temperatureC===null?'unavailable':''}/></div>
      <div><span>STORAGE</span><b>{disk?`${Math.round(disk.usedPercent)}%`:'—'}</b><i/></div>
      <div><span>NETWORK</span><b>↓{rate(network?.rxBytesPerSecond)}</b><small>↑{rate(network?.txBytesPerSecond)}</small></div>
    </div>
    <footer><span><i/> LIVE SENSOR FABRIC</span><b>OPEN DIAGNOSTICS ↗</b></footer>
  </section>;
}
