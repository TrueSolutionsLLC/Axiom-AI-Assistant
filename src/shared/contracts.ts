export type CompanionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'success' | 'warning' | 'error';
export type AppearanceColor = 'teal' | 'green' | 'blue' | 'violet' | 'amber' | 'orange' | 'pink' | 'red' | 'white';
export type CompanionEmotion = 'neutral' | 'happy' | 'focused' | 'concerned' | 'angry' | 'excited';
export type MotionProfile = 'adaptive' | 'cinematic' | 'efficient' | 'reduced';
export type InterfaceDensity = 'compact' | 'balanced' | 'spacious';
export type AIProvider = 'openai' | 'anthropic' | 'gemini';
export type SpeechProvider = 'openai' | 'elevenlabs' | 'system';
export type RuntimeRisk = 'read' | 'write' | 'sensitive' | 'external' | 'destructive' | 'privileged';
export type RuntimeTaskStatus = 'queued' | 'active' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type RuntimeTaskPhase = 'received' | 'interpreting' | 'planning' | 'awaiting-approval' | 'executing' | 'observing' | 'verifying' | 'recovering' | 'blocked' | 'completed' | 'cancelled';
export type MemoryKind = 'fact' | 'preference' | 'person' | 'project' | 'decision' | 'instruction';
export interface AppearanceSettings {
  color: AppearanceColor;
  emotion: CompanionEmotion;
  /** Optional user-selected accent. Named palettes remain the fallback. */
  accentHex: string;
  glowIntensity: number;
  motionProfile: MotionProfile;
  density: InterfaceDensity;
}
export interface ElevenLabsVoice { voiceId: string; name: string; category: string; description: string; previewUrl?: string; }
export interface SpeechAlignment { characters:string[]; characterStartTimesSeconds:number[]; characterEndTimesSeconds:number[]; }
export interface MouthCalibration { voiceKey:string; offsetMs:number; gain:number; attack:number; release:number; calibratedAt?:string; }
export interface KnownPerson { id:string; name:string; descriptor:number[]; descriptors?:number[][]; primary:boolean; createdAt:string; lastSeenAt?:string; }
export interface VoiceProfile { id:string; name:string; provider:SpeechProvider; elevenLabsVoiceId:string; elevenLabsVoiceName:string; elevenLabsModel:string; stability:number; similarity:number; style:number; speed:number; }
export type SpeakerModel='acoustic-v1'|'wavlm-base-plus-sv';
export interface SpeakerProfile { id:string; name:string; model:SpeakerModel; sampleCount:number; primary:boolean; threshold:number; createdAt:string; updatedAt:string; lastMatchedAt?:string; }
export interface SpeakerProfileRecord extends SpeakerProfile { samples:number[][]; }
export interface SpeakerMatch { accepted:boolean; enrolled:boolean; name?:string; profileId?:string; score:number; threshold:number; reason:'matched'|'rejected'|'no-profiles'|'invalid-sample'|'reenrollment-required'; }
export type AxiomPlatform = 'windows' | 'macos' | 'linux';
export interface DevicePresence {
  id:string;
  name:string;
  platform:AxiomPlatform;
  hostname:string;
  architecture:string;
  appVersion:string;
  sessionId?:string;
  sessionState?:'active'|'idle';
  heartbeatAt?:string;
  firstSeenAt:string;
  lastSeenAt:string;
  lastActiveAt:string;
}
export interface SyncStatus {
  enabled:boolean;
  configured:boolean;
  syncing:boolean;
  state:'off'|'setup'|'ready'|'syncing'|'error';
  folder:string;
  device:DevicePresence;
  peers:DevicePresence[];
  voiceOwnedHere:boolean;
  voiceOwner?:DevicePresence;
  lastSyncAt?:string;
  lastError?:string;
}
export interface SyncTombstone { entity:'history'|'memory'|'skill'|'agent'|'voice-profile'|'speaker-profile'|'known-person'; id:string; deletedAt:string; }
export interface SyncPayload {
  schema:1;
  writtenAt:string;
  device:DevicePresence;
  history:ChatMessage[];
  memories:MemoryItem[];
  goals:GoalItem[];
  skills:SkillItem[];
  agents:AgentItem[];
  commitments:CommitmentItem[];
  todos?:TodoItem[];
  monitors?:MonitorItem[];
  voiceProfiles:VoiceProfile[];
  speakerProfiles:SpeakerProfileRecord[];
  knownPeople?:KnownPerson[];
  appearance:{value:AppearanceSettings;updatedAt:string};
  tombstones:SyncTombstone[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  /** Derived, never model-claimed: 'concern' when Axiom flagged a request as
   * likely a mistake before complying, 'uncertain' when it answered without
   * verified tool evidence backing the claim. See normalizeActionReply and
   * detectReplyTone in openai.ts — both are computed from actual signals
   * (explicit CONCERN: marker, or presence/absence of verified ToolEvents),
   * never from the model self-reporting a confidence number, which would be
   * exactly the kind of unverified claim Axiom's honesty rules forbid. */
  tone?: 'concern' | 'uncertain';
}

export interface IdentityEvidence {
  face?: { name:string; confidence:number; observedAt:string };
  speaker?: { name:string; score:number; verifiedAt:string };
}

export interface AssistantRequest {
  message: string;
  history: Pick<ChatMessage, 'role' | 'text'>[];
  imageDataUrl?: string;
  resumeTaskId?:string;
  identity?:IdentityEvidence;
  untrustedPresence?:boolean;
}

export interface AssistantReply {
  text: string;
  provider: AIProvider;
  model: string;
  toolEvents: ToolEvent[];
  /** Set only from real signal — an explicit CONCERN: marker in the model's
   * own text (disagreement), or a mandatory action request that produced no
   * verified ToolEvent (uncertainty). Never a self-reported confidence
   * number; that would itself be an unverified claim. */
  tone?: 'concern' | 'uncertain';
}

/** A record of something Axiom got wrong before, kept the same way a person
 * would keep a lesson learned — not a fact about the user, a fact about
 * Axiom's own past behavior, so the same mistake doesn't need to be
 * rediscovered from scratch each time. */
export interface SelfCorrection {
  id: string;
  /** What situation this applies to, in the user's own words where possible
   * — matched against future requests the same way memory search works. */
  pattern: string;
  mistake: string;
  fix: string;
  createdAt: string;
  embedding?: number[];
}

export interface SettingsSnapshot {
  at: string;
  label: string;
}

export interface ToolEvent {
  name: string;
  status: 'running' | 'verified' | 'blocked' | 'failed';
  summary: string;
  at: string;
  actionId?: string;
  permissionId?: string;
  risk?: RuntimeRisk;
  reversible?: boolean;
  evidenceId?: string;
  resultDigest?: string;
  approvalId?: string;
  attempts?:number;
  recovered?:boolean;
  verification?:{method:'structured-result'|'state-observation'|'artifact-check'|'human-confirmation';detail:string;checkedAt:string};
  uiCommand?: { type: 'appearance'; appearance: AppearanceSettings; color: AppearanceColor; emotion: CompanionEmotion };
}

export interface PublicSettings {
  provider: AIProvider;
  model: string;
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  hasSelectedAIKey: boolean;
  providerModels: Record<AIProvider, string>;
  autoFailover: boolean;
  fallbackOrder: AIProvider[];
  codingProvider:AIProvider;
  researchProvider:AIProvider;
  speechProvider: SpeechProvider;
  hasElevenLabsKey: boolean;
  elevenLabsVoiceId: string;
  elevenLabsVoiceName: string;
  elevenLabsModel: string;
  voiceStability: number;
  voiceSimilarity: number;
  voiceStyle: number;
  voiceSpeed: number;
  mouthCalibration:MouthCalibration;
  startMicrophoneOn: boolean;
  /** Explicit acknowledgement before any biometric capture may run. */
  biometricConsent:{acknowledged:boolean;at?:string;version:number;requiredVersion:number};
  preferredMicrophoneId:string;
  preferredMicrophoneLabel:string;
  microphoneNoiseFloor:number;
  microphoneSpeechThreshold:number;
  microphoneCalibratedAt?:string;
  speakerLockEnabled:boolean;
  speakerProfiles:SpeakerProfile[];
  voiceProfiles:VoiceProfile[];
  activeVoiceProfileId:string;
  encryptionAvailable: boolean;
  /** Secrets that are stored but cannot be decrypted on this machine. */
  unreadableCredentials: string[];
  appearance: AppearanceSettings;
  codingWorkspace: string;
  platform:AxiomPlatform;
  platformLabel:string;
  secureStorageLabel:string;
  deviceName:string;
  syncEnabled:boolean;
  syncFolder:string;
  hasSyncPassphrase:boolean;
  automaticBackupsEnabled:boolean;
  updateFeedUrl:string;
  updateChannel:'stable'|'beta';
  lastUpdateCheckAt?:string;
  lastKnownLatestVersion?:string;
  /** A secret passphrase (never the primary user's name — that's guessable)
   * that restores owner trust for a turn when biometrics fail to recognize
   * an enrolled owner. Only whether one is set is exposed here; the phrase
   * itself never leaves the main process. */
  hasOwnerOverridePhrase:boolean;
}

export interface SaveSettingsRequest {
  appearance?: Partial<AppearanceSettings>;
  provider?: AIProvider;
  model: string;
  autoFailover?: boolean;
  fallbackOrder?: AIProvider[];
  codingProvider?:AIProvider;
  researchProvider?:AIProvider;
  openAIKey?: string;
  clearOpenAIKey?: boolean;
  anthropicKey?: string;
  clearAnthropicKey?: boolean;
  geminiKey?: string;
  clearGeminiKey?: boolean;
  speechProvider?: SpeechProvider;
  elevenLabsKey?: string;
  clearElevenLabsKey?: boolean;
  elevenLabsVoiceId?: string;
  elevenLabsVoiceName?: string;
  elevenLabsModel?: string;
  voiceStability?: number;
  voiceSimilarity?: number;
  voiceStyle?: number;
  voiceSpeed?: number;
  mouthOffsetMs?:number;
  mouthGain?:number;
  mouthAttack?:number;
  mouthRelease?:number;
  mouthCalibratedAt?:string;
  startMicrophoneOn?: boolean;
  updateFeedUrl?:string;
  updateChannel?:'stable'|'beta';
  acknowledgeBiometricConsent?:boolean;
  withdrawBiometricConsent?:boolean;
  preferredMicrophoneId?:string;
  preferredMicrophoneLabel?:string;
  microphoneNoiseFloor?:number;
  microphoneSpeechThreshold?:number;
  microphoneCalibratedAt?:string;
  speakerLockEnabled?:boolean;
  codingWorkspace?: string;
  deviceName?:string;
  syncEnabled?:boolean;
  syncFolder?:string;
  syncPassphrase?:string;
  clearSyncPassphrase?:boolean;
  automaticBackupsEnabled?:boolean;
  ownerOverridePhrase?:string;
  clearOwnerOverridePhrase?:boolean;
}

export interface PermissionInfo {
  id: string;
  label: string;
  risk: 'read' | 'write' | 'sensitive';
  enabled: boolean;
}
export interface AuditItem extends ToolEvent { id: string; }

export interface RuntimeTask {
  id: string;
  title: string;
  status: RuntimeTaskStatus;
  phase: RuntimeTaskPhase;
  risk: RuntimeRisk;
  source: 'conversation' | 'schedule' | 'system' | 'agent';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  successCriteria: string;
  attempt: number;
  maxAttempts: number;
  blocker?: string;
  nextAction?: string;
  timeline: RuntimeTaskTransition[];
  actionIds: string[];
}

export interface RuntimeTaskTransition {
  id: string;
  phase: RuntimeTaskPhase;
  at: string;
  summary: string;
}

export interface CommitmentItem {
  id: string;
  title: string;
  status: 'open' | 'fulfilled' | 'cancelled';
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  sourceTaskId?: string;
  lastNotifiedAt?: string;
}

export interface EvidenceItem {
  id: string;
  actionId: string;
  taskId?: string;
  kind: 'tool-result' | 'state-observation' | 'artifact' | 'human-confirmation';
  summary: string;
  observedAt: string;
  integrity: string;
  resultDigest?: string;
}

export interface ApprovalRequest {
  id: string;
  code: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'expired' | 'failed';
  risk: Extract<RuntimeRisk, 'external' | 'destructive'>;
  preview: string;
  recovery: string;
  argsDigest: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  sourceTaskId?: string;
  resultSummary?: string;
}

export interface CapabilityHealthItem {
  id: string;
  label: string;
  kind: 'model' | 'tool' | 'sensor' | 'security' | 'runtime';
  state: 'healthy' | 'ready' | 'disabled' | 'degraded' | 'unconfigured';
  detail: string;
  checkedAt: string;
}

export interface CapabilityHorizonItem {
  id: string;
  title: string;
  stage: 'today' | 'engineering' | 'experimental' | 'future';
  priority: number;
  rationale: string;
}

export interface RuntimeSnapshot {
  generatedAt: string;
  tasks: RuntimeTask[];
  commitments: CommitmentItem[];
  evidence: EvidenceItem[];
  approvals: ApprovalRequest[];
  capabilities: CapabilityHealthItem[];
  horizon: CapabilityHorizonItem[];
  metrics: { activeTasks: number; openCommitments: number; verifiedActions: number; healthyCapabilities: number; pendingApprovals: number };
}

export interface ApprovalDecisionResult { runtime: RuntimeSnapshot; event?: ToolEvent; message: string; }

export type DesktopEntityKind = 'application' | 'window' | 'control' | 'document';
export interface DesktopEntity {
  id: string;
  kind: DesktopEntityKind;
  stableKey: string;
  label: string;
  status: 'live' | 'stale';
  application?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  attributes: Record<string,string|number|boolean>;
}
export interface DesktopRelation { id:string; fromId:string; toId:string; type:'contains'|'owns'|'associated-with'; firstSeenAt:string; lastSeenAt:string; }
export interface DesktopObservation { id:string; entityId?:string; kind:'discovered'|'changed'|'observed'|'disappeared'|'acted-on'; summary:string; toolName:string; at:string; }
export interface DesktopGraphSnapshot {
  generatedAt:string;
  entities:DesktopEntity[];
  relations:DesktopRelation[];
  observations:DesktopObservation[];
  metrics:{applications:number;liveWindows:number;knownControls:number;staleObjects:number;observations:number};
}
export interface DesktopGraphRefreshResult { graph:DesktopGraphSnapshot; event:ToolEvent; }

export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  status: 'active' | 'superseded';
  origin: 'user-explicit' | 'assistant-inferred' | 'imported';
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  retrievalCount: number;
  supersedesId?: string;
  embedding?: number[];
}
export interface GoalItem { id: string; title: string; status: 'active' | 'completed'; createdAt: string; updatedAt: string; }
export interface SkillItem { id:string; name:string; description:string; instructions:string; enabled:boolean; createdAt:string; updatedAt:string; lastRunAt?:string; runCount:number; }
export type ScheduleKind='manual'|'interval'|'daily';
export interface ScheduleSpec { kind:ScheduleKind; intervalMinutes?:number; dailyTime?:string; nextRunAt?:string; }
export interface AgentItem { id:string; name:string; role:string; instructions:string; enabled:boolean; createdAt:string; updatedAt:string; lastRunAt?:string; runCount:number; schedule:ScheduleSpec; lastResult?:string; lastStatus?:'completed'|'failed'; color?:AppearanceColor; voiceProfileId?:string; }
export interface AgentRunItem { id:string; agentId:string; agentName:string; status:'active'|'completed'|'failed'; startedAt:string; completedAt?:string; summary?:string; taskId?:string; }
export interface TodoItem { id:string; text:string; status:'open'|'completed'; createdAt:string; updatedAt:string; completedAt?:string; }
export interface MonitorItem { id:string; title:string; instruction:string; source:'screen'|'camera'; intervalSeconds:number; status:'active'|'triggered'|'stopped'|'failed'; createdAt:string; updatedAt:string; nextRunAt:string; endsAt?:string; lastRunAt?:string; lastObservation?:string; }
export interface BackgroundEvent { id:string; kind:'agent'|'reminder'|'monitor'|'backup'|'system'; title:string; text:string; createdAt:string; speak:boolean; read:boolean; taskId?:string; }
export interface SchedulerSnapshot { running:boolean; checkedAt:string; agents:AgentItem[]; agentRuns:AgentRunItem[]; monitors:MonitorItem[]; events:BackgroundEvent[]; nextWakeAt?:string; }
export type ConnectorId='google'|'shopify'|'meta'|'dropbox'|'homebridge'|'ring'|'stripe'|'klaviyo'|'whatsapp';
export interface ConnectorStatus { id:ConnectorId; label:string; configured:boolean; connected:boolean; account:string; endpoint:string; scopes:string[]; expiresAt?:string; lastCheckedAt?:string; lastError?:string; setupHint:string; }
export interface ConnectorSetup { id:ConnectorId; account?:string; endpoint?:string; clientId?:string; clientSecret?:string; accessToken?:string; refreshToken?:string; expiresAt?:string; scopes?:string[]; clearSecrets?:boolean; }
export interface HomebridgeAccessory { uniqueId:string;name:string;type:string;serviceName:string;values:Record<string,unknown>; }
export interface HomebridgeSnapshot { configured:boolean;connected:boolean;endpoint:string;generatedAt:string;accessories:HomebridgeAccessory[];counts:Record<string,number>;error?:string; }
export interface HomebridgeControlRequest { target:string;characteristic?:string;value:unknown; }
export interface HomebridgeControlResult { accessory:HomebridgeAccessory;characteristic:string;before:unknown;after:unknown;verified:boolean;executedAt:string; }
export interface RingCamera { id:number;name:string;kind:string;locationId:string;online:boolean;batteryPercent?:number; }
export interface RingCameraList { configured:boolean;connected:boolean;cameras:RingCamera[];error?:string; }
export type RingConnectResult={status:ConnectorStatus[]}|{twoFactorRequired:true;prompt:string};
// Live view runs over a WebSocket ticket exchange relayed through main
// (it needs the Bearer token, which never leaves main), so unlike a normal
// request/response IPC call this is a live multi-message session: one open
// call gets a correlation id back immediately, then every subsequent
// message (the SDP answer, trickled ICE candidates, a fault, or a clean
// close) arrives later via the single push channel below.
export type RingLiveViewEvent=
  |{type:'answer';liveSessionId:string;sdp:string}
  |{type:'ice';liveSessionId:string;candidate:string;sdpMLineIndex:number}
  |{type:'fault';liveSessionId:string;reason:string}
  |{type:'closed';liveSessionId:string};
