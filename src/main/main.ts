import { app, BrowserWindow, crashReporter, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, session, shell, systemPreferences, Tray } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AIProvider, ApprovalDecisionResult, AssistantRequest, BackgroundEvent, CapabilityHealthItem, ChatMessage, ConversationLatencyReport, ElevenLabsVoice, OperationalProbe, OperationalSnapshot, PlatformPermissionStatus, ProviderHealth, RendererCapabilityReport, RuntimeSnapshot, SaveSettingsRequest, ScreenCapture, ToolEvent } from '../shared/contracts';
import { AppStore } from './store';
import { normalizeActionReply, runAssistant } from './openai';
import { desktopInfrastructureStatus, deterministicActionRoute, executeTool, permissions, providerTools, requiresToolUse } from './tools';
import { synthesizeSpeechWithFallback, transcribeAudio } from './audio';
import { assessRuntimeOutcome, capabilityHorizon, classifyRuntimeRisk } from './runtimeCore';
import { SyncManager } from './sync';
import { platformProfile } from './platform';
import { forwardAssistantRequest } from './assistantRequest';
import { BackgroundRuntime } from './backgroundRuntime';
import { ConnectorClient } from './connectors';
import { MediaService } from './media';
import { showCursorGuide } from './cursorGuide';
import { getSystemTelemetrySnapshot } from './systemTelemetry';
import { ReliabilityFabric } from './reliabilityFabric';
import { checkForUpdate, downloadVerifiedUpdate } from './updater';
import { RingLiveViewSessions } from './ringLiveView';
import { GodsEyeViewManager } from './godsEyeView';

// A dedicated profile keeps renderer QA isolated from the user's real Axiom
// identity, credentials, memory, and single-instance lock.
if(process.env.AXIOM_QA_USER_DATA)app.setPath('userData',path.resolve(process.env.AXIOM_QA_USER_DATA));

const store = new AppStore();
const syncManager = new SyncManager(store);
const connectors=new ConnectorClient(store);
const ringSessions=new RingLiveViewSessions(()=>connectors.ringTicket(),(event)=>mainWindow?.webContents.send('ring:liveview-event',event),writeDiagnostic);
const mediaService=new MediaService(store);
const reliability=new ReliabilityFabric();
let mainWindow: BrowserWindow | null = null;
let godsEyeView: GodsEyeViewManager | null = null;

// Keyword-gated tool offering (see providerTools() in tools.ts) will always
// have a long tail of real phrasings a hand-written regex never anticipated
// — every fix so far (web search, folder creation, Homebridge, desktop
// control...) was found this same way: a live user hit a phrase, it didn't
// match, Axiom said "I can't do that" for something it actually can do, and
// that failure was invisible until someone happened to notice and report
// it. Rather than claim this class of bug is now eliminated (it structurally
// can't be, by a keyword-matching system), every occurrence going forward is
// logged with the exact message that triggered it — turning a silent,
// unrecorded gap into a concrete, greppable diagnostic entry the next
// missing trigger can actually be fixed from.
const capabilityDenialPattern=/\b(i can'?t (?:do|help with|access|control|open|run|perform|assist with)|i'?m not able to|i am not able to|i don'?t have (?:the ability|access|the capability|a way)|that'?s not something i can|not (?:something )?i(?:'?m| am) able to|i have no way to|i'?m unable to|i am unable to|outside (?:of )?what i can do|not (?:currently )?(?:supported|available) (?:in|from|through) this|i can'?t (?:do that|help with that) (?:here|in this chat|in this conversation))\b/i;
let tray: Tray | null = null;
let isQuitting = false;
const backgroundLaunch = process.argv.includes('--background');
let explicitShowRequested = !backgroundLaunch;
const pendingCameraCaptures=new Map<string,{resolve:(capture:ScreenCapture)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout}>();
let rendererRecoveryUsed=false;
const providerHealth=new Map<AIProvider,Omit<ProviderHealth,'provider'>>();
let operationalProbeAt=0;
let operationalProbePromise:Promise<void>|null=null;

function emitBackgroundEvent(event:BackgroundEvent):void{mainWindow?.webContents.send('background:event',event);}
function showBackgroundNotification(title:string,text:string):void{try{if(Notification.isSupported())new Notification({title,body:text.slice(0,500),silent:false}).show();}catch(reason){writeDiagnostic('background-notification-failed',{message:reason instanceof Error?reason.message:String(reason)});}}
function requestCameraCapture(reason:string):Promise<ScreenCapture>{
  if(!mainWindow||mainWindow.isDestroyed())return Promise.reject(new Error('Axiom must be open to capture a camera frame.'));
  const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingCameraCaptures.delete(id);reject(new Error('Camera frame request timed out. Keep Presence Link enabled and the camera available.'));},12_000);pendingCameraCaptures.set(id,{resolve,reject,timer});mainWindow!.webContents.send('background:camera-request',{id,reason});});
}

const backgroundRuntime=new BackgroundRuntime(store,{run:(input)=>adaptiveAssistantCore(input),captureScreen:capturePrimaryScreen,captureCamera:requestCameraCapture,emit:emitBackgroundEvent,notify:showBackgroundNotification,pollMedia:()=>mediaService.pollPending()});

async function capturePrimaryScreen(): Promise<ScreenCapture> {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1600 / display.size.width, 900 / display.size.height);
  const width = Math.max(640, Math.round(display.size.width * scale));
  const height = Math.max(360, Math.round(display.size.height * scale));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('The primary display could not be captured.');
  return { dataUrl: source.thumbnail.toDataURL(), width: source.thumbnail.getSize().width, height: source.thumbnail.getSize().height, capturedAt: new Date().toISOString() };
}

function platformPermissions():PlatformPermissionStatus[]{
  if(process.platform!=='darwin')return[
    {id:'microphone',label:'Microphone',state:'not-required',required:false,detail:'Managed by Windows privacy settings and checked when voice starts.'},
    {id:'camera',label:'Camera',state:'not-required',required:false,detail:'Managed by Windows privacy settings and checked by Presence Link.'},
    {id:'screen',label:'Screen recording',state:'not-required',required:false,detail:'No separate Axiom permission is required on Windows.'},
    {id:'accessibility',label:'Computer control',state:'not-required',required:false,detail:'Windows UI Automation is available through the control engine.'},
  ];
  const media=(id:'microphone'|'camera'|'screen',label:string):PlatformPermissionStatus=>{const raw=systemPreferences.getMediaAccessStatus(id);return{id,label,state:raw,required:true,detail:raw==='granted'?`${label} access is ready.`:`Allow ${label.toLowerCase()} access in System Settings > Privacy & Security.`};};
  const accessibility=systemPreferences.isTrustedAccessibilityClient(false);
  return[media('microphone','Microphone'),media('camera','Camera'),media('screen','Screen recording'),{id:'accessibility',label:'Accessibility control',state:accessibility?'granted':'denied',required:true,detail:accessibility?'Mac application control is ready.':'Allow Axiom under System Settings > Privacy & Security > Accessibility.'}];
}

async function openPlatformPermission(id:PlatformPermissionStatus['id']):Promise<void>{
  const urls:Record<PlatformPermissionStatus['id'],string>=process.platform==='darwin'?{
    microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',camera:'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',screen:'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  }:{microphone:'ms-settings:privacy-microphone',camera:'ms-settings:privacy-webcam',screen:'ms-settings:privacy-screenshots',accessibility:'ms-settings:easeofaccess'};
  await shell.openExternal(urls[id]);
}

