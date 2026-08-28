import crypto from 'node:crypto';
import type {
  AxiomPlatform,
  ConversationLatencyReport,
  DevicePresence,
  OperationalProbe,
  OperationalRouteReceipt,
  OperationalSnapshot,
  RendererCapabilityReport,
  ToolEvent,
} from '../shared/contracts';

const nowIso=()=>new Date().toISOString();
const fresh=(value:string|undefined,maxAgeMs:number,now=Date.now())=>Boolean(value&&Number.isFinite(Date.parse(value))&&now-Date.parse(value!)<=maxAgeMs);

export function routeIntent(message:string,candidates:string[]):string{
  const text=message.toLowerCase(),joined=candidates.join(' ');
  if(candidates.includes('web_search'))return'LIVE INTELLIGENCE';
  if(/camera|screen|vision/.test(joined)||/\b(?:camera|see|look|screen)\b/.test(text))return'VISUAL PERCEPTION';
  if(/system_summary/.test(joined)||/\b(?:cpu|gpu|ram|storage|temperature|hardware)\b/.test(text))return'HARDWARE DIAGNOSTICS';
  if(/browser/.test(joined))return'BROWSER OPERATION';
  if(/application|window|clipboard|media/.test(joined))return'DESKTOP CONTROL';
  if(/project|checkpoint/.test(joined))return'BUILD LAB';
  if(/file|directory|path/.test(joined))return'FILE SYSTEM';
  if(/memory|goal|todo|commitment/.test(joined))return'MEMORY + PLANNING';
  return candidates.length?'CAPABILITY ROUTING':'CONVERSATION';
}

export function fuseIdentity(report:RendererCapabilityReport|undefined,now=Date.now()):OperationalSnapshot['identity']{
  if(report?.speakerDecision==='noise')return{state:'noise-rejected',detail:'Acoustic gate rejected noise before it reached Axiom.'};
  const face=report?.faceIdentity,voice=report?.speakerIdentity;
  const faceReady=Boolean(face&&fresh(face.observedAt,15_000,now)),voiceReady=Boolean(voice&&fresh(voice.verifiedAt,30_000,now));
  if(faceReady&&voiceReady){
    if(face!.name.trim().toLowerCase()===voice!.name.trim().toLowerCase())return{state:'dual-verified',name:face!.name,detail:`Face ${Math.round(face!.confidence*100)}% + voice ${Math.round(voice!.score*100)}% agree.`};
    return{state:'conflict',detail:`Face reports ${face!.name}; voice reports ${voice!.name}. Privileged tools must remain locked.`};
  }
  if(faceReady)return{state:'face-verified',name:face!.name,detail:`Face verified at ${Math.round(face!.confidence*100)}%; current voice is not verified.`};
  if(voiceReady)return{state:'voice-verified',name:voice!.name,detail:`Voice verified at ${Math.round(voice!.score*100)}%; current face is not verified.`};
  return{state:'unknown',detail:report?.speakerDecision==='rejected'?'Unknown speaker rejected.':'No fresh biometric agreement is available.'};
}

function rendererProbes(report:RendererCapabilityReport|undefined):OperationalProbe[]{
  const checkedAt=report?.reportedAt||nowIso();
  if(!report)return[
    {id:'renderer-microphone',label:'MICROPHONE PATH',domain:'voice',state:'checking',detail:'Awaiting renderer sensor report.',checkedAt,recovery:'Wait for the interface to finish starting.'},
    {id:'renderer-camera',label:'PRESENCE CAMERA',domain:'vision',state:'checking',detail:'Awaiting renderer sensor report.',checkedAt,recovery:'Wait for Presence Link to initialize.'},
    {id:'renderer-speaker-id',label:'NEURAL SPEAKER ID',domain:'security',state:'checking',detail:'Loading local identity model.',checkedAt},
  ];
  const micReady=report.microphone==='ready'||report.microphone==='recording',micFault=report.microphone==='fault';
  const transcriptionReady=report.transcription==='ready',transcriptionFallback=report.transcription==='fallback';
  const cameraReady=report.camera==='locked',cameraBlocked=['busy','denied','error'].includes(report.camera);
  return[
    {id:'renderer-microphone',label:'MICROPHONE PATH',domain:'voice',state:micReady?'ready':micFault?'blocked':'degraded',detail:micReady?`Input ${report.microphone}; transcription ${report.transcription}.`:micFault?'Microphone capture failed.':`Microphone is ${report.microphone}.`,checkedAt,recovery:micFault?'Select another microphone or restore operating-system microphone access.':'Axiom will arm the input after startup speech and active-device arbitration.'},
    {id:'renderer-transcription',label:'REALTIME TRANSCRIPTION',domain:'voice',state:transcriptionReady?'ready':transcriptionFallback?'degraded':report.transcription==='fault'?'blocked':'checking',detail:transcriptionReady?'OpenAI WebRTC transcription is connected.':transcriptionFallback?'Buffered transcription recovery is active.':`Transcription path is ${report.transcription}.`,checkedAt,recovery:'Axiom automatically falls back to bounded buffered transcription when the realtime path fails.'},
    {id:'renderer-camera',label:'PRESENCE CAMERA',domain:'vision',state:cameraReady?'ready':cameraBlocked?'blocked':'degraded',detail:cameraReady?'Face/body tracking is locked locally.':`Presence Link is ${report.camera}.`,checkedAt,recovery:cameraBlocked?'Release the camera from other apps or restore camera permission, then retry Presence Link.':'Remain in view while the local tracking models acquire a lock.'},
    {id:'renderer-speaker-id',label:'NEURAL SPEAKER ID',domain:'security',state:report.speakerEngine==='ready'?'ready':report.speakerEngine==='fault'?'blocked':'checking',detail:report.speakerEngine==='ready'?`WavLM local engine ready · decision ${report.speakerDecision}.`:`WavLM engine ${report.speakerEngine}.`,checkedAt,recovery:'Reload the bundled WavLM model or re-enroll the voice profile.'},
  ];
}

