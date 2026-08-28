import type { SystemTelemetry } from '../shared/contracts';

const bytes=(value:number|undefined|null)=>{if(value===undefined||value===null||!Number.isFinite(value))return'—';const units=['B','KB','MB','GB','TB'];let size=Math.max(0,value),index=0;while(size>=1024&&index<units.length-1){size/=1024;index++;}return`${size>=100||index===0?Math.round(size):size.toFixed(1)} ${units[index]}`;};
const rate=(value:number|undefined|null)=>value===undefined||value===null?'—':`${bytes(value)}/s`;
const reading=(value:number|undefined|null,suffix:string)=>value===undefined||value===null?'NOT EXPOSED':`${Math.round(value*10)/10}${suffix}`;
const sumReadings=(first:number|undefined|null,second:number|undefined|null)=>first===undefined||first===null?second===undefined||second===null?null:second:(second??0)+first;
const duration=(seconds:number|undefined)=>{if(!seconds)return'—';const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);return`${days?`${days}d `:''}${hours}h ${minutes}m`;};

function Meter({value}:{value:number|undefined|null}){return <span className="diag-meter"><i style={{width:`${Math.max(0,Math.min(100,value??0))}%`}}/></span>;}

export function SystemDiagnosticsPanel({telemetry,onRefresh}:{telemetry:SystemTelemetry|null;onRefresh:()=>Promise<void>}){
  const gpu=telemetry?.gpus?.find((item)=>item.loadPercent!==null||item.temperatureC!==null)||telemetry?.gpus?.[0];
  const network=telemetry?.networks?.find((item)=>item.default)||telemetry?.networks?.[0];
  const updating=!telemetry;
  return <section className="diagnostics-console">
    <header className="diag-title"><div><span>HW–00 / LIVE SENSOR FABRIC</span><b>COMPUTER VITALS</b><small>{telemetry?.system?`${telemetry.system.manufacturer} ${telemetry.system.model} · ${telemetry.system.os} ${telemetry.system.release} · ${telemetry.system.architecture}`:'Establishing hardware inventory…'}</small></div><button onClick={()=>void onRefresh()} disabled={updating}>{updating?'LINKING…':'REFRESH NOW'}</button></header>
    <div className="diag-overview">
      <article><span>CPU LOAD</span><b>{reading(telemetry?.cpuPercent,'%')}</b><Meter value={telemetry?.cpuPercent}/><small>{telemetry?.cpu?.model||'PROCESSOR'}</small></article>
      <article className={telemetry?.cpu?.temperatureC!==null?'thermal':''}><span>CPU THERMAL</span><b>{reading(telemetry?.cpu?.temperatureC,' °C')}</b><small>{telemetry?.availability?.cpuTemperature?'LIVE HARDWARE SENSOR':'SENSOR NOT PROVIDED BY OS'}</small></article>
      <article><span>GPU LOAD</span><b>{reading(gpu?.loadPercent,'%')}</b><Meter value={gpu?.loadPercent}/><small>{gpu?.model||'NO GRAPHICS CONTROLLER REPORTED'}</small></article>
      <article className={gpu?.temperatureC!==null?'thermal':''}><span>GPU THERMAL</span><b>{reading(gpu?.temperatureC,' °C')}</b><small>{gpu?.powerWatts!==null&&gpu?.powerWatts!==undefined?`${gpu.powerWatts} W · `:''}{gpu?.fanPercent!==null&&gpu?.fanPercent!==undefined?`${gpu.fanPercent}% FAN`:'DRIVER SENSOR STATUS'}</small></article>
      <article><span>MEMORY</span><b>{reading(telemetry?.memoryPercent,'%')}</b><Meter value={telemetry?.memoryPercent}/><small>{bytes(telemetry?.memory?.usedBytes)} / {bytes(telemetry?.memory?.totalBytes)}</small></article>
      <article><span>POWER</span><b>{telemetry?.battery?.present?reading(telemetry.battery.percent,'%'):telemetry?'AC DESKTOP':'—'}</b><small>{telemetry?.battery?.present?(telemetry.battery.charging?'CHARGING':telemetry.battery.acConnected?'AC CONNECTED':'ON BATTERY'):'NO BATTERY INSTALLED'}</small></article>
    </div>

    <div className="diag-grid">
      <section className="diag-card cpu-detail"><header><span>HW–01</span><b>PROCESSOR ARRAY</b><em>{telemetry?.cpu?.logicalCores??'—'} THREADS</em></header><div className="diag-card-body">
        <div className="diag-spec-row"><span>PHYSICAL / LOGICAL</span><b>{telemetry?.cpu?.physicalCores??'—'} / {telemetry?.cpu?.logicalCores??'—'}</b><span>CLOCK</span><b>{telemetry?.cpu?.speedGHz?`${telemetry.cpu.speedGHz} GHz`:'—'}</b><span>USER / SYSTEM</span><b>{reading(telemetry?.cpu?.userPercent,'%')} / {reading(telemetry?.cpu?.systemPercent,'%')}</b></div>
        <div className="core-grid">{telemetry?.cpu?.perCorePercent?.length?telemetry.cpu.perCorePercent.map((value,index)=><div key={index} title={`Logical processor ${index+1}: ${value}%`}><i style={{height:`${Math.max(2,value)}%`}}/><span>{String(index+1).padStart(2,'0')}</span></div>):<p className="diag-empty">PER-CORE COUNTERS INITIALIZING</p>}</div>
      </div></section>

      <section className="diag-card gpu-detail"><header><span>HW–02</span><b>GRAPHICS ARRAY</b><em>{telemetry?.gpus?.length??0} CONTROLLER{telemetry?.gpus?.length===1?'':'S'}</em></header><div className="diag-card-body diag-list">{telemetry?.gpus?.length?telemetry.gpus.map((item,index)=><article key={`${item.model}-${index}`}><div><b>{item.model}</b><small>{item.vendor}{item.driver?` · DRIVER ${item.driver}`:''}</small></div><dl><div><dt>GPU</dt><dd>{reading(item.loadPercent,'%')}</dd></div><div><dt>VRAM</dt><dd>{item.memoryTotalMB?`${Math.round(item.memoryUsedMB??0)} / ${Math.round(item.memoryTotalMB)} MB`:item.vramMB?`${Math.round(item.vramMB)} MB`:'—'}</dd></div><div><dt>TEMP</dt><dd>{reading(item.temperatureC,' °C')}</dd></div><div><dt>POWER</dt><dd>{reading(item.powerWatts,' W')}</dd></div></dl></article>):<p className="diag-empty">GRAPHICS DRIVER INVENTORY INITIALIZING</p>}</div></section>

      <section className="diag-card storage-detail"><header><span>HW–03</span><b>STORAGE VOLUMES</b><em>{telemetry?.disks?.length??0} MOUNTED</em></header><div className="diag-card-body diag-list">{telemetry?.disks?.length?telemetry.disks.map((disk)=><article key={disk.mount}><div className="disk-line"><b>{disk.mount}</b><small>{disk.type||disk.filesystem} · {bytes(disk.usedBytes)} USED / {bytes(disk.totalBytes)}</small><strong>{disk.usedPercent}%</strong></div><Meter value={disk.usedPercent}/></article>):<p className="diag-empty">STORAGE INVENTORY INITIALIZING</p>}<div className="io-row"><span>READ <b>{rate(telemetry?.diskIo?.readBytesPerSecond)}</b></span><span>WRITE <b>{rate(telemetry?.diskIo?.writeBytesPerSecond)}</b></span><span>IOPS <b>{reading(sumReadings(telemetry?.diskIo?.readOperationsPerSecond,telemetry?.diskIo?.writeOperationsPerSecond),'/s')}</b></span><span>BUSY <b>{reading(telemetry?.diskIo?.utilizationPercent,'%')}</b></span></div></div></section>

      <section className="diag-card network-detail"><header><span>HW–04</span><b>NETWORK + POWER</b><em>{network?.state?.toUpperCase()||'SCANNING'}</em></header><div className="diag-card-body"><div className="network-primary"><b>{network?.interface||'NETWORK INTERFACE'}</b><small>{network?.ip4||'Address pending'}{network?.speedMbps?` · ${network.speedMbps} Mbps link`:''}</small><div><span>↓ {rate(network?.rxBytesPerSecond)}</span><span>↑ {rate(network?.txBytesPerSecond)}</span></div></div><div className="battery-grid"><span>BATTERY <b>{telemetry?.battery?.present?reading(telemetry.battery.percent,'%'):'NOT INSTALLED'}</b></span><span>HEALTH <b>{telemetry?.battery?.healthPercent!==null?reading(telemetry?.battery?.healthPercent,'%'):'—'}</b></span><span>CYCLES <b>{telemetry?.battery?.cycleCount??'—'}</b></span><span>UPTIME <b>{duration(telemetry?.uptimeSeconds)}</b></span></div></div></section>

      <section className="diag-card process-detail"><header><span>HW–05</span><b>PROCESS PRESSURE</b><em>{telemetry?.processes?.all??0} ACTIVE</em></header><div className="diag-card-body process-columns"><div><b>TOP CPU</b>{telemetry?.processes?.topCpu?.map((item)=><p key={`cpu-${item.pid}`}><span>{item.name}</span><em>{item.cpuPercent}%</em></p>)}</div><div><b>TOP MEMORY</b>{telemetry?.processes?.topMemory?.map((item)=><p key={`mem-${item.pid}`}><span>{item.name}</span><em>{item.memoryPercent}%</em></p>)}</div></div></section>
    </div>
    <footer className="diag-footer"><span>LAST VERIFIED {telemetry?.collectedAt?new Date(telemetry.collectedAt).toLocaleTimeString():'—'} · HOST {telemetry?.hostname?.toUpperCase()||'—'}</span>{telemetry?.warnings?.length?<details><summary>{telemetry.warnings.length} SENSOR NOTICE{telemetry.warnings.length===1?'':'S'}</summary>{telemetry.warnings.map((warning)=><p key={warning}>{warning}</p>)}</details>:<b>ALL REPORTED SENSORS NOMINAL</b>}</footer>
  </section>;
}