protocol.registerSchemesAsPrivileged([{ scheme: 'axiom', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if(process.env.AXIOM_QA==='1')app.disableHardwareAcceleration();
crashReporter.start({productName:'Axiom',uploadToServer:false,compress:true,globalExtra:{releaseChannel:'local-production-candidate'}});

// Expose Axiom's own semantic controls to Windows UI Automation and assistive
// technologies. This also makes the installed application testable through the
// same accessibility path Axiom uses when it controls supported desktop apps.
app.commandLine.appendSwitch('force-renderer-accessibility');

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

function showMainWindow(): void {
  explicitShowRequested = true;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow?.show();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
}

function configureLoginLaunch(): void {
  if (!['win32', 'darwin'].includes(process.platform) || process.env.AXIOM_QA === '1') return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--background'] });
  } catch (reason) {
    writeDiagnostic('login-launch-configuration-failed', { message: reason instanceof Error ? reason.message : String(reason) });
  }
}

function ensureTray(): void {
  if (tray) return;
  const iconPath = path.join(app.getAppPath(), 'build', 'axiom-icon.png');
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) {
    writeDiagnostic('tray-icon-unavailable', { iconPath });
    return;
  }
  tray = new Tray(source.resize({ width: 20, height: 20 }));
  tray.setToolTip('Axiom');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Axiom', click: showMainWindow },
    { label: 'Axiom keeps running while this window is hidden', enabled: false },
    { type: 'separator' },
    { label: 'Quit Axiom', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}


function registerAppProtocol(): void {
  const rendererRoot = path.resolve(__dirname, '../../dist-renderer');
  protocol.handle('axiom', (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname || '/index.html');
    const candidate = path.resolve(rendererRoot, `.${pathname}`);
    if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#03070c',
    title: 'Axiom',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('axiom://app/') || url.startsWith('file:') || Boolean(process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL));
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone',(_event,details)=>{writeDiagnostic('renderer-process-gone',details);if(!rendererRecoveryUsed&&mainWindow){rendererRecoveryUsed=true;setTimeout(()=>mainWindow?.reload(),700);}});
  mainWindow.once('ready-to-show', () => { if (explicitShowRequested) mainWindow?.show(); });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
    showBackgroundNotification('AXIOM REMAINS ACTIVE', 'Approved background work is continuing. Use the tray icon to reopen Axiom or quit it.');
  });
  mainWindow.on('closed', () => { mainWindow = null; godsEyeView = null; store.setGodsEyeViewManager(undefined); });

  godsEyeView = new GodsEyeViewManager(mainWindow);
  store.setGodsEyeViewManager(godsEyeView);

  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadURL('axiom://app/index.html');
}

function writeDiagnostic(kind:string,detail:unknown):void{try{const directory=path.join(app.getPath('userData'),'diagnostics'),file=path.join(directory,'axiom-runtime.log');fs.mkdirSync(directory,{recursive:true});if(fs.existsSync(file)&&fs.statSync(file).size>5*1024*1024){const previous=path.join(directory,'axiom-runtime.previous.log');if(fs.existsSync(previous))fs.rmSync(previous);fs.renameSync(file,previous);}fs.appendFileSync(file,`${new Date().toISOString()} ${kind} ${JSON.stringify(detail)}\n`,'utf8');}catch{/* diagnostics must never crash Axiom */}}

function message(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString() };
}

async function providerCheck(provider:AIProvider|'elevenlabs'):Promise<{ok:boolean;message:string}>{
  const key=provider==='elevenlabs'?store.elevenLabsKey():store.aiKey(provider);
  if(!key){const label=provider==='gemini'?'Gemini':provider==='elevenlabs'?'ElevenLabs':provider[0].toUpperCase()+provider.slice(1);const unreadable=store.unreadableCredentials().some((item)=>item.startsWith(label));
    return{ok:false,message:unreadable?`The ${label} key is saved but cannot be decrypted on this device. Re-enter it, or restore a portable backup.`:`No ${label} API key is saved.`};}
  const signal=AbortSignal.timeout(8_000);
  const request=provider==='openai'?fetch('https://api.openai.com/v1/models',{headers:{authorization:`Bearer ${key}`},signal})
    :provider==='anthropic'?fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},signal})
    :provider==='gemini'?fetch('https://generativelanguage.googleapis.com/v1beta/models',{headers:{'x-goog-api-key':key},signal})
    :fetch('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':key},signal});
  const started=Date.now();const response=await request;if(!response.ok){let detail='';try{const data=await response.json() as {error?:{message?:string};detail?:{message?:string}};detail=data.error?.message||data.detail?.message||'';}catch{}if(provider!=='elevenlabs')providerHealth.set(provider,{state:'degraded',latencyMs:Date.now()-started,lastChecked:new Date().toISOString(),message:detail||`HTTP ${response.status}`});throw new Error(detail||`${provider} connection failed (${response.status}).`);}
  const message=`${provider==='openai'?'OpenAI':provider==='gemini'?'Gemini':provider==='elevenlabs'?'ElevenLabs':'Anthropic'} connection verified.`;if(provider!=='elevenlabs')providerHealth.set(provider,{state:'healthy',latencyMs:Date.now()-started,lastChecked:new Date().toISOString(),message});return{ok:true,message};
}

function healthSnapshot():ProviderHealth[]{return(['openai','anthropic','gemini'] as AIProvider[]).map((provider)=>{if(!store.aiKey(provider))return{provider,state:'unconfigured',message:'No encrypted key saved.'};return{provider,...(providerHealth.get(provider)??{state:'ready' as const,message:'Credential ready; awaiting health check.'})};});}

// fly/zoom/pan/navigate added for God's Eye View: those verbs drive a real
// side-effecting action (a page reload against the embedded globe) but
// weren't covered by any existing word here, so a request built entirely
// from them (e.g. "zoom in on Tokyo") sailed through with cross-provider
// failover fully enabled — a real risk of the tool firing once against the
// first provider and then firing again against a retry that has no memory
// of it. Not adding "find"/"track"/"show me" here — too common in ordinary,
// genuinely non-mutating conversation to be worth losing failover
// resilience over.
function mayMutate(messageText:string):boolean{return/\b(create|write|delete|remove|rename|move|copy|open|launch|click|press|type|fill|paste|close|quit|execute|run|powershell|install|publish|send|purchase|control|turn|dim|lock|unlock|arm|disarm|fly|zoom|pan|navigate)\b/i.test(messageText);}
function currentPermissions(){return permissions().map((permission)=>({...permission,enabled:store.permissionEnabled(permission.id,permission.enabled)}));}