interface SnapshotContext{
  platform:AxiomPlatform;
  localDevice:DevicePresence;
  activeDevice?:DevicePresence;
}

export class ReliabilityFabric{
  private baseProbes:OperationalProbe[]=[];
  private renderer?:RendererCapabilityReport;
  private latencies:ConversationLatencyReport[]=[];
  private route:OperationalRouteReceipt={request:'',intent:'CONVERSATION',candidates:[],state:'idle',startedAt:nowIso(),detail:'Waiting for a request.'};

  setBaseProbes(probes:OperationalProbe[]):void{this.baseProbes=probes.map((probe)=>({...probe}));}
  reportRenderer(report:RendererCapabilityReport):void{this.renderer={...report};}
  reportLatency(report:ConversationLatencyReport):void{
    const normalized={...report,id:report.id||crypto.randomUUID(),at:report.at||nowIso(),sttMs:Math.max(0,Math.round(report.sttMs||0)),firstTokenMs:Math.max(0,Math.round(report.firstTokenMs||0)),ttsMs:Math.max(0,Math.round(report.ttsMs||0)),firstAudioMs:Math.max(0,Math.round(report.firstAudioMs||0)),routeMs:Math.max(0,Math.round(report.routeMs||0))};
    this.latencies=[...this.latencies,normalized].slice(-40);
  }
  beginRoute(request:string,candidates:string[]):void{this.route={request:request.trim().slice(0,260),intent:routeIntent(request,candidates),candidates:[...new Set(candidates)].slice(0,16),state:'routing',startedAt:nowIso(),detail:candidates.length?`Selecting from ${candidates.length} relevant capability path(s).`:'Direct conversation path selected.'};}
  finishRoute(events:ToolEvent[],failure?:string):void{
    const completedAt=nowIso(),recovered=events.some((event)=>event.name==='adaptive_failover'||/recover/i.test(event.summary)),verified=events.filter((event)=>event.status==='verified'),blocked=events.find((event)=>event.status==='blocked'),failed=events.find((event)=>event.status==='failed');
    const state=failure||failed?'failed':blocked?'blocked':recovered?'recovered':'verified';
    const capability=verified.find((event)=>event.name!=='adaptive_failover')?.name;
    this.route={...this.route,state,completedAt,capability,detail:failure?.slice(0,300)||failed?.summary||blocked?.summary||(capability?`${capability.replaceAll('_',' ')} completed with a verified receipt.`:'Conversation completed without a computer action.')};
  }
  identity():OperationalSnapshot['identity']{return fuseIdentity(this.renderer);}
  hasIdentityConflict():boolean{return this.identity().state==='conflict';}
  snapshot(context:SnapshotContext):OperationalSnapshot{
    const probes=[...this.baseProbes,...rendererProbes(this.renderer)],deduped=[...new Map(probes.map((probe)=>[probe.id,probe])).values()];
    const ready=deduped.filter((probe)=>probe.state==='ready').length,degraded=deduped.filter((probe)=>probe.state==='degraded'||probe.state==='checking').length,blocked=deduped.filter((probe)=>probe.state==='blocked').length;
    const coreBlocked=deduped.some((probe)=>['ai-router','runtime-journal','secure-vault'].includes(probe.id)&&probe.state==='blocked');
    const identity=this.identity(),active=context.activeDevice||context.localDevice,latest=this.latencies.at(-1),samples=this.latencies.length;
    const average=(key:'firstAudioMs'|'firstTokenMs')=>samples?Math.round(this.latencies.reduce((sum,item)=>sum+item[key],0)/samples):0;
    return{generatedAt:nowIso(),overall:coreBlocked?'blocked':blocked||degraded?'degraded':'nominal',probes:deduped,route:{...this.route},latency:{latest,averageFirstAudioMs:average('firstAudioMs'),averageFirstTokenMs:average('firstTokenMs'),samples},identity,activeDevice:{id:active.id,name:active.name,platform:active.platform,local:active.id===context.localDevice.id,lastActiveAt:active.lastActiveAt},metrics:{ready,degraded,blocked,total:deduped.length}};
  }
}