export interface MediaArtifact { id:string; kind:'image'|'video'; provider:'openai'; model:string; prompt:string; status:'queued'|'in_progress'|'completed'|'failed'; createdAt:string; updatedAt:string; path?:string; jobId?:string; progress?:number; size?:string; durationSeconds?:number; estimatedCostUsd:number; error?:string; }
export interface ScreenCapture { dataUrl: string; width: number; height: number; capturedAt: string; }
export interface ProcessTelemetry { pid:number; name:string; cpuPercent:number; memoryPercent:number; }
export interface GpuTelemetry {
  vendor:string; model:string; vramMB:number|null; loadPercent:number|null;
  memoryUsedMB:number|null; memoryTotalMB:number|null; temperatureC:number|null;
  fanPercent:number|null; powerWatts:number|null; driver:string;
}
export interface DiskTelemetry { mount:string; filesystem:string; type:string; totalBytes:number; usedBytes:number; availableBytes:number; usedPercent:number; }
export interface NetworkTelemetry { interface:string; type:string; ip4:string; default:boolean; state:string; speedMbps:number|null; rxBytesPerSecond:number|null; txBytesPerSecond:number|null; }
export interface SystemTelemetry {
  collectedAt:string; platform:string; hostname:string;
  cpuPercent:number; memoryPercent:number; uptimeSeconds:number;
  cpu:{
    manufacturer:string; model:string; physicalCores:number; logicalCores:number;
    speedGHz:number|null; loadPercent:number; userPercent:number; systemPercent:number;
    perCorePercent:number[]; temperatureC:number|null; maxTemperatureC:number|null;
  };
  memory:{ totalBytes:number; usedBytes:number; freeBytes:number; availableBytes:number; swapTotalBytes:number; swapUsedBytes:number; usedPercent:number; };
  gpus:GpuTelemetry[];
  disks:DiskTelemetry[];
  diskIo:{ readBytesPerSecond:number|null; writeBytesPerSecond:number|null; readOperationsPerSecond:number|null; writeOperationsPerSecond:number|null; utilizationPercent:number|null; };
  networks:NetworkTelemetry[];
  battery:{ present:boolean; percent:number|null; charging:boolean; acConnected:boolean; timeRemainingMinutes:number|null; cycleCount:number|null; healthPercent:number|null; };
  processes:{ all:number; running:number; blocked:number; sleeping:number; topCpu:ProcessTelemetry[]; topMemory:ProcessTelemetry[]; };
  system:{ manufacturer:string; model:string; os:string; release:string; architecture:string; virtual:boolean; };
  availability:{ cpuTemperature:boolean; gpuLoad:boolean; gpuTemperature:boolean; diskIo:boolean; networkThroughput:boolean; battery:boolean; };
  warnings:string[];
}
export interface ProviderHealth { provider: AIProvider; state: 'ready' | 'healthy' | 'degraded' | 'unconfigured'; latencyMs?: number; lastChecked?: string; message: string; }
export interface PlatformPermissionStatus { id:'microphone'|'camera'|'screen'|'accessibility'; label:string; state:'granted'|'denied'|'restricted'|'unknown'|'not-determined'|'not-required'; required:boolean; detail:string; }

