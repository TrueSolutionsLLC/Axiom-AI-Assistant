import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AgentItem, AgentRunItem, AIProvider, AppearanceColor, AppearanceSettings, ApprovalRequest, AuditItem, BackgroundEvent, ChatMessage, CommitmentItem, ConnectorId, ConnectorSetup, ConnectorStatus, DesktopEntity, DesktopGraphSnapshot, DesktopObservation, DesktopRelation, DevicePresence, EvidenceItem, GoalItem, KnownPerson, MediaArtifact, MemoryItem, MemoryKind, MonitorItem, MouthCalibration, PublicSettings, RuntimeRisk, RuntimeTask, RuntimeTaskPhase, RuntimeTaskStatus, SaveSettingsRequest, ScheduleSpec, SelfCorrection, SettingsSnapshot, SkillItem, SpeakerMatch, SpeakerProfile, SpeakerProfileRecord, SpeechProvider, SyncPayload, SyncStatus, SyncTombstone, TodoItem, ToolEvent, VoiceProfile } from '../shared/contracts';
import { actionEvidence, stableActionDigest } from './runtimeCore';
import { normalizeMemoryRecord, rankMemoryRecords, cosineSimilarity, SEMANTIC_INCLUSION_THRESHOLD } from './memoryCore';
import { embedText } from './embeddings';
import { ingestDesktopToolResult, queryDesktopGraph, snapshotDesktopGraph } from './desktopGraph';
import { defaultDeviceName, platformProfile } from './platform';
import { advanceSchedule, normalizeSchedule, scheduleIsDue } from './schedulerCore';

interface StoredApproval extends ApprovalRequest { encryptedArgs: string; }
interface StoredConnector { id:ConnectorId;account:string;endpoint:string;clientId:string;encryptedClientSecret?:string;encryptedAccessToken?:string;encryptedRefreshToken?:string;expiresAt?:string;scopes:string[];updatedAt:string;lastCheckedAt?:string;lastError?:string; }

interface StoredData {
  model: string;
  provider: AIProvider;
  providerModels: Record<AIProvider,string>;
  autoFailover: boolean;
  fallbackOrder: AIProvider[];
  codingProvider:AIProvider;
  researchProvider:AIProvider;
  encryptedOpenAIKey?: string;
  encryptedAnthropicKey?: string;
  encryptedGeminiKey?: string;
  encryptedElevenLabsKey?: string;
  speechProvider: SpeechProvider;
  elevenLabsVoiceId: string;
  elevenLabsVoiceName: string;
  elevenLabsModel: string;
  voiceStability: number;
  voiceSimilarity: number;
  voiceStyle: number;
  voiceSpeed: number;
  mouthCalibrations:Record<string,MouthCalibration>;
  startMicrophoneOn:boolean;
  biometricConsentAt?:string;
  biometricConsentVersion?:number;
  updateFeedUrl:string;
  updateChannel:'stable'|'beta';
  lastUpdateCheckAt?:string;
  lastKnownLatestVersion?:string;
  preferredMicrophoneId:string;
  preferredMicrophoneLabel:string;
  microphoneNoiseFloor:number;
  microphoneSpeechThreshold:number;
  microphoneCalibratedAt?:string;
  speakerLockEnabled:boolean;
  voiceProfiles:VoiceProfile[];
  activeVoiceProfileId:string;
  speakerProfiles:SpeakerProfileRecord[];
  history: ChatMessage[];
  memories: MemoryItem[];
  goals: GoalItem[];
  skills: SkillItem[];
  agents: AgentItem[];
  agentRuns:AgentRunItem[];
  todos:TodoItem[];
  monitors:MonitorItem[];
  backgroundEvents:BackgroundEvent[];
  knownPeople:KnownPerson[];
  appearance: AppearanceSettings;
  codingWorkspace: string;
  permissionOverrides:Record<string,boolean>;
  audit:AuditItem[];
  runtimeTasks:RuntimeTask[];
  commitments:CommitmentItem[];
  evidence:EvidenceItem[];
  approvals:StoredApproval[];
  desktopEntities:DesktopEntity[];
  desktopRelations:DesktopRelation[];
  desktopObservations:DesktopObservation[];
  deviceId:string;
  deviceName:string;
  deviceFirstSeenAt:string;
  deviceLastActiveAt:string;
  syncEnabled:boolean;
  syncFolder:string;
  encryptedSyncPassphrase?:string;
  syncPeers:DevicePresence[];
  lastSyncAt?:string;
  lastSyncError?:string;
  appearanceUpdatedAt:string;
  syncTombstones:SyncTombstone[];
  automaticBackupsEnabled:boolean;
  lastAutomaticBackupAt?:string;
  connectors:StoredConnector[];
  mediaArtifacts:MediaArtifact[];
  encryptedBiometrics?:string;
  ownerOverridePhraseSalt?:string;
  ownerOverridePhraseHash?:string;
  ownerOverrideFailures:number;
  ownerOverrideLockedUntil?:string;
  selfCorrections:SelfCorrection[];
  lastSettingsSnapshot?:{at:string;label:string;data:Partial<StoredData>};
}

const defaultAppearance=():AppearanceSettings=>({color:'teal',emotion:'neutral',accentHex:'#20ffd3',glowIntensity:1,motionProfile:'adaptive',density:'balanced'});
function normalizeAppearance(input?:Partial<AppearanceSettings>):AppearanceSettings{
  const colors=['teal','green','blue','violet','amber','orange','pink','red','white'] as const;
  const emotions=['neutral','happy','focused','concerned','angry','excited'] as const;
  const motions=['adaptive','cinematic','efficient','reduced'] as const;
  const densities=['compact','balanced','spacious'] as const;
  const base=defaultAppearance();
  return{
    color:colors.includes(input?.color as typeof colors[number])?input!.color!:base.color,
    emotion:emotions.includes(input?.emotion as typeof emotions[number])?input!.emotion!:base.emotion,
    accentHex:typeof input?.accentHex==='string'&&/^#[0-9a-f]{6}$/i.test(input.accentHex)?input.accentHex.toLowerCase():base.accentHex,
    glowIntensity:typeof input?.glowIntensity==='number'&&Number.isFinite(input.glowIntensity)?Math.max(.35,Math.min(1.5,input.glowIntensity)):base.glowIntensity,
    motionProfile:motions.includes(input?.motionProfile as typeof motions[number])?input!.motionProfile!:base.motionProfile,
    density:densities.includes(input?.density as typeof densities[number])?input!.density!:base.density,
  };
}

const BIOMETRIC_CONSENT_VERSION=1;
/**
 * Seeded once, on a fresh install only — persisted data always wins on
 * later runs (see `init()`'s `{...base,...parsed}` merge). Real examples
 * from this app's own build history, not placeholders, so the feature is
 * demonstrably populated with genuine lessons from day one rather than an
 * empty list nobody ever fills in.
 */
function seedSelfCorrections():SelfCorrection[]{
  const now=new Date().toISOString();
  return [
    {id:crypto.randomUUID(),pattern:'a request Axiom should be able to fulfill gets refused with "I don\'t have that tool"',mistake:'Tool availability was decided by hand-written keyword regexes per message; phrasing the author never anticipated (e.g. "verify this" instead of "search the news", "open Chrome" instead of "open the app") matched nothing, so the model got zero tools and correctly-but-uselessly said it could not help.',fix:'Broadened the regexes for the specific phrasings reported, and audited every keyword group in one pass rather than fixing them one at a time as each was individually reported.',createdAt:now},
    {id:crypto.randomUUID(),pattern:'a multi-frame detection counter (unknown visitor, office watch) is slower in real use than the math predicts',mistake:'The counter hard-reset to zero on any single missed or ambiguous frame, so ordinary real-world flakiness (camera tracking briefly losing lock) could restart the count several times before landing enough consecutive good frames.',fix:'Replaced strict-consecutive counting with a tolerant sliding window that only forgets progress on genuinely conflicting evidence, not on a gap.',createdAt:now},
    {id:crypto.randomUUID(),pattern:'the owner is not recognized by camera/voice and needs a way back into trusted mode',mistake:'There was no fallback when biometrics genuinely failed (bad angle, lighting, or an enrollment gap) other than getting the camera to cooperate — and a spoken claimed name was correctly never accepted as proof, since that is exactly what an intruder would also say.',fix:'Added a real secret (scrypt-hashed owner override phrase, rate-limited) as the deliberate way back in — distinct from a name, which is public information.',createdAt:now},
  ];
}
const defaults = (): StoredData => { const now=new Date().toISOString();return ({ model: 'gpt-5.6-luna', provider:'openai', providerModels:{openai:'gpt-5.6-luna',anthropic:'claude-sonnet-5',gemini:'gemini-3.6-flash'}, autoFailover:true, fallbackOrder:['openai','anthropic','gemini'],codingProvider:'openai',researchProvider:'openai', speechProvider:'openai', elevenLabsVoiceId:'JBFqnCBsd6RMkjVDRZzb', elevenLabsVoiceName:'George', elevenLabsModel:'eleven_flash_v2_5', voiceStability:.5, voiceSimilarity:.78, voiceStyle:.18, voiceSpeed:1.12,mouthCalibrations:{},startMicrophoneOn:true,updateFeedUrl:'',updateChannel:'stable',preferredMicrophoneId:'',preferredMicrophoneLabel:'System default',microphoneNoiseFloor:.006,microphoneSpeechThreshold:.02,speakerLockEnabled:true,voiceProfiles:[],activeVoiceProfileId:'',speakerProfiles:[], history: [], memories: [], goals: [], skills: [], agents: [],agentRuns:[],todos:[],monitors:[],backgroundEvents:[],knownPeople:[], appearance: defaultAppearance(), codingWorkspace: '',permissionOverrides:{},audit:[],runtimeTasks:[],commitments:[],evidence:[],approvals:[],desktopEntities:[],desktopRelations:[],desktopObservations:[],deviceId:crypto.randomUUID(),deviceName:defaultDeviceName(),deviceFirstSeenAt:now,deviceLastActiveAt:now,syncEnabled:false,syncFolder:'',syncPeers:[],appearanceUpdatedAt:now,syncTombstones:[],automaticBackupsEnabled:true,connectors:[],mediaArtifacts:[],ownerOverrideFailures:0,selfCorrections:seedSelfCorrections() }); };

const recordTime=(item:unknown):number=>{const record=item as {createdAt?:string;updatedAt?:string;lastRunAt?:string;at?:string};return Date.parse(record.updatedAt||record.lastRunAt||record.createdAt||record.at||'')||0;};
function mergeRecords<T extends {id:string}>(local:T[],remote:T[],limit:number):T[]{const map=new Map<string,T>();for(const item of [...local,...remote]){const current=map.get(item.id);if(!current||recordTime(item)>=recordTime(current))map.set(item.id,item);}return[...map.values()].sort((a,b)=>recordTime(a)-recordTime(b)).slice(-limit);}

function normalizeRuntimeTask(item:RuntimeTask):RuntimeTask{
  const phaseByStatus:Record<RuntimeTaskStatus,RuntimeTaskPhase>={queued:'received',active:'executing',waiting:'awaiting-approval',blocked:'blocked',completed:'completed',failed:'blocked',cancelled:'cancelled'};
  const createdAt=item.createdAt||new Date().toISOString(),phase=item.phase||phaseByStatus[item.status]||'received';
  return{...item,phase,successCriteria:item.successCriteria||'Complete the requested outcome and retain verified evidence for every computer action.',attempt:Math.max(1,Number(item.attempt)||1),maxAttempts:Math.max(1,Number(item.maxAttempts)||3),timeline:Array.isArray(item.timeline)&&item.timeline.length?item.timeline.slice(-80):[{id:crypto.randomUUID(),phase,at:createdAt,summary:item.summary||'Recovered legacy task state.'}],actionIds:Array.isArray(item.actionIds)?item.actionIds:[]};
}

export class AppStore {
  private data: StoredData = defaults();
  private file = '';
  private readonly sessionId=crypto.randomUUID();

  /** Writes to the same diagnostics log main.ts's writeDiagnostic() uses, so
   * a data-loss event during store init shows up in one place instead of
   * vanishing silently — this is the one path where losing the user's
   * entire profile (memories, goals, agents, connectors) to a swallowed
   * exception was previously possible with zero forensic trail. */
  private static writeInitDiagnostic(kind:string,detail:unknown):void{
    try{
      const directory=path.join(app.getPath('userData'),'diagnostics'),file=path.join(directory,'axiom-runtime.log');
      fs.mkdirSync(directory,{recursive:true});
      fs.appendFileSync(file,`${new Date().toISOString()} ${kind} ${JSON.stringify(detail)}\n`,'utf8');
    }catch{/* diagnostics must never crash Axiom */}
  }
  private static describeError(error:unknown):string{return error instanceof Error?error.message:String(error);}