async function refreshOperationalProbes(force=false):Promise<void>{
  if(!force&&Date.now()-operationalProbeAt<60_000)return;
  if(operationalProbePromise)return operationalProbePromise;
  operationalProbePromise=(async()=>{
    const checkedAt=new Date().toISOString(),settings=store.publicSettings(),platform=platformProfile(),permissionList=currentPermissions(),osPermissions=platformPermissions(),sync=syncManager.status();
    const probes:OperationalProbe[]=[];
    const activeProvider=settings.provider;
    let aiState:OperationalProbe['state']=settings.hasSelectedAIKey?'ready':'blocked',aiDetail=settings.hasSelectedAIKey?`${activeProvider.toUpperCase()} credential is encrypted and available.`:'No active AI provider credential is configured.',aiLatency:number|undefined;
    if(settings.hasSelectedAIKey){
      try{const started=Date.now(),result=await providerCheck(activeProvider);aiLatency=Date.now()-started;aiState=result.ok?'ready':'degraded';aiDetail=result.message;}
      catch(reason){aiState='degraded';aiDetail=reason instanceof Error?reason.message:String(reason);}
    }
    probes.push({id:'ai-router',label:'AI ROUTER',domain:'intelligence',state:aiState,detail:aiDetail,checkedAt,latencyMs:aiLatency,recovery:'Choose a configured provider or allow Automatic Safe Failover in Settings.'});
    const webEnabled=permissionList.find((item)=>item.id==='web-search')?.enabled!==false;
    probes.push({id:'live-web',label:'LIVE WEB SEARCH',domain:'intelligence',state:settings.hasSelectedAIKey&&webEnabled?'ready':webEnabled?'blocked':'degraded',detail:settings.hasSelectedAIKey&&webEnabled?`${settings.researchProvider.toUpperCase()} research route is armed with mandatory live grounding.`:webEnabled?'A model credential is required for live search.':'Web search is disabled by the capability policy.',checkedAt,recovery:'Configure the research provider and enable Web Search under Tools.'});
    const speechReady=settings.speechProvider==='system'||settings.speechProvider==='openai'&&settings.hasOpenAIKey||settings.speechProvider==='elevenlabs'&&settings.hasElevenLabsKey;
    let speechDetail=`${settings.speechProvider.toUpperCase()} output selected.`;
    if(settings.speechProvider==='elevenlabs'&&settings.hasElevenLabsKey){try{const started=Date.now(),result=await providerCheck('elevenlabs');speechDetail=`${result.message} · ${Date.now()-started} ms`; }catch(reason){speechDetail=reason instanceof Error?reason.message:String(reason);}}
    probes.push({id:'speech-output',label:'SPEECH OUTPUT',domain:'voice',state:speechReady?'ready':'blocked',detail:speechReady?speechDetail:`${settings.speechProvider.toUpperCase()} is selected but its credential is missing.`,checkedAt,recovery:'Select the system voice or configure the selected cloud voice provider.'});
    const roots=[app.getPath('desktop'),app.getPath('documents'),app.getPath('downloads')];
    let rootsReady=true;try{await Promise.all(roots.map((root)=>fs.promises.access(root,fs.constants.R_OK|fs.constants.W_OK)));}catch{rootsReady=false;}
    probes.push({id:'file-boundaries',label:'BOUNDED FILE SYSTEM',domain:'control',state:rootsReady?'ready':'degraded',detail:rootsReady?'Desktop, Documents, and Downloads passed read/write access checks.':'One or more approved user folders failed an access check.',checkedAt,recovery:'Restore folder permission or choose a coding workspace inside an accessible approved folder.'});
    const automation=await desktopInfrastructureStatus(),accessibility=osPermissions.find((item)=>item.id==='accessibility'),controlPolicy=permissionList.some((item)=>['desktop-control','window-control','apps-open'].includes(item.id)&&item.enabled),controlReady=automation.ready&&controlPolicy&&(!accessibility?.required||accessibility.state==='granted');
    probes.push({id:'desktop-control',label:`${platform.automationLabel.toUpperCase()} CONTROL`,domain:'control',state:controlReady?'ready':automation.ready?'degraded':'blocked',detail:controlReady?automation.detail:!controlPolicy?'Desktop-control authority is disabled by the user.':accessibility?.required&&accessibility.state!=='granted'?accessibility.detail:automation.detail,checkedAt,recovery:!controlPolicy?'Enable the required control capabilities under Tools.':automation.recovery});
    try{const started=Date.now(),telemetry=await getSystemTelemetrySnapshot();probes.push({id:'hardware-sensors',label:'HARDWARE SENSOR FABRIC',domain:'hardware',state:'ready',detail:`CPU ${Math.round(telemetry.cpuPercent)}% · memory ${Math.round(telemetry.memoryPercent)}% · ${telemetry.gpus.length} GPU path(s).`,checkedAt,latencyMs:Date.now()-started,recovery:'No recovery required.'});}
    catch(reason){probes.push({id:'hardware-sensors',label:'HARDWARE SENSOR FABRIC',domain:'hardware',state:'degraded',detail:reason instanceof Error?reason.message:String(reason),checkedAt,recovery:'Axiom will continue with native CPU/memory counters and retry extended sensors.'});}
    const modelRoot=path.join(app.getAppPath(),'dist-renderer','models'),speakerModel=path.join(modelRoot,'wavlm-base-plus-sv','onnx','model_quantized.onnx'),faceModel=path.join(modelRoot,'face_landmarker.task'),memoryModel=path.join(modelRoot,'all-MiniLM-L6-v2','onnx','model_quantized.onnx');
    const modelsReady=fs.existsSync(speakerModel)&&fs.existsSync(faceModel)&&fs.existsSync(memoryModel);
    probes.push({id:'local-models',label:'LOCAL PERCEPTION MODELS',domain:'vision',state:modelsReady?'ready':'blocked',detail:modelsReady?'WavLM speaker identity, MediaPipe face tracking, and MiniLM memory embedding assets are installed.':'One or more bundled perception models are missing.',checkedAt,recovery:'Repair or reinstall Axiom to restore the signed local model bundle.'});
    probes.push({id:'secure-vault',label:`${platform.secureStorageLabel.toUpperCase()} VAULT`,domain:'security',state:settings.encryptionAvailable?'ready':'blocked',detail:settings.encryptionAvailable?'Credentials and local identity secrets are protected by the operating system.':'Operating-system secure storage is unavailable.',checkedAt,recovery:'Unlock the current user session and restore operating-system credential storage.'});
    probes.push({id:'runtime-journal',label:'DURABLE RUNTIME + EVIDENCE',domain:'memory',state:'ready',detail:`${store.runtimeTasks().length} task records · ${store.evidence().length} verified evidence records.`,checkedAt,recovery:'Interrupted tasks can be reviewed and resumed from CORE.'});
    probes.push({id:'recovery-loop',label:'BOUNDED RECOVERY LOOP',domain:'security',state:settings.autoFailover?'ready':'degraded',detail:settings.autoFailover?'Provider failover and read-only tool recovery are armed; mutating requests are never replayed.':'Automatic provider failover is disabled by the user.',checkedAt,recovery:'Enable Automatic Safe Failover in Settings if desired.'});
    probes.push({id:'continuity',label:'CROSS-DEVICE CONTINUITY',domain:'continuity',state:sync.state==='error'?'degraded':sync.state==='setup'?'degraded':'ready',detail:sync.state==='ready'?`${sync.peers.length} peer device(s) linked · active voice ${sync.voiceOwnedHere?'local':sync.voiceOwner?.name||'peer'}.`:sync.state==='off'?'Local-only mode is intentionally active.':sync.lastError||'Sync setup is incomplete.',checkedAt:sync.lastSyncAt||checkedAt,recovery:'Choose the same shared folder and passphrase on both computers, then run Sync Now.'});
    reliability.setBaseProbes(probes);operationalProbeAt=Date.now();
  })().finally(()=>{operationalProbePromise=null;});
  return operationalProbePromise;
}

async function operationalSnapshot(force=false):Promise<OperationalSnapshot>{
  await refreshOperationalProbes(force);
  const sync=syncManager.status();
  return reliability.snapshot({platform:platformProfile().id,localDevice:sync.device,activeDevice:sync.voiceOwner||sync.device});
}