export type OperationalState='checking'|'ready'|'degraded'|'blocked';
export type OperationalDomain='intelligence'|'voice'|'vision'|'control'|'memory'|'continuity'|'security'|'hardware';
export interface OperationalProbe {
  id:string;
  label:string;
  domain:OperationalDomain;
  state:OperationalState;
  detail:string;
  checkedAt:string;
  latencyMs?:number;
  recovery?:string;
}
export interface RendererCapabilityReport {
  reportedAt:string;
  microphone:'off'|'connecting'|'ready'|'recording'|'fault';
  transcription:'off'|'connecting'|'ready'|'fallback'|'fault';
  camera:'off'|'starting'|'searching'|'locked'|'lost'|'busy'|'denied'|'error';
  faceIdentity?:{name:string;confidence:number;observedAt:string};
  speakerIdentity?:{name:string;score:number;verifiedAt:string};
  speakerEngine:'loading'|'ready'|'fault';
  speakerDecision:'open'|'listening'|'verified'|'rejected'|'noise'|'enrolling';
}
export interface ConversationLatencyReport {
  id:string;
  at:string;
  input:'text'|'voice';
  sttMs:number;
  firstTokenMs:number;
  ttsMs:number;
  firstAudioMs:number;
  routeMs:number;
  recovered:boolean;
}
export interface OperationalRouteReceipt {
  request:string;
  intent:string;
  candidates:string[];
  state:'idle'|'routing'|'verified'|'recovered'|'failed'|'blocked';
  startedAt:string;
  completedAt?:string;
  capability?:string;
  detail:string;
}
export interface OperationalSnapshot {
  generatedAt:string;
  overall:'nominal'|'degraded'|'blocked';
  probes:OperationalProbe[];
  route:OperationalRouteReceipt;
  latency:{latest?:ConversationLatencyReport;averageFirstAudioMs:number;averageFirstTokenMs:number;samples:number};
  identity:{state:'dual-verified'|'face-verified'|'voice-verified'|'conflict'|'unknown'|'noise-rejected';name?:string;detail:string};
  activeDevice:{id:string;name:string;platform:AxiomPlatform;local:boolean;lastActiveAt:string};
  metrics:{ready:number;degraded:number;blocked:number;total:number};
}