  init(): void {
    this.file = path.join(app.getPath('userData'), 'axiom-data.json');
    const backup=`${this.file}.bak`;
    const load=(content:string):void => {
      const parsed=JSON.parse(content) as Partial<StoredData>;
      const base=defaults();const provider=parsed.provider&&['openai','anthropic','gemini'].includes(parsed.provider)?parsed.provider:'openai';
      const migratedElevenModel=parsed.elevenLabsModel==='eleven_multilingual_v2'||parsed.elevenLabsModel==='eleven_turbo_v2_5'?'eleven_flash_v2_5':parsed.elevenLabsModel||base.elevenLabsModel;
      let biometricPeople:unknown=parsed.knownPeople,biometricSpeakers:unknown=parsed.speakerProfiles;
      if(typeof parsed.encryptedBiometrics==='string'){
        try{
          if(!safeStorage.isEncryptionAvailable())throw new Error('Secure storage is unavailable.');
          const decrypted=JSON.parse(safeStorage.decryptString(Buffer.from(parsed.encryptedBiometrics,'base64'))) as {knownPeople?:unknown;speakerProfiles?:unknown};
          biometricPeople=decrypted.knownPeople;biometricSpeakers=decrypted.speakerProfiles;
        }catch{biometricPeople=[];biometricSpeakers=[];}
      }
      const knownPeople=Array.isArray(biometricPeople)?biometricPeople.filter((item):item is KnownPerson=>Boolean(item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.name==='string'&&Array.isArray(item.descriptor)&&item.descriptor.length===128)).slice(-100).map((item)=>({...item,descriptor:[...item.descriptor],descriptors:(Array.isArray(item.descriptors)?item.descriptors:[]).filter((vector)=>Array.isArray(vector)&&vector.length===128&&vector.every(Number.isFinite)).slice(-8).map((vector)=>[...vector])})):[];
      this.data = { ...base, ...parsed, appearance:normalizeAppearance(parsed.appearance), provider, elevenLabsModel:migratedElevenModel, mouthCalibrations:parsed.mouthCalibrations&&typeof parsed.mouthCalibrations==='object'?parsed.mouthCalibrations:{}, providerModels:{...base.providerModels,...parsed.providerModels,[provider]:parsed.model||parsed.providerModels?.[provider]||base.providerModels[provider]}, fallbackOrder:this.validOrder(parsed.fallbackOrder),voiceProfiles:Array.isArray(parsed.voiceProfiles)?parsed.voiceProfiles.slice(-24).map((profile)=>({...profile,elevenLabsModel:profile.elevenLabsModel==='eleven_multilingual_v2'||profile.elevenLabsModel==='eleven_turbo_v2_5'?'eleven_flash_v2_5':profile.elevenLabsModel})):[],speakerProfiles:this.normalizeSpeakerProfiles(biometricSpeakers), permissionOverrides:parsed.permissionOverrides&&typeof parsed.permissionOverrides==='object'?parsed.permissionOverrides:{},audit:Array.isArray(parsed.audit)?parsed.audit.slice(-500):[], runtimeTasks:Array.isArray(parsed.runtimeTasks)?parsed.runtimeTasks.slice(-200).map(normalizeRuntimeTask):[], commitments:Array.isArray(parsed.commitments)?parsed.commitments.slice(-300):[], evidence:Array.isArray(parsed.evidence)?parsed.evidence.slice(-1000):[], approvals:Array.isArray(parsed.approvals)?parsed.approvals.filter((item)=>item&&typeof item==='object'&&typeof item.encryptedArgs==='string').slice(-200) as StoredApproval[]:[], history: Array.isArray(parsed.history) ? parsed.history.slice(-200) : [], memories: Array.isArray(parsed.memories) ? parsed.memories.map((item)=>normalizeMemoryRecord(item)).filter((item):item is MemoryItem=>Boolean(item)).slice(-300) : [], goals: Array.isArray(parsed.goals) ? parsed.goals.slice(-200) : [], skills:Array.isArray(parsed.skills)?parsed.skills.slice(-200) as SkillItem[]:[], agents:Array.isArray(parsed.agents)?parsed.agents.slice(-100) as AgentItem[]:[],knownPeople, desktopEntities:Array.isArray(parsed.desktopEntities)?parsed.desktopEntities.filter((item):item is DesktopEntity=>Boolean(item&&typeof item==='object'&&typeof item.id==='string')).slice(-500):[], desktopRelations:Array.isArray(parsed.desktopRelations)?parsed.desktopRelations.filter((item):item is DesktopRelation=>Boolean(item&&typeof item==='object'&&typeof item.id==='string')).slice(-1200):[], desktopObservations:Array.isArray(parsed.desktopObservations)?parsed.desktopObservations.filter((item):item is DesktopObservation=>Boolean(item&&typeof item==='object'&&typeof item.id==='string')).slice(-1000):[],deviceId:typeof parsed.deviceId==='string'&&parsed.deviceId?parsed.deviceId:base.deviceId,deviceName:typeof parsed.deviceName==='string'&&parsed.deviceName.trim()?parsed.deviceName.slice(0,80):base.deviceName,deviceFirstSeenAt:typeof parsed.deviceFirstSeenAt==='string'?parsed.deviceFirstSeenAt:base.deviceFirstSeenAt,deviceLastActiveAt:typeof parsed.deviceLastActiveAt==='string'?parsed.deviceLastActiveAt:base.deviceLastActiveAt,syncPeers:Array.isArray(parsed.syncPeers)?parsed.syncPeers.slice(-20):[],syncTombstones:Array.isArray(parsed.syncTombstones)?parsed.syncTombstones.slice(-2000):[] };
    };
    try{
      if(!fs.existsSync(this.file)){
        // A brand-new install with nothing saved yet — this is normal, not
        // a failure. Before this check, a fresh install fell straight
        // through to the recovery branch below (no file, no backup either)
        // and got logged as a max-severity "DATA-LOSS" event on every
        // single first launch, burying genuine data-loss reports under a
        // flood of routine ones.
        this.data=defaults();
      }else{
        load(fs.readFileSync(this.file,'utf8'));
      }
    }catch(primaryError){
      AppStore.writeInitDiagnostic('store-init-primary-failed',{message:AppStore.describeError(primaryError)});
      try{
        if(!fs.existsSync(backup))throw primaryError;
        if(fs.existsSync(this.file))fs.renameSync(this.file,`${this.file}.corrupt-${Date.now()}`);
        fs.copyFileSync(backup,this.file);
        load(fs.readFileSync(this.file,'utf8'));
        AppStore.writeInitDiagnostic('store-init-recovered-from-backup',{});
      }catch(backupError){
        // Last resort only: everything else, including the .bak recovery
        // this same block already tries, has failed. Logged at max
        // severity because this is the one path that silently wiped a
        // user's entire profile (memories, goals, agents, connectors) with
        // zero forensic trail before this fix.
        AppStore.writeInitDiagnostic('store-init-DATA-LOSS-fell-back-to-defaults',{primary:AppStore.describeError(primaryError),backup:AppStore.describeError(backupError)});
        this.data = defaults();
      }
    }
    this.data.agents=this.data.agents.map((item)=>({...item,schedule:normalizeSchedule(item.schedule,new Date())}));
    this.data.agentRuns=Array.isArray(this.data.agentRuns)?this.data.agentRuns.slice(-500):[];
    this.data.todos=Array.isArray(this.data.todos)?this.data.todos.slice(-500):[];
    this.data.monitors=Array.isArray(this.data.monitors)?this.data.monitors.slice(-100):[];
    this.data.backgroundEvents=Array.isArray(this.data.backgroundEvents)?this.data.backgroundEvents.slice(-500):[];
    this.data.connectors=Array.isArray(this.data.connectors)?this.data.connectors.filter((item)=>['google','shopify','meta','dropbox','homebridge','ring','stripe','klaviyo','whatsapp'].includes(item.id)).slice(-9):[];
    this.data.mediaArtifacts=Array.isArray(this.data.mediaArtifacts)?this.data.mediaArtifacts.slice(-200):[];
    let recovered=false;const now=new Date().toISOString();for(const task of this.data.runtimeTasks){if(task.status==='active'||task.status==='queued'){task.status='blocked';task.phase='blocked';task.updatedAt=now;task.summary='Axiom restarted before this operation reached a verified terminal state.';task.blocker='The previous process ended before verification completed.';task.nextAction='Resume this task to replan from its last verified action.';task.timeline=[...task.timeline,{id:crypto.randomUUID(),phase:'blocked' as const,at:now,summary:task.summary}].slice(-80);delete task.completedAt;recovered=true;}}for(const run of this.data.agentRuns){if(run.status==='active'){run.status='failed';run.completedAt=now;run.summary='Axiom restarted before the agent run completed.';recovered=true;}}if(recovered)this.flush();
  }

  publicSettings(): PublicSettings {
    const selectedKey = this.aiKey(this.data.provider),platform=platformProfile(),voiceKey=this.voiceCalibrationKey(),mouthCalibration=this.data.mouthCalibrations[voiceKey]??{voiceKey,offsetMs:18,gain:1,attack:.6,release:.48};
    return {
      provider: this.data.provider,
      model: this.data.model,
      hasOpenAIKey: Boolean(this.data.encryptedOpenAIKey),
      hasAnthropicKey: Boolean(this.data.encryptedAnthropicKey),
      hasGeminiKey: Boolean(this.data.encryptedGeminiKey),
      hasSelectedAIKey: Boolean(selectedKey),
      providerModels:{...this.data.providerModels},
      autoFailover:this.data.autoFailover,
      fallbackOrder:[...this.data.fallbackOrder],
      codingProvider:this.data.codingProvider,
      researchProvider:this.data.researchProvider,
      speechProvider:this.data.speechProvider,
      hasElevenLabsKey:Boolean(this.data.encryptedElevenLabsKey),
      elevenLabsVoiceId:this.data.elevenLabsVoiceId,
      elevenLabsVoiceName:this.data.elevenLabsVoiceName,
      elevenLabsModel:this.data.elevenLabsModel,
      voiceStability:this.data.voiceStability,
      voiceSimilarity:this.data.voiceSimilarity,
      voiceStyle:this.data.voiceStyle,
      voiceSpeed:this.data.voiceSpeed,
      mouthCalibration:{...mouthCalibration},
      startMicrophoneOn:this.data.startMicrophoneOn,
      biometricConsent:this.biometricConsentState(),
      updateFeedUrl:this.data.updateFeedUrl??'',
      updateChannel:this.data.updateChannel??'stable',
      lastUpdateCheckAt:this.data.lastUpdateCheckAt,
      lastKnownLatestVersion:this.data.lastKnownLatestVersion,
      preferredMicrophoneId:this.data.preferredMicrophoneId,
      preferredMicrophoneLabel:this.data.preferredMicrophoneLabel,
      microphoneNoiseFloor:this.data.microphoneNoiseFloor,
      microphoneSpeechThreshold:this.data.microphoneSpeechThreshold,
      microphoneCalibratedAt:this.data.microphoneCalibratedAt,
      speakerLockEnabled:this.data.speakerLockEnabled,
      speakerProfiles:this.speakerProfiles(),
      voiceProfiles:this.data.voiceProfiles.map((profile)=>({...profile})),
      activeVoiceProfileId:this.data.activeVoiceProfileId,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      unreadableCredentials: this.unreadableCredentials(),
      appearance: { ...this.data.appearance },
      codingWorkspace: this.data.codingWorkspace || path.join(app.getPath('documents'), 'Axiom Projects'),
      platform:platform.id,
      platformLabel:platform.label,
      secureStorageLabel:platform.secureStorageLabel,
      deviceName:this.data.deviceName,
      syncEnabled:this.data.syncEnabled,
      syncFolder:this.data.syncFolder,
      hasSyncPassphrase:Boolean(this.data.encryptedSyncPassphrase),
      automaticBackupsEnabled:this.data.automaticBackupsEnabled,
      hasOwnerOverridePhrase:this.hasOwnerOverridePhrase(),
    };
  }

