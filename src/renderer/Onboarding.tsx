import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AIProvider, AppearanceColor, AppearanceSettings, CompanionEmotion, PublicSettings, SpeechProvider } from '../shared/contracts';

// Small, local copies rather than importing from App.tsx — this component
// stays self-contained (same pattern as ConnectorMatrix.tsx/SmartHomePanel.tsx
// already use their own local helpers instead of reaching into App.tsx).
const providerLabel:Record<AIProvider,string>={openai:'OPENAI',anthropic:'CLAUDE',gemini:'GEMINI'};
const providerPlaceholder:Record<AIProvider,string>={openai:'sk-proj-…',anthropic:'sk-ant-…',gemini:'AIza…'};
const appearancePalette:Record<AppearanceColor,string>={teal:'32,255,211',green:'96,255,132',blue:'65,184,255',violet:'182,103,255',amber:'255,181,48',orange:'255,122,50',pink:'255,79,200',red:'255,48,78',white:'220,255,255'};
const appearancePaletteHex:Record<AppearanceColor,string>={teal:'#20ffd3',green:'#60ff84',blue:'#41b8ff',violet:'#b667ff',amber:'#ffb530',orange:'#ff7a32',pink:'#ff4fc8',red:'#ff304e',white:'#dcffff'};
const emotions:CompanionEmotion[]=['neutral','happy','focused','excited','angry'];

const bootLines=[
  ['LOCAL RUNTIME','ONLINE'],['ENCRYPTED VAULT','SEALED · READY'],['PERMISSION KERNEL','ARMED'],
  ['MEMORY CORE','EMPTY · AWAITING FIRST SYNC'],['DEVICE FINGERPRINT','REGISTERED'],['NEURAL UPLINK','AWAITING CONFIGURATION'],
] as const;

type StepId=1|2|3|4|5|6;
const steps:StepId[]=[1,2,3,4,5,6];
const stepMeta:Record<StepId,{name:string;optional:boolean}>={
  1:{name:'IDENTITY',optional:true},2:{name:'NEURAL CORE',optional:false},3:{name:'VOICE',optional:true},
  4:{name:'PRESENCE',optional:true},5:{name:'SMART HOME',optional:true},6:{name:'APPEARANCE',optional:true},
};

