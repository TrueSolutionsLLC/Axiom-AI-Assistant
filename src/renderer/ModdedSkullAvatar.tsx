import { useEffect, useRef } from 'react';
import type { AppearanceSettings, CompanionState } from '../shared/contracts';
import { mouthFrameWeights } from './mouthFrames';
import { mouthKinematics } from './mouthKinematics';
import { isSpeechArticulating } from './speechVisualGuard';
import type { TrackingPose } from './useFaceTracking';
import type { Viseme } from './visemes';

export interface MouthShape { open: number; wide: number; round: number; viseme?:Viseme; }
export type Appearance = AppearanceSettings;
interface Props { mode: CompanionState; energy: number; tracking: TrackingPose; mouth: MouthShape; appearance: Appearance; }
const palette: Record<Appearance['color'], string> = { teal:'32,255,211', green:'96,255,132', blue:'65,184,255', violet:'182,103,255', amber:'255,181,48', orange:'255,122,50', pink:'255,79,200', red:'255,48,78', white:'220,255,255' };
const hexToRgb=(value:string,fallback:string):string=>{const match=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);return match?`${parseInt(match[1],16)},${parseInt(match[2],16)},${parseInt(match[3],16)}`:fallback;};
const clamp = (n:number, min=0, max=1) => Math.max(min, Math.min(max, n));
const damp = (from:number, to:number, speed:number, dt:number) => from + (to-from) * (1-Math.exp(-speed*dt));