  saveSettings(input: SaveSettingsRequest): PublicSettings {
    const touched=Object.keys(input).filter((key)=>key!=='model'&&(input as unknown as Record<string,unknown>)[key]!==undefined);
    if(touched.length)this.snapshotSettings(`Changed ${touched.slice(0,4).join(', ')}${touched.length>4?`, +${touched.length-4} more`:''}`);
    if(input.appearance)this.setAppearance(normalizeAppearance({...this.data.appearance,...input.appearance}));
    if(input.provider && ['openai','anthropic','gemini'].includes(input.provider))this.data.provider=input.provider;
    this.data.model = input.model.trim() || this.data.providerModels[this.data.provider];
    this.data.providerModels[this.data.provider]=this.data.model;
    if(typeof input.autoFailover==='boolean')this.data.autoFailover=input.autoFailover;
    if(input.fallbackOrder)this.data.fallbackOrder=this.validOrder(input.fallbackOrder);
    if(input.codingProvider&&['openai','anthropic','gemini'].includes(input.codingProvider))this.data.codingProvider=input.codingProvider;
    if(input.researchProvider&&['openai','anthropic','gemini'].includes(input.researchProvider))this.data.researchProvider=input.researchProvider;
    if(input.deviceName!==undefined)this.data.deviceName=input.deviceName.trim().slice(0,80)||defaultDeviceName();
    if(typeof input.syncEnabled==='boolean')this.data.syncEnabled=input.syncEnabled;
    if(input.syncFolder!==undefined){const clean=input.syncFolder.trim();if(clean){const candidate=path.resolve(clean),home=path.resolve(app.getPath('home'));if(candidate!==home&&!candidate.startsWith(`${home}${path.sep}`))throw new Error('The sync folder must be inside your user home folder.');this.data.syncFolder=candidate;}else this.data.syncFolder='';}
    if(input.clearSyncPassphrase)delete this.data.encryptedSyncPassphrase;
    if(typeof input.automaticBackupsEnabled==='boolean')this.data.automaticBackupsEnabled=input.automaticBackupsEnabled;
    if(input.syncPassphrase?.trim()){if(input.syncPassphrase.trim().length<12)throw new Error('Use a sync passphrase with at least 12 characters.');this.data.encryptedSyncPassphrase=this.encryptSecret(input.syncPassphrase.trim());}
    if (input.codingWorkspace !== undefined) {
      const candidate = path.resolve(input.codingWorkspace.trim() || path.join(app.getPath('documents'), 'Axiom Projects'));
      const roots = ['desktop', 'documents', 'downloads'].map((name) => path.resolve(app.getPath(name as 'desktop' | 'documents' | 'downloads')));
      if (!roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) throw new Error('The coding workspace must be inside Desktop, Documents, or Downloads.');
      this.data.codingWorkspace = candidate;
    }
    if (input.clearOpenAIKey) delete this.data.encryptedOpenAIKey;
    if (input.openAIKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(`${platformProfile().secureStorageLabel} is unavailable; the API key was not saved.`);
      this.data.encryptedOpenAIKey = safeStorage.encryptString(input.openAIKey.trim()).toString('base64');
    }
    this.saveEncryptedKey('encryptedAnthropicKey',input.anthropicKey,input.clearAnthropicKey);
    this.saveEncryptedKey('encryptedGeminiKey',input.geminiKey,input.clearGeminiKey);
    this.saveEncryptedKey('encryptedElevenLabsKey',input.elevenLabsKey,input.clearElevenLabsKey);
    if(input.speechProvider&&['openai','elevenlabs','system'].includes(input.speechProvider))this.data.speechProvider=input.speechProvider;
    if(input.elevenLabsVoiceId!==undefined)this.data.elevenLabsVoiceId=input.elevenLabsVoiceId.trim().slice(0,120);
    if(input.elevenLabsVoiceName!==undefined)this.data.elevenLabsVoiceName=input.elevenLabsVoiceName.trim().slice(0,120);
    if(input.elevenLabsModel!==undefined)this.data.elevenLabsModel=input.elevenLabsModel.trim().slice(0,120)||'eleven_flash_v2_5';
    this.data.voiceStability=this.bounded(input.voiceStability,this.data.voiceStability,0,1);
    this.data.voiceSimilarity=this.bounded(input.voiceSimilarity,this.data.voiceSimilarity,0,1);
    this.data.voiceStyle=this.bounded(input.voiceStyle,this.data.voiceStyle,0,1);
    this.data.voiceSpeed=this.bounded(input.voiceSpeed,this.data.voiceSpeed,.7,1.2);
    if(input.mouthOffsetMs!==undefined||input.mouthGain!==undefined||input.mouthAttack!==undefined||input.mouthRelease!==undefined||input.mouthCalibratedAt!==undefined){const voiceKey=this.voiceCalibrationKey(),current=this.data.mouthCalibrations[voiceKey]??{voiceKey,offsetMs:18,gain:1,attack:.6,release:.48};this.data.mouthCalibrations[voiceKey]={voiceKey,offsetMs:this.bounded(input.mouthOffsetMs,current.offsetMs,-220,220),gain:this.bounded(input.mouthGain,current.gain,.5,1.8),attack:this.bounded(input.mouthAttack,current.attack,.1,.95),release:this.bounded(input.mouthRelease,current.release,.1,.95),calibratedAt:input.mouthCalibratedAt&&Number.isFinite(Date.parse(input.mouthCalibratedAt))?input.mouthCalibratedAt:current.calibratedAt};}
    if(typeof input.startMicrophoneOn==='boolean')this.data.startMicrophoneOn=input.startMicrophoneOn;
    if(input.acknowledgeBiometricConsent){this.data.biometricConsentAt=new Date().toISOString();this.data.biometricConsentVersion=BIOMETRIC_CONSENT_VERSION;}
    if(input.withdrawBiometricConsent){
      // Withdrawal must stop future capture immediately, not merely hide the UI.
      delete this.data.biometricConsentAt;delete this.data.biometricConsentVersion;this.data.speakerLockEnabled=false;
    }
    if(typeof input.updateFeedUrl==='string')this.data.updateFeedUrl=input.updateFeedUrl.trim().slice(0,2000);
    if(input.updateChannel==='stable'||input.updateChannel==='beta')this.data.updateChannel=input.updateChannel;
    if(input.preferredMicrophoneId!==undefined)this.data.preferredMicrophoneId=input.preferredMicrophoneId.trim().slice(0,400);
    if(input.preferredMicrophoneLabel!==undefined)this.data.preferredMicrophoneLabel=input.preferredMicrophoneLabel.trim().slice(0,160)||'System default';
    this.data.microphoneNoiseFloor=this.bounded(input.microphoneNoiseFloor,this.data.microphoneNoiseFloor,.001,.2);
    this.data.microphoneSpeechThreshold=this.bounded(input.microphoneSpeechThreshold,this.data.microphoneSpeechThreshold,.006,.3);
    if(input.microphoneCalibratedAt!==undefined&&Number.isFinite(Date.parse(input.microphoneCalibratedAt)))this.data.microphoneCalibratedAt=input.microphoneCalibratedAt;
    if(typeof input.speakerLockEnabled==='boolean')this.data.speakerLockEnabled=input.speakerLockEnabled;
    if(input.clearOwnerOverridePhrase)this.clearOwnerOverridePhrase();
    else if(input.ownerOverridePhrase?.trim())this.setOwnerOverridePhrase(input.ownerOverridePhrase);
    this.flush();
    return this.publicSettings();
  }

  openAIKey(): string {
    return this.decryptKey(this.data.encryptedOpenAIKey);
  }

  aiKey(provider:AIProvider):string{return this.decryptKey(provider==='openai'?this.data.encryptedOpenAIKey:provider==='anthropic'?this.data.encryptedAnthropicKey:this.data.encryptedGeminiKey);}
  modelFor(provider:AIProvider):string{return this.data.providerModels[provider];}
  providerOrder(preferred:AIProvider=this.data.provider):AIProvider[]{return[preferred,this.data.provider,...this.data.fallbackOrder].filter((provider,index,array)=>array.indexOf(provider)===index);}
  autoFailover():boolean{return this.data.autoFailover;}
  elevenLabsKey():string{return this.decryptKey(this.data.encryptedElevenLabsKey);}

  private decryptKey(encrypted?:string): string {
    if (!encrypted) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { return ''; }
  }

  /**
   * A stored secret has three states, not two. Collapsing "present but
   * undecryptable" into "absent" tells the user their key is missing when it is
   * actually there and unreadable — typically because the profile's os_crypt key
   * in Local State no longer matches the ciphertext (restored backup, copied
   * profile, new machine).
   */
  credentialState(encrypted?:string):'absent'|'ready'|'unreadable'{
    if(!encrypted)return'absent';
    if(!safeStorage.isEncryptionAvailable())return'unreadable';
    try{return safeStorage.decryptString(Buffer.from(encrypted,'base64'))?'ready':'unreadable';}
    catch{return'unreadable';}
  }

  /** Field labels for every secret that is stored but cannot be decrypted. */
  unreadableCredentials():string[]{
    const labels:Array<[string|undefined,string]>=[
      [this.data.encryptedOpenAIKey,'OpenAI key'],
      [this.data.encryptedAnthropicKey,'Anthropic key'],
      [this.data.encryptedGeminiKey,'Gemini key'],
      [this.data.encryptedElevenLabsKey,'ElevenLabs key'],
      [this.data.encryptedSyncPassphrase,'Sync passphrase'],
      [this.data.encryptedBiometrics,'Biometric templates'],
    ];
    const unreadable=labels.filter(([value])=>this.credentialState(value)==='unreadable').map(([,label])=>label);
    for(const connector of this.data.connectors){
      if([connector.encryptedClientSecret,connector.encryptedAccessToken,connector.encryptedRefreshToken].some((value)=>this.credentialState(value)==='unreadable'))unreadable.push(`${connector.id} credentials`);
    }
    return unreadable;
  }