export function Onboarding({onComplete,onExit}:{onComplete:(next:PublicSettings)=>void;onExit:()=>void}){
  const [phase,setPhase]=useState<'boot'|'wizard'|'finale'>('boot');
  const [bootRevealed,setBootRevealed]=useState(0);
  const [current,setCurrent]=useState<StepId>(1);
  const [status,setStatus]=useState<Record<StepId,'pending'|'done'|'skipped'>>({1:'pending',2:'pending',3:'pending',4:'pending',5:'pending',6:'pending'});

  const [name,setName]=useState('');
  const [provider,setProvider]=useState<AIProvider>('openai');
  const [apiKey,setApiKey]=useState('');
  const [connState,setConnState]=useState<'idle'|'busy'|'ok'|'error'>('idle');
  const [connMessage,setConnMessage]=useState('');

  const [speechProvider,setSpeechProvider]=useState<SpeechProvider>('elevenlabs');

  const [presenceEnabled,setPresenceEnabled]=useState(true);

  const [hbUrl,setHbUrl]=useState('http://homebridge.local:8581');
  const [hbUser,setHbUser]=useState('');
  const [hbPass,setHbPass]=useState('');

  const [color,setColor]=useState<AppearanceColor>('teal');
  const [emotion,setEmotion]=useState<CompanionEmotion>('neutral');

  const [finishing,setFinishing]=useState(false);
  const [finishError,setFinishError]=useState('');
  const [clock,setClock]=useState(()=>new Date().toLocaleTimeString('en-US',{hour12:false}));
  const bootTimer=useRef<number|undefined>(undefined);

  useEffect(()=>{const id=window.setInterval(()=>setClock(new Date().toLocaleTimeString('en-US',{hour12:false})),1000);return()=>window.clearInterval(id);},[]);
  useEffect(()=>{
    const revealTimers=bootLines.map((_line,index)=>window.setTimeout(()=>setBootRevealed((n)=>Math.max(n,index+1)),index*220+260));
    bootTimer.current=window.setTimeout(()=>setPhase('wizard'),1600+bootLines.length*220);
    return()=>{revealTimers.forEach((id)=>window.clearTimeout(id));window.clearTimeout(bootTimer.current);};
  },[]);
  const skipBoot=()=>{window.clearTimeout(bootTimer.current);setPhase('wizard');};

  const keyTested=connState==='ok';
  const advance=()=>{if(current<steps.length)setCurrent((current+1) as StepId);else setPhase('finale');};
  const back=()=>{if(current>1)setCurrent((current-1) as StepId);};
  const skipStep=()=>{setStatus((s)=>({...s,[current]:'skipped'}));advance();};
  const nextStep=()=>{
    if(current===2&&!keyTested)return;
    setStatus((s)=>({...s,[current]:'done'}));advance();
  };

  const testUplink=async()=>{
    const clean=apiKey.trim();
    if(!clean){setConnState('error');setConnMessage('ENTER A KEY FIRST');return;}
    setConnState('busy');setConnMessage('VERIFYING CREDENTIAL…');
    try{
      const patch=provider==='openai'?{openAIKey:clean}:provider==='anthropic'?{anthropicKey:clean}:{geminiKey:clean};
      await window.axiom.saveSettings({model:'',provider,...patch});
      const result=await window.axiom.testProvider(provider);
      if(result.ok){setConnState('ok');setConnMessage('UPLINK ESTABLISHED');}
      else{setConnState('error');setConnMessage(result.message||'CONNECTION FAILED');}
    }catch(reason){setConnState('error');setConnMessage(reason instanceof Error?reason.message:String(reason));}
  };

  const finish=async()=>{
    if(finishing)return;
    setFinishing(true);setFinishError('');
    try{
      const appearance:AppearanceSettings={color,emotion,accentHex:appearancePaletteHex[color],glowIntensity:1,motionProfile:'adaptive',density:'balanced'};
      const next=await window.axiom.saveSettings({
        model:'',provider,appearance,speechProvider,
        acknowledgeBiometricConsent:status[4]!=='skipped'&&presenceEnabled?true:undefined,
        completeOnboarding:true,
      });
      if(status[1]!=='skipped'&&name.trim())await window.axiom.addMemory(`The user's name is ${name.trim()}.`,'person');
      if(status[5]!=='skipped'&&(hbUser.trim()||hbPass.trim())){
        await window.axiom.saveConnector({id:'homebridge',account:hbUser.trim(),endpoint:hbUrl.trim(),clientSecret:hbPass.trim()||undefined});
      }
      onComplete(next);
    }catch(reason){setFinishError(reason instanceof Error?reason.message:String(reason));}
    finally{setFinishing(false);}
  };

  return <div className="onboarding-stage">
    <canvas className="onboarding-field" ref={(node)=>{if(node)startField(node);}}/>
    <div className="onboarding-grid-floor"/>
    <div className="onboarding-frame">
      <span className="onboarding-bracket tl"/><span className="onboarding-bracket tr"/>
      <span className="onboarding-bracket bl"/><span className="onboarding-bracket br"/>
      <div className="onboarding-hud-top"><span>AXIOM // <b>FIRST CONTACT PROTOCOL</b></span><span className="onboarding-clock">{clock}</span></div>
      <div className="onboarding-hud-bottom"><span>LOCAL-FIRST · NOTHING LEAVES THIS DEVICE UNVERIFIED</span><span>{phase==='boot'?'PHASE 0 / BOOT':phase==='finale'?'PHASE 2 / LIVE':`PHASE 1 / ${stepMeta[current].name}`}</span></div>
    </div>

    {phase==='boot'&&<div className="onboarding-boot">
      <div className="onboarding-boot-mark"><svg viewBox="0 0 100 100">
        <circle className="onboarding-boot-ring" cx="50" cy="50" r="46"/>
        <circle className="onboarding-boot-ring2" cx="50" cy="50" r="38"/>
        <polygon className="onboarding-boot-core" points="50,28 68,62 32,62"/>
        <circle cx="50" cy="50" r="3.4" fill="#eafffb"/>
      </svg></div>
      <span className="onboarding-boot-title">AXIOM</span>
      <div className="onboarding-boot-sub">PRIVATE INTELLIGENCE · COLD START</div>
      <div className="onboarding-boot-log">{bootLines.map(([label,value],index)=><div key={label} style={{animationDelay:`${index*.22}s`}} className={`onboarding-boot-line${index<bootRevealed?' ok':''}`}><i/><span>{label}</span><em>{value}</em></div>)}</div>
      <button className="onboarding-boot-skip" onClick={skipBoot}>SKIP INTRO</button>
    </div>}

    {phase==='wizard'&&<div className="onboarding-wizard">
      <div className="onboarding-rail">{steps.map((s,i)=><FragmentTick key={s} step={s} current={current} status={status[s]} last={i===steps.length-1}/>)}</div>

      <div className="onboarding-panel">
        {current===1&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 1 · IDENTITY</div>
          <h2 className="onboarding-title">Who's <b>activating</b> this core?</h2>
          <p className="onboarding-desc">Just a first name — Axiom uses it to address you and personalize what it remembers. Nothing here is sent anywhere.</p>
          <input className="onboarding-name-input" value={name} onChange={(event)=>setName(event.target.value)} placeholder="Type your first name…" autoComplete="off"/>
        </div>}

        {current===2&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 2 · NEURAL CORE <span className="onboarding-chip required">REQUIRED</span></div>
          <h2 className="onboarding-title">Connect an <b>AI provider</b></h2>
          <p className="onboarding-desc">Axiom needs one real model account to think. Pick a provider and paste an API key — this is the only step that can't be skipped, since nothing else works without it.</p>
          <div className="onboarding-tabs">{(['openai','anthropic','gemini'] as AIProvider[]).map((p)=><button key={p} className={p===provider?'sel':''} onClick={()=>{setProvider(p);setApiKey('');setConnState('idle');setConnMessage('');}}>◈ {providerLabel[p]}</button>)}</div>
          <div className="onboarding-key-row">
            <label className="onboarding-field"><span>{providerLabel[provider]} API KEY</span><input type="password" value={apiKey} onChange={(event)=>{setApiKey(event.target.value);setConnState('idle');}} placeholder={providerPlaceholder[provider]}/></label>
            <button className="onboarding-test-btn" onClick={()=>void testUplink()} disabled={connState==='busy'}>TEST UPLINK</button>
          </div>
          <div className={`onboarding-conn-status ${connState}`}>{connState==='busy'&&<span className="onboarding-spin"/>}<span>{connMessage}</span></div>
        </div>}

        {current===3&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 3 · VOICE <span className="onboarding-chip optional">OPTIONAL</span></div>
          <h2 className="onboarding-title">Give Axiom a <b>voice</b></h2>
          <p className="onboarding-desc">Choose how Axiom speaks back to you, or skip for text-only — you can change this anytime in Settings.</p>
          <div className="onboarding-cards">
            <div className={`onboarding-card ${speechProvider==='elevenlabs'?'sel':''}`} onClick={()=>setSpeechProvider('elevenlabs')}><b>ELEVENLABS</b><span>Realistic, expressive voices. Needs its own API key, added later in Settings.</span></div>
            <div className={`onboarding-card ${speechProvider==='openai'?'sel':''}`} onClick={()=>setSpeechProvider('openai')}><b>OPENAI VOICE</b><span>Uses the same key from Step 2. Solid default.</span></div>
            <div className={`onboarding-card ${speechProvider==='system'?'sel':''}`} onClick={()=>setSpeechProvider('system')}><b>SYSTEM VOICE</b><span>Your OS's built-in speech. No setup, lower quality.</span></div>
          </div>
        </div>}

        {current===4&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 4 · PRESENCE <span className="onboarding-chip optional">OPTIONAL</span></div>
          <h2 className="onboarding-title">Let Axiom <b>see and hear</b> who's home</h2>
          <p className="onboarding-desc">Face and voice recognition are for personalization only — recognizing you, nothing else. This needs your explicit consent before any camera or microphone frame is ever stored.</p>
          <div className="onboarding-consent-box"><b>What this turns on:</b> Axiom can recognize enrolled faces/voices to greet you by name and tailor responses. <b>What it never does:</b> constant recording, sending frames off-device, or granting extra authority based on who's detected. You can withdraw consent anytime in Settings.</div>
          <div className="onboarding-cards two">
            <div className={`onboarding-card ${presenceEnabled?'sel':''}`} onClick={()=>setPresenceEnabled(true)}><b>ENABLE NOW</b><span>Grants consent; enroll your face/voice after setup in Settings.</span></div>
            <div className={`onboarding-card ${!presenceEnabled?'sel':''}`} onClick={()=>setPresenceEnabled(false)}><b>SKIP FOR NOW</b><span>Axiom stays text/voice-only. Enable later anytime.</span></div>
          </div>
        </div>}

        {current===5&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 5 · SMART HOME <span className="onboarding-chip optional">OPTIONAL</span></div>
          <h2 className="onboarding-title">Link your <b>Homebridge</b> instance</h2>
          <p className="onboarding-desc">Control real locks, lights, and sensors through your existing Homebridge Config UI X. Skip if you don't run Homebridge — nothing else in Axiom depends on this.</p>
          <div className="onboarding-key-row">
            <label className="onboarding-field wide"><span>HOMEBRIDGE UI URL</span><input value={hbUrl} onChange={(event)=>setHbUrl(event.target.value)} placeholder="http://homebridge.local:8581"/></label>
            <label className="onboarding-field"><span>USERNAME</span><input value={hbUser} onChange={(event)=>setHbUser(event.target.value)} placeholder="admin"/></label>
          </div>
          <label className="onboarding-field"><span>PASSWORD</span><input type="password" value={hbPass} onChange={(event)=>setHbPass(event.target.value)} placeholder="••••••••"/></label>
        </div>}

        {current===6&&<div className="onboarding-step">
          <div className="onboarding-eyebrow">STEP 6 · APPEARANCE <span className="onboarding-chip optional">OPTIONAL</span></div>
          <h2 className="onboarding-title">Choose Axiom's <b>signal color</b></h2>
          <p className="onboarding-desc">This tunes the whole interface — glow, accents, the companion's eyes. You can change it anytime just by asking.</p>
          <div className="onboarding-color-grid">{(Object.keys(appearancePalette) as AppearanceColor[]).map((c)=><div key={c} className={`onboarding-swatch ${c===color?'sel':''}`} title={c} style={{background:`radial-gradient(circle at 35% 30%, rgba(255,255,255,.5), rgba(${appearancePalette[c]},1) 60%)`}} onClick={()=>setColor(c)}/>)}</div>
          <div className="onboarding-emotion-row">{emotions.map((e)=><button key={e} className={e===emotion?'sel':''} onClick={()=>setEmotion(e)}>{e.toUpperCase()}</button>)}</div>
          <div className="onboarding-preview-orb" style={{'--pv':appearancePalette[color]} as CSSProperties}/>
        </div>}
      </div>

      <div className="onboarding-panel">
        <div className="onboarding-nav-row">
          <div className="onboarding-nav-row-left"><span className="onboarding-step-index">STEP {current} OF {steps.length}</span><button className="onboarding-exit-link" onClick={onExit}>EXIT TO SETTINGS</button></div>
          <div className="onboarding-nav-left">
            {current>1&&<button className="onboarding-btn-ghost" onClick={back}>BACK</button>}
            {stepMeta[current].optional&&<button className="onboarding-btn-ghost" onClick={skipStep}>SKIP</button>}
            <button className="onboarding-btn-primary" onClick={nextStep} disabled={current===2&&!keyTested}>{current===steps.length?'FINISH SETUP':'CONTINUE'}</button>
          </div>
        </div>
      </div>
    </div>}

    {phase==='finale'&&<div className="onboarding-finale">
      <div className="onboarding-preview-orb large" style={{'--pv':appearancePalette[color]} as CSSProperties}/>
      <div className="onboarding-finale-title">SYSTEM <b>ONLINE</b></div>
      <div className="onboarding-finale-sub">AXIOM IS READY · CONFIGURATION SAVED LOCALLY</div>
      <div className="onboarding-summary">
        <div><span>Identity</span><em className={status[1]!=='skipped'&&name.trim()?'on':'off'}>{status[1]!=='skipped'&&name.trim()?name.trim():'Skipped'}</em></div>
        <div><span>Neural core</span><em className={keyTested?'on':'off'}>{keyTested?`${providerLabel[provider]} connected`:'Not connected'}</em></div>
        <div><span>Voice</span><em className={status[3]!=='skipped'?'on':'off'}>{status[3]!=='skipped'?speechProvider.toUpperCase():'Skipped — text only'}</em></div>
        <div><span>Presence</span><em className={status[4]!=='skipped'&&presenceEnabled?'on':'off'}>{status[4]!=='skipped'&&presenceEnabled?'Consent granted':'Skipped'}</em></div>
        <div><span>Smart home</span><em className={status[5]!=='skipped'&&(hbUser.trim()||hbPass.trim())?'on':'off'}>{status[5]!=='skipped'&&(hbUser.trim()||hbPass.trim())?'Configured':'Skipped'}</em></div>
        <div><span>Appearance</span><em className="on">{color.toUpperCase()}</em></div>
      </div>
      {finishError&&<div className="onboarding-finish-error">{finishError}</div>}
      <button className="onboarding-enter-btn" onClick={()=>void finish()} disabled={finishing}>{finishing?'ENTERING…':'ENTER AXIOM →'}</button>
    </div>}
  </div>;
}