function capabilityHealth():CapabilityHealthItem[]{const now=new Date().toISOString(),settings=store.publicSettings(),platform=platformProfile(),sync=syncManager.status(),neuralProfiles=settings.speakerProfiles.filter((item)=>item.model==='wavlm-base-plus-sv'),mouth=settings.mouthCalibration;const providerItems=healthSnapshot().map((item):CapabilityHealthItem=>({id:`model-${item.provider}`,label:`${item.provider.toUpperCase()} MODEL`,kind:'model',state:item.state,detail:item.message,checkedAt:item.lastChecked??now}));const toolItems=currentPermissions().map((item):CapabilityHealthItem=>({id:`tool-${item.id}`,label:item.label.toUpperCase(),kind:'tool',state:item.enabled?'ready':'disabled',detail:`${item.risk.toUpperCase()} authority · ${item.enabled?'policy enabled':'blocked by user'}`,checkedAt:now}));return[{id:'runtime-journal',label:'DURABLE RUNTIME JOURNAL',kind:'runtime',state:'healthy',detail:'Tasks survive restarts and interrupted work is explicitly recoverable.',checkedAt:now},{id:'speaker-neural',label:'LOCAL NEURAL SPEAKER ID',kind:'sensor',state:settings.speakerLockEnabled?(neuralProfiles.length?'healthy':'ready'):'disabled',detail:neuralProfiles.length?`${neuralProfiles.length} WavLM identity profile(s) enrolled locally.`:'WavLM is bundled locally; enroll your voice to lock listening to you.',checkedAt:now},{id:'microphone-adaptive',label:'ADAPTIVE MICROPHONE GATE',kind:'sensor',state:settings.microphoneCalibratedAt?'healthy':'ready',detail:settings.microphoneCalibratedAt?`Calibrated noise ${settings.microphoneNoiseFloor.toFixed(4)} · speech ${settings.microphoneSpeechThreshold.toFixed(4)}.`:'Select a microphone and run ambient-noise calibration.',checkedAt:settings.microphoneCalibratedAt||now},{id:'mouth-alignment',label:'VOICE-SPECIFIC ARTICULATION',kind:'sensor',state:mouth.calibratedAt?'healthy':'ready',detail:mouth.calibratedAt?`${settings.elevenLabsVoiceName}: ${mouth.offsetMs>=0?'+':''}${mouth.offsetMs} ms · ${mouth.gain.toFixed(2)}×.`:'Run mouth calibration for the selected ElevenLabs voice.',checkedAt:mouth.calibratedAt||now},{id:'permission-kernel',label:'ONE-TIME PERMISSION KERNEL',kind:'security',state:'healthy',detail:'Destructive and external actions require an exact expiring approval.',checkedAt:now},{id:'security-vault',label:`${platform.secureStorageLabel.toUpperCase()} VAULT`,kind:'security',state:settings.encryptionAvailable?'healthy':'degraded',detail:settings.encryptionAvailable?`Credentials protected by ${platform.secureStorageLabel}.`:`${platform.secureStorageLabel} unavailable.`,checkedAt:now},{id:'identity-sync',label:'CROSS-DEVICE PRESENCE LEASE',kind:'runtime',state:sync.state==='ready'?'healthy':sync.state==='error'?'degraded':sync.state==='off'?'disabled':'unconfigured',detail:sync.state==='ready'?`${sync.peers.length} peer device(s) linked · voice ${sync.voiceOwnedHere?'owned here':`leased to ${sync.voiceOwner?.name||'peer'}`}.`:sync.lastError||'Configure an encrypted shared folder to continue across devices.',checkedAt:sync.lastSyncAt||now},{id:'sensor-screen',label:'EXPLICIT SCREEN VISION',kind:'sensor',state:currentPermissions().find((item)=>item.id==='screen-capture')?.enabled?'ready':'disabled',detail:'Capture occurs only after a user request.',checkedAt:now},...providerItems,...toolItems];}
function runtimeSnapshot():RuntimeSnapshot{const tasks=store.runtimeTasks(),commitments=store.commitments(),evidence=store.evidence(),approvals=store.approvals(),capabilities=capabilityHealth();return{generatedAt:new Date().toISOString(),tasks,commitments,evidence,approvals,capabilities,horizon:capabilityHorizon,metrics:{activeTasks:tasks.filter((item)=>['queued','active','waiting','blocked'].includes(item.status)).length,openCommitments:commitments.filter((item)=>item.status==='open').length,verifiedActions:evidence.length,healthyCapabilities:capabilities.filter((item)=>item.state==='healthy'||item.state==='ready').length,pendingApprovals:approvals.filter((item)=>item.status==='pending').length}};}

async function decideApproval(idOrCode:string,decision:'approved'|'denied'):Promise<ApprovalDecisionResult>{
  const pending=store.approvalPayload(idOrCode);if(!pending)throw new Error('That approval is unavailable or has expired.');
  if(decision==='denied'){store.denyApproval(pending.id);if(pending.sourceTaskId)store.settleRuntimeTask(pending.sourceTaskId,'cancelled','The user denied the requested action.');return{runtime:runtimeSnapshot(),message:`${pending.code} denied. No action was taken.`};}
  const result=await executeTool(pending.toolName,pending.args,store,`APPROVE ${pending.code}. ${pending.preview}`);store.finishApproval(pending.id,result.event.status==='verified'?'executed':'failed',result.event.summary);store.appendAudit([result.event],pending.sourceTaskId);if(pending.sourceTaskId)store.settleRuntimeTask(pending.sourceTaskId,result.event.status==='verified'?'completed':'failed',result.event.summary);const message=result.event.status==='verified'?`${pending.code} executed and verified: ${result.event.summary}`:`${pending.code} failed without being reported as complete: ${result.event.summary}`;return{runtime:runtimeSnapshot(),event:result.event,message};
}

// The optional static approval phrase (store.setActionApprovalPhrase) can't
// tell two simultaneously-pending actions apart the way a fresh per-action
// AX-XXXXXX code can — the user was told exactly that trade-off before
// opting in. Ambiguous is refused outright rather than guessing which one
// was meant; a genuine mismatch just reports unmatched, never anything
// about what a real code would have been.
async function decideApprovalByPhrase(phrase:string):Promise<ApprovalDecisionResult&{matched:boolean}>{
  if(!store.verifyActionApprovalPhrase(phrase))return{matched:false,runtime:runtimeSnapshot(),message:''};
  const pending=store.approvals().filter((item)=>item.status==='pending');
  if(!pending.length)return{matched:true,runtime:runtimeSnapshot(),message:'Your approval phrase matched, but nothing is currently awaiting approval.'};
  if(pending.length>1)return{matched:true,runtime:runtimeSnapshot(),message:`Your approval phrase matched, but ${pending.length} actions are currently awaiting approval — say the exact code (e.g. APPROVE ${pending[0].code}) or open CORE to choose the right one.`};
  const decision=await decideApproval(pending[0].id,'approved');
  return{matched:true,...decision};
}

async function adaptiveAssistantCore(input:AssistantRequest,onDelta?:(delta:string)=>void){
  const settings=store.publicSettings();const directAction=input.untrustedPresence?undefined:deterministicActionRoute(input.message);
  if(directAction){const result=await executeTool(directAction.name,directAction.args,store,input.message),text=normalizeActionReply(directAction.successText,[result.event],true);onDelta?.(text);return{text,provider:settings.provider,model:settings.model,toolEvents:[result.event]};}
  const coding=/\b(code|coding|project|source|implement|refactor|bug|test suite|typecheck|lint|checkpoint|build)\b/i.test(input.message),research=/\b(news|headline|current|latest|today|weather|forecast|search|look up|online|web)\b/i.test(input.message);const preferred=coding?settings.codingProvider:research?settings.researchProvider:settings.provider;const configured=store.providerOrder(preferred).filter((provider)=>Boolean(store.aiKey(provider))),recentlyDegraded=(provider:AIProvider)=>{const health=providerHealth.get(provider);return health?.state==='degraded'&&Boolean(health.lastChecked)&&Date.now()-Date.parse(health.lastChecked!)<5*60_000;};const candidates=[...configured].sort((left,right)=>Number(recentlyDegraded(left))-Number(recentlyDegraded(right)));if(!candidates.length){const unreadable=store.unreadableCredentials();throw new Error(unreadable.length?`A provider key is saved but cannot be decrypted on this device (${unreadable.join(', ')}). Re-enter it in Settings, or restore a portable backup.`:'Add an AI provider key in Settings.');}
  const allowed=settings.autoFailover&&!mayMutate(input.message)?candidates:candidates.slice(0,1);const failures:string[]=[];
  for(const provider of allowed){const started=Date.now();let streamed=false;try{const reply=await runAssistant(store.aiKey(provider),provider,store.modelFor(provider),input,store,(delta)=>{streamed=true;onDelta?.(delta);});providerHealth.set(provider,{state:'healthy',latencyMs:Date.now()-started,lastChecked:new Date().toISOString(),message:'Last assistant request succeeded.'});if(provider!==settings.provider){const failover:ToolEvent={name:'adaptive_failover',status:'verified',summary:`Recovered automatically with ${provider.toUpperCase()}.`,at:new Date().toISOString()};reply.toolEvents.unshift(failover);}return reply;}catch(reason){const detail=reason instanceof Error?reason.message:String(reason);providerHealth.set(provider,{state:'degraded',latencyMs:Date.now()-started,lastChecked:new Date().toISOString(),message:detail.slice(0,180)});failures.push(`${provider}: ${detail}`);if(streamed)break;}}
  throw new Error(`AI providers unavailable. ${failures.join(' | ')}`);
}
async function adaptiveAssistant(event:Electron.IpcMainInvokeEvent,input:AssistantRequest){return adaptiveAssistantCore(input,(delta)=>event.sender.send('assistant:delta',delta));}