export function ModdedSkullAvatar(props: Props) {
  const host = useRef<HTMLDivElement>(null); const wave = useRef<HTMLCanvasElement>(null); const live = useRef(props);
  useEffect(() => { live.current = props; }, [props]);
  useEffect(() => {
    const root=host.current!,canvas=wave.current!,ctx=canvas.getContext('2d')!;const pointer={x:0,y:0};
    const onPointer=(event:PointerEvent)=>{const r=root.getBoundingClientRect();pointer.x=clamp((event.clientX-r.left)/Math.max(1,r.width))*2-1;pointer.y=clamp((event.clientY-r.top)/Math.max(1,r.height))*2-1;};
    let qaOverride:{until:number;mode:CompanionState;energy:number;mouth:MouthShape}|null=null;
    const onQaFrame=(event:Event)=>{if(sessionStorage.getItem('axiom-mouth-qa')!=='1')return;const detail=(event as CustomEvent<Partial<{durationMs:number;mode:CompanionState;energy:number;mouth:MouthShape}>>).detail||{};if(!detail.mouth)return;qaOverride={until:performance.now()+clamp(Number(detail.durationMs)||180,40,2000),mode:detail.mode||'speaking',energy:clamp(Number(detail.energy)||.72),mouth:detail.mouth};};
    window.addEventListener('pointermove',onPointer);window.addEventListener('axiom:mouth-qa-frame',onQaFrame);let raf=0,last=performance.now(),lastWaveDraw=0,blinkAt=last+1900+Math.random()*2500,blink=1,lastSpeech=0,nodImpulse=0;
    const pose={x:0,y:0,yaw:0,pitch:0,roll:0,gazeX:0,gazeY:0,depth:.5,open:0,wide:0,round:0};
    const gesture={yaw:0,pitch:0,roll:0,gazeX:0,gazeY:0,next:last};
    const frame=(now:number)=>{
      const dt=Math.min(.05,(now-last)/1000);last=now;const base=live.current,p=qaOverride&&now<qaOverride.until?{...base,...qaOverride}:base,tracked=p.tracking.confidence>.16&&now-p.tracking.lastSeen<1800,t=now/1000,articulating=isSpeechArticulating(p.mode,p.mouth.open),speech=articulating?p.energy:0,listen=p.mode==='listening'&&!articulating?1:0;
      if(now>gesture.next){const intensity=speech>.08?1:listen?.5:.16;gesture.yaw=(Math.random()*2-1)*2.25*intensity;gesture.pitch=(Math.random()*1.7-.62)*1.45*intensity;gesture.roll=(Math.random()*2-1)*.58*intensity;gesture.gazeX=(Math.random()*2-1)*1.5*intensity;gesture.gazeY=(Math.random()*2-1)*.8*intensity;gesture.next=now+(speech>.08?420+Math.random()*720:listen?900+Math.random()*1200:2400+Math.random()*3600);}
      // A real speaker punctuates phrases rather than continuously bobbing.
      // Drive a short, critically damped nod from sharp speech-energy attacks.
      if(speech-lastSpeech>.19)nodImpulse=Math.min(2.4,nodImpulse+(speech-lastSpeech)*3.2);
      lastSpeech=damp(lastSpeech,speech,12,dt);nodImpulse=damp(nodImpulse,0,5.8,dt);
      const breathing=Math.sin(t*1.13)*.38;
      const talkYaw=gesture.yaw+speech*Math.sin(t*3.1)*.12;
      const talkPitch=gesture.pitch+speech*Math.sin(t*4.15+.4)*.1-nodImpulse;
      // Translation follows the person, while most of the attention cue comes
      // from rotation. This reads as a head on a neck instead of a sliding card.
      pose.x=damp(pose.x,tracked?p.tracking.x*92:Math.sin(t*.31)*2.4,tracked?9.6:.8,dt);pose.y=damp(pose.y,tracked?p.tracking.y*32+breathing:Math.sin(t*.47)*1.3+breathing,tracked?8.8:.7,dt);
      pose.yaw=damp(pose.yaw,(tracked?p.tracking.x*24+p.tracking.yaw*15:pointer.x*2.2)+talkYaw,tracked?9.4:2.4,dt);pose.pitch=damp(pose.pitch,(tracked?-p.tracking.y*12+p.tracking.pitch*10:pointer.y*1.4)+talkPitch,tracked?8.8:2.2,dt);pose.roll=damp(pose.roll,(tracked?-p.tracking.roll*9:Math.sin(t*.23)*.48)+gesture.roll,tracked?8.2:1.8,dt);
      pose.gazeX=damp(pose.gazeX,(tracked?p.tracking.x*.88+p.tracking.gazeX*.38:pointer.x*.44)*11+gesture.gazeX,12.5,dt);pose.gazeY=damp(pose.gazeY,(tracked?p.tracking.y*.68+p.tracking.gazeY*.34:pointer.y*.32)*7.6+gesture.gazeY,11.5,dt);pose.depth=damp(pose.depth,tracked?p.tracking.distance:.5,3.2,dt);
      // App.tsx already applies the original Jarvis speech envelope. Applying a
      // second damp here made two photographic mouth frames remain visible at
      // once, which was the source of Axiom's blurred/doubled teeth.
      pose.open=articulating?clamp(p.mouth.open):0;pose.wide=clamp(p.mouth.wide);pose.round=clamp(p.mouth.round);
      if(tracked)blink=Math.min(p.tracking.blinkLeft,p.tracking.blinkRight);else if(now>blinkAt){const age=now-blinkAt;blink=age<75?1-age/75:age<155?(age-75)/80:1;if(age>170){blink=1;blinkAt=now+2100+Math.random()*4200;}}
      const emotion=p.appearance.emotion,squint=emotion==='angry'||emotion==='focused'?.82:emotion==='happy'?.88:1,rgb=p.mode==='error'?'255,48,78':p.mode==='warning'?'255,181,48':hexToRgb(p.appearance.accentHex,palette[p.appearance.color]);
      const shut=p.mouth.viseme==='closed'||p.mouth.viseme==='rest';if(shut)pose.open=0;
      // Exact transition gates from the proven Jarvis mod. Most of the time one
      // full skull frame is visible; cross-fades exist only in two tiny ranges.
      const {closed,half,opened}=mouthFrameWeights(pose.open,shut),kinematics=mouthKinematics(p.mouth.viseme,pose.open,pose.wide,pose.round);
      root.dataset.viseme=p.mouth.viseme||'neutral';
      const set=(name:string,value:string)=>root.style.setProperty(name,value);set('--head-x',`${pose.x.toFixed(2)}px`);set('--head-y',`${pose.y.toFixed(2)}px`);set('--head-yaw',`${pose.yaw.toFixed(2)}deg`);set('--head-pitch',`${pose.pitch.toFixed(2)}deg`);set('--head-roll',`${pose.roll.toFixed(2)}deg`);set('--head-scale',(.955+pose.depth*.075).toFixed(3));set('--gaze-x',`${pose.gazeX.toFixed(2)}px`);set('--gaze-y',`${pose.gazeY.toFixed(2)}px`);set('--eye-open',clamp(blink*squint,.04,1).toFixed(3));set('--jaw-open',pose.open.toFixed(3));set('--mouth-wide',pose.wide.toFixed(3));set('--mouth-round',pose.round.toFixed(3));set('--jaw-drop',`${kinematics.jawDrop.toFixed(2)}px`);set('--jaw-swing',`${kinematics.jawSwing.toFixed(2)}deg`);set('--upper-lift',`${kinematics.upperLift.toFixed(2)}px`);set('--mouth-width',kinematics.width.toFixed(3));set('--mouth-height',kinematics.height.toFixed(3));set('--mouth-asymmetry',`${(articulating?Math.sin(t*5.7)*pose.open*.38:0).toFixed(2)}deg`);set('--jaw-closed',closed.toFixed(3));set('--jaw-half',half.toFixed(3));set('--jaw-open-frame',opened.toFixed(3));set('--avatar-rgb',rgb);set('--speech-energy',speech.toFixed(3));set('--light-x',`${(50-pose.yaw*1.15).toFixed(1)}%`);set('--light-y',`${(42+pose.pitch*.7).toFixed(1)}%`);set('--depth-shift-x',`${(-pose.yaw*.34).toFixed(2)}px`);set('--depth-shift-y',`${(pose.pitch*.22).toFixed(2)}px`);
      const r=root.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      const reduced=p.appearance.motionProfile==='reduced',waveInterval=reduced?110:p.appearance.motionProfile==='efficient'?30:0;
      if(now-lastWaveDraw>=waveInterval){
        lastWaveDraw=now;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);ctx.save();ctx.translate(r.width/2,r.height*.47);
        // The waveform is a separate live signal field. The HUD ring is never
        // drawn here, so head tracking cannot move or duplicate it.
        const half=r.width*.49,thinking=p.mode==='thinking'?1:0,success=p.mode==='success'?1:0;
        const heartbeat=(Math.sin(t*2.1)*.5+.5)*.045,activity=clamp(.07+heartbeat+speech*.9+listen*.28+thinking*.22+success*.18,0,1.18);
        const centerFade=(x:number)=>clamp((Math.abs(x)-r.width*.12)/(r.width*.31),.12,1);
        const signalAt=(x:number,layer=0)=>{
          const phase=layer*1.37,carrier=Math.sin(x*(.105+layer*.012)+t*(7.4+layer*1.9)+phase),detail=Math.sin(x*(.031+layer*.006)-t*(3.2+layer*.8)-phase),micro=Math.sin(x*.235+t*12.7+phase)*.28;
          return (carrier*.58+detail*.3+micro*.12)*(4+activity*25)*(.42+centerFade(x)*.9);
        };
        const horizon=ctx.createLinearGradient(-half,0,half,0);horizon.addColorStop(0,`rgba(${rgb},0)`);horizon.addColorStop(.12,`rgba(${rgb},${.24+activity*.24})`);horizon.addColorStop(.5,`rgba(${rgb},${.08+activity*.12})`);horizon.addColorStop(.88,`rgba(${rgb},${.24+activity*.24})`);horizon.addColorStop(1,`rgba(${rgb},0)`);
        ctx.strokeStyle=horizon;ctx.lineWidth=1;ctx.shadowColor=`rgb(${rgb})`;ctx.shadowBlur=5+activity*12;ctx.beginPath();ctx.moveTo(-half,0);ctx.lineTo(half,0);ctx.stroke();
        // Mirrored spectrum pylons become taller and denser while speaking.
        const barStep=p.appearance.motionProfile==='efficient'?12:8;
        for(let x=-half;x<=half;x+=barStep){
          const edge=centerFade(x),mod=Math.abs(Math.sin(x*.079-t*4.7)+Math.sin(x*.021+t*2.3)*.62),burst=Math.pow(Math.abs(Math.sin(x*.113+t*8.1)),3);
          const height=(2+mod*8+burst*15)*(activity+.08)*edge;if(height<.8)continue;
          ctx.beginPath();ctx.moveTo(x,-height);ctx.lineTo(x,height);ctx.strokeStyle=`rgba(${rgb},${(.06+edge*.19+speech*.28).toFixed(3)})`;ctx.lineWidth=barStep>8?1:1.15;ctx.shadowBlur=activity>0.3?7:2;ctx.stroke();
        }
        // Three counter-moving carrier traces create depth without extra DOM.
        for(let layer=2;layer>=0;layer--){
          ctx.beginPath();const step=p.appearance.motionProfile==='efficient'?5:3;for(let x=-half;x<=half;x+=step){const y=signalAt(x,layer)*(layer===0?1:layer===1?.62:.38);x===-half?ctx.moveTo(x,y):ctx.lineTo(x,y);}
          ctx.strokeStyle=`rgba(${rgb},${layer===0?.24+activity*.58:layer===1?.13+activity*.28:.07+activity*.16})`;ctx.lineWidth=layer===0?1.45:1;ctx.shadowBlur=layer===0?7+activity*15:3;ctx.stroke();
        }
        // Bright data packets travel along the signal in both directions.
        const packets=reduced?2:p.appearance.motionProfile==='efficient'?4:7;
        for(let index=0;index<packets;index++){const direction=index%2?1:-1,progress=(t*(.11+index*.008)+index/packets)%1,x=direction*(progress*2-1)*half,y=signalAt(x,0);const radius=1.1+activity*1.8;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fillStyle=`rgba(${rgb},${.32+activity*.5})`;ctx.shadowBlur=9+activity*12;ctx.fill();}
        ctx.restore();
      }
      raf=requestAnimationFrame(frame);
    };raf=requestAnimationFrame(frame);return()=>{cancelAnimationFrame(raf);window.removeEventListener('pointermove',onPointer);window.removeEventListener('axiom:mouth-qa-frame',onQaFrame);};
  },[]);
  const jawFrames=<div className="modded-mouth-part modded-lower-mouth" aria-hidden="true"><img className="modded-mouth-frame modded-jaw-closed" src="./mod-assets/axiom-skull-closed.png" alt=""/><img className="modded-mouth-frame modded-jaw-half" src="./mod-assets/axiom-skull-half.png" alt=""/><img className="modded-mouth-frame modded-jaw-open" src="./mod-assets/axiom-skull-open.png" alt=""/></div>;
  return <div ref={host} className={`signal-avatar modded-avatar emotion-${props.appearance.emotion}`} data-mode={props.mode} data-tracking-source={props.tracking.source} data-tracking-confidence={props.tracking.confidence.toFixed(3)} data-tracking-fps={props.tracking.fps} data-tracking-motion={props.tracking.motion.toFixed(3)} aria-label={`Axiom icon wireframe skull: ${props.mode}`}><div className="modded-cleanplate" aria-hidden="true"/><canvas ref={wave} className="modded-wave" aria-hidden="true"/><div className="modded-ring" aria-hidden="true"><svg viewBox="0 0 1024 1024" role="presentation"><defs><mask id="axiom-stationary-ring-mask" maskUnits="userSpaceOnUse"><rect width="1024" height="1024" fill="black"/><circle cx="512" cy="512" r="500" fill="white"/><circle cx="512" cy="512" r="385" fill="black"/></mask></defs><image href="./mod-assets/axiom-skull-closed.png" width="1024" height="1024" mask="url(#axiom-stationary-ring-mask)"/></svg></div><div className="modded-head"><img className="modded-depth-back" src="./mod-assets/axiom-skull-closed.png" alt=""/><img className="modded-base" src="./mod-assets/axiom-skull-closed.png" alt=""/>{jawFrames}<div className="modded-volume-light" aria-hidden="true"/><div className="modded-eyes"><i className="left"><b/></i><i className="right"><b/></i></div><div className="modded-speech-aura"/></div></div>;
}