function FragmentTick({step,current,status,last}:{step:StepId;current:StepId;status:'pending'|'done'|'skipped';last:boolean}){
  const cls=step===current?'current':status==='done'?'done':status==='skipped'?'skipped':'';
  return <>
    <div className={`onboarding-tick ${cls}`}><div className="onboarding-dot"/><div className="onboarding-label">{stepMeta[step].name}</div></div>
    {!last&&<div className={`onboarding-bar ${status==='done'||status==='skipped'?'done':''}`}/>}
  </>;
}

// A shared full-screen particle field, same lightweight ambient-motion
// pattern already used elsewhere in Axiom (the Ring materialize burst, the
// cognition field) — drawn once per mounted canvas, not re-created on every
// render.
function startField(canvas:HTMLCanvasElement):void{
  if(canvas.dataset.started)return;canvas.dataset.started='1';
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const resize=()=>{canvas.width=window.innerWidth;canvas.height=window.innerHeight;};
  resize();window.addEventListener('resize',resize);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const particles=Array.from({length:reduced?0:70},()=>({x:Math.random()*window.innerWidth,y:Math.random()*window.innerHeight,r:.6+Math.random()*1.4,vx:(Math.random()-.5)*.12,vy:(Math.random()-.5)*.12,a:.15+Math.random()*.35}));
  const frame=()=>{
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for(const p of particles){
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0)p.x=window.innerWidth;if(p.x>window.innerWidth)p.x=0;if(p.y<0)p.y=window.innerHeight;if(p.y>window.innerHeight)p.y=0;
      ctx.beginPath();ctx.fillStyle=`rgba(93,255,223,${p.a})`;ctx.shadowColor='rgba(93,255,223,.8)';ctx.shadowBlur=4;
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();
    }
    if(!reduced)requestAnimationFrame(frame);
  };
  frame();
}