  private encryptSecret(value:string):string{if(!safeStorage.isEncryptionAvailable())throw new Error(`${platformProfile().secureStorageLabel} is unavailable; the secret was not saved.`);return safeStorage.encryptString(value).toString('base64');}
  private saveEncryptedKey(field:'encryptedAnthropicKey'|'encryptedGeminiKey'|'encryptedElevenLabsKey',value?:string,clear?:boolean):void{if(clear)delete this.data[field];if(value?.trim())this.data[field]=this.encryptSecret(value.trim());}
  private bounded(value:number|undefined,current:number,min:number,max:number):number{return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):current;}
  private validOrder(value?:AIProvider[]):AIProvider[]{const providers=(value??[]).filter((provider):provider is AIProvider=>['openai','anthropic','gemini'].includes(provider));const defaults:AIProvider[]=['openai','anthropic','gemini'];return[...new Set<AIProvider>([...providers,...defaults])];}
  private voiceCalibrationKey():string{return this.data.speechProvider==='elevenlabs'?`elevenlabs:${this.data.elevenLabsVoiceId||'default'}`:`${this.data.speechProvider}:default`;}
  private normalizedVoicePrint(value:number[]):number[]|null{const vector=Array.from(value??[],Number);if(![28,512].includes(vector.length)||vector.some((item)=>!Number.isFinite(item)))return null;const magnitude=Math.sqrt(vector.reduce((sum,item)=>sum+item*item,0));if(magnitude<.1)return null;return vector.map((item)=>item/magnitude);}
  private voiceSimilarity(left:number[],right:number[]):number{if(left.length!==right.length||!left.length)return 0;let dot=0,leftSize=0,rightSize=0;for(let index=0;index<left.length;index++){dot+=left[index]*right[index];leftSize+=left[index]*left[index];rightSize+=right[index]*right[index];}const denominator=Math.sqrt(leftSize*rightSize);return denominator?Math.max(-1,Math.min(1,dot/denominator)):0;}

  history(): ChatMessage[] { return [...this.data.history]; }

  appendHistory(...messages: ChatMessage[]): void {
    this.data.history = [...this.data.history, ...messages].slice(-200);
    this.flush();
  }

  clearHistory(): void {
    const deletedAt=new Date().toISOString();for(const item of this.data.history)this.addTombstone('history',item.id,deletedAt);
    this.data.history = [];
    this.flush();
  }

  memories(): MemoryItem[] { return this.data.memories.map((item)=>({...item})); }
  addMemory(text:string,options:{kind?:MemoryKind;origin?:MemoryItem['origin'];confidence?:number;supersedesId?:string}={}):MemoryItem{const clean=text.trim().slice(0,2000);if(!clean)throw new Error('Memory text is required.');const now=new Date().toISOString(),kinds:MemoryKind[]=['fact','preference','person','project','decision','instruction'],kind=kinds.includes(options.kind as MemoryKind)?options.kind as MemoryKind:'fact';const item:MemoryItem={id:crypto.randomUUID(),text:clean,kind,status:'active',origin:options.origin??'user-explicit',confidence:Math.max(0,Math.min(1,options.confidence??1)),createdAt:now,updatedAt:now,retrievalCount:0,supersedesId:options.supersedesId};this.data.memories=[...this.data.memories,item].slice(-300);this.flush();void this.attachMemoryEmbedding(item.id,clean);return{...item};}
  // Embedding a sentence takes real (if fast) model inference, so it never
  // blocks the synchronous save — it lands in the background and just
  // upgrades that memory from keyword-only to semantic search once ready.
  // Best-effort: a memory a caller has since forgotten, or a model that
  // fails to load, both just leave the record on keyword search forever.
  private async attachMemoryEmbedding(id:string,text:string):Promise<void>{
    const vector=await embedText(text).catch(()=>undefined);
    if(!vector)return;
    const record=this.data.memories.find((item)=>item.id===id);
    if(!record)return;
    record.embedding=vector;
    this.flush();
  }
  async backfillMemoryEmbeddings():Promise<void>{
    // Per-item try/catch so one bad record (a write failure, a malformed
    // string) can't silently abort the backfill for every record after it
    // in the array — each memory gets its own independent shot.
    for(const item of this.data.memories){
      if(item.status!=='active'||item.embedding)continue;
      await this.attachMemoryEmbedding(item.id,item.text).catch(()=>{});
    }
  }
  // Finds the closest existing active memory of the same kind before a new
  // one is saved, so remember_fact can tell the difference between "this is
  // basically the same thing already saved" and "this looks like it might
  // update or contradict something already on file" instead of silently
  // letting two competing facts about the same topic both sit as active
  // forever. Thresholds are calibrated from real MiniLM output on a small
  // hand-built set of fact/contradiction/unrelated pairs, not an exhaustive
  // statistical study: true paraphrase-duplicates landed ~0.98, same-topic
  // contradictions (e.g. "lives in St. Louis" vs "now lives in Austin")
  // clustered 0.75-0.84, and genuinely unrelated facts about the same
  // person stayed at or below 0.54 — leaving real margin either side of the
  // 0.95 duplicate cut and the 0.70 conflict-flag cut.
  async findSimilarActiveMemory(kind:MemoryKind,text:string):Promise<{item:MemoryItem;similarity:number}|undefined>{
    const vector=await embedText(text).catch(()=>undefined);
    if(!vector)return undefined;
    let best:{item:MemoryItem;similarity:number}|undefined;
    for(const candidate of this.data.memories){
      if(candidate.status!=='active'||candidate.kind!==kind||!candidate.embedding)continue;
      const similarity=cosineSimilarity(vector,candidate.embedding);
      if(!best||similarity>best.similarity)best={item:{...candidate},similarity};
    }
    return best;
  }
  async searchMemories(query:string):Promise<MemoryItem[]>{
    const queryEmbedding=await embedText(query).catch(()=>undefined);
    const ranked=rankMemoryRecords(this.data.memories,query,12,queryEmbedding);
    if(ranked.length){const now=new Date().toISOString();for(const item of ranked){item.lastUsedAt=now;item.retrievalCount+=1;}this.flush();}
    return ranked.map((item)=>({...item}));
  }
  correctMemory(id:string,text:string,kind?:MemoryKind):MemoryItem{const existing=this.data.memories.find((item)=>item.id===id);if(!existing)throw new Error('Memory not found.');existing.status='superseded';existing.updatedAt=new Date().toISOString();return this.addMemory(text,{kind:kind??existing.kind,origin:'user-explicit',confidence:1,supersedesId:id});}
  forgetMemory(id:string):boolean{const before=this.data.memories.length;this.data.memories=this.data.memories.filter((item)=>item.id!==id);if(this.data.memories.length===before)return false;this.addTombstone('memory',id);this.flush();return true;}
  knownPeople():KnownPerson[]{return this.data.knownPeople.map((item)=>({...item,descriptor:[...item.descriptor],descriptors:item.descriptors?.map((vector)=>[...vector])}));}
  saveKnownPerson(name:string,descriptor:number[]):KnownPerson{this.requireBiometricConsent('Enrolling a face');
    if(!safeStorage.isEncryptionAvailable())throw new Error(`${platformProfile().secureStorageLabel} is required before Axiom can retain a face profile.`);
    const clean=name.trim().replace(/[^\p{L}\p{N}'’ .-]/gu,'').slice(0,48),vector=Array.from(descriptor??[],Number);
    if(!clean)throw new Error('A person name is required.');
    if(vector.length!==128||vector.some((value)=>!Number.isFinite(value)))throw new Error('A clear face descriptor was not captured.');
    const now=new Date().toISOString(),existing=this.data.knownPeople.find((item)=>item.name.toLowerCase()===clean.toLowerCase());
    if(existing){const samples=[...(existing.descriptors?.length?existing.descriptors:[existing.descriptor]),vector].slice(-8);existing.descriptors=samples;existing.descriptor=Array.from({length:128},(_,index)=>samples.reduce((sum,sample)=>sum+sample[index],0)/samples.length);existing.lastSeenAt=now;this.flush();return{...existing,descriptor:[...existing.descriptor],descriptors:existing.descriptors.map((sample)=>[...sample])};}
    const item:KnownPerson={id:crypto.randomUUID(),name:clean,descriptor:vector,descriptors:[vector],primary:this.data.knownPeople.length===0,createdAt:now,lastSeenAt:now};
    this.data.knownPeople=[...this.data.knownPeople,item].slice(-100);this.addMemory(`${item.primary?'Primary user is':'Recognizes'} ${clean} by face`,{kind:'person',origin:'user-explicit',confidence:1});this.flush();return{...item,descriptor:[...item.descriptor]};
  }
  markKnownPersonSeen(id:string):KnownPerson{const item=this.data.knownPeople.find((person)=>person.id===id);if(!item)throw new Error('Known person not found.');item.lastSeenAt=new Date().toISOString();this.flush();return{...item,descriptor:[...item.descriptor]};}
  forgetKnownPerson(id:string):boolean{const before=this.data.knownPeople.length;this.data.knownPeople=this.data.knownPeople.filter((item)=>item.id!==id);if(this.data.knownPeople.length===before)return false;this.addTombstone('known-person',id);this.flush();return true;}
  /**
   * Biometric capture — face descriptors and voice embeddings, kept solely
   * to recognize enrolled people for personalization — requires an
   * explicit, versioned acknowledgement before it may run.
   *
   * Enforced here rather than in the renderer so the gate cannot be bypassed by
   * a stale UI or a direct IPC call. Bumping BIOMETRIC_CONSENT_VERSION when the
   * collected data changes re-prompts instead of silently inheriting consent
   * given for something narrower.
   */
  biometricConsentGranted():boolean{
    return (this.data.biometricConsentVersion??0)>=BIOMETRIC_CONSENT_VERSION&&Boolean(this.data.biometricConsentAt);
  }
  private requireBiometricConsent(action:string):void{
    if(this.biometricConsentGranted())return;
    throw new Error(`${action} needs biometric consent. Open Control Center → SYNC + DEVICE, scroll to Biometric Consent, and acknowledge what Axiom collects, where it is stored, and how long it is kept.`);
  }
  biometricConsentState():{acknowledged:boolean;at?:string;version:number;requiredVersion:number}{
    return{acknowledged:this.biometricConsentGranted(),at:this.data.biometricConsentAt,version:this.data.biometricConsentVersion??0,requiredVersion:BIOMETRIC_CONSENT_VERSION};
  }

  /**
   * Biometrics can legitimately fail (camera angle, lighting, a re-enrollment
   * that never saved) and lock the real owner out of every tool for a turn.
   * A stated name ("I am Robbie") cannot be trusted as an unlock, since it's
   * exactly what an intruder would also say — so this is a real secret,
   * scrypt-hashed like the portable-backup passphrase, checked in constant
   * time, and rate-limited so it can't be brute-forced by someone standing
   * in front of the camera repeating guesses.
   */
  hasOwnerOverridePhrase():boolean{return Boolean(this.data.ownerOverridePhraseHash&&this.data.ownerOverridePhraseSalt);}
  setOwnerOverridePhrase(phrase:string):void{
    const clean=phrase.trim();
    if(clean.length<8)throw new Error('Use an owner override phrase of at least 8 characters — not just your name, which anyone could say.');
    const salt=crypto.randomBytes(16);
    this.data.ownerOverridePhraseSalt=salt.toString('base64');
    this.data.ownerOverridePhraseHash=crypto.scryptSync(clean,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('base64');
    this.data.ownerOverrideFailures=0;delete this.data.ownerOverrideLockedUntil;
    this.flush();
  }
  clearOwnerOverridePhrase():void{delete this.data.ownerOverridePhraseHash;delete this.data.ownerOverridePhraseSalt;this.data.ownerOverrideFailures=0;delete this.data.ownerOverrideLockedUntil;this.flush();}
  verifyOwnerOverridePhrase(phrase:string):boolean{
    if(!this.hasOwnerOverridePhrase())return false;
    if(this.data.ownerOverrideLockedUntil&&Date.parse(this.data.ownerOverrideLockedUntil)>Date.now())return false;
    const salt=Buffer.from(this.data.ownerOverridePhraseSalt!,'base64'),expected=Buffer.from(this.data.ownerOverridePhraseHash!,'base64');
    const actual=crypto.scryptSync(String(phrase??'').trim(),salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
    const match=actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
    if(match){this.data.ownerOverrideFailures=0;delete this.data.ownerOverrideLockedUntil;this.flush();return true;}
    this.data.ownerOverrideFailures=(this.data.ownerOverrideFailures??0)+1;
    if(this.data.ownerOverrideFailures>=5){this.data.ownerOverrideLockedUntil=new Date(Date.now()+10*60_000).toISOString();this.data.ownerOverrideFailures=0;}
    this.flush();
    return false;
  }

  /**
   * Lessons about Axiom's own past mistakes — distinct from `memories`,
   * which are facts about the user. Surfaced to the model as context (see
   * `identityAndMemoryContext` in openai.ts) so a bug pattern that was
   * already found and fixed once doesn't need three separate live reports
   * before it's recognized as a pattern again.
   */
  selfCorrections():SelfCorrection[]{return [...this.data.selfCorrections];}
  recordSelfCorrection(pattern:string,mistake:string,fix:string):SelfCorrection[]{
    const clean=pattern.trim();if(!clean)throw new Error('A self-correction needs a pattern to match against future situations.');
    const item:SelfCorrection={id:crypto.randomUUID(),pattern:clean.slice(0,300),mistake:mistake.trim().slice(0,1000),fix:fix.trim().slice(0,1000),createdAt:new Date().toISOString()};
    this.data.selfCorrections=[...this.data.selfCorrections,item].slice(-200);this.flush();void this.attachSelfCorrectionEmbedding(item.id,clean);return this.selfCorrections();
  }
  forgetSelfCorrection(id:string):SelfCorrection[]{this.data.selfCorrections=this.data.selfCorrections.filter((item)=>item.id!==id);this.flush();return this.selfCorrections();}
  private async attachSelfCorrectionEmbedding(id:string,pattern:string):Promise<void>{
    const vector=await embedText(pattern).catch(()=>undefined);
    if(!vector)return;
    const record=this.data.selfCorrections.find((item)=>item.id===id);
    if(!record)return;
    record.embedding=vector;
    this.flush();
  }
  async backfillSelfCorrectionEmbeddings():Promise<void>{
    for(const item of this.data.selfCorrections){
      if(item.embedding)continue;
      await this.attachSelfCorrectionEmbedding(item.id,item.pattern).catch(()=>{});
    }
  }
  /** Same semantic-plus-keyword blend as memory search now uses — a lesson
   * pattern written as "user asks about the weather" used to require the
   * live message to literally share one of those words; a rephrase like
   * "what's it like outside" would miss it entirely despite meaning the
   * same thing. */
  async relevantSelfCorrections(message:string,limit=3):Promise<SelfCorrection[]>{
    const words=new Set(message.toLowerCase().split(/[^a-z0-9']+/).filter((word)=>word.length>3));
    const queryEmbedding=await embedText(message).catch(()=>undefined);
    if(!words.size&&!queryEmbedding)return [];
    return this.data.selfCorrections
      .map((item)=>{
        const keywordHits=item.pattern.toLowerCase().split(/[^a-z0-9']+/).filter((word)=>words.has(word)).length;
        const semantic=queryEmbedding&&item.embedding?Math.max(0,cosineSimilarity(queryEmbedding,item.embedding)):0;
        return{item,keywordHits,semantic,score:keywordHits*2+semantic*3};
      })
      .filter((entry)=>entry.keywordHits>0||entry.semantic>=SEMANTIC_INCLUSION_THRESHOLD)
      .sort((left,right)=>right.score-left.score).slice(0,limit).map((entry)=>entry.item);
  }

  /**
   * A snapshot of the settings-relevant slice of state taken right before
   * `saveSettings` applies a change, so a mistake (fat-fingered retention
   * days, an accidental toggle) has a one-click way back — the same
   * reversibility a code checkpoint gives a file edit, but for settings.
   * Deliberately excludes credentials/biometrics/history: this reverts
   * configuration, not data.
   */
  private static readonly SNAPSHOT_KEYS=['provider','model','providerModels','autoFailover','fallbackOrder','codingProvider','researchProvider','speechProvider','elevenLabsVoiceId','elevenLabsVoiceName','elevenLabsModel','voiceStability','voiceSimilarity','voiceStyle','voiceSpeed','startMicrophoneOn','updateFeedUrl','updateChannel','preferredMicrophoneId','preferredMicrophoneLabel','microphoneNoiseFloor','microphoneSpeechThreshold','speakerLockEnabled','codingWorkspace','deviceName','syncEnabled','syncFolder','automaticBackupsEnabled'] as const;
  private snapshotSettings(label:string):void{
    const data:Partial<StoredData>={};
    for(const key of AppStore.SNAPSHOT_KEYS)(data as Record<string,unknown>)[key]=structuredClone((this.data as unknown as Record<string,unknown>)[key]);
    this.data.lastSettingsSnapshot={at:new Date().toISOString(),label,data};
  }
  lastSettingsSnapshot():SettingsSnapshot|undefined{const snapshot=this.data.lastSettingsSnapshot;return snapshot?{at:snapshot.at,label:snapshot.label}:undefined;}
  revertLastSettingsChange():PublicSettings{
    const snapshot=this.data.lastSettingsSnapshot;
    if(!snapshot)throw new Error('There is no recent settings change to revert.');
    this.data={...this.data,...snapshot.data};
    delete this.data.lastSettingsSnapshot;
    this.flush();
    return this.publicSettings();
  }

  speakerProfiles():SpeakerProfile[]{return this.data.speakerProfiles.map(({samples,...item})=>({...item,sampleCount:samples.length}));}
  enrollSpeaker(name:string,vector:number[]):SpeakerProfile[]{this.requireBiometricConsent('Enrolling a voice');
    if(!safeStorage.isEncryptionAvailable())throw new Error(`${platformProfile().secureStorageLabel} is required before Axiom can retain a voice profile.`);
    const clean=name.trim().replace(/[^\p{L}\p{N}'’ .-]/gu,'').slice(0,48),sample=this.normalizedVoicePrint(vector);if(!clean)throw new Error('Enter the speaker name first.');if(!sample)throw new Error('The voice sample was too short or unclear. Speak naturally for the full enrollment window.');
    const now=new Date().toISOString(),model=sample.length===512?'wavlm-base-plus-sv' as const:'acoustic-v1' as const,existing=this.data.speakerProfiles.find((item)=>item.name.toLowerCase()===clean.toLowerCase());
    if(existing){if(existing.model!==model){existing.model=model;existing.samples=[];existing.threshold=model==='wavlm-base-plus-sv'?.72:.86;}existing.samples=[...existing.samples,sample].slice(-5);existing.sampleCount=existing.samples.length;existing.updatedAt=now;if(existing.samples.length>1){let similarity=1,count=0;for(let left=0;left<existing.samples.length;left++)for(let right=left+1;right<existing.samples.length;right++){similarity=Math.min(similarity,this.voiceSimilarity(existing.samples[left],existing.samples[right]));count++;}if(count)existing.threshold=model==='wavlm-base-plus-sv'?Math.max(.68,Math.min(.84,similarity-.08)):Math.max(.82,Math.min(.92,similarity-.045));}}
    else{const item:SpeakerProfileRecord={id:crypto.randomUUID(),name:clean,model,samples:[sample],sampleCount:1,primary:this.data.speakerProfiles.length===0,threshold:model==='wavlm-base-plus-sv'?.72:.86,createdAt:now,updatedAt:now};this.data.speakerProfiles=[...this.data.speakerProfiles,item].slice(-24);this.addMemory(`${item.primary?'Primary user is':'Recognizes'} ${clean} by enrolled neural voice embedding`,{kind:'person',origin:'user-explicit',confidence:1});}
    this.data.speakerLockEnabled=true;this.flush();return this.speakerProfiles();
  }
  matchSpeaker(vector:number[],visiblePersonName?:string):SpeakerMatch{
    if(!this.data.speakerLockEnabled||!this.data.speakerProfiles.length)return{accepted:true,enrolled:false,score:1,threshold:0,reason:'no-profiles'};
    const sample=this.normalizedVoicePrint(vector);if(!sample)return{accepted:false,enrolled:true,score:0,threshold:.86,reason:'invalid-sample'};
    const model=sample.length===512?'wavlm-base-plus-sv':'acoustic-v1',eligible=this.data.speakerProfiles.filter((profile)=>profile.model===model);if(!eligible.length)return{accepted:false,enrolled:true,score:0,threshold:.72,reason:'reenrollment-required'};
    const candidates=eligible.map((profile)=>({profile,score:Math.max(...profile.samples.map((known)=>this.voiceSimilarity(sample,known)))})).sort((left,right)=>right.score-left.score),best=candidates[0];
    if(!best)return{accepted:false,enrolled:true,score:0,threshold:.72,reason:'rejected'};const visible=visiblePersonName?.trim().toLowerCase(),sameFace=Boolean(visible&&visible===best.profile.name.toLowerCase()),differentKnownFace=Boolean(visible&&this.data.knownPeople.some((person)=>person.name.toLowerCase()===visible)&&!sameFace),minimum=model==='wavlm-base-plus-sv'?.62:.76,maximum=model==='wavlm-base-plus-sv'?.9:.96,threshold=Math.max(minimum,Math.min(maximum,best.profile.threshold-(sameFace?.035:0)+(differentKnownFace?.035:0))),accepted=best.score>=threshold;
    if(accepted){best.profile.lastMatchedAt=new Date().toISOString();best.profile.updatedAt=best.profile.lastMatchedAt;this.flush();}
    return{accepted,enrolled:true,name:accepted?best.profile.name:undefined,profileId:accepted?best.profile.id:undefined,score:best.score,threshold,reason:accepted?'matched':'rejected'};
  }
  forgetSpeaker(id:string):SpeakerProfile[]{const before=this.data.speakerProfiles.length;this.data.speakerProfiles=this.data.speakerProfiles.filter((item)=>item.id!==id);if(before===this.data.speakerProfiles.length)throw new Error('Speaker profile not found.');this.addTombstone('speaker-profile',id);this.flush();return this.speakerProfiles();}
  goals(): GoalItem[] { return [...this.data.goals]; }
  addGoal(title: string): GoalItem { const clean=title.trim().slice(0,500);if(!clean)throw new Error('Goal title is required.');const now=new Date().toISOString();const item:GoalItem={id:crypto.randomUUID(),title:clean,status:'active',createdAt:now,updatedAt:now};this.data.goals=[...this.data.goals,item].slice(-200);this.flush();return item; }
  completeGoal(id: string): GoalItem | undefined { const item=this.data.goals.find((goal)=>goal.id===id);if(!item)return undefined;item.status='completed';item.updatedAt=new Date().toISOString();this.flush();return item; }
  todos():TodoItem[]{return[...this.data.todos].reverse().map((item)=>({...item}));}
  addTodo(text:string):TodoItem{const clean=text.trim().slice(0,500);if(!clean)throw new Error('To-do text is required.');const now=new Date().toISOString(),item:TodoItem={id:crypto.randomUUID(),text:clean,status:'open',createdAt:now,updatedAt:now};this.data.todos=[...this.data.todos,item].slice(-500);this.flush();return{...item};}
  setTodoStatus(id:string,status:TodoItem['status']):TodoItem[]{if(status!=='open'&&status!=='completed')throw new Error('To-do status must be "open" or "completed".');const item=this.data.todos.find((candidate)=>candidate.id===id);if(!item)throw new Error('To-do item not found.');item.status=status;item.updatedAt=new Date().toISOString();if(status==='completed')item.completedAt=item.updatedAt;else delete item.completedAt;this.flush();return this.todos();}
  removeTodo(id:string):TodoItem[]{const before=this.data.todos.length;this.data.todos=this.data.todos.filter((item)=>item.id!==id);if(before===this.data.todos.length)throw new Error('To-do item not found.');this.flush();return this.todos();}
  skills():SkillItem[]{return this.data.skills.map((item)=>({...item}));}
  saveSkill(name:string,description:string,instructions:string):SkillItem{const clean=name.trim().slice(0,80),steps=instructions.trim().slice(0,20_000);if(!clean||!steps)throw new Error('A skill needs a name and instructions.');const now=new Date().toISOString(),existing=this.data.skills.find((item)=>item.name.toLowerCase()===clean.toLowerCase());if(existing){existing.description=description.trim().slice(0,300);existing.instructions=steps;existing.enabled=true;existing.updatedAt=now;this.flush();return{...existing};}const item:SkillItem={id:crypto.randomUUID(),name:clean,description:description.trim().slice(0,300),instructions:steps,enabled:true,createdAt:now,updatedAt:now,runCount:0};this.data.skills=[...this.data.skills,item].slice(-200);this.flush();return{...item};}
  runSkill(name:string):SkillItem{const item=this.data.skills.find((candidate)=>candidate.enabled&&candidate.name.toLowerCase().includes(name.trim().toLowerCase()));if(!item)throw new Error('Enabled skill not found.');item.lastRunAt=new Date().toISOString();item.runCount+=1;item.updatedAt=item.lastRunAt;this.flush();return{...item};}
  removeSkill(name:string):boolean{const removed=this.data.skills.filter((item)=>item.name.toLowerCase()===name.trim().toLowerCase());if(!removed.length)return false;this.data.skills=this.data.skills.filter((item)=>!removed.includes(item));for(const item of removed)this.addTombstone('skill',item.id);this.flush();return true;}
  agents():AgentItem[]{return this.data.agents.map((item)=>({...item,schedule:{...item.schedule}}));}
  saveAgent(name:string,role:string,instructions:string,options?:{schedule?:ScheduleSpec;color?:AppearanceColor;voiceProfileId?:string}):AgentItem{const clean=name.trim().slice(0,60),job=instructions.trim().slice(0,20_000);if(!clean||!job)throw new Error('An agent needs a unique name and instructions.');if(this.data.agents.some((item)=>item.name.toLowerCase()===clean.toLowerCase()))throw new Error('An agent with that name already exists.');const now=new Date().toISOString(),item:AgentItem={id:crypto.randomUUID(),name:clean,role:role.trim().slice(0,120)||'Specialist',instructions:job,enabled:true,createdAt:now,updatedAt:now,runCount:0,schedule:normalizeSchedule(options?.schedule),color:options?.color,voiceProfileId:options?.voiceProfileId?.trim().slice(0,120)||undefined};this.data.agents=[...this.data.agents,item].slice(-100);this.flush();return{...item,schedule:{...item.schedule}};}
  runAgent(name:string):AgentItem{const item=this.data.agents.find((candidate)=>candidate.enabled&&candidate.name.toLowerCase().includes(name.trim().toLowerCase()));if(!item)throw new Error('Enabled agent not found.');item.lastRunAt=new Date().toISOString();item.runCount+=1;item.updatedAt=item.lastRunAt;this.flush();return{...item};}
  removeAgent(name:string):boolean{const removed=this.data.agents.filter((item)=>item.name.toLowerCase()===name.trim().toLowerCase());if(!removed.length)return false;this.data.agents=this.data.agents.filter((item)=>!removed.includes(item));for(const item of removed)this.addTombstone('agent',item.id);this.flush();return true;}
  findAgent(id:string):AgentItem|undefined{const item=this.data.agents.find((candidate)=>candidate.id===id);return item?{...item,schedule:{...item.schedule}}:undefined;}
  setAgentEnabled(id:string,enabled:boolean):AgentItem{const item=this.data.agents.find((candidate)=>candidate.id===id);if(!item)throw new Error('Agent not found.');item.enabled=enabled;item.updatedAt=new Date().toISOString();if(enabled)item.schedule=normalizeSchedule(item.schedule);this.flush();return{...item,schedule:{...item.schedule}};}
  dueAgents(at=new Date()):AgentItem[]{return this.data.agents.filter((item)=>item.enabled&&scheduleIsDue(item.schedule,at)).map((item)=>({...item,schedule:{...item.schedule}}));}
  beginAgentRun(id:string):AgentRunItem{const agent=this.data.agents.find((item)=>item.id===id);if(!agent||!agent.enabled)throw new Error('Enabled agent not found.');const now=new Date().toISOString(),task=this.beginRuntimeTask(`${agent.name}: ${agent.instructions}`,'read','agent'),run:AgentRunItem={id:crypto.randomUUID(),agentId:agent.id,agentName:agent.name,status:'active',startedAt:now,taskId:task.id};agent.lastRunAt=now;agent.runCount+=1;agent.updatedAt=now;agent.schedule=advanceSchedule(agent.schedule,new Date(now));this.data.agentRuns=[...this.data.agentRuns,run].slice(-500);this.flush();return{...run};}
  finishAgentRun(runId:string,status:'completed'|'failed',summary:string):AgentRunItem{const run=this.data.agentRuns.find((item)=>item.id===runId);if(!run)throw new Error('Agent run not found.');const now=new Date().toISOString();run.status=status;run.completedAt=now;run.summary=summary.trim().slice(0,3000);const agent=this.data.agents.find((item)=>item.id===run.agentId);if(agent){agent.lastStatus=status;agent.lastResult=run.summary;agent.updatedAt=now;}if(run.taskId)this.settleRuntimeTask(run.taskId,status==='completed'?'completed':'failed',run.summary);this.flush();return{...run};}
  agentRuns():AgentRunItem[]{return[...this.data.agentRuns].reverse().map((item)=>({...item}));}
  removeAgentById(id:string):boolean{const item=this.data.agents.find((candidate)=>candidate.id===id);return item?this.removeAgent(item.name):false;}
  monitors():MonitorItem[]{return[...this.data.monitors].reverse().map((item)=>({...item}));}
  addMonitor(input:{title:string;instruction:string;source:'screen'|'camera';intervalSeconds?:number;durationMinutes?:number}):MonitorItem{const title=input.title.trim().slice(0,120),instruction=input.instruction.trim().slice(0,1000);if(!title||!instruction)throw new Error('A monitor needs a title and a condition to watch for.');if(input.source!=='screen'&&input.source!=='camera')throw new Error('Monitor source must be screen or camera.');const now=new Date(),intervalSeconds=Math.max(15,Math.min(3600,Math.round(input.intervalSeconds||60))),duration=Math.max(1,Math.min(7*24*60,Math.round(input.durationMinutes||60))),item:MonitorItem={id:crypto.randomUUID(),title,instruction,source:input.source,intervalSeconds,status:'active',createdAt:now.toISOString(),updatedAt:now.toISOString(),nextRunAt:new Date(now.getTime()+intervalSeconds*1000).toISOString(),endsAt:new Date(now.getTime()+duration*60_000).toISOString()};this.data.monitors=[...this.data.monitors,item].slice(-100);this.flush();return{...item};}
  dueMonitors(at=new Date()):MonitorItem[]{const timestamp=at.getTime();let changed=false;for(const item of this.data.monitors){if(item.status==='active'&&item.endsAt&&Date.parse(item.endsAt)<=timestamp){item.status='stopped';item.updatedAt=at.toISOString();item.lastObservation='Monitoring window ended without a trigger.';changed=true;}}if(changed)this.flush();return this.data.monitors.filter((item)=>item.status==='active'&&Date.parse(item.nextRunAt)<=timestamp).map((item)=>({...item}));}
  settleMonitor(id:string,status:Extract<MonitorItem['status'],'active'|'triggered'|'stopped'|'failed'>,observation:string,at=new Date()):MonitorItem{const item=this.data.monitors.find((candidate)=>candidate.id===id);if(!item)throw new Error('Monitor not found.');item.status=status;item.lastRunAt=at.toISOString();item.updatedAt=item.lastRunAt;item.lastObservation=observation.trim().slice(0,2000);if(status==='active')item.nextRunAt=new Date(at.getTime()+item.intervalSeconds*1000).toISOString();this.flush();return{...item};}
  addBackgroundEvent(kind:BackgroundEvent['kind'],title:string,text:string,speak=true,taskId?:string):BackgroundEvent{const item:BackgroundEvent={id:crypto.randomUUID(),kind,title:title.trim().slice(0,120),text:text.trim().slice(0,3000),createdAt:new Date().toISOString(),speak,read:false,taskId};this.data.backgroundEvents=[...this.data.backgroundEvents,item].slice(-500);this.flush();return{...item};}
  backgroundEvents():BackgroundEvent[]{return[...this.data.backgroundEvents].reverse().map((item)=>({...item}));}
  markBackgroundEventRead(id:string):void{const item=this.data.backgroundEvents.find((candidate)=>candidate.id===id);if(item){item.read=true;this.flush();}}
  setAppearance(appearance: AppearanceSettings): AppearanceSettings { this.data.appearance=normalizeAppearance(appearance);this.data.appearanceUpdatedAt=new Date().toISOString();this.flush();return{...this.data.appearance}; }
  observeDesktopTool(toolName:string,args:Record<string,unknown>,output:string,at=new Date().toISOString()):void{const graph={entities:this.data.desktopEntities,relations:this.data.desktopRelations,observations:this.data.desktopObservations};ingestDesktopToolResult(graph,toolName,args,output,at);this.data.desktopEntities=graph.entities;this.data.desktopRelations=graph.relations;this.data.desktopObservations=graph.observations;this.flush();}
  desktopGraph():DesktopGraphSnapshot{return snapshotDesktopGraph({entities:this.data.desktopEntities,relations:this.data.desktopRelations,observations:this.data.desktopObservations});}
  queryDesktopObjects(query:string,limit=20):DesktopEntity[]{return queryDesktopGraph({entities:this.data.desktopEntities,relations:this.data.desktopRelations,observations:this.data.desktopObservations},query,limit);}
  codingWorkspace(): string { return this.data.codingWorkspace || path.join(app.getPath('documents'), 'Axiom Projects'); }
  permissionEnabled(id:string,defaultValue=true):boolean{return this.data.permissionOverrides[id]??defaultValue;}
  setPermission(id:string,enabled:boolean):void{this.data.permissionOverrides[id]=enabled;this.flush();}
  audit():AuditItem[]{return[...this.data.audit].reverse();}
  appendAudit(events:ToolEvent[],taskId?:string):void{if(!events.length)return;const normalized=events.map((event)=>({...event,actionId:event.actionId??crypto.randomUUID(),evidenceId:event.status==='verified'?(event.evidenceId??crypto.randomUUID()):event.evidenceId}));this.data.audit=[...this.data.audit,...normalized.map((event)=>({...event,id:crypto.randomUUID()}))].slice(-500);const added=normalized.map((event)=>actionEvidence(event,taskId)).filter((item):item is EvidenceItem=>Boolean(item));this.data.evidence=[...this.data.evidence,...added].slice(-1000);if(taskId){const task=this.data.runtimeTasks.find((item)=>item.id===taskId);if(task){task.actionIds=[...new Set([...task.actionIds,...normalized.map((event)=>event.actionId!).filter(Boolean)])];task.updatedAt=new Date().toISOString();}for(const event of normalized){if(!event.approvalId)continue;const approval=this.data.approvals.find((item)=>item.id===event.approvalId);if(approval&&!approval.sourceTaskId)approval.sourceTaskId=taskId;}}this.flush();}
  clearAudit():void{this.data.audit=[];this.flush();}
  beginRuntimeTask(title:string,risk:RuntimeRisk,source:RuntimeTask['source']='conversation'):RuntimeTask{const now=new Date().toISOString(),summary='Request received and entered into the durable runtime.';const task:RuntimeTask={id:crypto.randomUUID(),title:title.trim().slice(0,500),status:'active',phase:'interpreting',risk,source,createdAt:now,updatedAt:now,successCriteria:'Complete the requested outcome and retain verified evidence for every computer action.',attempt:1,maxAttempts:3,timeline:[{id:crypto.randomUUID(),phase:'received',at:now,summary},{id:crypto.randomUUID(),phase:'interpreting',at:now,summary:'Classifying intent, risk, and available capability routes.'}],actionIds:[]};this.data.runtimeTasks=[...this.data.runtimeTasks,task].slice(-200);this.flush();return structuredClone(task);}
  transitionRuntimeTask(id:string,phase:RuntimeTaskPhase,summary:string,options:{blocker?:string;nextAction?:string}={}):RuntimeTask|undefined{const task=this.data.runtimeTasks.find((item)=>item.id===id);if(!task)return undefined;const now=new Date().toISOString();task.phase=phase;task.updatedAt=now;task.summary=summary.trim().slice(0,1000);task.timeline=[...task.timeline,{id:crypto.randomUUID(),phase,at:now,summary:task.summary}].slice(-80);if(options.blocker)task.blocker=options.blocker.slice(0,1000);else if(!['blocked','awaiting-approval'].includes(phase))delete task.blocker;if(options.nextAction)task.nextAction=options.nextAction.slice(0,1000);else if(['completed','cancelled'].includes(phase))delete task.nextAction;this.flush();return structuredClone(task);}
  resumeRuntimeTask(id:string,title?:string):RuntimeTask{const task=this.data.runtimeTasks.find((item)=>item.id===id);if(!task)throw new Error('Interrupted task not found.');if(!['blocked','failed','waiting','queued'].includes(task.status))throw new Error(`Task cannot resume from ${task.status}.`);const now=new Date().toISOString();task.status='active';task.phase='recovering';task.attempt=Math.min(task.maxAttempts,task.attempt+1);task.updatedAt=now;task.summary='Resumed from the last verified checkpoint; replanning a safe alternate route.';task.timeline=[...task.timeline,{id:crypto.randomUUID(),phase:'recovering' as const,at:now,summary:task.summary}].slice(-80);delete task.blocker;delete task.completedAt;if(title?.trim())task.title=title.trim().slice(0,500);this.flush();return structuredClone(task);}
  settleRuntimeTask(id:string,status:Extract<RuntimeTaskStatus,'waiting'|'completed'|'failed'|'blocked'|'cancelled'>,summary?:string,phase?:RuntimeTaskPhase,options:{blocker?:string;nextAction?:string}={}):RuntimeTask|undefined{const task=this.data.runtimeTasks.find((item)=>item.id===id);if(!task)return undefined;const now=new Date().toISOString(),resolvedPhase=phase??(status==='waiting'?'awaiting-approval':status==='completed'?'completed':status==='cancelled'?'cancelled':'blocked');task.status=status;task.phase=resolvedPhase;task.updatedAt=now;if(['completed','failed','cancelled'].includes(status))task.completedAt=now;else delete task.completedAt;task.summary=summary?.trim().slice(0,1000);task.timeline=[...task.timeline,{id:crypto.randomUUID(),phase:resolvedPhase,at:now,summary:task.summary||status}].slice(-80);if(options.blocker)task.blocker=options.blocker.slice(0,1000);else if(!['blocked','awaiting-approval'].includes(resolvedPhase))delete task.blocker;if(options.nextAction)task.nextAction=options.nextAction.slice(0,1000);else if(['completed','cancelled'].includes(resolvedPhase))delete task.nextAction;this.flush();return structuredClone(task);}
  runtimeTasks():RuntimeTask[]{return[...this.data.runtimeTasks].reverse().map((item)=>structuredClone(normalizeRuntimeTask(item)));}
  evidence():EvidenceItem[]{return[...this.data.evidence].reverse().map((item)=>({...item}));}
  commitments():CommitmentItem[]{return[...this.data.commitments].reverse().map((item)=>({...item}));}
  addCommitment(title:string,dueAt?:string,sourceTaskId?:string):CommitmentItem{const clean=title.trim().slice(0,500);if(!clean)throw new Error('Commitment title is required.');let normalizedDue:string|undefined;if(dueAt?.trim()){const parsed=new Date(dueAt);if(Number.isNaN(parsed.getTime()))throw new Error('Commitment due date is invalid.');normalizedDue=parsed.toISOString();}const now=new Date().toISOString();const item:CommitmentItem={id:crypto.randomUUID(),title:clean,status:'open',dueAt:normalizedDue,createdAt:now,updatedAt:now,sourceTaskId};this.data.commitments=[...this.data.commitments,item].slice(-300);this.flush();return{...item};}
  dueCommitments(at=new Date()):CommitmentItem[]{return this.data.commitments.filter((item)=>item.status==='open'&&item.dueAt&&Date.parse(item.dueAt)<=at.getTime()&&(!item.lastNotifiedAt||Date.parse(item.lastNotifiedAt)<Date.parse(item.dueAt))).map((item)=>({...item}));}
  markCommitmentNotified(id:string,at=new Date().toISOString()):void{const item=this.data.commitments.find((candidate)=>candidate.id===id);if(item){item.lastNotifiedAt=at;item.updatedAt=at;this.flush();}}
  resolveCommitment(id:string,status:Extract<CommitmentItem['status'],'fulfilled'|'cancelled'>):CommitmentItem|undefined{const item=this.data.commitments.find((candidate)=>candidate.id===id);if(!item)return undefined;item.status=status;item.updatedAt=new Date().toISOString();this.flush();return{...item};}
  approvals():ApprovalRequest[]{this.expireApprovals();return[...this.data.approvals].reverse().map(({encryptedArgs:_encryptedArgs,...item})=>({...item}));}
  requestApproval(toolName:string,args:Record<string,unknown>,risk:ApprovalRequest['risk'],preview:string,recovery:string):ApprovalRequest{this.expireApprovals();const argsDigest=stableActionDigest(toolName,args);const existing=this.data.approvals.find((item)=>item.status==='pending'&&item.toolName===toolName&&item.argsDigest===argsDigest);if(existing){const{encryptedArgs:_encryptedArgs,...publicItem}=existing;return{...publicItem};}const serialized=JSON.stringify(args);if(serialized.length>20_000)throw new Error('Approval payload exceeds the safety limit.');if(!safeStorage.isEncryptionAvailable())throw new Error(`${platformProfile().secureStorageLabel} is required for consequential action approvals.`);const now=new Date(),id=crypto.randomUUID();let code='';do{code=`AX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;}while(this.data.approvals.some((item)=>item.code===code));const item:StoredApproval={id,code,toolName,status:'pending',risk,preview:preview.slice(0,600),recovery:recovery.slice(0,600),argsDigest,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+15*60_000).toISOString(),encryptedArgs:safeStorage.encryptString(serialized).toString('base64')};this.data.approvals=[...this.data.approvals,item].slice(-200);this.flush();const{encryptedArgs:_encryptedArgs,...publicItem}=item;return{...publicItem};}
  authorizeApproval(toolName:string,args:Record<string,unknown>,userMessage?:string):ApprovalRequest|undefined{this.expireApprovals();const argsDigest=stableActionDigest(toolName,args);const item=this.data.approvals.find((candidate)=>candidate.status==='pending'&&candidate.toolName===toolName&&candidate.argsDigest===argsDigest);if(!item||!userMessage||!new RegExp(`\\bAPPROVE\\s+${item.code.replace('-','\\-')}\\b`,'i').test(userMessage))return undefined;item.status='approved';item.decidedAt=new Date().toISOString();this.flush();const{encryptedArgs:_encryptedArgs,...publicItem}=item;return{...publicItem};}
  approvalPayload(idOrCode:string):(ApprovalRequest&{args:Record<string,unknown>})|undefined{this.expireApprovals();const item=this.data.approvals.find((candidate)=>(candidate.id===idOrCode||candidate.code.toUpperCase()===idOrCode.toUpperCase())&&candidate.status==='pending');if(!item||!safeStorage.isEncryptionAvailable())return undefined;try{const args=JSON.parse(safeStorage.decryptString(Buffer.from(item.encryptedArgs,'base64'))) as Record<string,unknown>;const{encryptedArgs:_encryptedArgs,...publicItem}=item;return{...publicItem,args};}catch{return undefined;}}
  denyApproval(id:string):ApprovalRequest|undefined{this.expireApprovals();const item=this.data.approvals.find((candidate)=>candidate.id===id&&candidate.status==='pending');if(!item)return undefined;item.status='denied';item.decidedAt=new Date().toISOString();this.flush();const{encryptedArgs:_encryptedArgs,...publicItem}=item;return{...publicItem};}
  finishApproval(id:string,status:'executed'|'failed',summary:string):void{const item=this.data.approvals.find((candidate)=>candidate.id===id);if(!item)return;item.status=status;item.decidedAt=item.decidedAt??new Date().toISOString();item.resultSummary=summary.slice(0,600);this.flush();}
  saveVoiceProfile(name:string):PublicSettings{const clean=name.trim().slice(0,60);if(!clean)throw new Error('Name this voice profile first.');const replaced=this.data.voiceProfiles.filter((item)=>item.name.toLowerCase()===clean.toLowerCase());for(const item of replaced)this.addTombstone('voice-profile',item.id);const profile:VoiceProfile={id:crypto.randomUUID(),name:clean,provider:this.data.speechProvider,elevenLabsVoiceId:this.data.elevenLabsVoiceId,elevenLabsVoiceName:this.data.elevenLabsVoiceName,elevenLabsModel:this.data.elevenLabsModel,stability:this.data.voiceStability,similarity:this.data.voiceSimilarity,style:this.data.voiceStyle,speed:this.data.voiceSpeed};this.data.voiceProfiles=[...this.data.voiceProfiles.filter((item)=>item.name.toLowerCase()!==clean.toLowerCase()),profile].slice(-24);this.data.activeVoiceProfileId=profile.id;this.flush();return this.publicSettings();}
  activateVoiceProfile(id:string):PublicSettings{const profile=this.data.voiceProfiles.find((item)=>item.id===id);if(!profile)throw new Error('Voice profile not found.');this.data.activeVoiceProfileId=profile.id;this.data.speechProvider=profile.provider;this.data.elevenLabsVoiceId=profile.elevenLabsVoiceId;this.data.elevenLabsVoiceName=profile.elevenLabsVoiceName;this.data.elevenLabsModel=profile.elevenLabsModel;this.data.voiceStability=profile.stability;this.data.voiceSimilarity=profile.similarity;this.data.voiceStyle=profile.style;this.data.voiceSpeed=profile.speed;this.flush();return this.publicSettings();}
  deleteVoiceProfile(id:string):PublicSettings{this.data.voiceProfiles=this.data.voiceProfiles.filter((item)=>item.id!==id);this.addTombstone('voice-profile',id);if(this.data.activeVoiceProfileId===id)this.data.activeVoiceProfileId='';this.flush();return this.publicSettings();}

  devicePresence(now=new Date().toISOString()):DevicePresence{const platform=platformProfile(),active=Date.parse(now)-Date.parse(this.data.deviceLastActiveAt)<30_000;return{id:this.data.deviceId,name:this.data.deviceName,platform:platform.id,hostname:os.hostname(),architecture:os.arch(),appVersion:app.getVersion(),sessionId:this.sessionId,sessionState:active?'active':'idle',heartbeatAt:now,firstSeenAt:this.data.deviceFirstSeenAt,lastSeenAt:now,lastActiveAt:this.data.deviceLastActiveAt};}
  syncConfiguration():{enabled:boolean;folder:string;passphrase:string}{return{enabled:this.data.syncEnabled,folder:this.data.syncFolder,passphrase:this.decryptKey(this.data.encryptedSyncPassphrase)};}
  syncStatus(syncing=false):SyncStatus{const configured=Boolean(this.data.syncFolder&&this.data.encryptedSyncPassphrase),enabled=this.data.syncEnabled,now=new Date().toISOString(),device=this.devicePresence(now),peers=this.data.syncPeers.filter((item)=>item.id!==this.data.deviceId).map((item)=>({...item,sessionId:item.sessionId||'legacy',sessionState:item.sessionState||'idle',heartbeatAt:item.heartbeatAt||item.lastSeenAt})).sort((a,b)=>Date.parse(b.heartbeatAt||b.lastSeenAt)-Date.parse(a.heartbeatAt||a.lastSeenAt)),livePeers=peers.filter((item)=>Date.parse(now)-Date.parse(item.heartbeatAt||item.lastSeenAt)<40_000),activeDevices=[device,...livePeers].filter((item)=>item.sessionState==='active'),voiceOwner=(activeDevices.length?activeDevices:[device]).sort((a,b)=>Date.parse(b.lastActiveAt||b.heartbeatAt||b.lastSeenAt)-Date.parse(a.lastActiveAt||a.heartbeatAt||a.lastSeenAt))[0];return{enabled,configured,syncing,state:syncing?'syncing':!enabled?'off':!configured?'setup':this.data.lastSyncError?'error':'ready',folder:this.data.syncFolder,device,peers,voiceOwnedHere:!enabled||!configured||voiceOwner?.id===device.id,voiceOwner,lastSyncAt:this.data.lastSyncAt,lastError:this.data.lastSyncError};}
  noteDeviceActivity(at=new Date().toISOString()):void{this.data.deviceLastActiveAt=at;this.flush();}
  exportSyncPayload(now=new Date().toISOString()):SyncPayload{return{schema:1,writtenAt:now,device:this.devicePresence(now),history:this.data.history.map((item)=>({...item})),memories:this.data.memories.map((item)=>({...item})),goals:this.data.goals.map((item)=>({...item})),skills:this.data.skills.map((item)=>({...item})),agents:this.data.agents.map((item)=>({...item,schedule:{...item.schedule}})),commitments:this.data.commitments.map((item)=>({...item})),todos:this.data.todos.map((item)=>({...item})),monitors:this.data.monitors.map((item)=>({...item})),voiceProfiles:this.data.voiceProfiles.map((item)=>({...item})),speakerProfiles:this.data.speakerProfiles.map((item)=>({...item,samples:item.samples.map((sample)=>[...sample])})),knownPeople:this.data.knownPeople.map((item)=>({...item,descriptor:[...item.descriptor]})),appearance:{value:{...this.data.appearance},updatedAt:this.data.appearanceUpdatedAt},tombstones:this.data.syncTombstones.map((item)=>({...item}))};}
  mergeSyncPayload(payload:SyncPayload):void{
    if(payload.schema!==1||!payload.device?.id)return;
    const tombstones=new Map<string,SyncTombstone>();for(const item of [...this.data.syncTombstones,...(payload.tombstones||[])]){const key=`${item.entity}:${item.id}`,current=tombstones.get(key);if(!current||Date.parse(item.deletedAt)>Date.parse(current.deletedAt))tombstones.set(key,item);}this.data.syncTombstones=[...tombstones.values()].sort((a,b)=>Date.parse(a.deletedAt)-Date.parse(b.deletedAt)).slice(-2000);
    const alive=<T extends {id:string}>(entity:SyncTombstone['entity'],items:T[],stamp:(item:T)=>number=recordTime):T[]=>items.filter((item)=>{const deleted=tombstones.get(`${entity}:${item.id}`);return!deleted||Date.parse(deleted.deletedAt)<stamp(item);});
    this.data.history=alive('history',mergeRecords(this.data.history,payload.history||[],200),(item)=>Date.parse(item.createdAt)||0);
    this.data.memories=alive('memory',mergeRecords(this.data.memories,payload.memories||[],300));
    this.data.goals=mergeRecords(this.data.goals,payload.goals||[],200);
    this.data.skills=alive('skill',mergeRecords(this.data.skills,payload.skills||[],200));
    this.data.agents=alive('agent',mergeRecords(this.data.agents,payload.agents||[],100));
    this.data.commitments=mergeRecords(this.data.commitments,payload.commitments||[],300);
    this.data.todos=mergeRecords(this.data.todos,payload.todos||[],500);
    this.data.monitors=mergeRecords(this.data.monitors,payload.monitors||[],100);
    this.data.voiceProfiles=alive('voice-profile',mergeRecords(this.data.voiceProfiles,payload.voiceProfiles||[],24,));
    this.data.speakerProfiles=alive('speaker-profile',mergeRecords(this.data.speakerProfiles,this.normalizeSpeakerProfiles(payload.speakerProfiles),24));
    const remotePeople=(payload.knownPeople||[]).filter((item):item is KnownPerson=>Boolean(item&&typeof item.id==='string'&&typeof item.name==='string'&&Array.isArray(item.descriptor)&&item.descriptor.length===128&&item.descriptor.every(Number.isFinite)));
    this.data.knownPeople=alive('known-person',mergeRecords(this.data.knownPeople,remotePeople,100));
    if(payload.appearance&&Date.parse(payload.appearance.updatedAt)>Date.parse(this.data.appearanceUpdatedAt)){this.data.appearance=normalizeAppearance(payload.appearance.value);this.data.appearanceUpdatedAt=payload.appearance.updatedAt;}
    const peerMap=new Map(this.data.syncPeers.map((item)=>[item.id,item]));const current=peerMap.get(payload.device.id);if(!current||Date.parse(payload.device.lastSeenAt)>=Date.parse(current.lastSeenAt))peerMap.set(payload.device.id,{...payload.device});this.data.syncPeers=[...peerMap.values()].slice(-20);
    this.flush();
  }
  recordSyncSuccess(at:string,devices:DevicePresence[]):void{this.data.lastSyncAt=at;delete this.data.lastSyncError;const peers=new Map(this.data.syncPeers.map((item)=>[item.id,item]));for(const item of devices){const current=peers.get(item.id);if(!current||Date.parse(item.lastSeenAt)>=Date.parse(current.lastSeenAt))peers.set(item.id,item);}this.data.syncPeers=[...peers.values()].slice(-20);this.flush();}
  recordSyncError(message:string):void{this.data.lastSyncError=message.slice(0,500);this.flush();}

  connectorStatuses():ConnectorStatus[]{
    const definitions:Record<ConnectorId,{label:string;hint:string}>={google:{label:'Google Gmail + Calendar',hint:'Add a Google Desktop OAuth client ID, then choose Connect.'},shopify:{label:'Shopify Admin',hint:'Enter the myshopify.com store domain and a scoped Admin API access token.'},meta:{label:'Meta Insights',hint:'Enter an ad account ID and a scoped Meta Graph API access token.'},dropbox:{label:'Dropbox',hint:'Enter a scoped access token, or an app key before connecting with PKCE.'},homebridge:{label:'Homebridge Config UI X',hint:'Enter the Homebridge UI URL and the username/password you sign in with. Axiom logs in, caches the session, and verifies every device action by reading the resulting accessory state. Homebridge must be running in Insecure Mode (Homebridge Settings → Insecure Mode, or start it with -I) — that’s what its own accessory-control API requires.'},ring:{label:'Ring',hint:'Enter your Ring account email and password, then Connect. If your account uses 2FA, Axiom will ask for the verification code as a second step. Live view only — no snapshots or recordings are stored.'},stripe:{label:'Stripe',hint:'Enter a restricted Stripe API secret key (Developers → API keys → Create restricted key) with read access to Balances, Charges, Customers, and Payment Intents. Axiom only reads payment data — it never creates a charge, refund, or payout.'},klaviyo:{label:'Klaviyo',hint:'Enter a Klaviyo Private API Key (Settings → API Keys → Create Private API Key) with read access to campaigns and metrics.'},whatsapp:{label:'WhatsApp Business',hint:'Enter the Phone Number ID and a scoped access token from your Meta WhatsApp Business app (developers.facebook.com). WhatsApp only allows free-form messages within 24 hours of the other person\'s last message to you; outside that window only a pre-approved template message can be sent.'}};
    return(Object.keys(definitions) as ConnectorId[]).map((id)=>{const value=this.data.connectors.find((item)=>item.id===id),definition=definitions[id],expired=Boolean(value?.expiresAt&&Date.parse(value.expiresAt)<=Date.now());return{id,label:definition.label,configured:Boolean(value&&(value.clientId||value.encryptedAccessToken||value.encryptedClientSecret)),connected:Boolean(value?.encryptedAccessToken&&!expired),account:value?.account||'',endpoint:value?.endpoint||'',scopes:[...(value?.scopes||[])],expiresAt:value?.expiresAt,lastCheckedAt:value?.lastCheckedAt,lastError:value?.lastError,setupHint:definition.hint};});
  }
  saveConnector(input:ConnectorSetup):ConnectorStatus[]{if(!['google','shopify','meta','dropbox','homebridge','ring','stripe','klaviyo','whatsapp'].includes(input.id))throw new Error('Unknown connector.');const now=new Date().toISOString(),existing=this.data.connectors.find((item)=>item.id===input.id),item:StoredConnector=existing??{id:input.id,account:'',endpoint:'',clientId:'',scopes:[],updatedAt:now};if(input.account!==undefined)item.account=input.account.trim().slice(0,200);if(input.endpoint!==undefined){const raw=input.endpoint.trim().replace(/\/$/,'');item.endpoint=(input.id==='homebridge'?raw:raw.replace(/^https?:\/\//i,'')).slice(0,300);}if(input.clientId!==undefined)item.clientId=input.clientId.trim().slice(0,500);if(input.scopes)item.scopes=input.scopes.map((scope)=>scope.trim()).filter(Boolean).slice(0,30);if(input.expiresAt!==undefined)item.expiresAt=Number.isFinite(Date.parse(input.expiresAt))?new Date(input.expiresAt).toISOString():undefined;if(input.clearSecrets){delete item.encryptedClientSecret;delete item.encryptedAccessToken;delete item.encryptedRefreshToken;delete item.expiresAt;}if(input.clientSecret?.trim())item.encryptedClientSecret=this.encryptSecret(input.clientSecret.trim());if(input.accessToken?.trim())item.encryptedAccessToken=this.encryptSecret(input.accessToken.trim());if(input.refreshToken?.trim())item.encryptedRefreshToken=this.encryptSecret(input.refreshToken.trim());item.updatedAt=now;delete item.lastError;if(!existing)this.data.connectors.push(item);this.flush();return this.connectorStatuses();}
  connectorCredentials(id:ConnectorId):{account:string;endpoint:string;clientId:string;clientSecret:string;accessToken:string;refreshToken:string;expiresAt?:string;scopes:string[]}{const item=this.data.connectors.find((candidate)=>candidate.id===id);if(!item)return{account:'',endpoint:'',clientId:'',clientSecret:'',accessToken:'',refreshToken:'',scopes:[]};return{account:item.account,endpoint:item.endpoint,clientId:item.clientId,clientSecret:this.decryptKey(item.encryptedClientSecret),accessToken:this.decryptKey(item.encryptedAccessToken),refreshToken:this.decryptKey(item.encryptedRefreshToken),expiresAt:item.expiresAt,scopes:[...item.scopes]};}
  updateConnectorTokens(id:ConnectorId,input:{accessToken:string;refreshToken?:string;expiresAt?:string;scopes?:string[]}):void{this.saveConnector({id,accessToken:input.accessToken,refreshToken:input.refreshToken,expiresAt:input.expiresAt,scopes:input.scopes});}
  recordConnectorCheck(id:ConnectorId,error?:string):void{const item=this.data.connectors.find((candidate)=>candidate.id===id);if(!item)return;item.lastCheckedAt=new Date().toISOString();if(error)item.lastError=error.slice(0,500);else delete item.lastError;this.flush();}
  disconnectConnector(id:ConnectorId):ConnectorStatus[]{const item=this.data.connectors.find((candidate)=>candidate.id===id);if(item){delete item.encryptedAccessToken;delete item.encryptedRefreshToken;delete item.expiresAt;item.updatedAt=new Date().toISOString();this.flush();}return this.connectorStatuses();}
  mediaArtifacts():MediaArtifact[]{return[...this.data.mediaArtifacts].reverse().map((item)=>({...item}));}
  saveMediaArtifact(item:MediaArtifact):MediaArtifact{const index=this.data.mediaArtifacts.findIndex((candidate)=>candidate.id===item.id);if(index>=0)this.data.mediaArtifacts[index]={...item};else this.data.mediaArtifacts=[...this.data.mediaArtifacts,{...item}].slice(-200);this.flush();return{...item};}

  createBackup():{path:string;bytes:number;sha256:string;createdAt:string}{
    this.flush();const createdAt=new Date().toISOString(),folder=path.join(app.getPath('desktop'),'Axiom Backups');fs.mkdirSync(folder,{recursive:true});
    const target=path.join(folder,`Axiom-backup-${createdAt.replace(/[:.]/g,'-')}.json`);fs.copyFileSync(this.file,target);const bytes=fs.statSync(target).size,sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');return{path:target,bytes,sha256,createdAt};
  }
  /**
   * A portable backup re-encrypts every secret under a user passphrase instead of
   * the machine's os_crypt key, so it can be restored on another computer or
   * platform. A plain file copy cannot: safeStorage ciphertext is bound to the
   * profile's Local State key, which never leaves this machine and user.
   */
  createPortableBackup(passphrase:string,targetPath?:string):{path:string;bytes:number;sha256:string;createdAt:string;secrets:number;skipped:string[]}{
    const clean=String(passphrase??'');
    if(clean.length<12)throw new Error('Choose a backup passphrase of at least 12 characters. It cannot be recovered if lost.');
    this.flush();
    const createdAt=new Date().toISOString();
    const raw=JSON.parse(fs.readFileSync(this.file,'utf8')) as Record<string,unknown>;

    const salt=crypto.randomBytes(16),kdf={algorithm:'scrypt' as const,N:32768,r:8,p:1,keyLength:32,salt:salt.toString('base64')};
    const key=crypto.scryptSync(clean,salt,kdf.keyLength,{N:kdf.N,r:kdf.r,p:kdf.p,maxmem:96*1024*1024});
    const seal=(plaintext:string)=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);return{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};};

    const secrets:Record<string,{iv:string;tag:string;data:string}>={};
    const skipped:string[]=[];
    const carry=(pointer:string,ciphertext?:string)=>{
      if(!ciphertext)return;
      const plaintext=this.decryptKey(ciphertext);
      // An unreadable secret is dropped and named, never written as ciphertext
      // that the restoring machine could not decrypt anyway.
      if(!plaintext){skipped.push(pointer);return;}
      secrets[pointer]=seal(plaintext);
    };

    for(const field of Object.keys(raw).filter((name)=>/^encrypted/.test(name)))carry(field,raw[field] as string);
    const connectors=Array.isArray(raw.connectors)?raw.connectors as StoredConnector[]:[];
    connectors.forEach((connector,index)=>{
      for(const field of ['encryptedClientSecret','encryptedAccessToken','encryptedRefreshToken'] as const)carry(`connectors.${index}.${field}`,connector[field]);
    });

    // Machine-bound ciphertext is removed from the plain body: the portable copy
    // is the only representation of a secret in this file.
    const body:Record<string,unknown>={...raw};
    for(const field of Object.keys(body).filter((name)=>/^encrypted/.test(name)))delete body[field];
    body.connectors=connectors.map((connector)=>{const{encryptedClientSecret:_a,encryptedAccessToken:_b,encryptedRefreshToken:_c,...rest}=connector;return rest;});

    const payload={format:'axiom-portable-backup',version:1,appVersion:app.getVersion(),createdAt,platform:platformProfile().id,kdf,cipher:'aes-256-gcm',secrets,data:body};
    const folder=targetPath?path.dirname(targetPath):path.join(app.getPath('desktop'),'Axiom Backups');
    fs.mkdirSync(folder,{recursive:true});
    const target=targetPath??path.join(folder,`Axiom-portable-${createdAt.replace(/[:.]/g,'-')}.axiombackup`);
    fs.writeFileSync(target,JSON.stringify(payload,null,2),'utf8');
    const bytes=fs.statSync(target).size,sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return{path:target,bytes,sha256,createdAt,secrets:Object.keys(secrets).length,skipped};
  }

  /** Restores a portable backup, re-encrypting every secret for this machine. */
  restorePortableBackup(sourcePath:string,passphrase:string):{restored:number;skipped:string[];createdAt:string} {
    if(!safeStorage.isEncryptionAvailable())throw new Error(`${platformProfile().secureStorageLabel} is unavailable, so restored credentials could not be protected.`);
    // Only reachable today via a native OS file picker, but unlike sibling
    // path-handling call sites (codingWorkspace, syncFolder, updates:open-
    // installer) this had no boundary check of its own before reading —
    // confirm it's a real file, not a directory or missing path, before
    // trying to parse it as backup JSON.
    if(!fs.existsSync(sourcePath)||!fs.statSync(sourcePath).isFile())throw new Error('Backup file not found.');
    const payload=JSON.parse(fs.readFileSync(sourcePath,'utf8')) as {format?:string;version?:number;createdAt?:string;kdf?:{N:number;r:number;p:number;keyLength:number;salt:string};secrets?:Record<string,{iv:string;tag:string;data:string}>;data?:Record<string,unknown>};
    if(payload.format!=='axiom-portable-backup')throw new Error('That file is not an Axiom portable backup.');
    if(payload.version!==1)throw new Error(`Unsupported backup version ${payload.version}.`);
    if(!payload.kdf||!payload.data)throw new Error('The backup is missing its key-derivation parameters or data.');

    const kdf=payload.kdf,key=crypto.scryptSync(String(passphrase??''),Buffer.from(kdf.salt,'base64'),kdf.keyLength,{N:kdf.N,r:kdf.r,p:kdf.p,maxmem:96*1024*1024});
    const open=(sealed:{iv:string;tag:string;data:string}):string=>{
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(sealed.iv,'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString('utf8');
    };

    const entries=Object.entries(payload.secrets??{});
    // GCM authentication fails on a wrong passphrase, so probe one secret first
    // and report that plainly rather than half-restoring the profile.
    if(entries.length){try{open(entries[0][1]);}catch{throw new Error('That passphrase does not match this backup.');}}

    const restored:Record<string,unknown>={...payload.data};
    const connectors=Array.isArray(restored.connectors)?restored.connectors as StoredConnector[]:[];
    const skipped:string[]=[];
    let count=0;
    for(const[pointer,sealed]of entries){
      let plaintext:string;
      try{plaintext=open(sealed);}catch{skipped.push(pointer);continue;}
      const connectorMatch=/^connectors\.(\d+)\.(\w+)$/.exec(pointer);
      if(connectorMatch){
        const connector=connectors[Number(connectorMatch[1])];
        if(connector)(connector as unknown as Record<string,string>)[connectorMatch[2]]=this.encryptSecret(plaintext);else skipped.push(pointer);
      } else restored[pointer]=this.encryptSecret(plaintext);
      count+=1;
    }

    fs.writeFileSync(this.file,JSON.stringify(restored,null,2),'utf8');
    this.init();
    return{restored:count,skipped,createdAt:String(payload.createdAt??'')};
  }


  /**
   * A human-readable export of what Axiom holds about the user, for data
   * portability. Deliberately distinct from a portable backup: this is meant to
   * be read or handed to another service, not restored, so operator secrets
   * (API keys, connector tokens, sync passphrase) are excluded — they belong to
   * the operator's accounts, not to the person the data is about. Enrolled
   * biometric templates ARE included, since the person they describe has a
   * right to receive them.
   */
  exportAllData(targetPath?:string):{path:string;bytes:number;sha256:string;createdAt:string}{
    this.flush();
    const createdAt=new Date().toISOString();
    const document={
      format:'axiom-data-export',version:1,generatedAt:createdAt,axiomVersion:app.getVersion(),device:this.devicePresence(createdAt),
      conversationHistory:this.data.history,
      memories:this.data.memories,
      goals:this.data.goals,
      todos:this.data.todos,
      commitments:this.data.commitments,
      skills:this.data.skills,
      agents:this.data.agents.map(({id,name,role,instructions,schedule,createdAt:created,enabled})=>({id,name,role,instructions,schedule,createdAt:created,enabled})),
      enrolledFaces:this.data.knownPeople.map((item)=>({id:item.id,name:item.name,descriptor:item.descriptor,createdAt:item.createdAt,lastSeenAt:item.lastSeenAt})),
      enrolledVoices:this.data.speakerProfiles.map((item)=>({id:item.id,name:item.name,model:item.model,sampleCount:item.sampleCount,createdAt:item.createdAt})),
      biometricConsent:this.biometricConsentState(),
      updateFeedUrl:this.data.updateFeedUrl??'',
      updateChannel:this.data.updateChannel??'stable',
      lastUpdateCheckAt:this.data.lastUpdateCheckAt,
      lastKnownLatestVersion:this.data.lastKnownLatestVersion,
      settingsSummary:{provider:this.data.provider,speechProvider:this.data.speechProvider,speakerLockEnabled:this.data.speakerLockEnabled},
      auditTrail:this.data.audit,
    };
    const folder=targetPath?path.dirname(targetPath):path.join(app.getPath('desktop'),'Axiom Data Export');
    fs.mkdirSync(folder,{recursive:true});
    const target=targetPath??path.join(folder,`Axiom-data-export-${createdAt.replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(target,JSON.stringify(document,null,2),'utf8');
    const bytes=fs.statSync(target).size,sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return{path:target,bytes,sha256,createdAt};
  }

  /**
   * Irreversibly deletes every local Axiom record: conversation, memory, goals,
   * biometric enrollments, visitor evidence images, generated media files,
   * runtime/audit history, connector credentials, and provider API keys. This
   * device's identity and any sync it was doing are gone; a linked peer keeps
   * only what it already synced before this ran.
   *
   * Gated on an exact confirmation phrase — this sits below the file-deletion
   * boundary the app otherwise never crosses, so it must not be reachable by an
   * ambiguous request or a model retry.
   */
  eraseAllLocalData(confirmation:string):{erased:boolean;filesRemoved:number}{
    const required='DELETE ALL AXIOM DATA';
    if(confirmation!==required)throw new Error(`Type the exact phrase "${required}" to confirm permanent deletion. Nothing was removed.`);
    let filesRemoved=0;
    for(const artifact of this.data.mediaArtifacts){if(artifact.path){try{fs.rmSync(artifact.path,{force:true});filesRemoved+=1;}catch{/* already gone */}}}
    this.data=defaults();
    this.flush();
    return{erased:true,filesRemoved};
  }

  recordUpdateCheck(latestVersion?:string,at=new Date().toISOString()):void{this.data.lastUpdateCheckAt=at;if(latestVersion)this.data.lastKnownLatestVersion=latestVersion;this.flush();}

  automaticBackupDue(at=new Date()):boolean{if(!this.data.automaticBackupsEnabled||at.getHours()<2)return false;const last=Date.parse(this.data.lastAutomaticBackupAt||'');return!Number.isFinite(last)||new Date(last).toDateString()!==at.toDateString();}
  markAutomaticBackup(at=new Date().toISOString()):void{this.data.lastAutomaticBackupAt=at;this.flush();}

  private expireApprovals():void{const now=Date.now();let changed=false;for(const item of this.data.approvals){if(item.status==='pending'&&new Date(item.expiresAt).getTime()<=now){const timestamp=new Date().toISOString();item.status='expired';item.decidedAt=timestamp;if(item.sourceTaskId){const task=this.data.runtimeTasks.find((candidate)=>candidate.id===item.sourceTaskId&&candidate.status==='waiting');if(task){task.status='cancelled';task.updatedAt=timestamp;task.completedAt=timestamp;task.summary='The one-time approval expired. No action was taken.';}}changed=true;}}if(changed)this.flush();}
  private addTombstone(entity:SyncTombstone['entity'],id:string,deletedAt=new Date().toISOString()):void{const current=this.data.syncTombstones.find((item)=>item.entity===entity&&item.id===id);if(current)current.deletedAt=deletedAt;else this.data.syncTombstones.push({entity,id,deletedAt});this.data.syncTombstones=this.data.syncTombstones.slice(-2000);}

  private normalizeSpeakerProfiles(value:unknown):SpeakerProfileRecord[]{
    if(!Array.isArray(value))return[];
    return value.filter((item):item is SpeakerProfileRecord=>Boolean(item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.name==='string'&&Array.isArray(item.samples))).map((item)=>{
      const inferred:SpeakerProfileRecord['model']=item.model==='wavlm-base-plus-sv'||item.samples.some((sample)=>Array.isArray(sample)&&sample.length===512)?'wavlm-base-plus-sv':'acoustic-v1';
      const length=inferred==='wavlm-base-plus-sv'?512:28,samples=item.samples.filter((sample)=>Array.isArray(sample)&&sample.length===length&&sample.every(Number.isFinite)).slice(-5);
      return{...item,model:inferred,samples,sampleCount:samples.length};
    }).filter((item)=>item.samples.length>0).slice(-24);
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const backup = `${this.file}.bak`;
    let persisted:StoredData={...this.data};
    if(safeStorage.isEncryptionAvailable()){
      persisted={...persisted,encryptedBiometrics:safeStorage.encryptString(JSON.stringify({knownPeople:this.data.knownPeople,speakerProfiles:this.data.speakerProfiles})).toString('base64'),knownPeople:[],speakerProfiles:[]};
    }
    fs.writeFileSync(temp, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: 0o600 });
    if(fs.existsSync(this.file))fs.copyFileSync(this.file,backup);
    fs.renameSync(temp, this.file);
  }
}