export interface DesktopApi {
  getAppInfo(): Promise<{ version: string; platform: string }>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SaveSettingsRequest): Promise<PublicSettings>;
  sendMessage(input: AssistantRequest): Promise<AssistantReply>;
  onAssistantDelta(callback: (delta: string) => void): () => void;
  loadHistory(): Promise<ChatMessage[]>;
  clearHistory(): Promise<void>;
  listPermissions(): Promise<PermissionInfo[]>;
  setPermission(id:string,enabled:boolean):Promise<PermissionInfo[]>;
  loadAudit():Promise<AuditItem[]>;
  clearAudit():Promise<void>;
  captureScreen(): Promise<ScreenCapture>;
  getSystemTelemetry(): Promise<SystemTelemetry>;
  transcribeAudio(input: { audio: ArrayBuffer; mimeType: string }): Promise<{ text: string }>;
  openRealtimeTranscription(sdp:string):Promise<{sdp:string;model:string}>;
  synthesizeSpeech(text: string): Promise<{ audio: ArrayBuffer; mimeType: string; provider?: SpeechProvider; fallbackFrom?: SpeechProvider; fallbackReason?:string; alignment?:SpeechAlignment }>;
  listElevenLabsVoices(): Promise<ElevenLabsVoice[]>;
  testProvider(provider: AIProvider | 'elevenlabs'): Promise<{ ok: boolean; message: string }>;
  getProviderHealth(): Promise<ProviderHealth[]>;
  getOperationalSnapshot(force?:boolean):Promise<OperationalSnapshot>;
  reportRendererCapabilities(report:RendererCapabilityReport):Promise<OperationalSnapshot>;
  reportConversationLatency(report:ConversationLatencyReport):Promise<OperationalSnapshot>;
  saveVoiceProfile(name:string):Promise<PublicSettings>;
  activateVoiceProfile(id:string):Promise<PublicSettings>;
  deleteVoiceProfile(id:string):Promise<PublicSettings>;
  listKnownPeople():Promise<KnownPerson[]>;
  saveKnownPerson(name:string,descriptor:number[]):Promise<KnownPerson>;
  markKnownPersonSeen(id:string):Promise<KnownPerson>;
  forgetKnownPerson(id:string):Promise<KnownPerson[]>;
  enrollSpeaker(name:string,vector:number[]):Promise<SpeakerProfile[]>;
  matchSpeaker(vector:number[],visiblePersonName?:string):Promise<SpeakerMatch>;
  forgetSpeaker(id:string):Promise<SpeakerProfile[]>;
  getPlatformPermissions():Promise<PlatformPermissionStatus[]>;
  openPlatformPermission(id:PlatformPermissionStatus['id']):Promise<void>;
  listMemories(): Promise<MemoryItem[]>;
  addMemory(text: string, kind?: MemoryKind): Promise<MemoryItem>;
  forgetMemory(id: string): Promise<MemoryItem[]>;
  listGoals(): Promise<GoalItem[]>;
  addGoal(title: string): Promise<GoalItem>;
  listTodos():Promise<TodoItem[]>;
  addTodo(text:string):Promise<TodoItem>;
  setTodoStatus(id:string,status:'open'|'completed'):Promise<TodoItem[]>;
  removeTodo(id:string):Promise<TodoItem[]>;
  getSchedulerSnapshot():Promise<SchedulerSnapshot>;
  saveAgent(input:{name:string;role:string;instructions:string;schedule?:ScheduleSpec;color?:AppearanceColor;voiceProfileId?:string}):Promise<AgentItem>;
  setAgentEnabled(id:string,enabled:boolean):Promise<SchedulerSnapshot>;
  runAgentNow(id:string):Promise<SchedulerSnapshot>;
  removeAgent(id:string):Promise<SchedulerSnapshot>;
  addMonitor(input:{title:string;instruction:string;source:'screen'|'camera';intervalSeconds?:number;durationMinutes?:number}):Promise<MonitorItem>;
  stopMonitor(id:string):Promise<SchedulerSnapshot>;
  onBackgroundEvent(callback:(event:BackgroundEvent)=>void):()=>void;
  onCameraCaptureRequest(callback:(request:{id:string;reason:string})=>void):()=>void;
  submitCameraCapture(id:string,capture?:ScreenCapture,error?:string):void;
  listConnectors():Promise<ConnectorStatus[]>;
  saveConnector(input:ConnectorSetup):Promise<ConnectorStatus[]>;
  connectConnector(id:ConnectorId):Promise<ConnectorStatus[]>;
  disconnectConnector(id:ConnectorId):Promise<ConnectorStatus[]>;
  testConnector(id:ConnectorId):Promise<ConnectorStatus>;
  getHomebridgeSnapshot():Promise<HomebridgeSnapshot>;
  controlHomebridge(input:HomebridgeControlRequest):Promise<HomebridgeControlResult>;
  connectRing(email:string,password:string,twoFactorCode?:string):Promise<RingConnectResult>;
  listRingCameras():Promise<RingCameraList>;
  openRingLiveView(cameraId:number,offerSdp:string):Promise<{liveSessionId:string}>;
  sendRingIceCandidate(liveSessionId:string,candidate:string,sdpMLineIndex:number):Promise<void>;
  closeRingLiveView(liveSessionId:string):Promise<void>;
  onRingLiveViewEvent(callback:(event:RingLiveViewEvent)=>void):()=>void;
  listMediaArtifacts():Promise<MediaArtifact[]>;
  showCursorGuide(x:number,y:number,label:string,durationMs?:number):Promise<{shown:true;x:number;y:number;label:string;durationMs:number}>;
  getRuntimeSnapshot(): Promise<RuntimeSnapshot>;
  addCommitment(title: string, dueAt?: string): Promise<CommitmentItem>;
  resolveCommitment(id: string, status: 'fulfilled' | 'cancelled'): Promise<RuntimeSnapshot>;
  cancelRuntimeTask(id: string): Promise<RuntimeSnapshot>;
  decideApproval(id: string, decision: 'approved' | 'denied'): Promise<ApprovalDecisionResult>;
  getDesktopGraph(): Promise<DesktopGraphSnapshot>;
  refreshDesktopGraph(): Promise<DesktopGraphRefreshResult>;
  createBackup(): Promise<{path:string;bytes:number;sha256:string;createdAt:string}>;
  createPortableBackup(passphrase:string): Promise<{path:string;bytes:number;sha256:string;createdAt:string;secrets:number;skipped:string[]}>;
  chooseBackupFile(): Promise<string>;
  exportAllData(): Promise<{path:string;bytes:number;sha256:string;createdAt:string}>;
  eraseAllData(confirmation:string): Promise<{erased:boolean;filesRemoved:number}>;
  /** Checks a spoken/typed phrase against the enrolled owner override secret.
   * Never throws on a wrong guess — returns false so a stranger probing for
   * the phrase can't distinguish "wrong" from "errored" by timing or message. */
  verifyOwnerOverride(phrase:string): Promise<boolean>;
  listSelfCorrections(): Promise<SelfCorrection[]>;
  recordSelfCorrection(pattern:string,mistake:string,fix:string): Promise<SelfCorrection[]>;
  forgetSelfCorrection(id:string): Promise<SelfCorrection[]>;
  lastSettingsSnapshot(): Promise<SettingsSnapshot|undefined>;
  revertLastSettingsChange(): Promise<PublicSettings>;
  checkForUpdate(): Promise<{ok:boolean;currentVersion:string;updateAvailable:boolean;mustUpdate:boolean;latestVersion?:string;notes?:string;error?:string}>;
  downloadUpdate(): Promise<{ok:boolean;path?:string;error?:string}>;
  openUpdateInstaller(filePath:string): Promise<void>;
  restorePortableBackup(sourcePath:string,passphrase:string): Promise<{restored:number;skipped:string[];createdAt:string}>;
  getSyncStatus():Promise<SyncStatus>;
  syncNow():Promise<SyncStatus>;
  reportDeviceActivity():Promise<SyncStatus>;
  reportRendererCrash(message:string,stack?:string,componentStack?:string):Promise<void>;
}