async function elevenLabsVoices():Promise<ElevenLabsVoice[]>{
  const key=store.elevenLabsKey();if(!key)throw new Error('Save an ElevenLabs API key first.');
  const response=await fetch('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':key},signal:AbortSignal.timeout(15_000)});const data=await response.json() as {voices?:Array<{voice_id?:string;name?:string;category?:string;description?:string;preview_url?:string}>;detail?:{message?:string}};
  if(!response.ok)throw new Error(data.detail?.message||`ElevenLabs voice list failed (${response.status}).`);
  return(data.voices??[]).filter((voice)=>voice.voice_id&&voice.name).map((voice)=>({voiceId:voice.voice_id!,name:voice.name!,category:voice.category||'custom',description:voice.description||'',previewUrl:voice.preview_url})).sort((a,b)=>a.name.localeCompare(b.name));
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:save', (_event, input: SaveSettingsRequest) => {const result=store.saveSettings(input);operationalProbeAt=0;return result;});
  ipcMain.handle('settings:test-provider', (_event, provider:AIProvider|'elevenlabs') => providerCheck(provider));
  ipcMain.handle('settings:provider-health', () => healthSnapshot());
  ipcMain.handle('operations:snapshot',(_event,force?:boolean)=>operationalSnapshot(Boolean(force)));
  ipcMain.handle('operations:renderer',(_event,report:RendererCapabilityReport)=>{reliability.reportRenderer(report);return operationalSnapshot(false);});
  ipcMain.handle('operations:latency',(_event,report:ConversationLatencyReport)=>{reliability.reportLatency(report);return operationalSnapshot(false);});
  ipcMain.handle('connectors:list',()=>connectors.statuses());
  ipcMain.handle('connectors:save',(_event,input:import('../shared/contracts').ConnectorSetup)=>store.saveConnector(input));
  ipcMain.handle('connectors:connect',(_event,id:import('../shared/contracts').ConnectorId)=>connectors.connect(id));
  ipcMain.handle('connectors:disconnect',(_event,id:import('../shared/contracts').ConnectorId)=>connectors.disconnect(id));
  ipcMain.handle('connectors:test',(_event,id:import('../shared/contracts').ConnectorId)=>connectors.test(id));
  ipcMain.handle('homebridge:snapshot',()=>connectors.homebridgeSnapshot());
  ipcMain.handle('homebridge:control',(_event,input:import('../shared/contracts').HomebridgeControlRequest)=>{
    if(['LockTargetState','SecuritySystemTargetState','TargetDoorState'].includes(String(input.characteristic||'')))throw new Error('Security devices must be controlled through Axiom conversation so the approval kernel can show the exact action.');
    return connectors.homebridgeControl(input);
  });
  ipcMain.handle('ring:connect',async(_event,email:string,password:string,twoFactorCode?:string)=>{
    try{const result=await connectors.ringConnect(email,password,twoFactorCode);writeDiagnostic('ring-connect',{result:'twoFactorRequired' in result?'two-factor-required':'connected'});return result;}
    catch(reason){writeDiagnostic('ring-connect-failed',{message:reason instanceof Error?reason.message:String(reason)});throw reason;}
  });
  ipcMain.handle('ring:cameras',async()=>{
    const result=await connectors.ringCameraList();
    if(result.error)writeDiagnostic('ring-cameras-failed',{message:result.error});
    else writeDiagnostic('ring-cameras',{count:result.cameras.length,names:result.cameras.map((item)=>item.name)});
    return result;
  });
  ipcMain.handle('ring:liveview-open',async(_event,cameraId:number,offerSdp:string)=>{
    const started=Date.now();
    try{const liveSessionId=await ringSessions.open(cameraId,offerSdp);writeDiagnostic('ring-liveview-open',{cameraId,latencyMs:Date.now()-started,liveSessionId});return{liveSessionId};}
    catch(reason){writeDiagnostic('ring-liveview-open-failed',{cameraId,latencyMs:Date.now()-started,message:reason instanceof Error?reason.message:String(reason)});throw reason;}
  });
  ipcMain.handle('ring:liveview-ice',(_event,liveSessionId:string,candidate:string,sdpMLineIndex:number)=>{ringSessions.sendIce(liveSessionId,candidate,sdpMLineIndex);});
  ipcMain.handle('ring:liveview-close',(_event,liveSessionId:string)=>{writeDiagnostic('ring-liveview-close',{liveSessionId});ringSessions.close(liveSessionId);});
  ipcMain.handle('media:list',()=>store.mediaArtifacts());
  ipcMain.handle('cursor-guide:show',(_event,x:number,y:number,label:string,durationMs?:number)=>showCursorGuide(Number(x),Number(y),String(label||'LOOK HERE'),Number(durationMs)||5000));
  ipcMain.handle('gods-eye:open',async()=>{if(!godsEyeView)throw new Error('Axiom window is not ready.');return godsEyeView.open(store.godsEyeViewPath());});
  ipcMain.handle('gods-eye:set-bounds',(_event,bounds:{x:number;y:number;width:number;height:number})=>{godsEyeView?.setBounds(bounds);});
  ipcMain.handle('gods-eye:close',()=>{godsEyeView?.close();});
  ipcMain.handle('voice-profile:save',(_event,name:string)=>store.saveVoiceProfile(name));
  ipcMain.handle('voice-profile:activate',(_event,id:string)=>store.activateVoiceProfile(id));
  ipcMain.handle('voice-profile:delete',(_event,id:string)=>store.deleteVoiceProfile(id));
  ipcMain.handle('people:list',()=>store.knownPeople());
  ipcMain.handle('people:save',(_event,name:string,descriptor:number[])=>store.saveKnownPerson(name,descriptor));
  ipcMain.handle('people:seen',(_event,id:string)=>store.markKnownPersonSeen(id));
  ipcMain.handle('people:forget',(_event,id:string)=>{if(!store.forgetKnownPerson(id))throw new Error('Known person not found.');return store.knownPeople();});
  ipcMain.handle('speaker:enroll',(_event,name:string,vector:number[])=>store.enrollSpeaker(name,vector));
  ipcMain.handle('speaker:match',(_event,vector:number[],visiblePersonName?:string)=>store.matchSpeaker(vector,visiblePersonName));
  ipcMain.handle('speaker:forget',(_event,id:string)=>store.forgetSpeaker(id));
  ipcMain.handle('platform-permissions:get',()=>platformPermissions());
  ipcMain.handle('platform-permissions:open',(_event,id:PlatformPermissionStatus['id'])=>openPlatformPermission(id));
  ipcMain.handle('elevenlabs:voices', () => elevenLabsVoices());
  ipcMain.handle('history:load', () => store.history());
  ipcMain.handle('history:clear', () => store.clearHistory());
  ipcMain.handle('permissions:list', () => currentPermissions());
  ipcMain.handle('permissions:set', (_event,id:string,enabled:boolean) => {const known=permissions().some((permission)=>permission.id===id);if(!known)throw new Error('Unknown capability.');store.setPermission(id,Boolean(enabled));operationalProbeAt=0;return currentPermissions();});
  ipcMain.handle('audit:list',()=>store.audit());
  ipcMain.handle('audit:clear',()=>store.clearAudit());
  ipcMain.handle('screen:capture', () => capturePrimaryScreen());
  ipcMain.handle('desktop-graph:get',()=>store.desktopGraph());
  ipcMain.handle('desktop-graph:refresh',async()=>{const result=await executeTool('list_running_windows',{},store,'Refresh the desktop object graph');store.appendAudit([result.event]);return{graph:store.desktopGraph(),event:result.event};});
  ipcMain.handle('updates:check',async()=>{
    const settings=store.publicSettings();
    if(!settings.updateFeedUrl)return{ok:false,currentVersion:app.getVersion(),updateAvailable:false,mustUpdate:false,error:'No update feed URL is configured.'};
    try{
      const platform=process.platform==='darwin'?'mac':'win';
      const result=await checkForUpdate(settings.updateFeedUrl,app.getVersion(),platform);
      store.recordUpdateCheck(result.manifest.latestVersion);
      store.appendAudit([{name:'update_check',status:'verified',summary:result.updateAvailable?`Update ${result.manifest.latestVersion} is available (running ${app.getVersion()}).`:`Running the latest version (${app.getVersion()}).`,at:new Date().toISOString()}]);
      return{ok:true,currentVersion:app.getVersion(),updateAvailable:result.updateAvailable,mustUpdate:result.mustUpdate,latestVersion:result.manifest.latestVersion,notes:result.manifest.notes};
    }catch(reason){const message=reason instanceof Error?reason.message:String(reason);store.appendAudit([{name:'update_check_failed',status:'failed',summary:message,at:new Date().toISOString()}]);return{ok:false,currentVersion:app.getVersion(),updateAvailable:false,mustUpdate:false,error:message};}
  });
  ipcMain.handle('updates:download',async()=>{
    const settings=store.publicSettings();
    if(!settings.updateFeedUrl)return{ok:false,error:'No update feed URL is configured.'};
    try{
      const platform=process.platform==='darwin'?'mac':'win';
      const result=await checkForUpdate(settings.updateFeedUrl,app.getVersion(),platform);
      if(!result.artifact)return{ok:false,error:`No ${platform} artifact is published in this update feed.`};
      const target=await downloadVerifiedUpdate(result.artifact,path.join(app.getPath('temp'),'axiom-updates'));
      store.appendAudit([{name:'update_downloaded',status:'verified',summary:`Downloaded and verified update ${result.manifest.latestVersion} (sha256 matched) to ${target}.`,at:new Date().toISOString()}]);
      return{ok:true,path:target};
    }catch(reason){const message=reason instanceof Error?reason.message:String(reason);store.appendAudit([{name:'update_download_failed',status:'failed',summary:message,at:new Date().toISOString()}]);return{ok:false,error:message};}
  });
  ipcMain.handle('updates:open-installer',async(_event,filePath:string)=>{
    // Never executed silently: unsigned builds require the OS's own install
    // flow (Control-click → Open on macOS, SmartScreen "Run anyway" on Windows),
    // and even a signed build should not auto-run without the user seeing it.
    const clean=String(filePath||'');
    if(!clean.startsWith(path.join(app.getPath('temp'),'axiom-updates')))throw new Error('Refusing to open a file outside the verified update download folder.');
    const error=await shell.openPath(clean);
    if(error)throw new Error(error);
    store.appendAudit([{name:'update_installer_opened',status:'verified',summary:`Opened the verified installer at ${clean} for the user to run.`,at:new Date().toISOString()}]);
  });
  ipcMain.handle('data:export',()=>{const result=store.exportAllData();store.appendAudit([{name:'data_export',status:'verified',summary:`Exported a data-portability copy to ${result.path}.`,at:result.createdAt}]);return result;});
  ipcMain.handle('identity:verify-owner-override',(_event,phrase:string)=>{
    const matched=store.verifyOwnerOverridePhrase(String(phrase??''));
    store.appendAudit([{name:'presence_owner_override',status:matched?'verified':'failed',summary:matched?'Owner override phrase accepted; camera/voice biometrics were unavailable for this turn.':'An owner override phrase attempt did not match.',at:new Date().toISOString()}]);
    return matched;
  });
  ipcMain.handle('self-corrections:list',()=>store.selfCorrections());
  ipcMain.handle('self-corrections:record',(_event,pattern:string,mistake:string,fix:string)=>store.recordSelfCorrection(pattern,mistake,fix));
  ipcMain.handle('self-corrections:forget',(_event,id:string)=>store.forgetSelfCorrection(id));
  ipcMain.handle('settings:last-snapshot',()=>store.lastSettingsSnapshot());
  ipcMain.handle('settings:revert',()=>{const result=store.revertLastSettingsChange();store.appendAudit([{name:'settings_reverted',status:'verified',summary:'The most recent settings change was reverted from the saved snapshot.',at:new Date().toISOString()}]);operationalProbeAt=0;return result;});
  ipcMain.handle('data:erase',(_event,confirmation:string)=>{
    const result=store.eraseAllLocalData(String(confirmation||''));
    operationalProbeAt=0;
    // Written into the fresh post-erase profile: a receipt that the erase itself
    // happened, since everything it could have described is now gone.
    store.appendAudit([{name:'data_erased',status:'verified',summary:`All local Axiom data was permanently erased on user request. ${result.filesRemoved} file(s) removed.`,at:new Date().toISOString()}]);
    return result;
  });
  ipcMain.handle('backup:create',()=>store.createBackup());
  ipcMain.handle('backup:choose-file',async()=>{
    if(!mainWindow||mainWindow.isDestroyed())return '';
    const result=await dialog.showOpenDialog(mainWindow,{title:'Restore an Axiom portable backup',properties:['openFile'],filters:[{name:'Axiom portable backup',extensions:['axiombackup']},{name:'All files',extensions:['*']}]});
    return result.canceled?'':result.filePaths[0]??'';
  });
  ipcMain.handle('backup:create-portable',(_event,passphrase:string)=>{const result=store.createPortableBackup(String(passphrase??''));store.appendAudit([{name:'portable_backup_created',status:'verified',summary:`${result.secrets} secret(s) re-encrypted under a passphrase · ${result.path}`,at:result.createdAt}]);return result;});
  ipcMain.handle('backup:restore-portable',(_event,sourcePath:string,passphrase:string)=>{
    const result=store.restorePortableBackup(String(sourcePath??''),String(passphrase??''));
    store.appendAudit([{name:'portable_backup_restored',status:'verified',summary:`${result.restored} secret(s) restored and re-encrypted for this device.`,at:new Date().toISOString()}]);
    operationalProbeAt=0;return result;
  });
  ipcMain.on('background:camera-response',(_event,id:string,capture?:ScreenCapture,error?:string)=>{const pending=pendingCameraCaptures.get(id);if(!pending)return;clearTimeout(pending.timer);pendingCameraCaptures.delete(id);if(error)pending.reject(new Error(error));else if(capture?.dataUrl?.startsWith('data:image/'))pending.resolve(capture);else pending.reject(new Error('The camera returned no usable frame.'));});
  ipcMain.handle('sync:status',()=>syncManager.status());
  ipcMain.handle('sync:now',async()=>{const result=await syncManager.syncNow();operationalProbeAt=0;return result;});
  ipcMain.handle('device:activity',()=>syncManager.noteActivity());
  // A render-time exception used to leave zero trace — the ErrorBoundary
  // catches it in the renderer, but without this it would still vanish the
  // moment the user closes/reloads. Same runtime log every other failure
  // (Ring, voice, sync, assistant:send) already writes to.
  ipcMain.handle('renderer:crash',(_event,message:string,stack?:string,componentStack?:string)=>{writeDiagnostic('renderer-crash',{message,stack,componentStack});});
  ipcMain.handle('system:telemetry', () => getSystemTelemetrySnapshot());
  ipcMain.handle('audio:transcribe', async (_event, input: { audio: ArrayBuffer; mimeType: string }) => {
    const started=Date.now();
    try{
      const bytes=new Uint8Array(input.audio);
      const text=await transcribeAudio(store.openAIKey(),bytes,input.mimeType);
      writeDiagnostic('voice-transcription-complete',{mimeType:input.mimeType,bytes:bytes.byteLength,latencyMs:Date.now()-started,accepted:Boolean(text)});
      return{text};
    }catch(reason){
      writeDiagnostic('voice-transcription-failed',{mimeType:input.mimeType,bytes:input.audio.byteLength,latencyMs:Date.now()-started,message:reason instanceof Error?reason.message:String(reason)});
      throw reason;
    }
  });
  ipcMain.handle('audio:realtime-transcription',async(_event,sdp:string)=>{
    const offer=String(sdp||'');if(!offer.startsWith('v=0')||offer.length>120_000)throw new Error('Invalid realtime audio offer.');
    const key=store.openAIKey();if(!key)throw new Error('OpenAI is required for realtime transcription.');
    const model='gpt-realtime-2.1',form=new FormData();
    form.set('sdp',offer);form.set('session',JSON.stringify({type:'realtime',model,audio:{input:{transcription:{model:'gpt-live-transcribe',language:'en'},turn_detection:{type:'server_vad',threshold:.52,prefix_padding_ms:300,silence_duration_ms:480,create_response:false,interrupt_response:false}}}}));
    const started=Date.now(),response=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(30_000)});const answer=await response.text();
    if(!response.ok){writeDiagnostic('realtime-transcription-failed',{status:response.status,latencyMs:Date.now()-started,detail:answer.slice(0,500)});throw new Error(`Realtime transcription unavailable (${response.status}).`);}
    writeDiagnostic('realtime-transcription-ready',{model,latencyMs:Date.now()-started});return{sdp:answer,model};
  });
  ipcMain.handle('audio:synthesize', async (_event, text: string) => {
    const settings=store.publicSettings();
    const emotion=settings.appearance.emotion;const emotionalStyle=emotion==='angry'||emotion==='excited'?.22:emotion==='happy'?.12:0;const emotionalSpeed=emotion==='concerned'?-.06:emotion==='happy'||emotion==='excited'?.04:0;const emotionalStability=emotion==='focused'?.12:emotion==='concerned'?.08:0;
    try {
      const result = await synthesizeSpeechWithFallback({provider:settings.speechProvider,openAIKey:store.openAIKey(),elevenLabsKey:store.elevenLabsKey(),elevenLabsVoiceId:settings.elevenLabsVoiceId,elevenLabsModel:settings.elevenLabsModel,stability:Math.min(1,settings.voiceStability+emotionalStability),similarity:settings.voiceSimilarity,style:Math.min(1,settings.voiceStyle+emotionalStyle),speed:Math.max(.7,Math.min(1.2,settings.voiceSpeed+emotionalSpeed)),emotion}, text);
      if(result.fallbackFrom)writeDiagnostic('voice-provider-fallback',{selected:result.fallbackFrom,used:result.provider,reason:result.fallbackReason});
      return { audio: result.audio.buffer.slice(result.audio.byteOffset, result.audio.byteOffset + result.audio.byteLength), mimeType: result.mimeType, provider:result.provider, fallbackFrom:result.fallbackFrom,fallbackReason:result.fallbackReason,alignment:result.alignment };
    }catch(reason){writeDiagnostic('voice-synthesis-failed',{provider:settings.speechProvider,message:reason instanceof Error?reason.message:String(reason)});throw reason;}
  });
  ipcMain.handle('memory:list', () => store.memories());
  ipcMain.handle('memory:add', (_event, text: string,kind?:import('../shared/contracts').MemoryKind) => store.addMemory(text,{kind}));
  ipcMain.handle('memory:forget', (_event,id:string) => {if(!store.forgetMemory(id))throw new Error('Memory not found.');return store.memories();});
  ipcMain.handle('goals:list', () => store.goals());
  ipcMain.handle('goals:add', (_event, title: string) => store.addGoal(title));
  ipcMain.handle('todos:list',()=>store.todos());
  ipcMain.handle('todos:add',(_event,text:string)=>store.addTodo(text));
  ipcMain.handle('todos:status',(_event,id:string,status:'open'|'completed')=>store.setTodoStatus(id,status));
  ipcMain.handle('todos:remove',(_event,id:string)=>store.removeTodo(id));
  ipcMain.handle('scheduler:snapshot',()=>backgroundRuntime.snapshot());
  ipcMain.handle('agents:save',(_event,input:{name:string;role:string;instructions:string;schedule?:import('../shared/contracts').ScheduleSpec;color?:import('../shared/contracts').AppearanceColor;voiceProfileId?:string})=>store.saveAgent(input.name,input.role,input.instructions,input));
  ipcMain.handle('agents:enabled',(_event,id:string,enabled:boolean)=>{store.setAgentEnabled(id,enabled);return backgroundRuntime.snapshot();});
  ipcMain.handle('agents:run',async(_event,id:string)=>{await backgroundRuntime.runAgentNow(id);return backgroundRuntime.snapshot();});
  ipcMain.handle('agents:remove',(_event,id:string)=>{if(!store.removeAgentById(id))throw new Error('Agent not found.');return backgroundRuntime.snapshot();});
  ipcMain.handle('monitors:add',(_event,input:{title:string;instruction:string;source:'screen'|'camera';intervalSeconds?:number;durationMinutes?:number})=>store.addMonitor(input));
  ipcMain.handle('monitors:stop',(_event,id:string)=>{store.settleMonitor(id,'stopped','Stopped by the user.');return backgroundRuntime.snapshot();});
  ipcMain.handle('runtime:snapshot', () => runtimeSnapshot());
  ipcMain.handle('commitments:add', (_event,title:string,dueAt?:string) => store.addCommitment(title,dueAt));
  ipcMain.handle('commitments:resolve', (_event,id:string,status:'fulfilled'|'cancelled') => {if(status!=='fulfilled'&&status!=='cancelled')throw new Error('Invalid commitment status.');if(!store.resolveCommitment(id,status))throw new Error('Commitment not found.');return runtimeSnapshot();});
  ipcMain.handle('runtime:cancel-task', (_event,id:string) => {const task=store.runtimeTasks().find((item)=>item.id===id);if(!task)throw new Error('Runtime task not found.');if(!['queued','active','waiting','blocked'].includes(task.status))return runtimeSnapshot();for(const approval of store.approvals().filter((item)=>item.sourceTaskId===id&&item.status==='pending'))store.denyApproval(approval.id);store.settleRuntimeTask(id,'cancelled','Cancelled by the user from Runtime Core.');return runtimeSnapshot();});
  ipcMain.handle('approval:decide', (_event,id:string,decision:'approved'|'denied') => {if(decision!=='approved'&&decision!=='denied')throw new Error('Invalid approval decision.');return decideApproval(id,decision);});
  ipcMain.handle('assistant:send', async (event, input: AssistantRequest) => {
    const sendStarted=Date.now();
    const clean = input.message.trim().slice(0, 20_000);
    if (!clean) throw new Error('Message is empty.');
    const approvalCommand=/\b(APPROVE|DENY)\s+(AX-[A-F0-9]{6})\b/i.exec(clean);if(approvalCommand){const outcome=await decideApproval(approvalCommand[2],approvalCommand[1].toUpperCase()==='APPROVE'?'approved':'denied'),settings=store.publicSettings();const reply={text:outcome.message,provider:settings.provider,model:settings.model,toolEvents:outcome.event?[outcome.event]:[]};store.appendHistory(message('user',clean),message('assistant',reply.text));return reply;}
    // Opt-in shortcut requested directly by the user in place of the
    // default per-action AX-XXXXXX code: a single static personal phrase.
    // Only even attempted (scrypt is deliberately slow) when something is
    // actually pending, so ordinary conversation never pays this cost. On a
    // genuine mismatch this falls straight through to normal processing —
    // never intercepts, never reveals whether anything was close.
    if(store.hasActionApprovalPhrase()&&store.approvals().some((item)=>item.status==='pending')){
      const phraseOutcome=await decideApprovalByPhrase(clean);
      if(phraseOutcome.matched){const settings=store.publicSettings();const reply={text:phraseOutcome.message,provider:settings.provider,model:settings.model,toolEvents:phraseOutcome.event?[phraseOutcome.event]:[]};store.appendHistory(message('user','•••••••• (approval phrase)'),message('assistant',reply.text));return reply;}
    }
    const routeCandidates=providerTools(clean).map((tool)=>String(tool.name||tool.type||'')).filter(Boolean);reliability.beginRoute(clean,routeCandidates);
    const faceName=input.identity?.face?.name.trim().toLowerCase(),speakerName=input.identity?.speaker?.name.trim().toLowerCase(),identityConflict=Boolean(faceName&&speakerName&&faceName!==speakerName);
    const safeInput=identityConflict?{...input,untrustedPresence:true}:input;
    const task=input.resumeTaskId?store.resumeRuntimeTask(input.resumeTaskId,clean):store.beginRuntimeTask(clean,classifyRuntimeRisk(clean));
    const actionExpected=requiresToolUse(clean,providerTools(clean));
    store.transitionRuntimeTask(task.id,'planning',routeCandidates.length?`Planning with ${routeCandidates.length} relevant capability route(s): ${routeCandidates.slice(0,8).join(', ')}.`:'Planning a direct conversational response.');
    try{
      store.transitionRuntimeTask(task.id,'executing',actionExpected?'Executing the selected capability path.':'Generating a direct response; no computer mutation is required.');
      const reply = await adaptiveAssistant(event,forwardAssistantRequest(safeInput,clean));
      reliability.finishRoute(reply.toolEvents);store.appendAudit(reply.toolEvents,task.id);
      store.transitionRuntimeTask(task.id,'observing',reply.toolEvents.length?`Observed ${reply.toolEvents.length} capability receipt(s).`:'Observed a conversational response with no requested computer action.');
      store.transitionRuntimeTask(task.id,'verifying',actionExpected?'Checking tool receipts and outcome evidence.':'Confirming that no computer action was required.');
      const outcome=assessRuntimeOutcome(reply.toolEvents,actionExpected);
      store.settleRuntimeTask(task.id,outcome.status,outcome.summary,outcome.phase,{blocker:outcome.blocker,nextAction:outcome.nextAction});
      store.appendHistory(message('user', clean), message('assistant', reply.text));
      writeDiagnostic('assistant-send',{latencyMs:Date.now()-sendStarted,toolCount:reply.toolEvents.length,routeCandidates});
      if(!reply.toolEvents.length&&capabilityDenialPattern.test(reply.text))writeDiagnostic('possible-false-capability-denial',{message:clean,reply:reply.text.slice(0,500),actionExpected,routeCandidates});
      return reply;
    }
    catch(reason){
      const detail=reason instanceof Error?reason.message:String(reason);
      // This is the only place the real cause of "AI providers unavailable"
      // (or any other assistant:send failure) is ever recorded — previously
      // nothing here reached the diagnostic log at all, so a real, repeated
      // live failure left zero trace to diagnose from beyond a truncated
      // one-line toast in the renderer.
      writeDiagnostic('assistant-send-failed',{latencyMs:Date.now()-sendStarted,message:detail,routeCandidates,message_length:clean.length});
      reliability.finishRoute([],detail);store.settleRuntimeTask(task.id,'failed',detail,'blocked',{blocker:detail,nextAction:'Inspect provider and capability health, then resume this task from Runtime Core.'});throw reason;
    }
  });
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  // A throw anywhere in this chain used to leave Axiom with no window, no
  // tray icon, and no error of any kind — the process just sat there
  // looking dead, with the failure only visible as a silently-logged
  // unhandled rejection nobody would ever see. A solo dev on one known-good
  // machine never hit this; a stranger's fresh profile, restricted folder
  // permissions, or a first-run edge case plausibly could. Now the failure
  // is diagnosed, shown to the user, and Axiom still makes one last attempt
  // to open a window rather than giving up silently.
  try {
    store.init();
    void store.backfillMemoryEmbeddings();
    void store.backfillSelfCorrectionEmbeddings();
    configureLoginLaunch();
    syncManager.start();
    backgroundRuntime.start();
    registerIpc();
    setTimeout(()=>void refreshOperationalProbes(true).catch((reason)=>writeDiagnostic('startup-capability-probe-failed',{message:reason instanceof Error?reason.message:String(reason)})),900).unref();
    registerAppProtocol();
    // Camera access is only granted to Axiom's own renderer and only for the
    // explicit presence-tracking feature. Audio capture remains denied here.
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const localRenderer = requestingOrigin.startsWith('axiom:') || Boolean(process.env.VITE_DEV_SERVER_URL && requestingOrigin.startsWith(process.env.VITE_DEV_SERVER_URL));
      return localRenderer && permission === 'media';
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const localRenderer = webContents === mainWindow?.webContents;
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : [];
      const knownMedia = !mediaTypes?.length || mediaTypes.every((type) => type === 'video' || type === 'audio');
      callback(localRenderer && permission === 'media' && knownMedia);
    });
    createWindow();
    ensureTray();
    app.on('activate', showMainWindow);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    writeDiagnostic('startup-fatal', { message, stack: reason instanceof Error ? reason.stack : undefined });
    dialog.showErrorBox('Axiom failed to start', `Axiom hit an unexpected error during startup and could not finish opening.\n\n${message}\n\nIf this keeps happening, try reinstalling Axiom or contact support with this message.`);
    if (!mainWindow) { try { createWindow(); } catch { /* already reported above; nothing more to try */ } }
  }
});

app.on('second-instance', showMainWindow);

app.on('child-process-gone',(_event,details)=>writeDiagnostic('child-process-gone',details));
app.on('before-quit',()=>{isQuitting=true;syncManager.stop();backgroundRuntime.stop();ringSessions.closeAll();godsEyeView?.destroy();tray?.destroy();tray=null;for(const pending of pendingCameraCaptures.values()){clearTimeout(pending.timer);pending.reject(new Error('Axiom is closing.'));}pendingCameraCaptures.clear();});
process.on('uncaughtException',(error)=>{writeDiagnostic('uncaught-exception',{name:error.name,message:error.message,stack:error.stack});setImmediate(()=>app.exit(1));});
process.on('unhandledRejection',(reason)=>writeDiagnostic('unhandled-rejection',{message:reason instanceof Error?reason.message:String(reason),stack:reason instanceof Error?reason.stack:undefined}));

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && isQuitting) app.quit(); });
