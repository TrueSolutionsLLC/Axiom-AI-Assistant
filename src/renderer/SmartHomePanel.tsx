import { useEffect, useMemo, useState } from 'react';
import type { HomebridgeAccessory, HomebridgeSnapshot } from '../shared/contracts';

// Homebridge's live value lives under a characteristic-shaped key (On,
// LockCurrentState, CurrentDoorState...) rather than one uniform "state"
// field, so this picks the most relevant one per accessory instead of
// assuming every accessory has the same shape.
const homebridgeState=(accessory:HomebridgeAccessory):string=>{
  const values=accessory.values;
  if('On' in values)return values.On?'on':'off';
  if('LockCurrentState' in values)return values.LockCurrentState===1?'locked':'unlocked';
  if('CurrentDoorState' in values)return ['open','closed','opening','closing','stopped'][Number(values.CurrentDoorState)]||'unknown';
  const first=Object.values(values)[0];
  return first===undefined?'—':String(first);
};
const homebridgeTone=(accessory:HomebridgeAccessory)=>{const state=homebridgeState(accessory);return state==='on'||state==='unlocked'||state==='open'?'active':'normal';};

export function SmartHomePanel({onCommand}:{onCommand:(command:string)=>void}){
  const [hb,setHb]=useState<HomebridgeSnapshot|null>(null);
  useEffect(()=>{
    let mounted=true,timer:ReturnType<typeof setInterval>;
    const load=()=>{
      void window.axiom.getHomebridgeSnapshot().then((value)=>{if(mounted)setHb(value);}).catch(()=>{});
    };
    load();timer=setInterval(load,5000);return()=>{mounted=false;clearInterval(timer);};
  },[]);
  const hbAccessories=useMemo(()=>hb?.accessories.slice(0,18)||[],[hb]);
  const hbConfigured=Boolean(hb?.configured);

  if(!hbConfigured)return <section className="smart-home-panel"><header><div><span>SMART HOME</span><b>NOT LINKED</b></div><i/></header><div className="smart-home-empty"><b>CONNECT YOUR HOME</b><p>Open Settings → Connections and add Homebridge Config UI X.</p></div></section>;

  return <>
    <section className="smart-home-panel"><header><div><span>HOMEBRIDGE / HOMEKIT CONTROL PLANE</span><b>{hb!.connected?'SMART HOME ONLINE':'CONNECTION DEGRADED'}</b></div><i className={hb!.connected?'online':''}/></header>
      {/* connected can be true with an error present at the same time now —
          Homebridge Config UI X's own accessory cache can genuinely come
          back empty right after a restart until its Accessories tab has
          been opened once in a browser (github.com/homebridge/
          homebridge-config-ui-x#1005, reproduced live). That's real
          guidance, not a broken connection, so it must not render as the
          same red "CONNECTION DEGRADED" fault state as an actual failed
          login/request — hb.connected is the one true signal for that. */}
      {!hb!.connected?<div className="smart-home-empty fault"><b>CONNECTION DEGRADED</b><p>{hb!.error}</p></div>
        :hb!.error?<div className="smart-home-empty"><b>NO DEVICES YET</b><p>{hb!.error}</p></div>:<>
        <div className="smart-home-stats"><article><strong>{hb!.accessories.length}</strong><span>ACCESSORIES</span></article>{Object.entries(hb!.counts).slice(0,3).map(([type,count])=><article key={type}><strong>{count}</strong><span>{type.toUpperCase()}</span></article>)}</div>
        <div className="smart-home-entities">{hbAccessories.map((item)=><button key={item.uniqueId} onClick={()=>onCommand(`What is the current state of ${item.name} on Homebridge?`)}><i className={homebridgeTone(item)}/><p><b>{item.name}</b><span>{item.type}</span></p><em>{homebridgeState(item)}</em></button>)}</div>
      </>}
    </section>
    <div className="smart-home-actions"><button onClick={()=>onCommand('List all important smart-home devices and their current states.')}>FULL DEVICE STATUS</button><button onClick={()=>onCommand('Tell me whether any smart-home security sensors, doors, locks, or alarms need my attention.')}>SECURITY SWEEP</button></div>
  </>;
}
