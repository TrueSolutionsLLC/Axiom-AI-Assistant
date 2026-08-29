import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AIProvider, AppearanceColor, AuditItem, ChatMessage, CommitmentItem, ConversationLatencyReport, DesktopApi, DesktopGraphSnapshot, ElevenLabsVoice, GoalItem, MemoryItem, MemoryKind, OperationalSnapshot, PermissionInfo, PlatformPermissionStatus, ProviderHealth, PublicSettings, RendererCapabilityReport, RingCamera, RuntimeSnapshot, RuntimeTask, ScreenCapture, SelfCorrection, SettingsSnapshot, SpeakerMatch, SpeechProvider, SyncStatus, SystemTelemetry, ToolEvent } from '../shared/contracts';
import { ModdedSkullAvatar } from './ModdedSkullAvatar';
import type { Appearance, MouthShape } from './ModdedSkullAvatar';
import { stateLabel, visualReducer } from './state';
import { useFaceTracking } from './useFaceTracking';
import { LivenessBuffer, type LivenessState } from './livenessDetector';
import { takeSpeechChunks } from './speechChunks';
import { audioRms, VoiceActivityDetector } from './voiceActivity';
import { estimatedSpeechPose, speechMouthTarget, speechViseme, timedSpeechPose, visemePose } from './visemes';
import { protectedVoiceMode } from './speechVisualGuard';
import { canBridgeBorderlineMatch, combineSpeakerEvidence, createSpeakerTrust, matchingFaceProfile, speakerEvidenceQuality, speakerSessionValid } from './speakerTrust';
import type { FaceIdentityEvidence, SpeakerTrustSession, SpeakerTrustSource } from './speakerTrust';
import { resolveVoiceFaceTrust } from './identityConjunction';
import { speechOnlyText } from './speechText';
import { VOICE_ENROLLMENT_STEPS, VOICE_ENROLLMENT_SCRIPT, MIN_VOICE_STEPS_REQUIRED } from './voiceEnrollmentGuide';
import { usePersonRecognition, type EnrollmentProgress } from './usePersonRecognition';
import { ENROLLMENT_POSES, type EnrollmentPoseId, type EnrollmentValidation } from './faceEnrollmentGuide';
import { captureVoicePrint, createVoicePrintMonitor, embedForQa, warmNeuralSpeakerEngine } from './speakerIdentity';
import type { VoicePrint, VoicePrintMonitor } from './speakerIdentity';
import { faceEnrollmentIntent, storedIdentityName } from './identityIntent';
import { cameraRequestIntent } from './cameraIntent';
import { MissionControlPanel } from './MissionControlPanel';
import { ConnectorMatrix } from './ConnectorMatrix';
import { SmartHomePanel } from './SmartHomePanel';
import { IntelPanel } from './IntelPanel';
import { SystemDiagnosticsPanel } from './SystemDiagnosticsPanel';
import { VitalArray } from './VitalArray';
import { OperationalTruth } from './OperationalTruth';

type ActiveView = 'CONVERSE' | 'CAPABILITIES' | 'SCREEN' | 'FILES' | 'WEB' | 'AUTOMATE' | 'BUILD' | 'MEMORY' | 'RUNTIME' | 'GOALS';
const nav: { label: string; detail:string; glyph:string; view: ActiveView; action?: 'settings' }[] = [
  { label: 'CHAT', detail:'NEURAL LINK', glyph:'◉', view: 'CONVERSE' }, { label: 'TOOLS', detail:'CAPABILITY MAP', glyph:'⬡', view: 'CAPABILITIES' },
  { label: 'SCREEN', detail:'VISUAL INTEL', glyph:'▣', view: 'SCREEN' }, { label: 'FILES', detail:'DATA VAULT', glyph:'⌑', view: 'FILES' },
  { label: 'WEB', detail:'LIVE SIGNAL', glyph:'◎', view: 'WEB' }, { label: 'AUTOMATE', detail:'CONTROL BUS', glyph:'⟁', view: 'AUTOMATE' },
  { label: 'BUILD', detail:'FORGE LAB', glyph:'⌬', view: 'BUILD' }, { label: 'MEMORY', detail:'CORE ARCHIVE', glyph:'◌', view: 'MEMORY' }, { label: 'CORE', detail:'AGENT RUNTIME', glyph:'◇', view: 'RUNTIME' }, { label: 'SETTINGS', detail:'SYSTEM TUNING', glyph:'≡', view: 'CONVERSE', action: 'settings' },
  { label: 'STARRED', detail:'MISSION QUEUE', glyph:'✦', view: 'GOALS' },
];
// Rail redesign: only CHAT and SETTINGS get full-size primary treatment
// (Robbie: "i only use the settings really") — everything else collapses
// behind one "MORE" toggle instead of standing at equal visual weight.
const primaryNav=nav.filter((item)=>item.label==='CHAT'||item.label==='SETTINGS');
const secondaryNav=nav.filter((item)=>item.label!=='CHAT'&&item.label!=='SETTINGS');
const moduleCopy: Record<Exclude<ActiveView, 'CONVERSE'>, { title: string; description: string; permissions?: string[]; actions?: string[] }> = {
  CAPABILITIES: { title: 'Working capabilities', description: 'Registered tools, permissions, and verified execution paths. Every action appears in the activity ledger.', actions: ['Show me everything you can currently do'] },
  SCREEN: { title: 'Vision and desktop world model', description: 'A persistent semantic map of applications, windows, and controls, plus private on-device presence tracking and explicit one-request display vision.', permissions: ['screen-capture', 'read-system', 'appearance'], actions: ['Check my computer hardware and summarize it', 'Change your eyes to blue and look focused'] },
  FILES: { title: 'Secure file workspace', description: 'Read, create, and verify requested files inside Desktop, Documents, and Downloads with bounded access.', permissions: ['files-read', 'files-write'], actions: ['List the files on my Desktop', 'Create a verified text file on my Desktop'] },
  WEB: { title: 'Live intelligence', description: 'Search current web information when freshness matters, without inventing live facts.', permissions: ['web-search'], actions: ['Give me a concise briefing of today’s top headlines', 'Look up the latest weather forecast'] },
  AUTOMATE: { title: 'Computer command matrix', description: 'Inspect and operate applications through the native accessibility system, use the clipboard, launch tools, and expose only controls supported by this computer.', permissions: ['desktop-read','desktop-control','window-control','apps-open','browser-control','clipboard-read','clipboard-write','media-control','powershell'], actions: ['List my running application windows', 'Open a text editor', 'Tell me everything you can control on this computer'] },
  BUILD: { title: 'Axiom Build Lab', description: 'Describe a feature or bug in plain language. Axiom can inspect the configured project, edit source with automatic rollback checkpoints, and run its real build and tests before reporting success.', permissions: ['code-read','code-write','code-execute','code-delete','code-rollback'], actions: ['Inspect my coding workspace and explain the project', 'Find one worthwhile improvement, implement it, and run the tests', 'Run the project test and build checks and report any failures'] },
  MEMORY: { title: 'Governed memory', description: 'Durable facts remain encrypted on this computer and can continue across linked devices when Identity Sync is enabled.' },
  RUNTIME: { title: 'Axiom Runtime + Hardware Core', description: 'Live computer vitals and the operational truth layer: hardware sensors, durable work, explicit promises, verified evidence, capability health, and recovery.' },
  GOALS: { title: 'Mission control', description: 'Persistent to-dos, specialist agents, visual monitors, scheduled work, generated media, and the background event tape.' },
};
const uid = () => crypto.randomUUID();
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const MessageText=({text}:{text:string})=><>{text.split(/(https?:\/\/[^\s]+)/g).map((part,index)=>/^https?:\/\//i.test(part)?<a key={`${part}-${index}`} href={part.replace(/[),.;]+$/,'')} target="_blank" rel="noreferrer">{part}</a>:part)}</>;
const microphoneConstraints=(deviceId=''):MediaTrackConstraints=>({deviceId:deviceId?{exact:deviceId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1});
const automationCapabilities = [
  { code:'UIA', title:'APPLICATION CONTROL', detail:'Inspect controls, invoke buttons, select tabs and set fields' },
  { code:'WIN', title:'WINDOW MANAGEMENT', detail:'Focus, minimize, maximize, restore and explicitly close apps' },
  { code:'KEY', title:'MEDIA + INPUT', detail:'Volume, mute, playback and targeted application values' },
  { code:'CLP', title:'SECURE CLIPBOARD', detail:'Read or replace clipboard text only on direct request' },
  { code:'WEB', title:'BROWSER LAUNCH', detail:'Open verified HTTPS destinations in the default browser' },
  { code:'PS', title:'POWER AUTOMATION', detail:'Advanced PowerShell behind exact two-step confirmation' },
];
const macAutomationCapabilities = [
  { code:'AX', title:'ACCESSIBILITY CONTROL', detail:'Inspect controls, press buttons, select menus, and fill fields in visible Mac apps' },
  { code:'WIN', title:'WINDOW MANAGEMENT', detail:'Focus, minimize, maximize, restore, and explicitly close Mac windows' },
  { code:'APP', title:'APPLICATION LAUNCH', detail:'Open allowlisted native and productivity applications' },
  { code:'CLP', title:'SECURE CLIPBOARD', detail:'Read or replace clipboard text only on direct request' },
  { code:'WEB', title:'BROWSER CONTROL', detail:'Open and operate visible HTTPS pages with verification' },
  { code:'SCR', title:'SCREEN UNDERSTANDING', detail:'Capture the display only for an explicit user request' },
  { code:'BLD', title:'BUILD LAB', detail:'Edit and verify projects with automatic rollback checkpoints' },
];
const buildStages = [
  { code:'01', title:'UNDERSTAND', detail:'Inventory the project and read the relevant source before changing anything' },
  { code:'02', title:'CHECKPOINT', detail:'Create an automatic per-file rollback point before every write' },
  { code:'03', title:'IMPLEMENT', detail:'Make a minimal, coherent source change inside the configured workspace' },
  { code:'04', title:'VERIFY', detail:'Run the project’s real test, build, lint, or typecheck scripts' },
];
const providerDefaults:Record<AIProvider,string>={openai:'gpt-5.6-luna',anthropic:'claude-sonnet-5',gemini:'gemini-3.6-flash'};
const appearancePalette:Record<AppearanceColor,string>={teal:'#20ffd3',green:'#60ff84',blue:'#41b8ff',violet:'#b667ff',amber:'#ffb530',orange:'#ff7a32',pink:'#ff4fc8',red:'#ff304e',white:'#dcffff'};

// Hand-maintained, not auto-generated from commits — kept short and honest
// rather than exhaustive. Bump alongside package.json's version.
const BEHAVIOR_CHANGELOG:Array<{version:string;summary:string}> = [
  {version:'3.23.0',summary:"Robbie's ask: build in God's Eye View — his existing, real, open-source (MIT, bilawalsidhu/gods-eye-view) live 3D-globe app — as a built-in Axiom feature, \"some cool ass way,\" not just a shell-out to open it separately. Investigated the real app first rather than guessing: decompiled its actual macOS launcher applet (osadecompile) to find the real launch script, which showed it's a Vite dev server on localhost:4173 with its own OpenAI Realtime voice control — deliberately NOT reused, since Robbie confirmed Axiom should drive it directly instead of running two separate voice pipelines at once. Built a real GodsEyeViewManager (godsEyeView.ts) that owns the external project's server lifecycle (spawns `npm run dev`, polls readiness the same way the app's own real launcher script does) and embeds the running page via Electron's WebContentsView — deliberately not the `<webview>` tag, which Electron's own docs advise against, and not an iframe, since this is a second live local server, not remote content. Axiom drives the camera by writing to the embedded page's real URL hash (`#v=2&lat=...`), the exact format confirmed from watching the real app run — not a private or reverse-engineered API. Two new tools (open_gods_eye_view, gods_eye_fly_to) let Axiom open it and fly the camera by voice or text; UX-wise, per Robbie's own proposed design (approved from a mockup first), clicking either eye on the skull avatar opens it directly — a HUD panel materializes with corner brackets and a scan-sweep, matching the existing Ring-camera panels' particle-burst open/close pattern rather than inventing a new one. Mac-only for now, both the tools and the eye-click trigger — Robbie was explicit that Windows support is a separate, later session once he's back on that machine; gated the same way the existing Mac-only Apple tools (Mail, Notes, Reminders) already are, so nothing is offered where it can't work. Settings gained a project-folder field (defaults to empty — nothing runs until it's set). Verified with real unit tests: the manager's own readiness-polling/error/cleanup logic (mocked fs, spawn, and WebContentsView, not the real external app, which only Robbie's machine has installed), the two tools' keyword-trigger and mac-only gating, and the new store settings field and its runtime-only manager reference. Full build, typecheck, and test suite clean. What's still unverified because it can only be proven on Robbie's real machine: whether the embedded server actually starts and renders correctly end-to-end, and whether real click/voice-driven flyTo actually moves the real globe."},
  {version:'3.22.1',summary:'Robbie put his finger on something real: Axiom "over-explains himself" — does the thing, then narrates which tool ran and how it confirmed that, instead of just saying it\'s done. Traced it to the actual system prompt: baseInstructions is built entirely around verification honesty (\"never claim success unless verified,\" \"report changed files, checks, and checkpoint IDs\") — exactly the right instinct for whether Axiom is ALLOWED to say something worked, but that habit of self-justifying was bleeding into how it talks about ordinary, successful turns too. Rewrote the one function that owns tone specifically (conversationMode, deliberately separate from the verification rules) to say plainly: when something worked, say so in a sentence, don\'t narrate the mechanics unless asked. The detailed, structured breakdown is explicitly kept for exactly where it still belongs — blocked, failed, or genuinely uncertain results, which go through a completely separate, unchanged code path (normalizeActionReply) that still forces the full BLOCKED/NEEDED/COMPLETED SO FAR/NEXT ACTION report regardless of tone. Deliberately not a return to the randomly-rotated "personality" instructions rejected earlier this project for being unpredictable — same consistency principle, just a warmer, less clinical default voice. This is a prompt-wording change with no way to unit test whether it actually reads as more casual in practice — that\'s the next real test, on a real conversation.'},
  {version:'3.22.0',summary:"Three new connectors, requested directly: Stripe, Klaviyo, and WhatsApp Business, joining Google/Shopify/Meta/Dropbox/Homebridge/Ring. Stripe reads recent charges with a restricted, read-only API key — the tool description and the Settings hint both say plainly it can never create a charge, refund, or payout, and the key itself should be scoped that way at the source. Klaviyo reads recent email campaigns; every request sends the API-revision header Klaviyo requires, which is easy to silently omit and get a stale-behavior response instead of an error. WhatsApp sends a real text message through the connected Business number, gated behind the same fresh-approval requirement as Gmail sending — and is honest about a real constraint of Meta's API: a free-form message only works within 24 hours of the other person's last message to that number; outside that window Meta's own API rejects it and demands a pre-approved template, and Axiom surfaces that exact reason from Meta rather than guessing at a fix. All three verified against realistic fake-server responses, including Klaviyo's required header actually being sent and Meta's real 24-hour-window error message passing through unmodified. Declined the phone-calling feature from the same request — real telephony (Twilio) costs money and needs a deliberate decision about AI-call disclosure and recording-consent law that isn't Axiom's to make unilaterally; noted, not built."},
  {version:'3.21.0',summary:"Two direct complaints: replies feel slow (\"he shouldn't have to process the whole question and come back with an answer\"), and Axiom sometimes falsely claims it can't do something. Investigated both for real rather than guessing. (1) Confirmed in the actual request code: OpenAI has streamed token-by-token since 3.12.2, but Anthropic and Gemini never had streaming implemented at all — every reply from either literally waited for the entire response to finish generating server-side before showing a single character, regardless of how fast the model itself was. Built real SSE streaming for both, reusing the same buffer-the-first-forced-round-only pattern already proven for OpenAI (a tool-forced round can interleave stray preamble with the tool call, so only the free-choice final round streams live). Anthropic assembles a tool call's arguments from fragmented JSON deltas only once the block closes, never parses them mid-stream; Gemini concatenates its incremental text chunks into one final part without touching function calls, which arrive whole. Verified against real SSE payloads shaped exactly like each provider's actual streaming format, including one deliberately split mid-event to prove the cross-chunk buffering works, not just whole-event-per-read. (2) The \"I can't do that\" pattern is real, but honestly can't be fully eliminated — it's the long tail of a keyword-matching system encountering a phrasing nobody's hit yet, the same root cause behind every past fix to this exact class of bug (web search, folder creation, Homebridge, desktop control...). What was actually true before this fix: it was invisible. Every occurrence now gets logged with the exact message that triggered it, so the next one is a concrete, fixable diagnostic entry instead of a complaint with no trail — the same approach that actually solved \"AI providers unavailable\" earlier this project, applied to this bug's real shape instead of promising something a regex-based system structurally can't guarantee."},
  {version:'3.20.5',summary:'The first real, live bug from actually running the packaged app: "open Google Chrome" got "More than one application matches: Google Chrome, Google Chrome" — an unanswerable question, since both options display identically. Reproduced it exactly against the real files: Chrome\'s installer had left a shortcut in both the shared Public Desktop and the all-users Start Menu, and the app scans four separate shortcut folders (personal Desktop, Public Desktop, personal Start Menu, all-users Start Menu) but only ever de-duplicated against a separate Windows app list, never against itself. Two shortcuts with the exact same name can never be told apart in a "which one did you mean?" prompt anyway, so this is never a real choice to ask about — just the same app found twice. Fixed, and proven with a real regression test: confirmed it reproduces the exact live error message before the fix, and is gone after.'},
  {version:'3.20.4',summary:"Finished the documentation sweep from 3.20.2/3.20.3 by actually listing every root-level doc file instead of trusting a truncated search — found several more that a partial listing had hidden. MAC_AND_SYNC_SETUP.md is real, current, user-facing setup documentation for cross-device sync, and its Settings terminology all checked out — but it told anyone hitting a blocked Electron install script during Mac setup to run `npm install-scripts approve electron`, which isn't a real npm command at all; the actual one (verified against this machine's real npm) is `npm approve-scripts`. Also fixed a hardcoded example DMG filename that would go stale every release, same class of mistake PRODUCTION_READINESS.md's test-count reference already made. THIRD_PARTY_NOTICES.md — required reading before any commercial release per CLEAN_ROOM.md — only listed 3 of the packages actually shipped; added entries for the WavLM speaker-identity model, the new all-MiniLM-L6-v2 memory-embedding model, and the real npm runtime dependencies (Electron, React, Three.js, @huggingface/transformers, onnxruntime-node, ws, systeminformation), each with its actual license — while being explicit that this is a starting point for the independent audit the project's own clean-room process already calls for, not a replacement for one. One license (WavLM's) is flagged as unconfirmed rather than guessed. SECURITY_MODEL.md was checked against this session's own independent security audit and found accurate — left untouched."},
  {version:'3.20.3',summary:"Kept pulling the same thread from 3.20.2 — the project's own docs turned out to be a real audit surface, not just code. This pass found two more, both genuinely stale: docs/HOME_ASSISTANT.md still walked a user through connecting a smart-home platform that was removed entirely back in 3.7.3, pointing at a Settings screen that no longer exists (Homebridge replaced it). Replaced it with docs/HOMEBRIDGE.md, describing the platform that's actually there — including the one thing people would otherwise get stuck on (Homebridge has to be running in Insecure Mode, or its own control API refuses everything). Separately, PRODUCTION_READINESS.md — the project's own release-readiness contract — still had rows for Home Assistant and Office Sentry (both fully removed) sitting there as \"CONDITIONAL,\" as if they were real gaps blocking release rather than nonexistent features; fixed those rows, added one for the new local-memory system that didn't exist when the doc was last touched, and noted the real packaged-build verification from 3.20.1 against the row it actually resolves. A separate, much older RELEASE_NOTES.md stops at v2.9.1 with no indication it's frozen there — could easily be mistaken for the current state by anyone new to the project — so it now says plainly at the top that it's historical and where the real current record actually lives."},
  {version:'3.20.2',summary:"Robbie's ask this round was broader: fix everything, no new features, just make it real to install/setup/use and ready to actually ship. Found one thing that mattered more than any code bug so far. docs/ASSET_PROVENANCE.md — Axiom's own clean-room provenance ledger — has flagged since 2026-08-14 that three recovered mouth-pose images and a reference background, pulled from Robbie's commissioned modification of a previously purchased assistant, had \"distribution clearance pending\" and needed confirmation before any public or commercial release. Checked whether they're still actually used: they're not. The real, currently-rendered skull avatar (ModdedSkullAvatar.tsx) uses a completely separate, newly-authored image set (axiom-skull-closed/half/open.png — different files, different dimensions, not a rename) that already replaced them. But the four legally-clouded originals were still sitting in the public assets folder with zero code references, which means Vite was still copying them into every single packaged build regardless — dead weight shipping unresolved legal exposure inside the actual distributable, discoverable by anyone who unzips it. Removed them and updated the provenance ledger to record it. Separately: there was no README anywhere in the project — nothing telling a stranger what Axiom needs (an API key from one of three providers, nothing else required), how to install it on either platform, or what the optional setup (voice, face, smart home, connectors) actually involves. Wrote one. Also verified, while looking for more of the same class of gap: the Mac-source packaging script already uses an explicit allowlist rather than a denylist specifically to keep old temp/leftover directories out of what ships — that part was already sound, nothing to fix there."},
  {version:'3.20.1',summary:"Went to independently verify the one thing left unverified from 3.19.0 — whether the new native ONNX dependency actually survives real packaging, not just npm start — and found a real, serious bug in the process, on this Windows machine where I could actually test it directly. Built an actual packaged Windows app (not dev mode) and inspected what really ships inside it: @huggingface/transformers (and therefore onnxruntime-node, and the whole memory embedding system) was listed as a devDependency, correct for its original renderer-only use where Vite bundles it in — but silently wrong now that main-process code uses it directly, since devDependencies are never included in a packaged build by design. It would have loaded fine in every dev/test run and failed to load in every real distributed copy, forever, with memory quietly falling back to keyword-only search and no error anyone would see. Moved it to a real dependency and verified the fix for real: extracted the actual packaged app.asar, loaded the actual native binary electron-builder's rebuild step produced, and ran real inference against the actual packaged model files — genuine end-to-end proof for the Windows target specifically, which is the one machine here capable of proving it. The Mac build (different chip, only buildable on Robbie's own machine) still needs his real test, but the packaging approach itself is now proven sound rather than assumed."},
  {version:'3.20.0',summary:"Robbie asked directly: get this ready for real distribution — paid or open source, undecided — and go find bugs along the way. Ran three parallel audits (single-user assumptions, security posture of the tool-execution layer, and crash resilience) against exactly that bar: not \"does this work for the one machine it's always run on,\" but \"does this survive a stranger's install.\" Two real blockers found and fixed. (1) Startup had no error handling at all — any single failed step (a permissions problem, a first-run edge case) left Axiom sitting with literally no window, no tray icon, and no error, looking dead with zero explanation. Now wrapped in a real try/catch: a startup failure gets logged, shown in a real error dialog, and Axiom makes one more attempt to open a window rather than giving up silently. (2) The entire renderer was one 2000+ line component tree with no error boundary — any single render-time exception, anywhere, white-screened the whole app with no recovery but killing the process. Added a real React error boundary with a reload option, and its own crash report now reaches the same runtime log every other failure already writes to, so a crash a stranger hits leaves an actual trace instead of vanishing the moment they relaunch. Also fixed along the way: Google OAuth token requests had no timeout (a flaky connection could hang indefinitely with zero feedback) while every other network call in the app already enforced one; a brand-new install with no saved data yet was being logged as a max-severity \"DATA-LOSS\" event on every single first launch, which would have buried real data-loss reports under one for every routine install; and a background embedding-backfill loop could silently abort partway through on one bad record instead of continuing past it. Separately, the PowerShell safety filter — a plaintext denylist of dangerous command names — was found to be real but weaker than its own framing implied: it catches literal invocations but not common obfuscation (a base64 -EncodedCommand payload, a download-cradle piping a remote script into IEX, persistence via scheduled tasks or Defender exclusions). Expanded the denylist to catch those specific real patterns as a genuine improvement, while being honest in the code itself that this was never the actual security boundary — the human-approval flow (the exact command shown verbatim, requiring the literal APPROVE code from the user's own message, which the model cannot forge) is what was actually verified sound by the audit, and remains the real defense. What's flagged but deliberately not touched: package.json's author/license/appId and 30+ changelog entries carry personal, one-owner-specific framing that would need a real decision (product name, license choice, paid vs. open source) before public release — those are business calls, not bugs, and are Robbie's to make, not mine to guess at."},
  {version:'3.19.1',summary:"Follow-up while extending the memory work: found the exact same stale assumption sitting one function away. Axiom's self-correction lessons (the record of its own past mistakes, kept separate from facts about the user) had a comment reading almost verbatim \"good enough without needing an embedding model\" — written before an embedding model existed. A lesson recorded as \"user asks about the weather\" required the live message to literally share one of those words; asking \"what's it like outside today\" instead would miss the lesson entirely despite meaning the same thing. Now uses the same real semantic-plus-keyword blend memory search got in 3.19.0, verified the same way — a real test proves the rephrased case now matches, not an assumption that the same fix would obviously carry over."},
  {version:'3.19.0',summary:'A real "top-notch memory system" upgrade, done in the order proposed: semantic search, implicit capture, usage-aware ranking, and conflict detection, all landing together. (1) Memory retrieval used to be pure keyword substring matching — asking "where\'s my hometown" would never find a memory that only says "lives in St. Louis," since neither word appears in the other. Added a small, fully local, offline sentence-embedding model (all-MiniLM-L6-v2, bundled the same way WavLM already is for voice) so memories are now found by meaning, not just shared words; verified directly against the real model, not assumed — a memory sharing zero keywords with the query genuinely surfaces now. (2) remember_fact and recall_memory used to be offered to the model only behind an explicit "remember"-style trigger phrase — the exact same keyword-gating blind spot fixed for web search, folder creation, and Homebridge control earlier this project, just never caught here before. A plain statement made in passing ("I just moved to Austin") never said the word "remember," so Axiom was never even given the option to save it. Both tools are now offered on ordinary conversational turns so Axiom can choose to save something durable on its own; explicit saves stay recorded at full confidence, self-initiated ones are tagged assistant-inferred at reduced confidence so they read as distinct in the Memory settings page. Carefully scoped so this never dilutes the exact-tool-forcing behavior action/identity/smart-home/live-web requests depend on — verified with a regression test against the canonical sole-candidate case (create_directory). (3) Two memories tied on keyword relevance no longer rank arbitrarily — retrieval count and recency of last use now factor into ranking, so a memory Axiom keeps getting asked about stays sharp while one nobody has touched in months quietly fades from ties, without ever being deleted. (4) Before saving a new memory, Axiom now checks it against existing ones on the same topic: a near-identical paraphrase is recognized as a duplicate and not re-saved; something that looks like it\'s about the same thing but says something different (e.g. a new city after an old one) comes back as a possible conflict Axiom is instructed to raise with the user and reconcile via correct_memory, instead of silently letting two competing facts both sit as "active" forever. All four pieces are backed by real tests that exercise the actual bundled model (not a stubbed vector) — including the specific "shares zero keywords" retrieval case and the duplicate/conflict/unrelated similarity thresholds, calibrated from real model output on a small hand-built example set rather than assumed numbers. Existing memories are backfilled with embeddings automatically in the background on next launch — nothing is lost or needs re-saving. Unverified from here, same honesty boundary as always: the packaged app needs to actually load the new native ONNX runtime dependency correctly on a real machine, which only a real build and run can confirm.'},
  {version:'3.18.0',summary:'The left navigation rail — 11 flat routes stacked in one long, crowded column — is rebuilt after several rejected mockups and one honest admission that drove the final shape: "i only use the settings really." Only CHAT and SETTINGS now sit permanently visible at the top; the other 9 routes (Tools, Screen, Files, Web, Automate, Build, Memory, Core, Starred) collapse behind a single MORE toggle and expand on demand instead of always eating space for routes rarely touched. The freed space became a real "Quick Status" block: hands-free listening got pulled out of being "the hands-free widget," which Robbie called out directly as pointless, and rebuilt as a single fused control — a 3D counter-rotating ring core (skull glyph at center) wrapped in a live audio-reactive spectrum ring drawn from the same real hands-free state (settings.startMicrophoneOn) that already drove the old composer toggle, so clicking it does the exact same toggleHandsFree() call either way, just with a presence worth looking at. Below it, a live camera-peek button appears only when a Ring camera is actually open (first one in the real ringViews map), and a live CPU sparkline (built from a rolling window of the real telemetry feed, reusing the existing digit-scramble readout component) replaces what used to be static filler. Caught one real CSS bug before it shipped, consistent with the layered-stylesheet lesson from 3.13.1/3.15.1: a pre-existing generic `.rail button{height:62px;...}` reset in styles.css has higher CSS specificity than a bare new class like `.primary-node{}` alone, so it would have silently overridden the new button styling regardless of source order — every new rail button rule was written as `.rail .primary-node{}` etc. specifically to beat it.'},
  {version:'3.17.0',summary:'Settings cleanup, approved from a live mockup: the Control Center was 13 dense sections — API keys, sliders, a 52-item permission list, a changelog that had grown to 37 entries — all dumped into one continuous scroll. Redesigned around a simple idea: collapse everything, expand one. 3 always-visible essentials (AI Provider, Voice, Permissions) now show real live status without opening anything; the other 10 sections collapse into single-line headers and only open one at a time; the search bar now actually opens the right section and scrolls to it instead of just jumping to an anchor in a still-giant page. The mockup itself only showed 5 merged categories, but the real settings turned out to have more distinct sections than that (Updates, Data export/erase, Biometric Consent, and Portable Backup weren\'t all visible when it was built) — forcing those into artificial shared buckets would have just recreated the same wall-of-content problem inside a smaller box, so each stayed its own collapsible section instead. Every existing field, toggle, and button works exactly as before — this only changed how it\'s organized, not what any of it does.'},
  {version:'3.16.0',summary:'The "cognition field + scrambling readouts" combo Robbie approved from a live mockup is now real. A particle mesh around the skull swirls, accelerates, and starts firing synapse connections between nearby points whenever Axiom is genuinely thinking (wired to the real thinking/idle state transitions already driving the rest of the UI — not a separate simulated state), then bursts back outward once the reply resolves. CORE LOAD and ACTIVE WORK now scramble through digits before landing on their real value whenever they change, instead of just swapping text, like a HUD calibration readout. Both respect reduced-motion (skip straight to the final state, no animation).'},
  {version:'3.15.1',summary:'Robbie\'s screenshot with 3 cameras open showed real breakage: the first panel overlapping the CORE LOAD / INTEL LINK readouts at the top, panels crowded on top of each other with no visible gap, and the neural-link lines nowhere to be seen. Traced all three to real, fixable causes. The overlap: the fixed vertical arc (13% + 30% per camera) was sized against a single-row readouts layout, but commandCenter.css — the actual winning "final visual layer" — makes it a real 2-row grid reaching much further down; the arc never accounted for that. The crowding: that same fixed arc had no way to know how many cameras were actually open, so 3 stacked cameras simply didn\'t fit in the space it assumed. Both fixed together: panel position and size are now computed live against the real measured screen height and the actual number of open cameras, dividing the true safe space evenly between them and shrinking each circle as more join, so nothing overlaps regardless of count. The connector lines were real but nearly invisible against the skull\'s own glow and the busy camera feeds — thickened and brightened substantially (primary strand 1.6px/80% opacity to 2.4px/95%, secondaries 0.9px/40% to 1.4px/65%) so the neural-link bundle actually reads at a glance instead of disappearing into the background.'},
  {version:'3.15.0',summary:'Two direct requests, approved from a live mockup first: Ring cameras are now round instead of rectangular — each panel is a circle that echoes the skull\'s own ring geometry, with its outline drawing itself in the same way, and 8 scope-style targeting ticks around the circumference replacing the old corner brackets, which don\'t make sense on a circle. And the skull-to-panel data-link is now a real nerve bundle instead of one clean line: a bright primary strand plus two thinner secondaries with organic wandering curvature, a couple of short unconnected dendrite stubs near the skull for texture, pulsing synapse nodes along the primary strand, and the traveling light-pulse still runs along it when a camera connects. Controls (mute, push-to-talk, expand, close) moved into a floating pill caption below the circle, since a circle has no header bar to put them in. Caught and fixed a real bug of my own in the process: the connector was originally going to fully rebuild itself every animation frame while tracking the panel through its open/expand/collapse transitions, which would have restarted every strand\'s fade-in 60 times a second and made the whole thing flicker at near-zero opacity the entire time instead of settling — split into a one-time build and a lightweight per-frame reposition before it ever shipped.'},
  {version:'3.14.1',summary:'The 3.14.0 materialization Robbie built never actually played — asking Axiom for a camera has always force-switched to the SCREEN tab (a leftover from when Ring cameras rendered full-screen there), but the new panels only render on the home/chat screen, so the switch hid them completely behind SCREEN\'s unrelated local-camera content instead of showing anything. Fixed: opening a camera now stays on (or switches to) the home screen where the panels actually live. Also punched up the effect itself since it deserved a real chance to be judged fairly: bigger panels, ~2.3x more particles with brighter hot-white ones mixed in and further scatter distance, a proper "systems online" flash across the frame right as it finishes unfolding, a bigger bracket overshoot-and-settle snap, a stronger scan-line, and the whole sequence stretched out to breathe (~1.3s instead of rushing through in under a second) rather than being over before it registered.'},
  {version:'3.14.0',summary:'Replaced the plain corner camera tiles with the Jarvis-style materialization Robbie approved from a live mockup: opening a Ring camera now bursts a shower of particles that converge into the panel\'s outline, the frame unfolds open from its center, targeting brackets snap into the corners, and a scan-line sweeps down as the feed resolves — with a thin animated data-link drawn from the skull out to the panel the whole time it\'s open. Closing reverses it: the panel dissolves back into particles that scatter away. Panels sit in a fixed arc to the right of the skull, out of its space, same as before; expanding one to a larger view still works exactly as it did. Respects reduced-motion (skips the burst and animated transitions, keeps the open/closed states instant). Also applied the layered-CSS lesson from 3.13.1 before shipping: .stage carries `contain:layout paint style` from commandCenter.css, which silently makes it the containing block for anything position:fixed inside it — including the new particle canvas. Caught and fixed by measuring the canvas\'s own real on-screen box instead of assuming it matches the window, so the burst lands in the right place regardless of that containment.'},
  {version:'3.13.1',summary:'The broken composer from 3.13.0 ("COMMAND" label overlapping a squeezed input, the send arrow stranded below-left) was not a typo — it was a real, deeper discovery: styles.css is not the only stylesheet in this app. src.tsx loads 11 more CSS files after it (referenceMod.css, commandCenter.css, and others — a genuine layered "mod" architecture on top of the base styles, not something touched or known about earlier this session), and one of them, referenceMod.css, still had the OLD 3-column composer layout (record | input | send) — because CSS files loaded later always win ties over earlier ones, that stale rule was the one actually controlling the real app the whole time, regardless of what styles.css said. Adding a 4th button without updating that file meant the new button had nowhere defined to go, so the grid quietly wrapped it onto a second row, and the existing "COMMAND" caption label (also from that later file, injected via CSS — not something in the JSX) stayed at its old fixed position while the input column shrank out from under it. Fixed by updating the actually-winning file, matching its visual treatment for the new button, and moving the button to the row’s end so nothing else needed to shift. Also means: this same layered-CSS blind spot could affect earlier UI work this session that never checked these override files — worth a closer look if anything else from 3.10.0–3.13.0 looks off.'},
  {version:'3.13.0',summary:'Home-screen redesign, requested directly: (1) Ring cameras now live on the home/chat screen as a small corner stack that never covers the skull or its ring — click one to grow it into a large, clearly-visible view with a real animated expand/collapse (same video element, just resized/repositioned, so it stays smooth); click again to shrink it back. Note: an EXPANDED camera does take over a large central area of the screen while open, since making it "clearly visible" and "never touching the skull\'s space" are in tension once you deliberately blow one up — happy to change that boundary if this isn\'t what was meant. (2) Removed the persistent response text box under the skull entirely, replaced with only a one-line status word (LISTENING / RESPONDING / etc.) with a soft pulsing glow — Axiom\'s actual reply is still spoken aloud and still recorded in history, just never shown as a lingering text panel anymore. Also removed the "VOICE ID OPEN / WAVLM READY" pill below the skull outright. (3) Hands-free listening (on by default) now has a direct one-click toggle right next to the command bar — a headphone icon that dims when off — instead of only being reachable through Settings.'},
  {version:'3.12.4',summary:'Robbie\'s Front Door screenshot showed the actual layout bug behind "the feed is tiny": the box wrapping any live camera view (local or Ring) had no size of its own — every rule inside it says "fill 100% of my parent," but nothing ever gave that outer box a real size against the app frame it sits in, so the browser fell back to sizing the whole thing off the video\'s own small native resolution, leaving a tiny circular Ring fisheye frame floating in an otherwise empty box. Gave the camera window an explicit, real size against the main stage (same technique the avatar and composer already use), so a single open camera now fills that space properly, and several open at once share it in a real grid instead of everyone getting squeezed by an undersized container. Verified via full rebuild/typecheck/test pass, not a live visual check from here — no camera hardware reachable from this machine, so worth a look once built.'},
  {version:'3.12.3',summary:'Caught the actual "AI providers unavailable" bug live, in Robbie\'s own screenshot: asked for St. Louis weather, and the model correctly attempted the search, the search genuinely failed, and the model honestly said so instead of making something up — exactly the right behavior. Axiom then threw that answer away anyway and showed the scary red error instead, because a required-tool check treated "the tool ran and failed" the same as "the model never even tried," and hard-blocked both identically. Only the second case is actually dangerous (a genuine skip/hallucination risk); the first already produced a real, honest, evidence-backed reply that deserved to reach the user. Fixed in all three provider paths. Separately, worth knowing: switching the main AI provider in Settings does not change what handles weather/news/current-events questions — that\'s a separate "Research Provider" setting, defaulting to OpenAI independent of the main one, which is why this specific failure said "openai" even while the main provider was set to Anthropic.'},
  {version:'3.12.2',summary:'Robbie asked directly: shouldn\'t Axiom stream its answer as it\'s generated, like other AI apps do, instead of waiting for the whole thing? Traced it and found a real, specific bug, not a platform limitation: OpenAI\'s response API genuinely streams token-by-token under the hood, but any request that forces a tool call — which is most useful requests: weather, news, opening apps, camera control, basically anything actionable — had its ENTIRE final answer silently buffered and dumped in one shot at the end instead of shown live, because the same buffering guard meant for the initial tool-call decision was mistakenly being reused for the real final answer too. Fixed: only the first, forced round is buffered now; every round after that (where the model is answering freely, tool_choice back to automatic) streams live like a normal conversational reply always did. Anthropic and Gemini still don\'t stream at all yet, honestly — they never did a real token stream, just a single one-shot callback at the very end; not fixed this pass since Robbie\'s active provider is OpenAI, but a known, real gap if either of those becomes the primary provider later.'},
  {version:'3.12.1',summary:'"AI providers unavailable" has hit repeatedly, on random requests, with no way to actually diagnose it — because it turns out that exact failure path never wrote to the diagnostic log at all, even though every other Axiom failure (Ring, voice, sync) has since the first Ring 500 taught that lesson. Checked the real runtime log directly: days of real usage, zero entries for it, confirming the gap rather than guessing at it. Fixed: assistant:send now logs both success and failure (with the real per-provider error text and total latency) to the same runtime log everything else already uses. Also traced why replies can take 2-30 seconds: weather/news/current-events questions route through a real, hidden Google search browser window, whose own settle/consent-retry logic can legitimately take up to ~23 seconds before the model ever sees a result — not fixed yet (retuning those timeouts blind, without evidence, is exactly the kind of guess that hasn\'t worked before), but the latency log now records which requests triggered a search tool, so the next slow one can be measured instead of guessed at.'},
  {version:'3.12.0',summary:'Ring camera audio was playing automatically with no control over it (an accident of the video element never being muted, not a built feature) and there was no way to talk back at all. Both fixed: each camera tile now has its own speaker mute toggle, defaulting to sound-on for the first camera you open and muted for any opened after it (so "show me all my cameras" doesn\'t turn into three overlapping audio streams by default) — and a real push-to-talk mic button, matching how Ring\'s own app and every doorbell intercom works: hold to talk, release to stop, never an open mic. The microphone is only requested the first time you actually press talk on a given camera, not when you open the view, so watching a camera never triggers a permission prompt on its own. Verified against Ring\'s real protocol (same source already used to build the live-view signaling) that no new server-side messages are needed for this — audio was already fully negotiated, our own connection just never sent a real outgoing track. Not yet verified live: whether the far end (the camera\'s own speaker) actually plays it intelligibly — that needs a real device test.'},
  {version:'3.11.1',summary:'Closed the one gap left in 3.11.0: UWP/Microsoft Store apps have no Desktop or Start Menu shortcut file at all, so they were still unreachable. Added Get-StartApps (Windows\' own built-in enumerator for literally everything in the Start Menu, traditional and Store apps alike — verified live against this machine: 152 real entries, Notepad and Calculator included, since both are UWP apps now) as a second source, merged with the shortcut scan and de-duplicated so an app appearing in both never triggers a false "which one did you mean?". Also verified directly against the real Desktop that "God\'s Eye View.lnk" is exactly where expected and now resolvable.'},
  {version:'3.11.0',summary:'"Open God\'s Eye View" got refused as impossible — the real cause was worse than a missed keyword: open_application had a closed list of ~14-24 pre-approved app names baked directly into its schema, so it was structurally incapable of opening anything else, no matter how the request was phrased. Rebuilt it to resolve ANY installed application by name — real Desktop and Start Menu shortcuts on Windows, /Applications on macOS — with the same exact/substring/ambiguous name-matching already proven for Ring cameras and Homebridge accessories (an unresolved tie is a clear question back, never a guess). The original ~14 well-known system tools (Notepad, Calculator, Settings, Explorer, etc.) still open instantly with no filesystem search. UWP/Microsoft Store apps without a Start Menu shortcut are a known, stated gap for now, not silently unhandled.'},
  {version:'3.10.0',summary:'Ring cameras now show simultaneously, not one at a time — asking for a second named camera while the first is still open now opens both side by side, and a new "show me all my cameras" opens every camera on the account at once, in a grid. This was a renderer-only change: the main-process side already tracked live-view sessions in a map keyed by session id, built that way from the start even though only one was ever used at a time. Also fixed three real bugs found in the same pass: switching cameras (or a lost connection retrying) used to only tear down the local video, leaving the actual Ring session running in the background until Ring\'s own server eventually force-closed it — now every camera\'s session is explicitly closed by id, whether the user closes it, replaces it, or the connection drops for good. That forced close was also arriving as a genuinely malformed frame from Ring\'s server (an invalid close status code, the same kind of spec violation already worked around once for the SDP answer), which was being reported as a connection fault even for a session Axiom itself asked to close — now correctly treated as normal, not an error. And the video feed itself was silently mirrored left-right this whole time, inherited by accident from the local self-view webcam\'s styling — wrong for a security camera, now fixed.'},
  {version:'3.9.2',summary:'While waiting to confirm the exact phrasing behind a separate "front door stopped working" report, fixed a real, confirmed gap in the meantime: camera routing only recognized the full word "camera"/"webcam", never the extremely common shorthand "cam" ("front door cam", "back door cam") — that phrasing fell straight through to the general AI assistant, which correctly (but unhelpfully) reported it has no camera tool. "Cam"/"cams" now works everywhere "camera" did, including the new "what Ring cameras do I have" question from 3.9.1.'},
  {version:'3.9.1',summary:'First real multi-camera test surfaced two real gaps. First: Robbie has three Ring cameras, but only "Front Door" ever showed up — the other two were real cameras Ring\'s own server puts in a generic catch-all device bucket instead of the camera-specific one Axiom was reading; now included (filtered to only camera-like devices from that bucket, not garage-door openers or other non-camera devices that also live there). Second: the "no camera by that name" error told the user to "ask Axiom to list your cameras" — a capability that didn\'t actually exist. Built it for real (a direct "what Ring cameras do I have" question now works), and the not-found error now names your actual cameras directly instead of pointing at a dead end.'},
  {version:'3.9.0',summary:'Ring live view was hitting a real 500 from Ring\'s server because it was built against the wrong API — a REST endpoint (integrations/v1/liveview/start) that turned out to be a legacy/different-purpose path. Investigating the ring-mqtt project led to Home Assistant\'s actual current, shipping Ring integration source, which uses a completely different protocol: a WebSocket ticket exchange with real trickle ICE in both directions, not a single request/response. Rebuilt live-view signaling against that real protocol — a WebSocket session now lives in the main process (it needs the account\'s auth token), relaying the SDP offer/answer and individual ICE candidates to and from the renderer\'s WebRTC connection as they happen, instead of waiting for everything up front. Also includes a fix for a known Ring server bug (it sometimes answers a receive-only offer with the wrong SDP direction, which strict WebRTC implementations reject) and a keepalive ping loop Ring\'s connection requires to stay open. Everything about Ring login, 2FA, and camera listing — already confirmed working against a real account — is untouched. The actual live-view handshake itself still hasn\'t been tested against a real camera as of this build; that\'s the next real test.'},
  {version:'3.8.2',summary:'The 3.8.1 logging fix worked as intended and immediately surfaced a real error: Ring\'s liveview/start API returned a 500, but the connector\'s generic error handling discarded whatever Ring actually said, showing only "Connector request failed (500)" — a dead end even with logging turned on. It now includes the raw response body in that case, so the exact reason is visible instead of a bare status code. Also fixed a real, independently-worth-fixing gap found in the same pass: the Ring live-view connection was never given a STUN server, so it could only ever offer local-network candidates — added public STUN, which most WebRTC clients need to be reachable from behind home NAT. Also fixed the same "resource fork, Finder information, or similar detritus not allowed" codesign failure hit during Mac build — a Dropbox-extracted source folder carries extended attributes codesign refuses to sign; the Mac build script now strips them automatically before signing instead of failing at the very last step.'},
  {version:'3.8.1',summary:'First real Ring live-view attempt connected and matched the right camera, but the video never came through — status just showed FAULT with no explanation. That was a real gap: a dropped WebRTC connection (the likely cause — a network/NAT/firewall issue reaching Ring\'s media servers, not necessarily an Axiom bug) never logged or displayed anything at all, and none of the Ring API calls left a trace in the diagnostic log the way voice/realtime calls already do. Fixed both: the live-view window now shows the actual reason under FAULT instead of just the word itself, and every Ring connect/camera-list/live-view call now logs to the runtime diagnostic log on success or failure, so a real failure is diagnosable instead of a dead end.'},
  {version:'3.8.0',summary:'Added live Ring camera viewing, live video only — no snapshots, matching what was asked for. Along the way, fixed a real mislabeling risk: "show me the front door camera" used to just open Axiom\'s own local PC webcam with no indication it wasn\'t the real camera; it now recognizes a named camera and routes to Ring specifically, or says plainly that Ring isn\'t connected or that camera doesn\'t exist, rather than silently showing the wrong thing. Ring has no official API, so this hand-rolls the same small REST/WebRTC surface Home Assistant\'s and Homebridge\'s own Ring integrations use — verified against that reference project\'s actual source, not guessed. New Ring connector in Settings → Connections (email + password, with a follow-up verification-code step if your account has 2FA). Live view itself is native WebRTC straight to Ring\'s servers — no ffmpeg, no local streaming server — and always sends an explicit end-session call when you close the view, so nothing keeps streaming after you\'re done. Honest caveat: this hasn\'t been run against a real Ring account yet, only verified against Ring\'s actual (unofficial, reverse-engineered) API source and covered by unit tests with a fake server — the first real Connect attempt is the real test.'},
  {version:'3.7.4',summary:'Checked the Homebridge integration against Homebridge Config UI X\'s actual source code, not just its docs, to make sure it holds up for real: found and fixed three real gaps. First, error messages from Homebridge were silently replaced with a generic "Bad Request"/"Unauthorized" instead of the actual specific reason (e.g. "Homebridge must be running in insecure mode to access accessories.") — a message-priority bug in the shared error parser. Second, controlling an accessory did up to 4 extra "did it really work" round trips after every action, when Config UI X\'s own response to the control request already contains a genuine verified read of the device — now used directly, so most control actions confirm in one round trip instead of up to five. Third, and most important: the tool schema lets the model send a lock/door/alarm value as a string ("0") or a number (0), and the unlock/open/disarm safety check plus the after-action verification both compared with strict equality — a string value could have silently skipped the "requires an explicit unlock request" guard, or made a genuinely successful lock change get reported as failed. Both now compare type-tolerantly. All three were confirmed against Homebridge\'s real source and covered by new tests, not just inferred from behavior.'},
  {version:'3.7.3',summary:'Removed Home Assistant support at Robbie\'s request — Homebridge Config UI X is the only smart-home platform he actually uses, and running both meant every status question and lock/unlock request had to guess (or was told) which platform to prefer. Homebridge keeps every capability it had: live accessory reads, exact-name control with the same fresh-approval boundary on locks/garage/security, and the state-grounding fix from 3.6.3. One real capability is gone, not just cleanup: the real-time "Smart Home Watchdog" background push notifications (e.g. a door left open) were built on Home Assistant\'s WebSocket event stream, which Homebridge has no equivalent of here — that alerting is no longer available in either app version.'},
  {version:'3.7.2',summary:'Guided voice enrollment now shows a fixed sentence to read aloud for each of the three conditions (normal/quiet/close), instead of "speak naturally" with nothing to say — which tended to produce hesitant, quiet, or too-short samples. The neural voice-matching model doesn\'t need any particular content (it\'s text-independent), so this is purely about getting a fluent, consistent take; the same sentence is used every time so distance/volume stays the only intentional variable across the three conditions.'},
  {version:'3.7.1',summary:'Added the "welcome back" greeting: return to camera view after 5+ minutes away and Axiom greets you by name again, same as opening the app — gated on actually recognizing you first, and politely deferred if you\'re already mid-conversation. Also chased down the real cause behind the background-noise/TV-triggering question: Personal Voice Lock has been ON in Settings, but zero voice profiles were ever enrolled — the safety check correctly falls back to accepting any speaker when it has nothing enrolled to compare against, so the toggle has been a complete no-op the whole time, quietly. Added a hard-to-miss warning right on the toggle when this is the case, instead of leaving it to small print only a status pill elsewhere reflected.'},
  {version:'3.7.0',summary:'Hands-free reliability, fixed for real this time. Found by turning on a type-check the renderer build was silently skipping (vite build only transpiles, it never verified types — closed that gap permanently, it now runs on every build): a cleanup earlier this session left one call to a deleted function inside the realtime voice transcription handler, which threw and silently dropped the transcribed message every time it was reached — a direct, self-inflicted cause of "randomly doesn\'t respond, have to press the mic." Fixed, along with two more real gaps the same type-check exposed: voice-triggered "remember my face" called a method that never existed (always failed) and a face-tracking variable TypeScript could no longer prove was assigned. Separately: once the realtime voice connection faults for any reason, it now automatically retries with backoff instead of permanently downgrading to the slower buffered path for the rest of the session — likely the "seems slower now" half of the report. Also fixed the exact freeze/stutter cause described: the boot splash screen has its own real 1.35-second animation, but the greeting used to fire on a blind 550ms timer — well before the splash even started fading — so Axiom would start talking while it was still fully covering the screen. Now waits for the splash and the window to actually finish loading.'},
  {version:'3.6.3',summary:'Answers your own question: how do we make sure what Axiom says about a device is actually true? "Is the back door locked?" used to force nothing at all — no verb, no request phrasing the router recognized — so Axiom was free to just answer from nothing. It also never matched "locked"/"unlocked" as smart-home words in the first place (different words from "lock"/"unlock", not just a boundary issue). Fixed both, and split status questions from action requests: a pure status question now offers only the read tool — often exactly one candidate — which Axiom can force by exact name, the same hard guarantee already used for search, instead of a softer generic hint.'},
  {version:'3.6.2',summary:'"unlock the back door" offered zero tools at all — bare "lock" doesn\'t match "unlock" (no word boundary), so a request built entirely around unlocking matched nothing, and Axiom correctly (not a hallucination) reported no Homebridge tool was available. Separately, with only Homebridge configured, every smart-home request still offered Home Assistant\'s two tools alongside it — 4 unnecessary candidates instead of 2 — and every lock/unlock attempt in that conversation failed while a plain status check happened to succeed. Fixed "unlock" matching and made tool offering aware of which platform is actually configured, so an unused platform stops diluting the candidate pool.'},
  {version:'3.6.1',summary:'A full audit across the app (three parallel reviews: tool routing, the IPC/data layer, the renderer), not a response to a specific bug report. Worst finding: a store error-handling path could silently wipe your entire profile — memories, goals, agents, connectors — to blank defaults with zero log if anything unexpected happened while loading; it now retries from the daily backup first and logs every step. Also fixed: two more keyword collisions in the same family as the desktop/folder bug ("restore my checkpoint" was offering 14 tools; bare create/read/write was polluting create-a-goal/read-this-email/write-a-test requests with unrelated file tools); forgetting a memory now requires the same approval a delete does, since it was permanently unrecoverable and wasn\'t; clicking or invoking a "Delete Account"/"Confirm Purchase"-labeled control outside the browser had no safety check at all. Cleaned up ~250 lines of dead state and two entirely unused components along the way. Two things came back clean and are worth naming: the 52-permission Settings categorization and the 85-channel IPC boundary both had zero inconsistencies.'},
  {version:'3.6.0',summary:'Added Homebridge Config UI X as a smart-home connector alongside Home Assistant, at the user\'s request — he runs Homebridge, not Home Assistant. New connector in Settings → Connections (URL, username, password; Axiom logs in and caches the session itself), two new tools (homebridge_snapshot, homebridge_control) with the same fresh-approval boundary for locks/garage/security state that Home Assistant control already has, and the AUTOMATE tab\'s smart-home dashboard now shows whichever platform (or both) is actually configured instead of assuming Home Assistant.'},
  {version:'3.5.7',summary:'First real Mac build run surfaced a genuine gap: the test suite\'s PowerShell tests assumed Windows, so npm test failed on the Mac before it would produce a DMG. The app itself was correct the whole time — PowerShell is deliberately Windows-only and Axiom correctly refuses it elsewhere — only the tests needed to become platform-aware. Fixed by marking those three tests Windows-only (skipped, not deleted) and adding a new test that explicitly confirms Axiom refuses PowerShell on non-Windows platforms instead of just not testing it.'},
  {version:'3.5.6',summary:'Two fixes for "Axiom can\'t control the computer." First, a real dead end: a blocked destructive action (e.g. closing an app) tells you to say APPROVE plus a code, but that phrase alone shares no words with the original request, so Axiom had nothing left to call — saying it did nothing. Approving now runs the exact pending action directly instead of routing back through tool selection. Second, added an explicit PERMISSIONS section to Settings, grouped by category (Computer Control, Files & Code, Vision & Screen, Live Intel & Communication, Smart Home, Memory/Goals/Agents, Media & Alerts) — this existed scattered one tab at a time before, never in Settings itself.'},
  {version:'3.5.5',summary:'The 3.5.4 controls panel was real but placed somewhere it could never be seen from the voice command that actually opens the camera: "open the camera view" opens a full-screen live preview overlay that sits on top of the SCREEN tab, hiding the panel underneath it entirely. Moved a compact copy of the same stats and controls directly into that live camera window as a sidebar, so asking to see the camera now actually shows both.'},
  {version:'3.5.4',summary:'Two additions on request. The live camera preview now draws a highlighted box around whoever is detected — green for a recognized face, amber for an unrecognized one — so presence is visible at a glance, not just implied by the status text. Also added a Native Camera Controls panel (SCREEN tab): every webcam reports different manual controls, so this reads whatever your specific camera actually exposes (focus, exposure, white balance, zoom where supported) and lets you set it directly, as a backup to the automatic continuous-mode fix from 3.5.3.'},
  {version:'3.5.3',summary:'After the black-flash fix, the camera itself was visible continuously for the first time — revealing its autofocus racking in and out instead of locking on. Axiom now asks the camera driver to hold focus, exposure, and white balance in continuous mode instead of leaving that to whatever the driver defaults to, on cameras that expose that control. Not independently confirmed against your specific webcam yet — report back if it is still hunting.'},
  {version:'3.5.2',summary:'Fixed the live camera preview flickering black. The tracking hook returns a brand-new object on every render (it updates ~20x/second as head-pose data streams in), and the preview effect was keyed on that whole object — so on every single render it tore down the video feed and reconnected it, flashing black each time. Now keyed on the one stable piece it actually needs, so the feed stays connected continuously.'},
  {version:'3.5.1',summary:'Two more real failures, same root cause as the search bug: "create a new folder on the desktop" offered 13 tools (the word "desktop" wrongly pulled in window-control tools) and the model didn\'t reliably pick the right one. Narrowed the keyword collision and generalized exact-tool-name forcing to any mandatory request with one clear tool, not just search. Also made Google search tolerate a known Chromium redirect quirk (ERR_ABORTED) that was failing real searches outright.'},
  {version:'3.5.0',summary:'Removed Office Sentry entirely, at the user\'s explicit request: no more unknown-visitor challenges, audio alerts, evidence snapshots, or tool-lockout tied to camera presence. Face and voice recognition remain for one purpose only — knowing who Axiom is talking to, for personalization. The owner override phrase and the face/voice identity-conflict safeguard are unaffected.'},
  {version:'3.4.4',summary:'Fixed a real desync: Presence Link could show "verified" while the very next spoken turn still got challenged as an unknown visitor — because that challenge check read a separate, unsmoothed single-frame signal instead of the same state the panel displays. Both now read the identical source of truth.'},
  {version:'3.4.3',summary:'Search results and headlines now come with real links, which sounded exactly as bad as you\'d expect when Axiom read them out loud. Speech now strips markdown links and bare URLs (keeping the label text), while the visible chat still shows every clickable link.'},
  {version:'3.4.2',summary:'Found the real cause via your app\'s own runtime task ledger: the model was ignoring a generic "you must call a tool" instruction and just answering in plain text — zero search attempts logged despite it being "required". Every provider now forces the exact search tool by name instead of a generic hint, which is a harder constraint the model cannot slide past.'},
  {version:'3.4.1',summary:'Swapped web search to Google specifically (not DuckDuckGo, not Bing, per direct request). Google requires JavaScript to render results, so plain scraping cannot work — Axiom now loads Google in its own real, hidden Chromium window (it already has one, being Electron) and reads results out of the actual rendered page. Also added a dedicated news-headlines tool (Google News RSS) after general web search returned homepage links instead of real headline text for "top headlines" requests.'},
  {version:'3.4.0',summary:'Replaced provider-hosted web search entirely. Axiom now runs its own direct search (no API key required) and executes it through the same verified-tool pipeline as everything else — a real HTTP call, real parsed results, a real error if it fails. No more opaque provider tool to lie about what happened.'},
  {version:'3.3.2',summary:'The denial-phrase catch in 3.3.1 was still one step behind the model\'s wording ("I can\'t perform a live web search" slipped past it). Replaced pattern-matching with a structural fix: OpenAI/Anthropic web search now requires actual source results, not just a non-failed call — the real bug regardless of how the model phrases giving up.'},
  {version:'3.3.1',summary:'Caught a real failure a live user hit: the web_search tool was offered and forced, but the model still claimed it had none — the provider reported the call as succeeded even though it silently did nothing. Axiom no longer trusts that false claim. Also added "search the internet" phrasing to the trigger, which was missing.'},
  {version:'3.3.0',summary:'Added self-corrections (Axiom remembers its own past mistakes, not just facts about you), CONCERN:-flagged disagreement, derived uncertainty flags, settings revert, and this changelog.'},
  {version:'3.2.1',summary:'Fixed three more tool-availability gaps: opening a named app by itself ("open Chrome"), opening a bare domain ("open google.com"), and image generation via "draw"/"sketch".'},
  {version:'3.2.0',summary:'Added the owner override phrase — a real secret that restores trust for a turn when camera/voice biometrics fail. A claimed name alone still never grants trust.'},
  {version:'3.1.2',summary:'Broadened the live-web trigger so verification/fact-check phrasing ("is this true", "confirm this") gets search access, not just literal topic words like "news".'},
  {version:'3.1.1',summary:'Office Sentry\'s unknown-visitor detection no longer resets to zero on a single tracking hiccup — a tolerant sliding window replaced the strict-consecutive counter.'},
];
const hexRgb=(hex:string):string=>{const match=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);return match?`${parseInt(match[1],16)}, ${parseInt(match[2],16)}, ${parseInt(match[3],16)}`:'32, 255, 211';};
const normalizeRendererAppearance=(value?:Partial<Appearance>):Appearance=>{const color=value?.color&&appearancePalette[value.color]?value.color:'teal';return{color,emotion:value?.emotion||'neutral',accentHex:value?.accentHex&&/^#[0-9a-f]{6}$/i.test(value.accentHex)?value.accentHex:appearancePalette[color],glowIntensity:typeof value?.glowIntensity==='number'?value.glowIntensity:1,motionProfile:value?.motionProfile||'adaptive',density:value?.density||'balanced'};};
// Single source of truth for the settings accordion — every collapsible
// section's id/label/icon/summary/search-terms in one place, so the
// essentials strip, the search box, and each SettingsSection wrapper all
// stay in sync. Redesigned from 13 flat h3-delimited blocks in one
// continuous scroll (Robbie: "hard to read and follow... humans are a
// simple creature") into individually collapsible sections — approved
// from a live mockup, though the mockup's 5 merged buckets turned out too
// few once every real section (Updates, Data export/erase, Biometric
// Consent, Portable Backup weren't visible when the mockup was built) was
// accounted for; forcing those together would have just recreated the
// wall-of-content problem inside a smaller box, so each stays its own
// section instead.
const settingSections=[
  {id:'settings-appearance',label:'APPEARANCE',icon:'◈',summary:'Color, glow, motion, and interface density',terms:'color theme glow motion animation density gpu'},
  {id:'settings-ai',label:'AI PROVIDER',icon:'◐',summary:'Which brain Axiom uses, your API keys, and automatic failover',terms:'openai claude anthropic gemini model api key routing'},
  {id:'settings-voice',label:'VOICE',icon:'◎',summary:'How Axiom sounds, and how it listens for you',terms:'elevenlabs voice microphone speaker wavlm noise mouth'},
  {id:'settings-trust',label:'TRUST TIERS',icon:'▲',summary:'What always runs automatically vs. always asks first',terms:'trust automatic approval destructive money'},
  {id:'settings-permissions',label:'PERMISSIONS',icon:'▤',summary:'Every category Axiom can act in — turn any off to block it outright',terms:'computer control automation window desktop files code powershell clipboard smart home memory agents approval block allow'},
  {id:'settings-changelog',label:'CHANGELOG',icon:'⌁',summary:'What has changed recently, version by version',terms:'changelog behavior version history updates'},
  {id:'settings-control',label:'LOCAL CONTROL',icon:'⚙',summary:'Coding workspace and daily verified backups',terms:'workspace backup local control'},
  {id:'settings-services',label:'CONNECTED SERVICES',icon:'⇄',summary:'Ring, Homebridge, and other linked accounts',terms:'connectors ring homebridge integrations'},
  {id:'settings-sync',label:'IDENTITY SYNC',icon:'⟲',summary:'Stay the same Axiom across your Windows and Mac',terms:'windows mac dropbox passphrase identity device sync'},
  {id:'settings-updates',label:'UPDATES',icon:'⇧',summary:'Check for and install new signed releases',terms:'update version install download'},
  {id:'settings-data',label:'YOUR DATA',icon:'▣',summary:'Export everything Axiom has recorded, or erase it all',terms:'export erase delete data privacy'},
  {id:'settings-consent',label:'BIOMETRIC CONSENT',icon:'◉',summary:'Required before any face or voice capture',terms:'biometric consent face voice privacy'},
  {id:'settings-backup',label:'PORTABLE BACKUP',icon:'⛁',summary:'Move your setup to another computer, and run diagnostics',terms:'portable backup recovery restore passphrase diagnostics'},
];
const PERMISSION_CATEGORIES:{label:string;detail:string;ids:string[]}[]=[
  {label:'COMPUTER CONTROL',detail:'Windows, applications, the clipboard, and PowerShell.',ids:['desktop-read','desktop-control','window-control','apps-open','browser-control','browser-read','clipboard-read','clipboard-write','media-control','powershell','cursor-guide']},
  {label:'FILES & CODE',detail:'Reading, writing, and building inside your file system and coding workspace.',ids:['files-read','files-write','code-read','code-write','code-execute','code-delete','code-rollback','backup']},
  {label:'VISION & SCREEN',detail:'Camera vision, display capture, and hardware/system reads.',ids:['screen-capture','read-system','read-time','appearance']},
  {label:'LIVE INTEL & COMMUNICATION',detail:'Web search, email, calendar, and connected business services.',ids:['web-search','gmail-read','gmail-write','gmail-send','calendar-read','calendar-write','dropbox-read','shopify-read','meta-read']},
  {label:'SMART HOME',detail:'Homebridge/HomeKit devices — lights, locks, climate, and scenes.',ids:['smart-home-read','smart-home-control']},
  {label:'MEMORY, GOALS & AGENTS',detail:'Durable memory, goals, todos, skills, and delegated agents.',ids:['memory-read','memory-write','goals-read','goals-write','todos-read','todos-write','skills-read','skills-write','agents-read','agents-write','agents-run','commitments-read','commitments-write','self-correction-write']},
  {label:'MEDIA & ALERTS',detail:'Image/video generation, notifications, and visual monitors.',ids:['media-generate','notifications','visual-monitor','capability-status']},
];
type PreparedSpeech = Awaited<ReturnType<DesktopApi['synthesizeSpeech']>>;
type CameraControlKey = 'focusDistance' | 'exposureCompensation' | 'colorTemperature' | 'zoom';
interface CameraControlState { key: CameraControlKey; label: string; min: number; max: number; step: number; value: number; mode: 'manual' | 'continuous'; supportsAuto: boolean }
const CAMERA_CONTROL_DEFS: { key: CameraControlKey; label: string; modeKey?: 'focusMode' | 'exposureMode' | 'whiteBalanceMode' }[] = [
  { key: 'focusDistance', label: 'FOCUS', modeKey: 'focusMode' },
  { key: 'exposureCompensation', label: 'EXPOSURE', modeKey: 'exposureMode' },
  { key: 'colorTemperature', label: 'WHITE BALANCE', modeKey: 'whiteBalanceMode' },
  { key: 'zoom', label: 'ZOOM' },
];

function RuntimeCorePanel({ runtime, operational, onRefresh, onResume }: { runtime: RuntimeSnapshot | null; operational:OperationalSnapshot|null; onRefresh: () => Promise<void>; onResume:(task:RuntimeTask)=>Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState('');
  const [approvalStatus, setApprovalStatus] = useState('');
  const openCommitments = runtime?.commitments.filter((item) => item.status === 'open') ?? [];
  const pendingApprovals = runtime?.approvals.filter((item) => item.status === 'pending') ?? [];
  const healthy = runtime?.metrics.healthyCapabilities ?? 0;
  const activeTasks = runtime?.tasks.filter((item) => item.status === 'active' || item.status === 'waiting').length ?? 0;
  const addCommitment = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title || saving) return;
    setSaving(true);
    try { await window.axiom.addCommitment(title); setDraft(''); await onRefresh(); }
    finally { setSaving(false); }
  };
  const resolve = async (item: CommitmentItem, status: 'fulfilled' | 'cancelled') => {
    await window.axiom.resolveCommitment(item.id, status);
    await onRefresh();
  };
  const decide = async (id: string, decision: 'approved' | 'denied') => {
    if (approvalBusy) return;
    setApprovalBusy(id); setApprovalStatus('');
    try { const result=await window.axiom.decideApproval(id,decision);setApprovalStatus(result.message);await onRefresh(); }
    catch (reason) { setApprovalStatus(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApprovalBusy(''); }
  };

  return <div className="runtime-core">
    <div className="runtime-metrics">
      <article><span>ACTIVE OPERATIONS</span><b>{String(activeTasks).padStart(2, '0')}</b><small>DURABLE TASK JOURNAL</small></article>
      <article><span>OPEN PROMISES</span><b>{String(openCommitments.length).padStart(2, '0')}</b><small>COMMITMENT LEDGER</small></article>
      <article><span>PROOF RECORDS</span><b>{String(runtime?.evidence.length ?? 0).padStart(2, '0')}</b><small>INTEGRITY CHAIN</small></article>
      <article className={pendingApprovals.length?'attention':''}><span>AWAITING CONSENT</span><b>{String(pendingApprovals.length).padStart(2, '0')}</b><small>ONE-TIME AUTHORITY</small></article>
      <article><span>HEALTHY SYSTEMS</span><b>{healthy}/{runtime?.capabilities.length ?? 0}</b><small>LIVE CAPABILITY MAP</small></article>
    </div>
    <div className="runtime-columns">
      <section className="runtime-card operational-probes"><header><div><span>RT–00</span><b>OPERATIONAL TRUTH / LIVE PROBES</b></div><em>{operational?.overall.toUpperCase()||'CHECKING'}</em></header>
        <div className="probe-grid">{operational?.probes.map((probe)=><article key={probe.id} className={`probe-${probe.state}`}><i/><div><b>{probe.label}</b><span>{probe.detail}</span><small>{probe.latencyMs!=null?`${probe.latencyMs} MS · `:''}{probe.recovery||'No recovery required.'}</small></div><em>{probe.state.toUpperCase()}</em></article>)||<div className="runtime-empty">Startup capability probes are running.</div>}</div>
      </section>
      <section className={`runtime-card approval-queue ${pendingApprovals.length?'has-pending':''}`}><header><div><span>PK–01</span><b>PERMISSION KERNEL / ACTION REHEARSAL</b></div><em>{pendingApprovals.length ? `${pendingApprovals.length} DECISION${pendingApprovals.length===1?'':'S'}` : 'GUARDED'}</em></header>
        {pendingApprovals.length ? <div className="approval-list">{pendingApprovals.map((item) => <article key={item.id}><div className="approval-code"><span>{item.risk.toUpperCase()}</span><b>{item.code}</b><small>EXPIRES {new Date(item.expiresAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</small></div><div className="approval-intent"><b>{item.preview}</b><span>RECOVERY / {item.recovery}</span><small>INTENT FINGERPRINT {item.argsDigest.slice(0,18)}…</small></div><div className="approval-actions"><button disabled={Boolean(approvalBusy)} onClick={()=>void decide(item.id,'denied')}>DENY</button><button className="approve" disabled={Boolean(approvalBusy)} onClick={()=>void decide(item.id,'approved')}>{approvalBusy===item.id?'EXECUTING…':'APPROVE + EXECUTE'}</button></div></article>)}</div> : <div className="approval-clear"><i/><div><b>CONSEQUENTIAL ACTIONS ARE INTERLOCKED</b><span>Axiom will rehearse destructive or external actions here before receiving one-time authority.</span></div></div>}
        {approvalStatus&&<div className="approval-status">{approvalStatus}</div>}
      </section>
      <section className="runtime-card task-journal"><header><div><span>RT–01</span><b>EXECUTION JOURNAL</b></div><em>LIVE</em></header>
        <div className="runtime-list">{runtime?.tasks.length ? runtime.tasks.slice(0, 7).map((task) => <article key={task.id}>
          <i className={`state-${task.status}`} /><div><b>{task.title}</b><span>{task.summary || 'Request accepted into the runtime.'}</span>{task.blocker&&<span className="runtime-blocker">BLOCKER / {task.blocker}</span>}{task.nextAction&&<span className="runtime-next">NEXT / {task.nextAction}</span>}<small>{task.risk.toUpperCase()} / {task.source.toUpperCase()} / ATTEMPT {task.attempt}/{task.maxAttempts} / {new Date(task.updatedAt).toLocaleString()}</small></div>{task.status==='blocked'||task.status==='failed'?<button className="resume-task" onClick={()=>void onResume(task)}>RESUME</button>:<em>{task.phase.replaceAll('-',' ').toUpperCase()}</em>}
        </article>) : <div className="runtime-empty">No operations have entered the journal yet.</div>}</div>
      </section>
      <section className="runtime-card commitment-ledger"><header><div><span>RT–02</span><b>COMMITMENT LEDGER</b></div><em>{openCommitments.length} OPEN</em></header>
        <form onSubmit={addCommitment}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Record a promise, follow-up, or responsibility…"/><button disabled={!draft.trim() || saving}>{saving ? '…' : 'COMMIT'}</button></form>
        <div className="runtime-list">{runtime?.commitments.length ? runtime.commitments.slice(0, 6).map((item) => <article key={item.id}>
          <i className={`state-${item.status}`} /><div><b>{item.title}</b><small>{item.status.toUpperCase()} / {new Date(item.createdAt).toLocaleString()}</small></div>{item.status === 'open' ? <span className="commit-actions"><button onClick={() => void resolve(item, 'fulfilled')}>DONE</button><button onClick={() => void resolve(item, 'cancelled')}>DROP</button></span> : <em>{item.status.toUpperCase()}</em>}
        </article>) : <div className="runtime-empty">No promises are being tracked.</div>}</div>
      </section>
      <section className="runtime-card evidence-chain"><header><div><span>RT–03</span><b>VERIFIED EVIDENCE</b></div><em>SHA–256</em></header>
        <div className="runtime-list">{runtime?.evidence.length ? runtime.evidence.slice(0, 6).map((item) => <article key={item.id}>
          <i className="state-verified"/><div><b>{item.summary}</b><span>{item.kind.replaceAll('-', ' ')}</span><small>{item.integrity.slice(0, 20)}… / {new Date(item.observedAt).toLocaleString()}</small></div><em>PROVEN</em>
        </article>) : <div className="runtime-empty">Verified tool outcomes will build the evidence chain here.</div>}</div>
      </section>
      <section className="runtime-card capability-map"><header><div><span>RT–04</span><b>CAPABILITY HEALTH</b></div><em>{healthy === (runtime?.capabilities.length ?? 0) ? 'NOMINAL' : 'CHECK'}</em></header>
        <div className="health-grid">{runtime?.capabilities.slice(0, 12).map((item) => <article key={item.id}><i className={`state-${item.state}`}/><div><b>{item.label}</b><span>{item.detail}</span></div><em>{item.state.toUpperCase()}</em></article>)}</div>
      </section>
      <section className="runtime-card capability-horizon"><header><div><span>RT–05</span><b>CAPABILITY HORIZON</b></div><em>EVOLVING</em></header>
        <div className="horizon-list">{runtime?.horizon.slice(0, 8).map((item) => <article key={item.id}><span>{String(item.priority).padStart(2, '0')}</span><div><b>{item.title}</b><p>{item.rationale}</p></div><em>{item.stage.toUpperCase()}</em></article>)}</div>
      </section>
    </div>
  </div>;
}

function MemoryFabricPanel({memories,onForget}:{memories:MemoryItem[];onForget:(id:string)=>Promise<void>}){
  const active=memories.filter((item)=>item.status==='active'),superseded=memories.filter((item)=>item.status==='superseded');
  const kinds=new Set(active.map((item)=>item.kind)).size,totalRetrievals=memories.reduce((sum,item)=>sum+item.retrievalCount,0);
  return <div className="memory-fabric">
    <div className="memory-metrics"><article><span>ACTIVE MEMORY</span><b>{active.length}</b><small>RETRIEVABLE RECORDS</small></article><article><span>SEMANTIC CLASSES</span><b>{kinds}</b><small>OF 6 MEMORY TYPES</small></article><article><span>RETRIEVALS</span><b>{totalRetrievals}</b><small>OBSERVED USE</small></article><article><span>SUPERSEDED</span><b>{superseded.length}</b><small>CORRECTION HISTORY</small></article></div>
    <div className="memory-records">{memories.length?memories.slice().reverse().map((item)=><article key={item.id} className={item.status}><div className="memory-kind"><i/><b>{item.kind.toUpperCase()}</b><span>{Math.round(item.confidence*100)}% CONFIDENCE</span></div><div className="memory-copy"><p>{item.text}</p><span>{item.origin.replaceAll('-',' ').toUpperCase()} / UPDATED {new Date(item.updatedAt).toLocaleString()}</span>{item.lastUsedAt&&<small>LAST RETRIEVED {new Date(item.lastUsedAt).toLocaleString()} / {item.retrievalCount} USE{item.retrievalCount===1?'':'S'}</small>}</div><div className="memory-controls">{item.status==='superseded'?<em>SUPERSEDED</em>:<button onClick={()=>void onForget(item.id)}>FORGET</button>}</div></article>):<div className="empty-state">No durable memories yet.</div>}</div>
  </div>;
}

function DesktopGraphPanel({graph,busy,onRefresh}:{graph:DesktopGraphSnapshot|null;busy:boolean;onRefresh:()=>Promise<void>}){
  const applications=graph?.entities.filter((item)=>item.kind==='application')??[],windows=graph?.entities.filter((item)=>item.kind==='window')??[],controls=graph?.entities.filter((item)=>item.kind==='control')??[];
  const windowsFor=(appId:string)=>{const ids=new Set(graph?.relations.filter((item)=>item.fromId===appId&&item.type==='contains').map((item)=>item.toId)??[]);return windows.filter((item)=>ids.has(item.id));};
  const metrics=graph?.metrics??{applications:0,liveWindows:0,knownControls:0,staleObjects:0,observations:0};
  return <div className="desktop-world">
    <header className="world-head"><div><span>SG–01 / SEMANTIC DESKTOP</span><b>OBJECT GRAPH</b><p>A durable, queryable map grounded in Windows UI Automation—not screenshots or guesses.</p></div><button onClick={()=>void onRefresh()} disabled={busy}>{busy?'SCANNING…':'SCAN DESKTOP'}</button></header>
    <div className="world-metrics"><article><span>APPLICATIONS</span><b>{String(metrics.applications).padStart(2,'0')}</b></article><article><span>LIVE WINDOWS</span><b>{String(metrics.liveWindows).padStart(2,'0')}</b></article><article><span>KNOWN CONTROLS</span><b>{String(metrics.knownControls).padStart(2,'0')}</b></article><article><span>STALE OBJECTS</span><b>{String(metrics.staleObjects).padStart(2,'0')}</b></article><article><span>OBSERVATIONS</span><b>{String(metrics.observations).padStart(2,'0')}</b></article></div>
    <div className="world-columns">
      <section className="world-topology"><header><span>LIVE TOPOLOGY</span><em>{graph?'PERSISTENT':'UNINITIALIZED'}</em></header><div className="topology-list">{applications.length?applications.slice(0,12).map((app)=>{const owned=windowsFor(app.id);return <article key={app.id} className={app.status}><div className="app-node"><i/><p><b>{app.label}</b><span>{owned.filter((item)=>item.status==='live').length} LIVE / {owned.length} KNOWN</span></p><em>{app.status.toUpperCase()}</em></div>{owned.slice(0,5).map((item)=><div className={`window-node ${item.attributes.isForeground?'foreground':''}`} key={item.id}><i/><p><b>{item.label}</b><span>HWND {String(item.attributes.hwnd||'—')} / {String(item.attributes.width||0)}×{String(item.attributes.height||0)}</span></p><em>{item.attributes.isForeground?'FOREGROUND':item.status.toUpperCase()}</em></div>)}</article>}):<div className="world-empty"><i/><b>NO OBJECTS MAPPED</b><span>Run a desktop scan to establish the first verified topology.</span></div>}</div></section>
      <section className="observation-stream"><header><span>OBSERVATION STREAM</span><em>LAST {Math.min(graph?.observations.length??0,12)}</em></header><div>{graph?.observations.length?graph.observations.slice(0,12).map((item)=><article key={item.id}><i className={item.kind}/><p><b>{item.kind.replaceAll('-',' ').toUpperCase()}</b><span>{item.summary}</span></p><time>{new Date(item.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></article>):<div className="world-empty compact"><b>AWAITING VERIFIED INPUT</b><span>Discoveries and changes will appear here.</span></div>}</div><footer>{controls.length} ACCESSIBLE CONTROL{controls.length===1?'':'S'} INDEXED</footer></section>
    </div>
  </div>;
}

function CameraControlsPanel({cameraControls,onSet,onReset,compact}:{cameraControls:{label:string;controls:CameraControlState[]}|null;onSet:(key:CameraControlKey,value:number)=>void;onReset:(key:CameraControlKey)=>void;compact?:boolean}){
  return <section className={compact?'camera-controls-panel compact':'camera-controls-panel'}>
    <header><b>NATIVE CAMERA CONTROLS</b><span>{cameraControls?.label?.toUpperCase()||'NO CAMERA'}</span></header>
    {!cameraControls?<p className="camera-controls-empty">Start tracking to detect available controls.</p>
    :!cameraControls.controls.length?<p className="camera-controls-empty">This camera doesn't expose manual controls — Axiom already keeps focus, exposure, and white balance in continuous mode where it can.</p>
    :<div className="camera-controls-grid">{cameraControls.controls.map((control)=><div key={control.key} className="camera-control"><div className="camera-control-head"><b>{control.label}</b>{control.supportsAuto&&<button className={control.mode==='continuous'?'active':''} onClick={()=>onReset(control.key)}>AUTO</button>}</div><input type="range" min={control.min} max={control.max} step={control.step} value={control.value} onChange={(event)=>onSet(control.key,Number(event.target.value))}/><span>{control.mode==='continuous'?'CONTINUOUS (AUTO)':`MANUAL · ${control.value.toFixed(control.step<1?2:0)}`}</span></div>)}</div>}
  </section>;
}

// A HUD stat that scrambles through random digits before landing on its
// real value whenever that value changes, instead of just swapping text —
// approved from a live mockup (Robbie: "concept 1 and 3", the cognition
// field + scrambling readouts combo). Respects reduced-motion by skipping
// straight to the final value.
function ScrambleValue({value}:{value:string}){
  const [display,setDisplay]=useState(value);
  const previous=useRef(value);
  useEffect(()=>{
    if(previous.current===value)return;
    previous.current=value;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){setDisplay(value);return;}
    const chars='0123456789';
    const digitCount=(value.match(/[0-9]/g)||[]).length||value.length;
    const suffix=value.match(/[^0-9]+$/)?.[0]??'';
    let frame=0;const totalFrames=14;
    const interval=window.setInterval(()=>{
      frame++;
      if(frame>=totalFrames||Math.random()<frame/totalFrames){setDisplay(value);}
      else{setDisplay(Array.from({length:digitCount},()=>chars[Math.floor(Math.random()*10)]).join('')+suffix);}
      if(frame>=totalFrames)window.clearInterval(interval);
    },28);
    return()=>window.clearInterval(interval);
  },[value]);
  return <>{display}</>;
}

// One collapsible settings section — approved from a live mockup, adapted
// to the real 13-section scope (see the settingSections comment). Every
// section's actual content is passed through as children completely
// unchanged; this component only owns the open/closed chrome around it,
// so no existing input/handler/binding needed to be touched to ship this.
function SettingsSection({id,icon,title,summary,open,onToggle,children}:{id:string;icon:string;title:string;summary:string;open:boolean;onToggle:()=>void;children:ReactNode}){
  return <div id={id} className={`settings-section${open?' open':''}`}>
    <button type="button" className="settings-section-head" onClick={onToggle} aria-expanded={open}>
      <span className="settings-section-icon">{icon}</span>
      <span className="settings-section-titles"><b>{title}</b><span>{summary}</span></span>
      <span className="settings-section-chevron">{open?'▾':'▸'}</span>
    </button>
    {open&&<div className="settings-section-body">{children}</div>}
  </div>;
}

export default function App() {
  // Opt-in only, mirrors the axiom-mouth-qa sessionStorage pattern used for
  // avatar QA: exposes the real WavLM embedding pipeline to an external test
  // harness for measuring it against a labeled dataset, offline from any live
  // conversation state. A no-op unless a QA script explicitly sets the flag.
  useEffect(()=>{
    if(sessionStorage.getItem('axiom-speaker-qa')!=='1')return;
    (window as unknown as {__axiomSpeakerQa?:{embed:(audio:Float32Array)=>Promise<number[]>}}).__axiomSpeakerQa={embed:embedForQa};
  },[]);
  const [visual, dispatch] = useReducer(visualReducer, { mode: 'idle', energy: 0.2 });
  // Cognition field — approved from a live mockup (Robbie: "concept 1 and
  // 3"): a particle mesh around the skull that swirls and fires synapse
  // connections while Axiom is actually thinking, then bursts back
  // outward once the reply resolves, instead of a status word being the
  // only visible sign anything is happening. Driven by the real
  // visual.mode transitions already dispatched elsewhere (thinking →
  // anything else), not a separate simulated state.
  const cognitionModeRef=useRef<'idle'|'thinking'|'resolving'>('idle');
  const cognitionModeStartRef=useRef(performance.now());
  const wasThinkingRef=useRef(false);
  useEffect(()=>{
    const isThinking=visual.mode==='thinking';
    if(isThinking&&!wasThinkingRef.current){cognitionModeRef.current='thinking';cognitionModeStartRef.current=performance.now();}
    else if(!isThinking&&wasThinkingRef.current){cognitionModeRef.current='resolving';cognitionModeStartRef.current=performance.now();}
    wasThinkingRef.current=isThinking;
  },[visual.mode]);
  useEffect(()=>{
    const canvas=cognitionCanvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CENTER=500,FIELD_R=420;
    interface Particle{angle:number;baseR:number;speed:number;size:number;phase:number;hot:boolean;x:number;y:number}
    let particles:Particle[]=[];
    const seed=(n:number)=>{particles=Array.from({length:n},()=>{const angle=Math.random()*Math.PI*2,r=150+Math.random()*FIELD_R*0.55;return{angle,baseR:r,speed:.15+Math.random()*.35,size:.8+Math.random()*1.8,phase:Math.random()*Math.PI*2,hot:Math.random()<.18,x:CENTER,y:CENTER};});};
    seed(90);
    let connections:Array<{a:Particle;b:Particle;life:number}>=[];
    let raf=0;
    if(reduced){return;}
    const frame=(now:number)=>{
      raf=requestAnimationFrame(frame);
      const mode=cognitionModeRef.current,elapsed=now-cognitionModeStartRef.current;
      ctx.clearRect(0,0,1000,1000);
      if(mode==='idle'){
        for(const p of particles){
          p.angle+=p.speed*0.0015;
          const wobble=Math.sin(now*0.0006+p.phase)*14;
          const x=CENTER+Math.cos(p.angle)*(p.baseR+wobble),y=CENTER+Math.sin(p.angle)*(p.baseR+wobble);
          ctx.beginPath();ctx.fillStyle=p.hot?'rgba(234,254,255,.22)':'rgba(70,232,255,.12)';ctx.arc(x,y,p.size*0.7,0,Math.PI*2);ctx.fill();
        }
      }else if(mode==='thinking'){
        const t=Math.min(1,elapsed/900);
        for(const p of particles){
          p.angle+=p.speed*(0.006+t*0.02);
          const targetR=p.baseR*(1-t*0.55),wobble=Math.sin(now*0.002+p.phase)*10*(1-t*0.5);
          p.x=CENTER+Math.cos(p.angle)*(targetR+wobble);p.y=CENTER+Math.sin(p.angle)*(targetR+wobble);
        }
        if(Math.random()<0.35){
          const a=particles[Math.floor(Math.random()*particles.length)],b=particles[Math.floor(Math.random()*particles.length)];
          if(a&&b&&a!==b){const dist=Math.hypot(a.x-b.x,a.y-b.y);if(dist<220)connections.push({a,b,life:1});}
        }
        connections=connections.filter((c)=>c.life>0);
        for(const c of connections){ctx.beginPath();ctx.strokeStyle=`rgba(234,254,255,${c.life*0.55})`;ctx.lineWidth=0.8;ctx.moveTo(c.a.x,c.a.y);ctx.lineTo(c.b.x,c.b.y);ctx.stroke();c.life-=0.045;}
        for(const p of particles){
          const alpha=0.35+t*0.4+(p.hot?0.2:0);
          ctx.beginPath();ctx.fillStyle=p.hot?`rgba(234,254,255,${alpha})`:`rgba(70,232,255,${alpha})`;ctx.shadowColor=p.hot?'rgba(234,254,255,1)':'rgba(70,232,255,1)';ctx.shadowBlur=p.hot?8:4;ctx.arc(p.x,p.y,p.size*(0.9+t*0.6),0,Math.PI*2);ctx.fill();
        }
      }else{
        const t=Math.min(1,elapsed/700);
        for(const p of particles){
          const targetR=p.baseR*(0.45+t*1.4),x=CENTER+Math.cos(p.angle)*targetR,y=CENTER+Math.sin(p.angle)*targetR;
          const alpha=Math.max(0,0.7*(1-t));
          ctx.beginPath();ctx.fillStyle=p.hot?`rgba(234,254,255,${alpha})`:`rgba(70,232,255,${alpha})`;ctx.shadowColor='rgba(70,232,255,1)';ctx.shadowBlur=6;ctx.arc(x,y,p.size,0,Math.PI*2);ctx.fill();
        }
        if(t>=1){cognitionModeRef.current='idle';cognitionModeStartRef.current=now;seed(90);}
      }
    };
    raf=requestAnimationFrame(frame);
    return()=>cancelAnimationFrame(raf);
  },[]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [ownerOverrideDraft,setOwnerOverrideDraft]=useState('');
  const [anthropicKeyDraft,setAnthropicKeyDraft]=useState('');
  const [geminiKeyDraft,setGeminiKeyDraft]=useState('');
  const [elevenKeyDraft,setElevenKeyDraft]=useState('');
  const [providerDraft,setProviderDraft]=useState<AIProvider>('openai');
  const [speechProviderDraft,setSpeechProviderDraft]=useState<SpeechProvider>('openai');
  const [voices,setVoices]=useState<ElevenLabsVoice[]>([]);
  const [voiceIdDraft,setVoiceIdDraft]=useState('JBFqnCBsd6RMkjVDRZzb');
  const [voiceNameDraft,setVoiceNameDraft]=useState('George');
  const [elevenModelDraft,setElevenModelDraft]=useState('eleven_flash_v2_5');
  const [voiceStability,setVoiceStability]=useState(.5);
  const [voiceSimilarity,setVoiceSimilarity]=useState(.78);
  const [voiceStyle,setVoiceStyle]=useState(.18);
  const [voiceSpeed,setVoiceSpeed]=useState(1.10);
  const [mouthOffsetMs,setMouthOffsetMs]=useState(18);
  const [mouthGain,setMouthGain]=useState(1);
  const [mouthAttack,setMouthAttack]=useState(.6);
  const [mouthRelease,setMouthRelease]=useState(.48);
  const [mouthCalibrating,setMouthCalibrating]=useState(false);
  const [startMicrophoneOn,setStartMicrophoneOn]=useState(true);
  const [microphones,setMicrophones]=useState<MediaDeviceInfo[]>([]);
  const [microphoneIdDraft,setMicrophoneIdDraft]=useState('');
  const [microphoneLabelDraft,setMicrophoneLabelDraft]=useState('System default');
  const [microphoneNoiseFloor,setMicrophoneNoiseFloor]=useState(.006);
  const [microphoneSpeechThreshold,setMicrophoneSpeechThreshold]=useState(.02);
  const [microphoneCalibrating,setMicrophoneCalibrating]=useState(false);
  const [speakerLockEnabled,setSpeakerLockEnabled]=useState(true);
  const [speakerEngineState,setSpeakerEngineState]=useState<'loading'|'ready'|'fault'>('loading');
  const [speakerName,setSpeakerName]=useState('');
  const [speakerStatus,setSpeakerStatus]=useState<'setup'|'listening'|'verified'|'rejected'|'noise'|'enrolling'>('setup');
  const [voiceStepIndex,setVoiceStepIndex]=useState(-1);
  const [enrollmentStatus,setEnrollmentStatus]=useState('Enroll five varied voice samples for the strongest personal lock.');
  const [speakerTrustSource,setSpeakerTrustSource]=useState<SpeakerTrustSource|'none'>('none');
  const [settingsStatus,setSettingsStatus]=useState('');
  const [backupPassphrase,setBackupPassphrase]=useState('');
  const [eraseConfirmText,setEraseConfirmText]=useState('');
  const [eraseBusy,setEraseBusy]=useState(false);
  const [updateFeedDraft,setUpdateFeedDraft]=useState('');
  const [updateCheckBusy,setUpdateCheckBusy]=useState(false);
  const [updateDownloadBusy,setUpdateDownloadBusy]=useState(false);
  const [updateResult,setUpdateResult]=useState<Awaited<ReturnType<typeof window.axiom.checkForUpdate>>|null>(null);
  const [updatePath,setUpdatePath]=useState('');
  const [appVersion,setAppVersion]=useState('');
  const [backupBusy,setBackupBusy]=useState(false);
  const [autoFailover,setAutoFailover]=useState(true);
  const [fallbackOrder,setFallbackOrder]=useState<AIProvider[]>(['openai','anthropic','gemini']);
  const [codingProvider,setCodingProvider]=useState<AIProvider>('openai');
  const [researchProvider,setResearchProvider]=useState<AIProvider>('openai');
  const [providerHealth,setProviderHealth]=useState<ProviderHealth[]>([]);
  const [platformPermissionStatus,setPlatformPermissionStatus]=useState<PlatformPermissionStatus[]>([]);
  const [diagnostics,setDiagnostics]=useState<Array<{label:string;ok:boolean;detail:string}>>([]);
  const [diagnosticsBusy,setDiagnosticsBusy]=useState(false);
  const [voiceProfileName,setVoiceProfileName]=useState('');
  const [modelDraft, setModelDraft] = useState('gpt-5.6-luna');
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [godsEyeViewPathDraft, setGodsEyeViewPathDraft] = useState('');
  const [automaticBackupsEnabled,setAutomaticBackupsEnabled]=useState(true);
  const [deviceNameDraft,setDeviceNameDraft]=useState('');
  const [syncEnabledDraft,setSyncEnabledDraft]=useState(false);
  const [syncFolderDraft,setSyncFolderDraft]=useState('');
  const [syncPassphraseDraft,setSyncPassphraseDraft]=useState('');
  const [syncStatus,setSyncStatus]=useState<SyncStatus|null>(null);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [startupGreetingVisible,setStartupGreetingVisible]=useState(true);
  const [activeView, setActiveView] = useState<ActiveView>('CONVERSE');
  const [clock, setClock] = useState(() => new Date());
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [selfCorrections, setSelfCorrections] = useState<SelfCorrection[]>([]);
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | undefined>(undefined);
  const [revertingSettings, setRevertingSettings] = useState(false);
  const [goals, setGoals] = useState<GoalItem[]>([]);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [audit,setAudit]=useState<AuditItem[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [operational,setOperational]=useState<OperationalSnapshot|null>(null);
  const [desktopGraph,setDesktopGraph]=useState<DesktopGraphSnapshot|null>(null);
  const [desktopGraphBusy,setDesktopGraphBusy]=useState(false);
  const [panelDraft, setPanelDraft] = useState('');
  const [memoryKind,setMemoryKind]=useState<MemoryKind>('fact');
  const [mouth, setMouth] = useState<MouthShape>({ open: 0, wide: 0, round: 0 });
  const [appearance, setAppearance] = useState<Appearance>({ color: 'teal', emotion: 'neutral', accentHex:'#20ffd3', glowIntensity:1, motionProfile:'adaptive', density:'balanced' });
  const [settingsQuery,setSettingsQuery]=useState('');
  // Which single settings section is expanded — collapsing everything
  // else out of view is the actual fix for "hard to read and follow",
  // not a visual restyle. AI Provider open by default since it's the one
  // almost everyone touches first.
  const [openSettingsSection,setOpenSettingsSection]=useState<string|null>('settings-ai');
  const jumpToSettingsSection=(id:string)=>{setOpenSettingsSection(id);requestAnimationFrame(()=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}));};
  const [recording, setRecording] = useState(false);
  const [voiceProcessing,setVoiceProcessing]=useState(false);
  const [realtimeVoice,setRealtimeVoice]=useState<'off'|'connecting'|'ready'|'fault'>('off');
  // Once the fast realtime lane faults (a network blip, anything), nothing
  // used to bring it back — the app permanently fell to the slower buffered
  // recorder for the rest of the session, which reads exactly like "hands-
  // free randomly stops working, then everything feels slower" without
  // ever actually being reported as broken by anything.
  const [realtimeRetryToken,setRealtimeRetryToken]=useState(0);
  const realtimeRetryAttempts=useRef(0);
  const [startupGreetingComplete,setStartupGreetingComplete]=useState(false);
  // Purely a passive "who does the camera currently recognize" display — no
  // alerting, no evidence capture, no challenge. Office Sentry (the active
  // camera-watchdog system) was removed at the user's request; this is what
  // remains of presence tracking: face recognition for personalization only.
  // 'uncertain' deliberately isn't a state here: it exists in
  // presenceIdentity.ts's PresenceIdentityDecision (a multi-frame sampled
  // decision used for the one-shot "who am I" query below), but this state
  // mirrors a single-frame recognition.observation on every ~1.9s poll tick
  // — there's no continuous multi-frame signal to derive "still verifying"
  // from without running the heavier classifyPresence() sampling on every
  // tick, which would be a real architecture change, not a bug fix.
  const [presenceIdentityState,setPresenceIdentityState]=useState<{kind:'scanning'|'known'|'unknown';name?:string}>({kind:'scanning'});
  const [screenCapture, setScreenCapture] = useState<ScreenCapture | null>(null);
  const [cameraCapture,setCameraCapture]=useState<ScreenCapture|null>(null);
  const [cameraFeedOpen,setCameraFeedOpen]=useState(false);
  // Every Ring camera keyed by id, so multiple can be live at once — see
  // ringPeersRef etc. below for the matching per-camera connection state.
  interface RingViewState{camera:RingCamera;connectionState:'connecting'|'ready'|'fault';faultReason:string;muted:boolean;talking:boolean;talkError:string;materializePhase:'materializing'|'live'|'derezzing';}
  const [ringViews,setRingViews]=useState<Map<number,RingViewState>>(new Map());
  const ringViewsRef=useRef(ringViews);ringViewsRef.current=ringViews;
  // Panels stay small and out of the skull's space by default; the user
  // picks at most one to blow up into a large view. The same <video>
  // element just changes CSS position/size between the two states (see
  // .ring-panel / .ring-panel.expanded) — no re-binding the stream, no
  // second video element.
  const [expandedRingCameraId,setExpandedRingCameraId]=useState<number|null>(null);
  // God's Eye View — a separate live 3D-globe app the user runs locally,
  // embedded via a native WebContentsView the main process layers directly
  // over godsEyeContentRef's on-screen box (not an iframe — see
  // godsEyeView.ts). 'materializing'/'live'/'derezzing' drive the same
  // particle-burst + CSS transition pattern as the Ring panels above;
  // status tracks the async open() call independently, since the panel can
  // be visually open (materializing) while the server is still starting.
  const [godsEye,setGodsEye]=useState<{phase:'closed'|'materializing'|'live'|'derezzing';status:'loading'|'ready'|'error';error:string}>({phase:'closed',status:'loading',error:''});
  const godsEyePhaseRef=useRef(godsEye.phase);godsEyePhaseRef.current=godsEye.phase;
  const godsEyePanelRef=useRef<HTMLDivElement|null>(null);
  const godsEyeContentRef=useRef<HTMLDivElement|null>(null);
  const ringVideoElsRef=useRef<Map<number,HTMLVideoElement>>(new Map());
  const ringPanelElsRef=useRef<Map<number,HTMLDivElement>>(new Map());
  const ringParticleCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const ringSkullAnchorRef=useRef<HTMLDivElement|null>(null);
  const cognitionCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const ringStageRef=useRef<HTMLDivElement|null>(null);
  const ringMaterializeTimersRef=useRef<Map<number,number>>(new Map());
  // A live measurement of .stage's real height, so panel layout can react
  // to the actual window size rather than assuming one. A prior fixed
  // percentage-arc layout (top:calc(13% + index*30%)) collided with the
  // real neural-readouts widget at the top — commandCenter.css (the
  // layered-CSS "final visual layer", loaded last — see
  // project-axiom-layered-css-architecture) makes it a genuine 2-row grid
  // occupying ~20-132px, taller than the single-row version in styles.css
  // this was originally sized against — and didn't leave enough room for
  // 3 simultaneous cameras without them overlapping each other.
  const [ringStageHeight,setRingStageHeight]=useState(800);
  useEffect(()=>{
    const el=ringStageRef.current;if(!el)return;
    const observer=new ResizeObserver((entries)=>{const height=entries[0]?.contentRect.height;if(height)setRingStageHeight(height);});
    observer.observe(el);
    return()=>observer.disconnect();
  },[]);
  const ringPeersRef=useRef<Map<number,RTCPeerConnection>>(new Map());
  const ringSessionIdsRef=useRef<Map<number,string>>(new Map());
  const ringRetryAttemptsRef=useRef<Map<number,number>>(new Map());
  const ringRetryTimersRef=useRef<Map<number,number>>(new Map());
  const ringPendingIceRef=useRef<Map<number,RTCIceCandidate[]>>(new Map());
  const ringEventUnsubscribeRef=useRef<Map<number,()=>void>>(new Map());
  // Two-way talk: the outgoing audio sender per camera (created once, up
  // front, as part of the recvonly->sendrecv transceiver) and the lazily
  // captured microphone stream — requested only on the user's first talk
  // press, not when the camera view opens, so a user who only wants to
  // watch never sees a mic-permission prompt.
  const ringAudioSendersRef=useRef<Map<number,RTCRtpSender>>(new Map());
  const ringMicStreamsRef=useRef<Map<number,MediaStream>>(new Map());
  const [cameraControls,setCameraControls]=useState<{label:string;controls:CameraControlState[]}|null>(null);
  const [personName,setPersonName]=useState('');
  const [enrollmentBusy,setEnrollmentBusy]=useState(false);
  const [enrollmentProgress,setEnrollmentProgress]=useState<EnrollmentProgress|null>(null);
  const [enrollmentResult,setEnrollmentResult]=useState<{name:string;groups:Partial<Record<EnrollmentPoseId,number[][]>>;validation:EnrollmentValidation}|null>(null);
  const [enrollmentSaving,setEnrollmentSaving]=useState(false);
  const [saveEnrollmentError,setSaveEnrollmentError]=useState('');
  const enrollmentCancelRef=useRef(false);
  const enrollmentNarratedRef=useRef('');
  const enrollmentProgressRef=useRef(enrollmentProgress);
  enrollmentProgressRef.current=enrollmentProgress;
  const [captureBusy, setCaptureBusy] = useState(false);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  // Rail redesign — approved from a live mockup after several rounds
  // (Robbie: "lets try this" on the final "Living Core" version). Only
  // CHAT and SETTINGS get full-size treatment since those are the two
  // Robbie said he actually uses; the other 9 nav routes collapse behind
  // one "MORE" toggle, freeing most of the rail for the quick-status
  // widgets below. Auto-opens if the active view is one of the 9 hidden
  // ones (reached via voice/tool call, not just a rail click), so the
  // active route is never hidden from view.
  const [moreNavOpen,setMoreNavOpen]=useState(false);
  const moreNavExpanded=moreNavOpen||activeView!=='CONVERSE';
  // Rolling CPU history for the quick-status sparkline — telemetry itself
  // only ever holds the latest snapshot, so the trail is built up here.
  const [cpuHistory,setCpuHistory]=useState<number[]>(()=>Array.from({length:16},()=>0));
  useEffect(()=>{
    if(!telemetry)return;
    setCpuHistory((current)=>[...current.slice(1),telemetry.cpuPercent]);
  },[telemetry]);
  // The Living Core's spectrum ring — a canvas-drawn radial bar field
  // wrapping the 3D core, dormant when hands-free is off, amplitude-
  // reactive (simulated — no real FFT of the mic feed, just a convincing
  // idle animation) when it's on, matching the mockup exactly.
  const livingCoreCanvasRef=useRef<HTMLCanvasElement|null>(null);
  useEffect(()=>{
    const canvas=livingCoreCanvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const BARS=40,CX=75,CY=75,BASE_R=58;
    const barLevels=Array.from({length:BARS},()=>0.1);
    const on=Boolean(settings?.startMicrophoneOn);
    let sweepAngle=0,raf=0;
    const frame=()=>{
      raf=requestAnimationFrame(frame);
      ctx.clearRect(0,0,150,150);
      sweepAngle+=on?0.01:0.006;
      for(let i=0;i<BARS;i++){
        const angle=(i/BARS)*Math.PI*2;
        if(on){
          const target=0.15+Math.abs(Math.sin(angle*3+sweepAngle*4))*0.7*(0.5+Math.random()*0.5);
          barLevels[i]+=(target-barLevels[i])*0.25;
        }else{
          const dormant=0.08+(Math.abs((angle-sweepAngle*2)%(Math.PI*2))<0.3?0.15:0);
          barLevels[i]+=(dormant-barLevels[i])*0.1;
        }
        const len=6+barLevels[i]*16;
        const x1=CX+Math.cos(angle)*BASE_R,y1=CY+Math.sin(angle)*BASE_R;
        const x2=CX+Math.cos(angle)*(BASE_R+len),y2=CY+Math.sin(angle)*(BASE_R+len);
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);
        ctx.strokeStyle=on?`rgba(70,232,255,${0.35+barLevels[i]*0.5})`:`rgba(70,232,255,${0.12+barLevels[i]*0.2})`;
        ctx.lineWidth=1.6;ctx.lineCap='round';ctx.stroke();
      }
    };
    raf=requestAnimationFrame(frame);
    return()=>cancelAnimationFrame(raf);
  },[settings?.startMicrophoneOn]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const discardVoiceCapture=useRef(false);
  const tracking = useFaceTracking();
  const recognition=usePersonRecognition(tracking.getVideoElement,tracking.status==='locked');
  // A face match alone cannot tell a real person from a printed photo held up
  // to the camera. Liveness requires an observed blink cycle plus real
  // yaw/pitch variance within a rolling window before that match is trusted
  // anywhere consequential — see livenessDetector.ts for why.
  const livenessBufferRef=useRef(new LivenessBuffer());
  const [liveness,setLiveness]=useState<LivenessState>({live:false,reason:'insufficient-samples',blinkObserved:false,poseVariance:0,sampleCount:0,windowMs:3000});
  const livenessRef=useRef(liveness);livenessRef.current=liveness;
  useEffect(()=>{
    if(tracking.status!=='locked'||tracking.pose.source!=='face'){
      // A new person can walk into frame the instant tracking re-locks; a
      // buffer built up under the previous face must never carry forward.
      livenessBufferRef.current.clear();
      setLiveness((current)=>current.reason==='insufficient-samples'?current:{live:false,reason:'insufficient-samples',blinkObserved:false,poseVariance:0,sampleCount:0,windowMs:3000});
      return;
    }
    const now=performance.now();
    livenessBufferRef.current.push({at:now,yaw:tracking.pose.yaw,pitch:tracking.pose.pitch,blinkLeft:tracking.pose.blinkLeft,blinkRight:tracking.pose.blinkRight});
    setLiveness(livenessBufferRef.current.assess(now));
  },[tracking.pose,tracking.status]);
  const liveCameraRef=useRef<HTMLVideoElement|null>(null);
  const detectionOverlayRef=useRef<HTMLCanvasElement|null>(null);
  const enrollmentVideoRef=useRef<HTMLVideoElement|null>(null);
  const trackingStatusRef=useRef(tracking.status);
  trackingStatusRef.current=tracking.status;
  const trackingPoseRef=useRef(tracking.pose);
  trackingPoseRef.current=tracking.pose;
  const recognitionObservationRef=useRef(recognition.observation);
  recognitionObservationRef.current=recognition.observation;
  const startupBriefed = useRef(false);
  const awaySince = useRef<number | null>(null);
  const returnGreetingPending = useRef(false);
  const returnGreetingBusy = useRef(false);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const lastSpeechEndedAt = useRef(0);
  const speechTurn = useRef({ id: 0, buffer: '', queuedChars: 0, active: false, chain: Promise.resolve() as Promise<void>, prepareTail: Promise.resolve() as Promise<void> });
  const speechDeltaHandler = useRef<(delta: string) => void>(() => {});
  const lastActivityReport=useRef(0);
  const assistantRequestAt=useRef(0),firstTokenCaptured=useRef(false),firstTtsCaptured=useRef(false);
  const pendingSttMs=useRef(0);
  const latencyReported=useRef(false);
  const latencyTurn=useRef<ConversationLatencyReport>({id:'',at:'',input:'text',sttMs:0,firstTokenMs:0,ttsMs:0,firstAudioMs:0,routeMs:0,recovered:false});
  const realtimeSendHandler=useRef<(text:string)=>Promise<void>>(async()=>{});
  const realtimeSpeakerMonitor=useRef<VoicePrintMonitor|null>(null);
  const realtimeVoicePrint=useRef<Promise<VoicePrint|null>|null>(null);
  const visiblePersonNameRef=useRef<string|undefined>(undefined);
  const verifiedSpeakerRef=useRef<{name:string;score:number;verifiedAt:string}|null>(null);
  const speakerTrustRef=useRef<SpeakerTrustSession|null>(null);
  const rollingSpeakerEvidence=useRef<Array<{at:number;print:VoicePrint}>>([]);
  const identityConflictStreak=useRef(0);
  const enrollingSpeakerRef=useRef(false);

  useEffect(() => {
    Promise.all([window.axiom.getSettings(), window.axiom.loadHistory(), window.axiom.listMemories(), window.axiom.listGoals(), window.axiom.listPermissions(),window.axiom.loadAudit(), window.axiom.getRuntimeSnapshot(),window.axiom.getDesktopGraph(),window.axiom.getAppInfo()]).then(([nextSettings, history, savedMemories, savedGoals, permissionList,auditItems,runtimeSnapshot,graphSnapshot,appInfo]) => {
      setAppVersion(appInfo.version);
      setSettings(nextSettings); setProviderDraft(nextSettings.provider); setModelDraft(nextSettings.model); setAutoFailover(nextSettings.autoFailover);setFallbackOrder(nextSettings.fallbackOrder);setCodingProvider(nextSettings.codingProvider);setResearchProvider(nextSettings.researchProvider); setWorkspaceDraft(nextSettings.codingWorkspace);setGodsEyeViewPathDraft(nextSettings.godsEyeViewPath);setAutomaticBackupsEnabled(nextSettings.automaticBackupsEnabled);setDeviceNameDraft(nextSettings.deviceName);setSyncEnabledDraft(nextSettings.syncEnabled);setSyncFolderDraft(nextSettings.syncFolder); setSpeechProviderDraft(nextSettings.speechProvider); setVoiceIdDraft(nextSettings.elevenLabsVoiceId); setVoiceNameDraft(nextSettings.elevenLabsVoiceName); setElevenModelDraft(nextSettings.elevenLabsModel); setVoiceStability(nextSettings.voiceStability); setVoiceSimilarity(nextSettings.voiceSimilarity); setVoiceStyle(nextSettings.voiceStyle); setVoiceSpeed(nextSettings.voiceSpeed);setMouthOffsetMs(nextSettings.mouthCalibration.offsetMs);setMouthGain(nextSettings.mouthCalibration.gain);setMouthAttack(nextSettings.mouthCalibration.attack);setMouthRelease(nextSettings.mouthCalibration.release);setStartMicrophoneOn(nextSettings.startMicrophoneOn);setUpdateFeedDraft(nextSettings.updateFeedUrl||'');setMicrophoneIdDraft(nextSettings.preferredMicrophoneId);setMicrophoneLabelDraft(nextSettings.preferredMicrophoneLabel);setMicrophoneNoiseFloor(nextSettings.microphoneNoiseFloor);setMicrophoneSpeechThreshold(nextSettings.microphoneSpeechThreshold);setSpeakerLockEnabled(nextSettings.speakerLockEnabled);setSpeakerName(nextSettings.speakerProfiles?.find((profile)=>profile.primary)?.name||''); setMessages(history);
      setAppearance(normalizeRendererAppearance(nextSettings.appearance));
      setMemories(savedMemories); setGoals(savedGoals); setPermissions(permissionList);setAudit(auditItems);setRuntime(runtimeSnapshot);setDesktopGraph(graphSnapshot);
      if (!nextSettings.hasSelectedAIKey) setSettingsOpen(true);
    }).catch((reason) => setError(String(reason)));
    Promise.all([window.axiom.listSelfCorrections(), window.axiom.lastSettingsSnapshot()]).then(([corrections,snapshot])=>{setSelfCorrections(corrections);setSettingsSnapshot(snapshot);}).catch(()=>{});
  }, []);
  useEffect(()=>{void window.axiom.getSyncStatus().then(setSyncStatus).catch(()=>{});const timer=window.setInterval(()=>void window.axiom.getSyncStatus().then(setSyncStatus).catch(()=>{}),10_000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{let cancelled=false;const refresh=(force=false)=>void window.axiom.getOperationalSnapshot(force).then((value)=>{if(!cancelled)setOperational(value);}).catch(()=>{});refresh();const timer=window.setInterval(()=>refresh(),4000);return()=>{cancelled=true;window.clearInterval(timer);};},[]);
  useEffect(()=>{const report=()=>{const now=Date.now();if(now-lastActivityReport.current<5000)return;lastActivityReport.current=now;void window.axiom.reportDeviceActivity().then(setSyncStatus).catch(()=>{});};const visible=()=>{if(document.visibilityState==='visible')report();};const heartbeat=window.setInterval(()=>{if(document.hasFocus())report();},8000);window.addEventListener('focus',report);window.addEventListener('pointerdown',report);window.addEventListener('keydown',report);document.addEventListener('visibilitychange',visible);report();return()=>{window.clearInterval(heartbeat);window.removeEventListener('focus',report);window.removeEventListener('pointerdown',report);window.removeEventListener('keydown',report);document.removeEventListener('visibilitychange',visible);};},[]);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(()=>{let cancelled=false;void warmNeuralSpeakerEngine().then(()=>{if(!cancelled)setSpeakerEngineState('ready');}).catch((reason)=>{console.warn('WavLM speaker engine unavailable',reason);if(!cancelled)setSpeakerEngineState('fault');});return()=>{cancelled=true;};},[]);
  useEffect(()=>{
    const trust=speakerTrustRef.current,face=recognition.observation;if(!trust||!face)return;
    const same=!face.unknown&&face.name.toLowerCase()===trust.name.toLowerCase();
    if(same){identityConflictStreak.current=0;const renewed=createSpeakerTrust(trust.name,trust.score,trust.source);speakerTrustRef.current=renewed;verifiedSpeakerRef.current={name:renewed.name,score:renewed.score,verifiedAt:renewed.verifiedAt};return;}
    identityConflictStreak.current+=1;
    if(identityConflictStreak.current<2)return;
    speakerTrustRef.current=null;verifiedSpeakerRef.current=null;rollingSpeakerEvidence.current=[];setSpeakerTrustSource('none');setSpeakerStatus('setup');setEnrollmentStatus('Identity session ended because a different or unknown face remained in view.');
  },[recognition.observation?.name,recognition.observation?.unknown,recognition.observation?.observedAt]);
  useEffect(()=>{
    if(!cameraFeedOpen)return;
    const connect=()=>{const preview=liveCameraRef.current,source=tracking.getVideoElement();if(!preview||!source?.srcObject)return false;if(preview.srcObject!==source.srcObject)preview.srcObject=source.srcObject;void preview.play().catch(()=>{});return true;};
    let timer=0;if(!connect())timer=window.setInterval(()=>{if(connect())window.clearInterval(timer);},180);
    return()=>{window.clearInterval(timer);if(liveCameraRef.current)liveCameraRef.current.srcObject=null;};
  },[cameraFeedOpen,tracking.getVideoElement]);
  // Redraws every pose tick (~20/sec) — cheap canvas work, not a persistent
  // resource, so unlike the srcObject connection above this is safe to key
  // on the live pose itself.
  useEffect(()=>{
    if(!cameraFeedOpen)return;
    const canvas=detectionOverlayRef.current,video=liveCameraRef.current,context=canvas?.getContext('2d');
    if(!canvas||!video||!context)return;
    if(video.videoWidth&&(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight)){canvas.width=video.videoWidth;canvas.height=video.videoHeight;}
    context.clearRect(0,0,canvas.width,canvas.height);
    const box=tracking.pose.box;
    if(!box||tracking.status!=='locked'||!canvas.width)return;
    const known=Boolean(recognition.observation&&!recognition.observation.unknown);
    const color=known?'#65ffab':'#ffb02a';
    // The video is mirrored via CSS (selfie view); this canvas is not, so the
    // box's x has to be mirrored manually to land on the visible face rather
    // than its unmirrored counterpart — keeping the canvas unmirrored is what
    // lets the label text underneath render right-reading instead of backwards.
    const w=box.width*canvas.width,h=box.height*canvas.height,y=box.y*canvas.height;
    const x=canvas.width-box.x*canvas.width-w;
    context.strokeStyle=color;context.lineWidth=Math.max(2,canvas.width*.004);context.shadowColor=color;context.shadowBlur=10;
    context.strokeRect(x,y,w,h);
    context.shadowBlur=0;
    const label=known?(recognition.observation!.name||'KNOWN').toUpperCase():'UNRECOGNIZED';
    const tagHeight=Math.max(16,canvas.width*.028);
    context.font=`${Math.max(11,canvas.width*.02)}px "Cascadia Mono",monospace`;
    const tagWidth=context.measureText(label).width+10;
    const tagY=Math.max(0,y-tagHeight);
    context.fillStyle='rgba(0,0,0,.72)';context.fillRect(x,tagY,tagWidth,tagHeight);
    context.fillStyle=color;context.fillText(label,x+5,tagY+tagHeight*.72);
  },[cameraFeedOpen,tracking.pose,tracking.status,recognition.observation]);
  // Every webcam model exposes a different subset of manual controls (some
  // none at all), so this reads whatever the connected camera actually
  // reports instead of assuming a fixed set — a backup for cameras where the
  // continuous-mode request doesn't hold, and just as useful on its own.
  useEffect(()=>{
    if(!tracking.enabled){setCameraControls(null);return;}
    let cancelled=false,timer=0;
    const build=()=>{
      const track=tracking.getVideoTrack();
      if(!track)return false;
      if(typeof track.getCapabilities!=='function'){setCameraControls({label:track.label||'CAMERA',controls:[]});return true;}
      let capabilities:Record<string,unknown>,settings:Record<string,unknown>;
      try{capabilities=track.getCapabilities() as unknown as Record<string,unknown>;settings=track.getSettings() as unknown as Record<string,unknown>;}
      catch{setCameraControls({label:track.label||'CAMERA',controls:[]});return true;}
      const controls:CameraControlState[]=[];
      for(const def of CAMERA_CONTROL_DEFS){
        const range=capabilities[def.key] as {min?:number;max?:number;step?:number}|undefined;
        if(!range||typeof range.min!=='number'||typeof range.max!=='number'||range.min===range.max)continue;
        const modes=def.modeKey?capabilities[def.modeKey] as string[]|undefined:undefined;
        if(modes&&!modes.includes('manual'))continue;
        const currentMode=def.modeKey?settings[def.modeKey] as string|undefined:undefined;
        const value=typeof settings[def.key]==='number'?settings[def.key] as number:range.min;
        controls.push({key:def.key,label:def.label,min:range.min,max:range.max,step:range.step||(range.max-range.min)/100||1,value,mode:currentMode==='continuous'?'continuous':'manual',supportsAuto:Boolean(modes?.includes('continuous'))});
      }
      setCameraControls({label:track.label||'CAMERA',controls});
      return true;
    };
    if(!build())timer=window.setInterval(()=>{if(!cancelled&&build())window.clearInterval(timer);},400);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[tracking.enabled,tracking.getVideoTrack]);
  const setCameraControl=async(key:CameraControlKey,value:number)=>{
    const track=tracking.getVideoTrack();if(!track)return;
    const modeKey=CAMERA_CONTROL_DEFS.find((def)=>def.key===key)?.modeKey;
    const advanced:Record<string,unknown>={[key]:value};if(modeKey)advanced[modeKey]='manual';
    try{await track.applyConstraints({advanced:[advanced]} as MediaTrackConstraints);}catch{return;}
    setCameraControls((current)=>current?{...current,controls:current.controls.map((control)=>control.key===key?{...control,value,mode:'manual'}:control)}:current);
  };
  const resetCameraControl=async(key:CameraControlKey)=>{
    const track=tracking.getVideoTrack();if(!track)return;
    const modeKey=CAMERA_CONTROL_DEFS.find((def)=>def.key===key)?.modeKey;if(!modeKey)return;
    try{await track.applyConstraints({advanced:[{[modeKey]:'continuous'}]} as MediaTrackConstraints);}catch{return;}
    setCameraControls((current)=>current?{...current,controls:current.controls.map((control)=>control.key===key?{...control,mode:'continuous'}:control)}:current);
  };
  // Guided enrollment needs its own visible feed: the tracking video used for
  // pose detection is created off-screen and never rendered anywhere on its
  // own, so without this a user doing the guided scan sees no camera at all.
  useEffect(()=>{
    if(!enrollmentBusy)return;
    const connect=()=>{const preview=enrollmentVideoRef.current,source=tracking.getVideoElement();if(!preview||!source?.srcObject)return false;if(preview.srcObject!==source.srcObject)preview.srcObject=source.srcObject;void preview.play().catch(()=>{});return true;};
    let timer=0;if(!connect())timer=window.setInterval(()=>{if(connect())window.clearInterval(timer);},180);
    return()=>{window.clearInterval(timer);if(enrollmentVideoRef.current)enrollmentVideoRef.current.srcObject=null;};
  },[enrollmentBusy,tracking.getVideoElement]);
  useEffect(()=>{if(!settingsOpen)return;void Promise.all([window.axiom.getProviderHealth(),window.axiom.getPlatformPermissions(),navigator.mediaDevices.enumerateDevices()]).then(([health,platformPermissions,devices])=>{setProviderHealth(health);setPlatformPermissionStatus(platformPermissions);setMicrophones(devices.filter((device)=>device.kind==='audioinput'));}).catch(()=>{});},[settingsOpen,settings]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => void window.axiom.getSystemTelemetry().then((value) => { if (!cancelled) setTelemetry(value); }).catch(() => {});
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  useEffect(()=>{
    if(!settings)return;
    const face=recognition.observation&&!recognition.observation.unknown&&livenessRef.current.live?{name:recognition.observation.name,confidence:recognition.observation.confidence,observedAt:recognition.observation.observedAt}:undefined;
    const speaker=verifiedSpeakerRef.current&&Date.now()-Date.parse(verifiedSpeakerRef.current.verifiedAt)<45_000?verifiedSpeakerRef.current:undefined;
    const report:RendererCapabilityReport={
      reportedAt:new Date().toISOString(),
      microphone:recording?'recording':voiceProcessing?'connecting':!settings.startMicrophoneOn?'off':realtimeVoice==='connecting'?'connecting':realtimeVoice==='fault'?'ready':realtimeVoice==='ready'?'ready':'off',
      transcription:!settings.startMicrophoneOn?'off':!settings.hasOpenAIKey?'fault':realtimeVoice==='ready'?'ready':realtimeVoice==='connecting'?'connecting':realtimeVoice==='fault'?'fallback':'off',
      camera:tracking.status,
      faceIdentity:face,
      speakerIdentity:speaker,
      speakerEngine:speakerEngineState,
      speakerDecision:speakerStatus==='setup'?'open':speakerStatus,
    };
    void window.axiom.reportRendererCapabilities(report).then(setOperational).catch(()=>{});
  },[settings?.startMicrophoneOn,settings?.hasOpenAIKey,recording,voiceProcessing,realtimeVoice,tracking.status,recognition.observation?.name,recognition.observation?.confidence,recognition.observation?.observedAt,speakerEngineState,speakerStatus]);
  const refreshRuntime = async () => { setRuntime(await window.axiom.getRuntimeSnapshot()); };
  const refreshDesktopGraph=async()=>{if(desktopGraphBusy)return;setDesktopGraphBusy(true);setError('');try{const result=await window.axiom.refreshDesktopGraph();setDesktopGraph(result.graph);setToolEvents((current)=>[result.event,...current].slice(0,12));}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setDesktopGraphBusy(false);}};
  useEffect(() => {
    let cancelled = false;
    const refresh = () => void window.axiom.getRuntimeSnapshot().then((value) => { if (!cancelled) setRuntime(value); }).catch(() => {});
    const timer = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const latest = messages[messages.length - 1];
  const primaryUserName=useMemo(()=>recognition.people.find((person)=>person.primary)?.name||settings?.speakerProfiles?.find((profile)=>profile.primary)?.name||[...memories].reverse().filter((item)=>item.status==='active'&&item.kind==='person').map((item)=>storedIdentityName(item.text)).find(Boolean)||'',[recognition.people,settings?.speakerProfiles,memories]);
  const statusText = useMemo(() => stateLabel(visual.mode), [visual.mode]);
  const currentModule = activeView === 'CONVERSE' ? null : moduleCopy[activeView];
  const visiblePermissions = currentModule?.permissions ? permissions.filter((permission) => currentModule.permissions?.includes(permission.id)) : permissions;
  const categorizedPermissionIds=new Set(PERMISSION_CATEGORIES.flatMap((category)=>category.ids));
  const uncategorizedPermissions=permissions.filter((permission)=>!categorizedPermissionIds.has(permission.id));

  const finishSpeechVisual = () => {
    lastSpeechEndedAt.current = performance.now();
    dispatch({ type: 'mode', mode: 'idle' });
    dispatch({ type: 'energy', energy: .2 });
    setMouth({ open: 0, wide: 0, round: 0 });
  };

  const reportLatency=(allowWithoutAudio=false)=>{
    const report=latencyTurn.current;
    if(latencyReported.current||!report.id||!report.routeMs||(!allowWithoutAudio&&!report.firstAudioMs))return;
    latencyReported.current=true;
    void window.axiom.reportConversationLatency({...report}).then(setOperational).catch(()=>{});
  };

  const playSystemSpeech = async (text: string, turnId: number): Promise<void> => {
    if (!('speechSynthesis' in window) || speechTurn.current.id !== turnId) throw new Error('System speech is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      utterance.voice = voices.find((voice) => /Microsoft (Mark|David)/i.test(voice.name))
        ?? voices.find((voice) => /^en-US$/i.test(voice.lang))
        ?? voices.find((voice) => /^en/i.test(voice.lang))
        ?? null;
      utterance.rate = voiceSpeed; utterance.pitch = .9; utterance.volume = 1;
      let settled = false,animation=0,syntheticIndex=0,syntheticAt=0,shown=0,lastVisualAt=0;
      const watchdog = window.setTimeout(() => {
        if (settled) return; cancelAnimationFrame(animation); settled = true; speechSynthesis.cancel(); reject(new Error('System speech timed out.'));
      }, Math.max(12_000, text.length * 115));
      const settle = (failure?: Error) => {
        if (settled) return; settled = true; window.clearTimeout(watchdog);cancelAnimationFrame(animation); failure ? reject(failure) : resolve();
      };
      // This is the exact boundary-anchored synthetic clock used by the
      // working Jarvis build. Browser boundary events correct the anchor, and
      // the 86 ms fallback keeps articulating between sparse events.
      const articulate=(now:number)=>{if(settled)return;if(now-lastVisualAt>30){lastVisualAt=now;const inferred=Math.min(Math.max(0,text.length-1),syntheticIndex+Math.floor((now-syntheticAt)/86)),pose=visemePose(speechViseme(text,inferred),inferred);let target=pose.open*(.84+.16*Math.sin(inferred*2.37)**2);if(pose.viseme==='wide')target=Math.max(target,.94);shown+=(target-shown)*(target>shown?(pose.viseme==='wide'?.84:.7):.52);if(pose.viseme==='closed'||pose.viseme==='rest')shown=0;setMouth({...pose,open:shown});}animation=requestAnimationFrame(articulate);};
      utterance.onstart = () => {syntheticAt=performance.now();if(latencyTurn.current.id&&!latencyTurn.current.firstAudioMs){latencyTurn.current.firstAudioMs=Math.round(performance.now()-assistantRequestAt.current);reportLatency();}dispatch({ type: 'mode', mode: 'speaking' });animation=requestAnimationFrame(articulate);};
      utterance.onboundary = (event) => {
        syntheticIndex=Math.max(0,event.charIndex);syntheticAt=performance.now();const pose=visemePose(speechViseme(text,syntheticIndex),syntheticIndex);shown=pose.open;setMouth(pose);
        dispatch({ type: 'energy', energy: .62 });
      };
      utterance.onend = () => settle();
      utterance.onerror = (event) => speechTurn.current.id !== turnId ? settle() : settle(new Error(`System speech failed: ${event.error}`));
      speechSynthesis.cancel(); speechSynthesis.resume(); speechSynthesis.speak(utterance);
    });
  };

  const cancelSpeechTurn = () => {
    speechTurn.current.id += 1;
    speechTurn.current.active = false;
    speechTurn.current.buffer = '';
    if (activeAudio.current) {
      activeAudio.current.pause();
      activeAudio.current.dispatchEvent(new Event('error'));
    }
    activeAudio.current = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    finishSpeechVisual();
  };

  const playSpeechSegment = async (text: string, turnId: number, prepared?:Promise<PreparedSpeech>): Promise<void> => {
    if (speechTurn.current.id !== turnId) return;
    let cloudFailure: unknown;
    try {
      const result = await (prepared??window.axiom.synthesizeSpeech(text));
      if (speechTurn.current.id !== turnId) return;
      const blobUrl = URL.createObjectURL(new Blob([result.audio], { type: result.mimeType }));
      const audio = new Audio(blobUrl); audio.preload = 'auto';
      const context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 256;analyser.smoothingTimeConstant=.48;
      activeAudio.current = audio;
      const source = context.createMediaElementSource(audio); source.connect(analyser); analyser.connect(context.destination);
      const bins = new Uint8Array(analyser.frequencyBinCount),samples=new Uint8Array(analyser.fftSize);let animation=0,shown=0,floor=.012,silenceFrames=0,shownPose=0;
      try {
        if (context.state === 'suspended') await context.resume();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (failure?: Error) => {
            if (settled) return; settled = true; cancelAnimationFrame(animation);
            failure ? reject(failure) : resolve();
          };
          const articulate = () => {
            if (speechTurn.current.id !== turnId) { settle(); return; }
            analyser.getByteFrequencyData(bins);
            analyser.getByteTimeDomainData(samples);
            let sum=0;for(const sample of samples){const value=(sample-128)/128;sum+=value*value;}const rms=Math.sqrt(sum/samples.length);floor=Math.min(.032,floor*.998+rms*.002);
            let vocal=0,count=0;for(let index=2;index<Math.min(bins.length,48);index++){vocal+=bins[index]/255;count++;}vocal=count?vocal/count:0;
            let energy=clamp((rms-floor-.0035)*10.5+vocal*.42);if(energy<.075){silenceFrames++;if(silenceFrames>2)energy=0;}else silenceFrames=0;
            const timed=timedSpeechPose(result.alignment,audio.currentTime+mouthOffsetMs/1000),pose=timed||estimatedSpeechPose(text,audio.currentTime,Number.isFinite(audio.duration)?audio.duration:Math.max(.4,text.length/13));
            if(timed)shownPose+=(timed.open-shownPose)*(timed.open>shownPose?mouthAttack:Math.max(mouthRelease,.62));else shownPose=pose.open;
            const target=speechMouthTarget({...pose,open:timed?shownPose:pose.open},energy,mouthGain,Boolean(timed));
            const rate=target>shown?(timed?mouthAttack:.56):mouthRelease;shown+=(target-shown)*rate;if(shown<.018)shown=0;
            setMouth({...pose,open:shown});
            dispatch({type:'energy',energy:.2+energy*.8});
            animation = requestAnimationFrame(articulate);
          };
          audio.onplay = () => {if(latencyTurn.current.id&&!latencyTurn.current.firstAudioMs){latencyTurn.current.firstAudioMs=Math.round(performance.now()-assistantRequestAt.current);reportLatency();}dispatch({ type: 'mode', mode: 'speaking' }); animation = requestAnimationFrame(articulate); };
          audio.onended = () => settle();
          audio.onerror = () => speechTurn.current.id !== turnId ? settle() : settle(new Error('Generated voice audio could not be decoded or played.'));
          void audio.play().catch((reason) => settle(reason instanceof Error ? reason : new Error(String(reason))));
        });
        return;
      } finally {
        URL.revokeObjectURL(blobUrl); source.disconnect(); analyser.disconnect(); void context.close();
        if (activeAudio.current === audio) activeAudio.current = null;
      }
    } catch (reason) {
      cloudFailure = reason;
    }
    if (speechTurn.current.id !== turnId) return;
    try {
      console.warn('Cloud voice unavailable; using operating-system speech.', cloudFailure);
      await playSystemSpeech(text, turnId);
    } catch (systemFailure) {
      const cloudDetail = cloudFailure instanceof Error ? cloudFailure.message : String(cloudFailure);
      const systemDetail = systemFailure instanceof Error ? systemFailure.message : String(systemFailure);
      setError(`Voice playback failed. ${cloudDetail} ${systemDetail}`);
    }
  };

  const startSpeechTurn = () => {
    cancelSpeechTurn();
    const turn = speechTurn.current;
    turn.active = true; turn.buffer = ''; turn.queuedChars = 0; turn.chain = Promise.resolve(); turn.prepareTail=Promise.resolve();
    return turn.id;
  };

  const enqueueSpeech = (text: string) => {
    const turn = speechTurn.current; if (!turn.active || !text) return;
    const turnId = turn.id; turn.queuedChars += text.length;
    // Generate the next sentence while the current sentence is still playing.
    // The separate preparation queue prevents API bursts while eliminating the
    // old synthesis-sized silence between spoken chunks.
    const synthesisQueuedAt=performance.now();
    const prepared=turn.prepareTail.then(()=>window.axiom.synthesizeSpeech(text));
    void prepared.then(()=>{if(speechTurn.current.id===turnId&&!firstTtsCaptured.current){const ttsMs=Math.round(performance.now()-synthesisQueuedAt);firstTtsCaptured.current=true;latencyTurn.current.ttsMs=ttsMs;}}).catch(()=>{});
    turn.prepareTail=prepared.then(()=>undefined,()=>undefined);
    turn.chain = turn.chain.then(() => playSpeechSegment(text, turnId, prepared));
  };

  const feedSpeech = (delta: string, flush = false) => {
    const turn = speechTurn.current; if (!turn.active) return;
    const result = takeSpeechChunks(turn.buffer + delta, flush); turn.buffer = result.remainder;
    result.chunks.forEach(enqueueSpeech);
  };

  const finishSpeechTurn = (fallbackText = ''):Promise<void> => {
    const turn = speechTurn.current; if (!turn.active) return Promise.resolve();
    feedSpeech('', true);
    if (!turn.queuedChars && fallbackText) enqueueSpeech(fallbackText);
    const turnId = turn.id;
    const completion=turn.chain.finally(() => {
      if (speechTurn.current.id !== turnId) return;
      speechTurn.current.active = false; finishSpeechVisual();
    });
    void completion;return completion;
  };

  const speak = (text: string):Promise<void> => { startSpeechTurn(); feedSpeech(text, true); return finishSpeechTurn(); };
  speechDeltaHandler.current = (delta) => { if(!firstTokenCaptured.current&&assistantRequestAt.current){const firstTokenMs=Math.round(performance.now()-assistantRequestAt.current);firstTokenCaptured.current=true;latencyTurn.current.firstTokenMs=firstTokenMs;}setStreamingText((current) => current + delta); feedSpeech(delta); };
  useEffect(() => window.axiom.onAssistantDelta((delta) => speechDeltaHandler.current(delta)), []);
  useEffect(() => () => cancelSpeechTurn(), []);

  useEffect(() => {
    if (!settings?.hasSelectedAIKey || startupBriefed.current || busy) return;
    startupBriefed.current = true;
    let cancelled=false,pollTimer=0,splashTimer=0;
    // Used to be a blind 550ms timer. The ".reference-master:after" boot
    // splash ("AXIOM // NEURAL INTERFACE") is a real, separate animation
    // that stays fully opaque and covering the whole screen until 74% into
    // its own 1.35s duration (referenceMod.css's reference-boot keyframes)
    // — 550ms fires well before that, so Axiom used to start talking while
    // the splash still fully covered the UI, which is exactly the freeze/
    // stutter reported live. Waits for both document load and the splash's
    // real duration, not just a guessed number.
    const BOOT_SPLASH_MS=1400;
    const waitForReady=(): Promise<void> => new Promise((resolve) => {
      const check=() => {
        if(cancelled)return;
        if(document.readyState==='complete')requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()));
        else pollTimer=window.setTimeout(check,60);
      };
      check();
    });
    void Promise.all([waitForReady(),new Promise((resolve)=>{splashTimer=window.setTimeout(resolve,BOOT_SPLASH_MS);})]).then(()=>{
      if(cancelled)return;
      const observed=recognitionObservationRef.current,verifiedName=observed&&!observed.unknown&&Date.now()-Date.parse(observed.observedAt)<12_000?observed.name:'';
      return speak(`Hello${verifiedName?`, ${verifiedName}`:''}. What would you like me to help you with?`).finally(()=>setStartupGreetingComplete(true));
    });
    return () => { cancelled=true; window.clearTimeout(pollTimer); window.clearTimeout(splashTimer); };
  }, [settings?.hasSelectedAIKey,primaryUserName]);

  // Passive display only: reflects whatever the camera currently recognizes,
  // purely for personalization (used to greet by name / give the model
  // identity context). No alerts, no evidence capture, no challenge, no
  // tool-blocking — Office Sentry's active-watchdog behavior was removed.
  useEffect(()=>{
    if(tracking.status!=='locked'){setPresenceIdentityState({kind:'scanning'});return;}
    const observation=recognition.observation;
    if(!observation){setPresenceIdentityState({kind:'scanning'});return;}
    setPresenceIdentityState(observation.unknown?{kind:'unknown'}:{kind:'known',name:observation.name});
  },[tracking.status,recognition.observation]);

  // Tracks presence gaps purely from whether anyone is currently tracked in
  // frame — separate from identity, since resolving *who* it is takes a
  // moment after tracking first locks back on (recognition polls on its own
  // ~1.9s cycle). Only flags a return worth greeting once someone has
  // actually been away 5+ minutes, not a momentary look-away.
  useEffect(()=>{
    if(!startupGreetingComplete)return;
    const RETURN_GREETING_AWAY_MS=5*60_000;
    if(tracking.status==='locked'){
      if(awaySince.current!==null){
        if(Date.now()-awaySince.current>=RETURN_GREETING_AWAY_MS)returnGreetingPending.current=true;
        awaySince.current=null;
      }
    }else if(awaySince.current===null){
      awaySince.current=Date.now();
    }
  },[tracking.status,startupGreetingComplete]);

  // Consumes the flag the effect above sets, once identity actually
  // resolves to someone known — greeting a stranger, or greeting before
  // Axiom can even say a name, would be worse than not greeting at all.
  useEffect(()=>{
    if(!returnGreetingPending.current||presenceIdentityState.kind!=='known'||returnGreetingBusy.current)return;
    if(busy||recording||voiceProcessing||settingsOpen||speechTurn.current.active)return;
    returnGreetingPending.current=false;returnGreetingBusy.current=true;
    void speak(`Welcome back${presenceIdentityState.name?`, ${presenceIdentityState.name}`:''}.`).finally(()=>{returnGreetingBusy.current=false;});
  },[presenceIdentityState.kind,presenceIdentityState.name]);

  const waitForCameraFrame=async(timeoutMs=5200):Promise<ScreenCapture|null>=>{
    if(!tracking.enabled)tracking.setEnabled(true);
    if(['busy','denied','error'].includes(trackingStatusRef.current))tracking.retry();
    const started=performance.now();
    while(performance.now()-started<timeoutMs){const frame=tracking.captureFrame();if(frame)return frame;await new Promise((resolve)=>window.setTimeout(resolve,160));}
    return null;
  };

  useEffect(()=>window.axiom.onCameraCaptureRequest(({id})=>{void(async()=>{try{const frame=tracking.captureFrame()??await waitForCameraFrame(9000);if(!frame)throw new Error(`Presence Link is ${trackingStatusRef.current}; no camera frame is available.`);window.axiom.submitCameraCapture(id,frame);}catch(reason){window.axiom.submitCameraCapture(id,undefined,reason instanceof Error?reason.message:String(reason));}})();}),[tracking.enabled]);
  useEffect(()=>window.axiom.onBackgroundEvent((event)=>{const assistant:ChatMessage={id:uid(),role:'assistant',text:event.text,createdAt:event.createdAt};setMessages((current)=>[...current,assistant]);setToolEvents((current)=>[{name:`background_${event.kind}`,status:event.title.toLowerCase().includes('fail')?'failed' as const:'verified' as const,summary:event.title,at:event.createdAt},...current].slice(0,12));void refreshRuntime();if(event.speak&&!settingsOpen)void speak(event.text);}),[settingsOpen]);

  const sendText = async (text: string,resumeTaskId?:string,inputSource:'text'|'voice'='text') => {
    const clean = text.trim(); if (!clean || busy) return;
    // A bare "I am Robbie" is correctly never enough to establish identity —
    // anyone could say it. When the camera genuinely can't confirm the owner
    // (bad angle, lighting, or an enrollment gap), the enrolled override
    // phrase is the deliberate, secret-based way back in. Gated on the word
    // "override" so ordinary conversation while unrecognized never touches
    // the hash check or spends the attempt-rate-limit budget.
    if(presenceIdentityState.kind!=='known'&&/\boverride\b/i.test(clean)){
      const overrideMatch=await window.axiom.verifyOwnerOverride(clean).catch(()=>false);
      if(overrideMatch){
        setPresenceIdentityState({kind:'known',name:primaryUserName});
        const now=new Date().toISOString(),reply=`Owner override confirmed${primaryUserName?`, ${primaryUserName}`:''}. Camera or voice biometrics were not available this turn, but the enrolled override phrase matched — full trust is restored. Go ahead with your request.`;
        setInput('');setMessages((current)=>[...current,{id:uid(),role:'user',text:'•••••••• (owner override phrase)',createdAt:now},{id:uid(),role:'assistant',text:reply,createdAt:now}]);
        setToolEvents((current)=>[{name:'presence_owner_override',status:'verified' as const,summary:'Owner override phrase accepted; camera/voice biometrics were unavailable for this turn.',at:now},...current].slice(0,12));
        await speak(reply);return;
      }
    }
    // A deterministic local answer, same reasoning as the camera-routing
    // block below: which Ring cameras exist is a fact Axiom already has to
    // fetch to route a named-camera request, so answering "what Ring
    // cameras do I have" doesn't need a model round trip either — and the
    // error messages below promise this capability, so it has to be real.
    if(/\b(?:what|which|list)\b.{0,25}\bring\b.{0,15}\b(?:cams?|cameras?)\b|\bring\b.{0,15}\b(?:cams?|cameras?)\b.{0,20}\b(?:do i have|are there)\b/i.test(clean)){
      const now=new Date().toISOString(),user:ChatMessage={id:uid(),role:'user',text:clean,createdAt:now};
      try{
        const connectorList=await window.axiom.listConnectors();
        if(!connectorList.find((item)=>item.id==='ring')?.connected){
          const reply='Ring isn\'t connected yet. Add your Ring account in Settings → Connections.';
          setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
        }
        const list=await window.axiom.listRingCameras();
        const reply=list.cameras.length?`Your Ring cameras: ${list.cameras.map((item)=>`${item.name}${item.online?'':' (offline)'}`).join(', ')}.`:'Ring is connected, but I don\'t see any cameras on the account.';
        setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }catch(reason){
        const reply=`I couldn't reach Ring: ${reason instanceof Error?reason.message:String(reason)}`;
        setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }
    }
    // "Show me all my cameras" — same deterministic-local reasoning as the
    // two blocks above, opening every camera additively (openRingLiveView
    // only ever replaces the SAME camera's session, never another one).
    if(/\b(?:show|open|display|view|watch|pull up|bring up|turn on|enable)\b.{0,20}\ball\b.{0,20}\b(?:cams?|cameras?)\b|\ball\b.{0,15}\bring\b.{0,15}\b(?:cams?|cameras?)\b|\bevery\b.{0,15}\b(?:cams?|cameras?)\b/i.test(clean)){
      const now=new Date().toISOString(),user:ChatMessage={id:uid(),role:'user',text:clean,createdAt:now};
      try{
        const connectorList=await window.axiom.listConnectors();
        if(!connectorList.find((item)=>item.id==='ring')?.connected){
          const reply='Ring isn\'t connected yet. Add your Ring account in Settings → Connections, then ask me again.';
          setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
        }
        const list=await window.axiom.listRingCameras();
        if(!list.cameras.length){
          const reply='Ring is connected, but I don\'t see any cameras on the account.';
          setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
        }
        // Ring panels only render on the CONVERSE (home/chat) screen now —
        // a leftover setActiveView('SCREEN') here used to switch to the
        // unrelated local-camera SCREEN tab, which no longer even shows
        // the panel and just hides it entirely behind SCREEN's own content.
        setInput('');setMessages((current)=>[...current,user]);setActiveView('CONVERSE');
        await Promise.all(list.cameras.map((camera)=>openRingLiveView(camera)));
        const reply=`Opening all ${list.cameras.length} of your Ring cameras: ${list.cameras.map((item)=>item.name).join(', ')}.`;
        setMessages((current)=>[...current,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }catch(reason){
        const reply=`I couldn't reach Ring: ${reason instanceof Error?reason.message:String(reason)}`;
        setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }
    }
    const cameraIntent=cameraRequestIntent(clean);
    if(cameraIntent.deviceName){
      // A named camera ("the front door camera") means the user wants a
      // specific external camera, not Axiom's own local webcam — opening the
      // local feed instead would be actively misleading, so this never falls
      // through to the local-webcam branch below on any failure path.
      const now=new Date().toISOString(),user:ChatMessage={id:uid(),role:'user',text:clean,createdAt:now};
      try{
        const connectorList=await window.axiom.listConnectors();
        const ringStatus=connectorList.find((item)=>item.id==='ring');
        if(!ringStatus?.connected){
          const reply=`Ring isn't connected yet. Add your Ring account in Settings → Connections, then ask me again.`;
          setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
        }
        const list=await window.axiom.listRingCameras();
        const target=cameraIntent.deviceName.toLowerCase();
        const candidates=list.cameras.filter((item)=>item.name.toLowerCase()===target||item.name.toLowerCase().includes(target));
        const exact=candidates.filter((item)=>item.name.toLowerCase()===target);
        const pool=exact.length===1?exact:candidates;
        if(pool.length===1){setInput('');setMessages((current)=>[...current,user]);setActiveView('CONVERSE');await openRingLiveView(pool[0]);return;}
        // "Ask Axiom to list your cameras" is not an actual capability — the
        // camera names are only ever known at this exact moment, right after
        // fetching list.cameras, so the only honest way to tell the user
        // what's actually available is to name them here directly.
        const available=list.cameras.map((item)=>item.name);
        const reply=pool.length>1?`I have more than one Ring camera matching "${cameraIntent.deviceName}": ${pool.slice(0,8).map((item)=>item.name).join(', ')}. Which one did you mean?`:available.length?`I don't have a Ring camera named "${cameraIntent.deviceName}". Your Ring cameras are: ${available.join(', ')}.`:`Ring is connected, but I don't see any cameras on the account.`;
        setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }catch(reason){
        const reply=`I couldn't reach Ring: ${reason instanceof Error?reason.message:String(reason)}`;
        setInput('');setMessages((current)=>[...current,user,{id:uid(),role:'assistant',text:reply,createdAt:now}]);await speak(reply);return;
      }
    }
    if(cameraIntent.showFeed){setCameraFeedOpen(true);setActiveView('SCREEN');setToolEvents((current)=>[{name:'camera_live_feed',status:'verified' as const,summary:'Live local camera preview opened at the user’s request.',at:new Date().toISOString()},...current].slice(0,12));}
    const enrollment=faceEnrollmentIntent(clean,messages,primaryUserName||speakerName);
    if(enrollment.requested){
      setBusy(true);setError('');const user:ChatMessage={id:uid(),role:'user',text:clean,createdAt:new Date().toISOString()};setMessages((current)=>[...current,user]);
      try{if(!enrollment.name){const reply='Tell me the name you want attached to the face profile, then face the camera and ask me to remember your face again.';setMessages((current)=>[...current,{id:uid(),role:'assistant',text:reply,createdAt:new Date().toISOString()}]);await speak(reply);return;}const descriptor=recognition.observation?.descriptor;if(!descriptor){const reply='I need a clear view of your face first — look at the camera, then ask me to remember your face again.';setMessages((current)=>[...current,{id:uid(),role:'assistant',text:reply,createdAt:new Date().toISOString()}]);await speak(reply);return;}const saved=await window.axiom.saveKnownPerson(enrollment.name,descriptor);const reply=`Enrollment complete. ${saved.name} is the ${saved.primary?'primary ':''}trusted face with ${saved.descriptors?.length??1} local recognition samples. I will only say face verified after several current camera frames agree; remembering your name alone is not verification.`;setMessages((current)=>[...current,{id:uid(),role:'assistant',text:reply,createdAt:new Date().toISOString()}]);setMemories(await window.axiom.listMemories());await speak(reply);}
      catch(reason){setError(reason instanceof Error?reason.message:String(reason));dispatch({type:'mode',mode:'error'});}finally{setBusy(false);}return;
    }
    if(/\b(?:who am i|do you know who (?:i am|you(?:'re| are) talking to)|recognize me|identify me|how do you know (?:it'?s|its) me|remember me)\b/i.test(clean)){
      setBusy(true);setInput('');setError('');const now=new Date().toISOString(),decision=await recognition.classifyPresence(6,260);
      const reply=decision.kind==='known'?`Yes. You are ${decision.name}. I verified your face across ${decision.faceFrames} camera frames at ${Math.round(decision.confidence*100)}% average confidence.`:decision.kind==='unknown'?`${primaryUserName?`I remember ${primaryUserName}, but `:''}the person in front of the camera does not match a trusted face profile. I will not treat this person as the owner.`:`I remember ${primaryUserName||'the enrolled owner'}, but I do not have enough current camera evidence to verify who is present.`;
      setMessages((current)=>[...current,{id:uid(),role:'user',text:clean,createdAt:now},{id:uid(),role:'assistant',text:reply,createdAt:now}]);setToolEvents((current)=>[{name:'presence_identity_check',status:decision.kind==='known'?'verified' as const:'blocked' as const,summary:reply,at:now},...current].slice(0,12));await speak(reply);setBusy(false);return;
    }
    let visualCapture=cameraCapture||screenCapture;
    if(cameraIntent.showFeed||cameraIntent.analyze||/\b(?:what|who|describe|tell me).{0,35}(?:see|camera|room)|\blook (?:at|around)|\bwhat am i doing\b/i.test(clean)){const frame=tracking.captureFrame()??await waitForCameraFrame();if(frame){visualCapture=frame;setCameraCapture(frame);setScreenCapture(null);}}
    if((cameraIntent.showFeed||cameraIntent.analyze)&&!visualCapture){
      const cameraState=trackingStatusRef.current.toUpperCase();
      const reply=`I received the camera request, but I do not have a usable frame yet. Presence Link reports ${cameraState}. Open macOS or Windows privacy settings, allow Axiom camera access, then ask me to open the feed again.`;
      const now=new Date().toISOString();
      setStartupGreetingVisible(false);setInput('');setError(reply);
      setMessages((current)=>[...current,{id:uid(),role:'user',text:clean,createdAt:now},{id:uid(),role:'assistant',text:reply,createdAt:now}]);
      setToolEvents((current)=>[{name:'camera_live_feed',status:'failed' as const,summary:`Camera request failed because Presence Link reported ${cameraState}.`,at:now},...current].slice(0,12));
      await speak(reply);return;
    }
    let liveFace=recognition.observation;if(/\b(?:who am i|know who|recognize me|identify me|how do you know|my identity)\b/i.test(clean))liveFace=await recognition.recognize()??liveFace;
    if(recorderRef.current?.state==='recording'){discardVoiceCapture.current=true;recorderRef.current.stop();}
    setStartupGreetingVisible(false);setInput(''); setError(''); setStreamingText(''); setBusy(true); startSpeechTurn();assistantRequestAt.current=performance.now();firstTokenCaptured.current=false;firstTtsCaptured.current=false;latencyReported.current=false;latencyTurn.current={id:uid(),at:new Date().toISOString(),input:inputSource,sttMs:inputSource==='voice'?pendingSttMs.current:0,firstTokenMs:0,ttsMs:0,firstAudioMs:0,routeMs:0,recovered:false};pendingSttMs.current=0; dispatch({ type: 'mode', mode: 'thinking' }); dispatch({ type: 'energy', energy: 0.72 });
    const user: ChatMessage = { id: uid(), role: 'user', text: clean, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, user]);
    try {
      // Gated on passive liveness, not just a name match: this is what lets
      // Axiom tell the model "FACE VERIFIED", which the model treats as grounds
      // to skip identity caution. A photo held up to the camera must not reach
      // this path just because it matched a stored descriptor.
      const face=liveFace&&!liveFace.unknown&&livenessRef.current.live?{name:liveFace.name,confidence:liveFace.confidence,observedAt:liveFace.observedAt}:undefined,speaker=verifiedSpeakerRef.current&&Date.now()-Date.parse(verifiedSpeakerRef.current.verifiedAt)<30_000?verifiedSpeakerRef.current:undefined;
      const requestMessage=visualCapture?`${clean}\n\nA current camera frame is attached. Describe only what is actually visible; if an action is uncertain, say so.`:clean;
      const reply = await window.axiom.sendMessage({ message: requestMessage, history: messages.map(({ role, text }) => ({ role, text })), imageDataUrl: visualCapture?.dataUrl,resumeTaskId,identity:face||speaker?{face,speaker}:undefined });
      latencyTurn.current.routeMs=Math.round(performance.now()-assistantRequestAt.current);latencyTurn.current.recovered=reply.toolEvents.some((event)=>event.recovered||event.name==='adaptive_failover');reportLatency();
      const assistant: ChatMessage = { id: uid(), role: 'assistant', text: reply.text, createdAt: new Date().toISOString(), tone: reply.tone };
      setMessages((current) => [...current, assistant]); setToolEvents((current) => [...reply.toolEvents, ...current].slice(0, 12));
      void window.axiom.loadAudit().then(setAudit);
      void Promise.all([window.axiom.listMemories(), window.axiom.listGoals(), window.axiom.getRuntimeSnapshot()]).then(([savedMemories, savedGoals, runtimeSnapshot]) => { setMemories(savedMemories); setGoals(savedGoals); setRuntime(runtimeSnapshot); });
      const appearanceCommand = reply.toolEvents.find((tool) => tool.uiCommand?.type === 'appearance')?.uiCommand;
      if (appearanceCommand?.type === 'appearance') setAppearance(normalizeRendererAppearance(appearanceCommand.appearance||{color:appearanceCommand.color,emotion:appearanceCommand.emotion}));
      setScreenCapture(null);setCameraCapture(null); setStreamingText(''); dispatch({ type: 'mode', mode: reply.toolEvents.length ? 'success' : 'thinking' }); const speechCompletion=finishSpeechTurn(speechOnlyText(reply.text));void speechCompletion.finally(()=>reportLatency(true));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      speechTurn.current.id += 1; speechTurn.current.active = false; speechTurn.current.buffer = '';
      setError(detail); dispatch({ type: 'mode', mode: 'error' }); dispatch({ type: 'energy', energy: 0.8 });
    } finally { setBusy(false); void refreshRuntime(); }
  };
  realtimeSendHandler.current=(text)=>sendText(text,undefined,'voice');
  const visiblePersonName=recognition.observation&&!recognition.observation.unknown?recognition.observation.name:undefined;
  visiblePersonNameRef.current=visiblePersonName;
  const openMicrophone=async(deviceId=settings?.preferredMicrophoneId||'')=>{try{return await navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(deviceId),video:false});}catch(reason){if(!deviceId)throw reason;setToolEvents((current)=>[{name:'microphone_recovery',status:'verified' as const,summary:'Selected microphone was unavailable; recovered with the system default input.',at:new Date().toISOString()},...current].slice(0,12));return navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(),video:false});}};
  const verifySpeaker=async(print:VoicePrint|null):Promise<SpeakerMatch>=>{
    const profiles=settings?.speakerProfiles??[],now=Date.now(),live=recognitionObservationRef.current,face:FaceIdentityEvidence|null=live?{name:live.name,confidence:live.confidence,unknown:live.unknown,observedAt:live.observedAt}:null,enrolledFace=matchingFaceProfile(profiles,face,now),activeSession=speakerTrustRef.current,sessionValid=speakerSessionValid(activeSession,face,now);
    const establish=(name:string,score:number,source:SpeakerTrustSource,detail:string):SpeakerMatch=>{const trust=createSpeakerTrust(name,score,source,now);speakerTrustRef.current=trust;verifiedSpeakerRef.current={name,score,verifiedAt:trust.verifiedAt};identityConflictStreak.current=0;setSpeakerTrustSource(source);setSpeakerStatus('verified');setSpeakerName(name);setEnrollmentStatus(`${name.toUpperCase()} VERIFIED · ${detail}`);return{accepted:true,enrolled:true,name,profileId:profiles.find((item)=>item.name.toLowerCase()===name.toLowerCase())?.id,score,threshold:0,reason:'matched'};};
    if(!speakerLockEnabled||!profiles.length){const open=await window.axiom.matchSpeaker(print?.vector??[],visiblePersonNameRef.current);if(!open.enrolled){setSpeakerStatus('setup');setSpeakerTrustSource('none');}return open;}
    if(print?.model==='wavlm-base-plus-sv'){rollingSpeakerEvidence.current=[...rollingSpeakerEvidence.current.filter((item)=>now-item.at<15_000),{at:now,print}].slice(-4);}
    const directQuality=speakerEvidenceQuality(print),combined=combineSpeakerEvidence(rollingSpeakerEvidence.current.map((item)=>item.print)),combinedQuality=speakerEvidenceQuality(combined),candidate=directQuality.strong?print:combinedQuality.strong?combined:directQuality.usable?print:null,candidateQuality=speakerEvidenceQuality(candidate);
    const match=candidate?await window.axiom.matchSpeaker(candidate.vector,visiblePersonNameRef.current):{accepted:false,enrolled:true,score:0,threshold:.72,reason:'invalid-sample' as const};
    if(match.accepted&&match.name){
      const strong=candidateQuality.strong;
      // Measured empirically: a strong voice-only match had a 25-33% false-accept
      // rate at these thresholds. Whenever the camera sees anything at all, the
      // voice match must be corroborated by it before it can grant trust — this
      // is exactly the case that matters for unattended watching, where a
      // stranger's voice scoring above threshold must not borrow the owner's
      // identity just because nobody checked it against what's on camera.
      const conjunction=resolveVoiceFaceTrust(match.name,face);
      if(conjunction.tier==='conflict'){
        speakerTrustRef.current=null;verifiedSpeakerRef.current=null;setSpeakerTrustSource('none');setSpeakerStatus('rejected');
        const summary=`Voice matched "${conjunction.voiceName}" but the camera shows ${conjunction.faceName?`a different person ("${conjunction.faceName}")`:'an unrecognized person'}. Refusing to grant identity trust from voice alone while the camera disagrees.`;
        setEnrollmentStatus(summary.toUpperCase());
        setToolEvents((current)=>[{name:'speaker_identity',status:'blocked' as const,summary,at:new Date().toISOString()},...current].slice(0,12));
        return{accepted:false,enrolled:true,score:match.score,threshold:match.threshold,reason:'rejected'};
      }
      const source:SpeakerTrustSource=conjunction.tier==='confirmed'?'voice-face-confirmed':strong?(candidate===print?'voice':'rolling-voice'):(enrolledFace?'multimodal':'session');
      if(strong)rollingSpeakerEvidence.current=[];
      const detail=conjunction.tier==='confirmed'?`FACE + WAVLM CONFIRMED · ${Math.round(match.score*100)}% MATCH · ${candidateQuality.detail}`:`${source==='rolling-voice'?'ROLLING ':''}WAVLM · ${Math.round(match.score*100)}% MATCH · ${candidateQuality.detail}${conjunction.tier==='voice-only'?' · NO CAMERA SIGNAL':''}`;
      return establish(match.name,match.score,source,detail);
    }
    if(activeSession&&canBridgeBorderlineMatch(match,activeSession,face,now))return establish(activeSession.name,Math.max(activeSession.score,match.score),'multimodal',`CONTINUOUS FACE + VOICE SESSION · BORDERLINE ${Math.round(match.score*100)}% ACCEPTED`);
    if(activeSession&&sessionValid&&!candidateQuality.strong)return establish(activeSession.name,activeSession.score,'session','CONTINUOUS IDENTITY SESSION · SHORT COMMAND ACCEPTED');
    if(enrolledFace&&!candidateQuality.strong)return establish(enrolledFace.name,Math.max(.55,face?.confidence??.55),'multimodal',`LIVE FACE + ROLLING VOICE · ${candidateQuality.detail}`);
    speakerTrustRef.current=null;verifiedSpeakerRef.current=null;setSpeakerTrustSource('none');
    if(!candidate){setSpeakerStatus('noise');setEnrollmentStatus(`IDENTITY INDETERMINATE · ${directQuality.detail} · command held for safety`);setToolEvents((current)=>[{name:'speaker_identity',status:'blocked' as const,summary:'Voice capture was indeterminate and no current Robbie identity session was available.',at:new Date().toISOString()},...current].slice(0,12));}
    else{setSpeakerStatus('rejected');const summary=match.reason==='reenrollment-required'?'Legacy voice profile requires neural re-enrollment.':`Unknown speaker rejected (${Math.round(match.score*100)}% / ${Math.round(match.threshold*100)}% required).`;setEnrollmentStatus(summary.toUpperCase());setToolEvents((current)=>[{name:'speaker_identity',status:'blocked' as const,summary,at:new Date().toISOString()},...current].slice(0,12));}
    return match;
  };

  useEffect(()=>{
    if(!settings?.startMicrophoneOn||!settings.hasOpenAIKey||!startupGreetingComplete||settingsOpen){setRealtimeVoice('off');return;}
    if(settings.syncEnabled&&syncStatus&&!syncStatus.voiceOwnedHere){setRealtimeVoice('off');return;}
    let disposed=false,stream:MediaStream|null=null,peer:RTCPeerConnection|null=null,monitor:VoicePrintMonitor|null=null;
    const connect=async()=>{try{
      setRealtimeVoice('connecting');stream=await openMicrophone();if(disposed)return;
      monitor=await createVoicePrintMonitor(stream);realtimeSpeakerMonitor.current=monitor;
      peer=new RTCPeerConnection();for(const track of stream.getTracks())peer.addTrack(track,stream);
      const events=peer.createDataChannel('oai-events');let speechAt=0;
      events.onmessage=(message)=>{let event:Record<string,unknown>;try{event=JSON.parse(String(message.data)) as Record<string,unknown>;}catch{return;}const type=String(event.type||'');
        if(type==='input_audio_buffer.speech_started'){if(enrollingSpeakerRef.current)return;speechAt=performance.now();realtimeVoicePrint.current=null;monitor?.begin();setSpeakerStatus('listening');void window.axiom.reportDeviceActivity().then(setSyncStatus).catch(()=>{});dispatch({type:'mode',mode:protectedVoiceMode(speechTurn.current.active,'listening')});}
        if(type==='input_audio_buffer.speech_stopped')realtimeVoicePrint.current=monitor?.finish()??null;
        if(type==='conversation.item.input_audio_transcription.completed'){if(enrollingSpeakerRef.current)return;const transcript=String(event.transcript||'').trim();if(!transcript)return;void(async()=>{const pending=realtimeVoicePrint.current??monitor?.finish()??Promise.resolve(null);realtimeVoicePrint.current=null;const match=await verifySpeaker(await pending);if(!match.accepted){dispatch({type:'mode',mode:protectedVoiceMode(speechTurn.current.active,'idle')});if(!speechTurn.current.active)dispatch({type:'energy',energy:.2});return;}if(speechTurn.current.active)cancelSpeechTurn();const sttMs=speechAt?Math.round(performance.now()-speechAt):0;pendingSttMs.current=sttMs;await realtimeSendHandler.current(transcript);})();}
        if(type==='error')console.warn('Realtime voice event',event);
      };
      peer.onconnectionstatechange=()=>{if(disposed||!peer)return;const state=peer.connectionState;console.info('Realtime voice connection',state);if(state==='connected'){realtimeRetryAttempts.current=0;setRealtimeVoice('ready');}else if(state==='failed'||state==='disconnected'||state==='closed')setRealtimeVoice('fault');};
      const offer=await peer.createOffer();await peer.setLocalDescription(offer);const answer=await window.axiom.openRealtimeTranscription(offer.sdp||'');if(disposed)return;await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});
    }catch(reason){if(!disposed){console.warn('Realtime transcription fast lane unavailable; using buffered fallback.',reason);setRealtimeVoice('fault');}void monitor?.dispose();stream?.getTracks().forEach((track)=>track.stop());peer?.close();}};
    void connect();return()=>{disposed=true;realtimeSpeakerMonitor.current=null;void monitor?.dispose();stream?.getTracks().forEach((track)=>track.stop());peer?.close();};
  },[settings?.startMicrophoneOn,settings?.hasOpenAIKey,settings?.preferredMicrophoneId,settings?.syncEnabled,settings?.speakerProfiles?.length,syncStatus?.voiceOwnedHere,startupGreetingComplete,settingsOpen,speakerLockEnabled,realtimeRetryToken]);

  // Backoff, not an immediate retry: a fault is often a real, momentary
  // network drop, and hammering it immediately just fights the buffered
  // fallback for the microphone during the same window. Capped at 3
  // minutes; resets to the first (20s) step as soon as a connection
  // actually holds (see the 'connected' branch above).
  useEffect(()=>{
    if(realtimeVoice!=='fault')return;
    const attempt=realtimeRetryAttempts.current;realtimeRetryAttempts.current=attempt+1;
    const delay=Math.min(180_000,20_000*2**Math.min(attempt,4));
    const timer=window.setTimeout(()=>setRealtimeRetryToken((value)=>value+1),delay);
    return()=>window.clearTimeout(timer);
  },[realtimeVoice]);

  // Ring's live view is native WebRTC too, but unlike the realtime-voice
  // connection above it is receive-only (no local mic/camera track to add)
  // and user-triggered rather than always-on, so it is one imperative
  // function instead of a settings-driven effect. Multiple cameras can be
  // open at once — each keeps its own peer connection, IPC session, and
  // retry schedule, keyed by camera.id throughout.
  // Materialize/de-rez particle burst — a shared full-screen canvas rather
  // than one per panel, since only one or two bursts ever run at once and
  // a single canvas avoids stacking-context/z-index fights with the panels
  // themselves. 'in' converges scattered motes onto the panel's edges;
  // 'out' does the reverse. Reduced motion just skips the burst entirely —
  // the panel's own opacity/clip-path transitions still convey open/close.
  const ringParticleBurst=(rect:{left:number;top:number;width:number;height:number},mode:'in'|'out')=>{
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const canvas=ringParticleCanvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    // The canvas is position:fixed, but .stage sets `contain:layout paint
    // style` (see commandCenter.css — the layered-CSS lesson from the
    // composer bug applies here too), which makes .stage the containing
    // block for fixed descendants instead of the real viewport. Rather
    // than fight that, measure the canvas's OWN actual on-screen box and
    // draw relative to it — correct whether it ends up viewport-fixed or
    // stage-contained, since getBoundingClientRect always reports real
    // screen position either way.
    const canvasRect=canvas.getBoundingClientRect();
    if(canvas.width!==canvasRect.width||canvas.height!==canvasRect.height){canvas.width=canvasRect.width;canvas.height=canvasRect.height;}
    const originX=rect.left-canvasRect.left,originY=rect.top-canvasRect.top;
    // Panels are circles now — scatter from the circumference, not
    // rectangle edges.
    const cx=originX+rect.width/2,cy=originY+rect.height/2,rx=rect.width/2,ry=rect.height/2;
    const particles=Array.from({length:140},()=>{
      const edgeAngle=Math.random()*Math.PI*2;
      const ex=cx+Math.cos(edgeAngle)*rx,ey=cy+Math.sin(edgeAngle)*ry;
      const angle=Math.random()*Math.PI*2,dist=140+Math.random()*260;
      const sx=ex+Math.cos(angle)*dist,sy=ey+Math.sin(angle)*dist;
      const size=1.1+Math.random()*2.2,hot=Math.random()<0.22;
      return mode==='in'?{x:sx,y:sy,tx:ex,ty:ey,size,hot}:{x:ex,y:ey,tx:sx,ty:sy,size,hot};
    });
    const duration=850,started=performance.now();
    const frame=(now:number)=>{
      const t=Math.min(1,(now-started)/duration);
      const eased=mode==='in'?1-(1-t)**3:t*t*(3-2*t);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      for(const particle of particles){
        const x=particle.x+(particle.tx-particle.x)*eased,y=particle.y+(particle.ty-particle.y)*eased;
        const alpha=mode==='in'?Math.min(1,t*2.4)*(1-Math.max(0,t-0.65)/0.35):1-t;
        const clamped=Math.max(0,alpha);
        const color=particle.hot?'234,254,255':'70,232,255';
        ctx.beginPath();ctx.fillStyle=`rgba(${color},${clamped*0.95})`;ctx.shadowColor=`rgba(${color},1)`;ctx.shadowBlur=particle.hot?14:9;ctx.arc(x,y,particle.size,0,Math.PI*2);ctx.fill();
      }
      if(t<1)requestAnimationFrame(frame);else ctx.clearRect(0,0,canvas.width,canvas.height);
    };
    requestAnimationFrame(frame);
  };
  // Draws (or redraws) the neural-link bundle from the skull's anchor
  // point out to a live panel — a primary strand, two thinner secondary
  // strands with jittered curvature, a couple of short unconnected
  // "dendrite" stubs near the skull for organic texture, and pulsing
  // synapse nodes along the primary strand, rather than one clean bezier.
  // Called on open, on expand/collapse, and on window resize, since the
  // panel's on-screen position changes each time.
  const ringConnectorSvgRef=useRef<SVGSVGElement|null>(null);
  const ringConnectorSeed=(cameraId:number)=>{let s=cameraId*97+13;return()=>{s=(s*9301+49297)%233280;return s/233280;};};
  // Full (re)build — creates every strand/tendril/synapse fresh, each
  // fading in from 0. Called ONCE per connection (open, or an expand/
  // collapse toggle where a discrete re-jitter is fine). Must never run
  // on every animation frame — recreating elements every frame would
  // restart each one's fade-in before it ever finishes, so the bundle
  // would flicker at near-zero opacity for the whole tracking window
  // instead of settling. Continuous repositioning during a transition
  // uses repositionRingConnector below instead, which only updates the
  // existing elements' coordinates.
  const buildRingConnector=(cameraId:number,withPulse=false)=>{
    const svg=ringConnectorSvgRef.current,anchor=ringSkullAnchorRef.current,stage=ringStageRef.current,panel=ringPanelElsRef.current.get(cameraId);
    svg?.querySelectorAll(`[data-owner="ring-${cameraId}"]`).forEach((node)=>node.remove());
    if(!svg||!anchor||!stage||!panel)return;
    const stageRect=stage.getBoundingClientRect(),anchorRect=anchor.getBoundingClientRect(),panelRect=panel.getBoundingClientRect();
    const ax=anchorRect.left-stageRect.left,ay=anchorRect.top-stageRect.top;
    const px=panelRect.left-stageRect.left,py=panelRect.top+panelRect.height/2-stageRect.top;
    const rnd=ringConnectorSeed(cameraId);
    const strandDefs=[{cls:'primary',jitter:0},{cls:'secondary',jitter:-22},{cls:'secondary',jitter:26}];
    const strands=strandDefs.map((def)=>{
      const midX=(ax+px)/2+(rnd()-0.5)*30;
      const midY1=ay+def.jitter*0.6+(rnd()-0.5)*14,midY2=py+def.jitter*0.4+(rnd()-0.5)*14;
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('class',`ring-strand ${def.cls}`);path.setAttribute('data-owner',`ring-${cameraId}`);
      path.setAttribute('d',`M ${ax} ${ay} C ${midX} ${midY1}, ${midX} ${midY2}, ${px} ${py}`);
      path.style.opacity='0';svg.appendChild(path);
      return path;
    });
    requestAnimationFrame(()=>{for(const strand of strands)strand.style.opacity='1';});
    for(let i=0;i<2;i++){
      const angle=rnd()*Math.PI*2,len=14+rnd()*16,sx2=ax+Math.cos(angle)*len,sy2=ay+Math.sin(angle)*len;
      const stub=document.createElementNS('http://www.w3.org/2000/svg','path');
      stub.setAttribute('class','ring-strand tendril');stub.setAttribute('data-owner',`ring-${cameraId}`);
      stub.setAttribute('d',`M ${ax} ${ay} Q ${ax+(sx2-ax)*0.5+(rnd()-0.5)*10} ${ay+(sy2-ay)*0.5+(rnd()-0.5)*10}, ${sx2} ${sy2}`);
      stub.style.opacity='0';svg.appendChild(stub);
      requestAnimationFrame(()=>{stub.style.opacity='1';});
    }
    const primary=strands[0],total=primary.getTotalLength();
    for(const frac of [0.32,0.68]){
      const point=primary.getPointAtLength(total*frac);
      const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('class','ring-synapse');dot.setAttribute('data-owner',`ring-${cameraId}`);
      dot.setAttribute('cx',String(point.x));dot.setAttribute('cy',String(point.y));dot.setAttribute('r','1.6');
      svg.appendChild(dot);
    }
    if(withPulse){
      const bead=document.createElementNS('http://www.w3.org/2000/svg','circle');
      bead.setAttribute('class','ring-pulse-bead');bead.setAttribute('data-owner',`ring-${cameraId}`);bead.setAttribute('r','3');
      svg.appendChild(bead);
      const started=performance.now(),duration=550;
      const pulseFrame=(now:number)=>{
        const t=Math.min(1,(now-started)/duration),point=primary.getPointAtLength(t*total);
        bead.setAttribute('cx',String(point.x));bead.setAttribute('cy',String(point.y));
        bead.style.opacity=t>0.92?String((1-t)/0.08):'1';
        if(t<1)requestAnimationFrame(pulseFrame);else bead.remove();
      };
      requestAnimationFrame(pulseFrame);
    }
  };
  const removeRingConnector=(cameraId:number)=>{
    const svg=ringConnectorSvgRef.current;
    svg?.querySelectorAll(`[data-owner="ring-${cameraId}"]`).forEach((node)=>{(node as SVGElement).style.opacity='0';window.setTimeout(()=>node.remove(),400);});
  };
  // Lightweight follow — updates the already-built strands'/synapses'
  // coordinates in place (same deterministic per-camera jitter, since the
  // seed only depends on cameraId) without touching opacity or recreating
  // any element. Safe to call every animation frame.
  const repositionRingConnector=(cameraId:number)=>{
    const svg=ringConnectorSvgRef.current,anchor=ringSkullAnchorRef.current,stage=ringStageRef.current,panel=ringPanelElsRef.current.get(cameraId);
    if(!svg||!anchor||!stage||!panel)return;
    const strands=svg.querySelectorAll<SVGPathElement>(`path.ring-strand.primary[data-owner="ring-${cameraId}"],path.ring-strand.secondary[data-owner="ring-${cameraId}"]`);
    if(!strands.length)return;
    const stageRect=stage.getBoundingClientRect(),anchorRect=anchor.getBoundingClientRect(),panelRect=panel.getBoundingClientRect();
    const ax=anchorRect.left-stageRect.left,ay=anchorRect.top-stageRect.top;
    const px=panelRect.left-stageRect.left,py=panelRect.top+panelRect.height/2-stageRect.top;
    const rnd=ringConnectorSeed(cameraId);
    const jitters=[0,-22,26];
    strands.forEach((strand,index)=>{
      const jitter=jitters[index]??0;
      const midX=(ax+px)/2+(rnd()-0.5)*30;
      const midY1=ay+jitter*0.6+(rnd()-0.5)*14,midY2=py+jitter*0.4+(rnd()-0.5)*14;
      strand.setAttribute('d',`M ${ax} ${ay} C ${midX} ${midY1}, ${midX} ${midY2}, ${px} ${py}`);
    });
    const primary=strands[0],total=primary.getTotalLength();
    const synapses=svg.querySelectorAll<SVGCircleElement>(`circle.ring-synapse[data-owner="ring-${cameraId}"]`);
    [0.32,0.68].forEach((frac,index)=>{
      const dot=synapses[index];if(!dot)return;
      const point=primary.getPointAtLength(total*frac);
      dot.setAttribute('cx',String(point.x));dot.setAttribute('cy',String(point.y));
    });
  };
  // The panel's own position/size change (materialize, expand, collapse)
  // is a CSS transition, not a one-shot jump — repositioning once at the
  // start would just point at where the panel USED to be. Track it for
  // the transition's duration instead.
  const trackRingConnector=(cameraId:number,durationMs=500)=>{
    const start=performance.now();
    const step=(now:number)=>{repositionRingConnector(cameraId);if(now-start<durationMs)requestAnimationFrame(step);};
    requestAnimationFrame(step);
  };
  useEffect(()=>{
    const redraw=()=>{for(const cameraId of ringViewsRef.current.keys())repositionRingConnector(cameraId);};
    window.addEventListener('resize',redraw);
    return()=>window.removeEventListener('resize',redraw);
  },[]);
  // Opening or closing any camera reflows every OTHER open camera's row
  // (the layout divides available space by the current count) — their
  // connectors need to follow that shift too, not just the one being
  // opened or closed.
  const ringViewCountRef=useRef(0);
  useEffect(()=>{
    if(ringViews.size===ringViewCountRef.current)return;
    ringViewCountRef.current=ringViews.size;
    for(const cameraId of ringViews.keys())trackRingConnector(cameraId,550);
  },[ringViews.size]);

  // Reports godsEyeContentRef's real on-screen box to the main process so
  // its native WebContentsView (drawn behind/over this exact rect, not a
  // DOM child) lines up with the placeholder. Only needed while a panel is
  // actually up — a closed panel has nothing to align.
  useEffect(()=>{
    if(godsEye.phase==='closed')return;
    const report=()=>{
      const el=godsEyeContentRef.current;if(!el)return;
      const rect=el.getBoundingClientRect();
      void window.axiom.setGodsEyeViewBounds({x:rect.left,y:rect.top,width:rect.width,height:rect.height}).catch(()=>{});
    };
    report();
    const observer=new ResizeObserver(report);
    if(godsEyeContentRef.current)observer.observe(godsEyeContentRef.current);
    window.addEventListener('resize',report);
    return()=>{observer.disconnect();window.removeEventListener('resize',report);};
  },[godsEye.phase]);
  const openGodsEye=async()=>{
    if(godsEyePhaseRef.current!=='closed')return;
    setGodsEye({phase:'materializing',status:'loading',error:''});
    requestAnimationFrame(()=>{const el=godsEyePanelRef.current;if(el)ringParticleBurst(el.getBoundingClientRect(),'in');});
    try{
      const result=await window.axiom.openGodsEyeView();
      if(!result.ready){setGodsEye({phase:'materializing',status:'error',error:result.error||"God's Eye View could not be started."});return;}
      setGodsEye({phase:'live',status:'ready',error:''});
    }catch(reason){
      setGodsEye({phase:'materializing',status:'error',error:reason instanceof Error?reason.message:String(reason)});
    }
  };
  const closeGodsEye=()=>{
    if(godsEyePhaseRef.current==='closed')return;
    const el=godsEyePanelRef.current;if(el)ringParticleBurst(el.getBoundingClientRect(),'out');
    setGodsEye((current)=>({...current,phase:'derezzing'}));
    void window.axiom.closeGodsEyeView().catch(()=>{});
    window.setTimeout(()=>setGodsEye({phase:'closed',status:'loading',error:''}),500);
  };
  const updateRingView=(cameraId:number,patch:Partial<RingViewState>)=>{
    setRingViews((current)=>{
      const existing=current.get(cameraId);if(!existing)return current;
      const next=new Map(current);next.set(cameraId,{...existing,...patch});return next;
    });
  };
  const scheduleRingRetry=(camera:RingCamera)=>{
    const existingTimer=ringRetryTimersRef.current.get(camera.id);if(existingTimer)window.clearTimeout(existingTimer);
    const attempt=ringRetryAttemptsRef.current.get(camera.id)??0;ringRetryAttemptsRef.current.set(camera.id,attempt+1);
    const delay=Math.min(180_000,20_000*2**Math.min(attempt,4));
    const timer=window.setTimeout(()=>{
      ringRetryTimersRef.current.delete(camera.id);
      if(ringViewsRef.current.get(camera.id)?.connectionState==='fault')void openRingLiveView(camera);
    },delay);
    ringRetryTimersRef.current.set(camera.id,timer);
  };
  const openRingLiveView=async(camera:RingCamera)=>{
    const cameraId=camera.id;
    // Reconnecting the SAME camera (a retry, or the user re-asking for a
    // camera that's already open) closes only that camera's existing
    // session — other cameras already open are never touched.
    const previousLiveSessionId=ringSessionIdsRef.current.get(cameraId);
    ringPeersRef.current.get(cameraId)?.close();ringSessionIdsRef.current.delete(cameraId);ringPendingIceRef.current.set(cameraId,[]);
    ringEventUnsubscribeRef.current.get(cameraId)?.();ringEventUnsubscribeRef.current.delete(cameraId);
    if(previousLiveSessionId)void window.axiom.closeRingLiveView(previousLiveSessionId).catch(()=>{});
    const timer=ringRetryTimersRef.current.get(cameraId);if(timer){window.clearTimeout(timer);ringRetryTimersRef.current.delete(cameraId);}
    // A retry/reconnect of an ALREADY-open camera keeps its current
    // materializePhase (no reason to replay the particle-burst open
    // animation every time a flaky connection retries) — only a genuinely
    // new camera starts in 'materializing'.
    const isNewOpen=!ringViewsRef.current.has(cameraId);
    setRingViews((current)=>{const next=new Map(current);const existingPhase=current.get(cameraId)?.materializePhase;next.set(cameraId,{camera,connectionState:'connecting',faultReason:'',muted:current.size>0,talking:false,talkError:'',materializePhase:existingPhase??'materializing'});return next;});
    if(isNewOpen){
      requestAnimationFrame(()=>{
        const panel=ringPanelElsRef.current.get(cameraId);
        if(panel)ringParticleBurst(panel.getBoundingClientRect(),'in');
        buildRingConnector(cameraId,true);
        trackRingConnector(cameraId,1400);
      });
      // Matches the full CSS sequence (ring sketch -> frame unfold ->
      // power flash -> tick snap -> scan-sweep, the last to finish at
      // ~1.72s) — switching to 'live' any earlier would cut an animation
      // off mid-flight, since the .materializing selector drives all of
      // them.
      const materializeTimer=window.setTimeout(()=>{updateRingView(cameraId,{materializePhase:'live'});ringMaterializeTimersRef.current.delete(cameraId);},1800);
      ringMaterializeTimersRef.current.set(cameraId,materializeTimer);
    }
    try{
      // Without a STUN server the offer can only contain local host
      // candidates — fine on a LAN, but Ring's media relay needs a
      // publicly-reachable (server-reflexive) candidate to reach a client
      // behind home NAT, which is the normal case here.
      const peer=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:global.stun.twilio.com:3478']}]});ringPeersRef.current.set(cameraId,peer);
      peer.addTransceiver('video',{direction:'recvonly'});
      // sendrecv (not recvonly) so a real microphone track can be attached
      // later via replaceTrack() for two-way talk — no SDP renegotiation is
      // needed when the track is swapped in after the fact. The sender
      // starts with no track and sends nothing until the user first
      // presses the talk button (see startRingTalk).
      const audioTransceiver=peer.addTransceiver('audio',{direction:'sendrecv'});
      ringAudioSendersRef.current.set(cameraId,audioTransceiver.sender);
      peer.ontrack=(event)=>{if(event.track.kind==='video'){const el=ringVideoElsRef.current.get(cameraId);if(el)el.srcObject=event.streams[0]??null;}};
      peer.onconnectionstatechange=()=>{
        if(ringPeersRef.current.get(cameraId)!==peer)return;const state=peer.connectionState;
        if(state==='connected'){ringRetryAttemptsRef.current.set(cameraId,0);updateRingView(cameraId,{connectionState:'ready',faultReason:''});}
        else if(state==='failed'||state==='disconnected'||state==='closed'){
          // No exception is thrown on this path — a NAT/firewall/ICE failure
          // reaches here silently, so this is the only place that failure is
          // ever surfaced at all.
          const reason=`WebRTC connection ${state} (ICE: ${peer.iceConnectionState}). This is usually a network/NAT/firewall issue reaching Ring's media servers, not an Axiom or account problem.`;
          console.warn('Ring live view connection dropped.',{camera:camera.name,connectionState:state,iceConnectionState:peer.iceConnectionState,iceGatheringState:peer.iceGatheringState});
          updateRingView(cameraId,{connectionState:'fault',faultReason:reason});scheduleRingRetry(camera);
        }
      };
      // Ring's signaling is real trickle ICE (both directions) relayed
      // through a main-process WebSocket — send each local candidate as
      // it's discovered instead of waiting for gathering to finish.
      // Candidates can fire before the open() IPC round trip resolves and
      // ringSessionIdsRef is set; those are queued and flushed once it is.
      peer.onicecandidate=(event)=>{
        if(!event.candidate)return;
        const liveSessionId=ringSessionIdsRef.current.get(cameraId);
        if(liveSessionId)void window.axiom.sendRingIceCandidate(liveSessionId,event.candidate.candidate,event.candidate.sdpMLineIndex??0);
        else{const pending=ringPendingIceRef.current.get(cameraId)||[];pending.push(event.candidate);ringPendingIceRef.current.set(cameraId,pending);}
      };
      const unsubscribe=window.axiom.onRingLiveViewEvent((liveEvent)=>{
        if(ringPeersRef.current.get(cameraId)!==peer||liveEvent.liveSessionId!==ringSessionIdsRef.current.get(cameraId))return;
        if(liveEvent.type==='answer'){
          peer.setRemoteDescription({type:'answer',sdp:liveEvent.sdp}).catch((reason)=>{
            console.warn('Ring SDP answer was rejected.',reason);
            const detail=reason instanceof Error?reason.message:String(reason);
            updateRingView(cameraId,{connectionState:'fault',faultReason:detail});scheduleRingRetry(camera);
          });
        }else if(liveEvent.type==='ice'){
          peer.addIceCandidate({candidate:liveEvent.candidate,sdpMLineIndex:liveEvent.sdpMLineIndex}).catch((reason)=>console.warn('Ring ICE candidate was rejected.',reason));
        }else if(liveEvent.type==='fault'){
          updateRingView(cameraId,{connectionState:'fault',faultReason:liveEvent.reason});scheduleRingRetry(camera);
        }
        // 'closed' → no-op; expected end of a renderer-initiated close.
      });
      ringEventUnsubscribeRef.current.set(cameraId,unsubscribe);
      const offer=await peer.createOffer();await peer.setLocalDescription(offer);
      if(ringPeersRef.current.get(cameraId)!==peer)return;
      const {liveSessionId}=await window.axiom.openRingLiveView(cameraId,peer.localDescription?.sdp||offer.sdp||'');
      if(ringPeersRef.current.get(cameraId)!==peer){void window.axiom.closeRingLiveView(liveSessionId).catch(()=>{});return;}
      ringSessionIdsRef.current.set(cameraId,liveSessionId);
      const queued=ringPendingIceRef.current.get(cameraId)||[];ringPendingIceRef.current.set(cameraId,[]);
      for(const candidate of queued)void window.axiom.sendRingIceCandidate(liveSessionId,candidate.candidate,candidate.sdpMLineIndex??0);
    }catch(reason){
      const detail=reason instanceof Error?reason.message:String(reason);
      console.warn('Ring live view failed to connect.',reason);
      updateRingView(cameraId,{connectionState:'fault',faultReason:detail});scheduleRingRetry(camera);
    }
  };
  const closeRingLiveView=(cameraId:number)=>{
    // The underlying session/peer/mic tear down immediately, same as
    // before — only the VISUAL removal waits for the de-rez animation
    // (particle burst-out + the panel's own dissolve transition) to
    // finish, so closing a camera looks intentional instead of an abrupt
    // disappearance.
    const materializeTimer=ringMaterializeTimersRef.current.get(cameraId);if(materializeTimer){window.clearTimeout(materializeTimer);ringMaterializeTimersRef.current.delete(cameraId);}
    const panel=ringPanelElsRef.current.get(cameraId);
    if(panel&&ringViewsRef.current.has(cameraId)){
      ringParticleBurst(panel.getBoundingClientRect(),'out');
      updateRingView(cameraId,{materializePhase:'derezzing'});
      window.setTimeout(()=>{
        setRingViews((current)=>{if(!current.has(cameraId))return current;const next=new Map(current);next.delete(cameraId);return next;});
        removeRingConnector(cameraId);
      },480);
    }else{
      setRingViews((current)=>{if(!current.has(cameraId))return current;const next=new Map(current);next.delete(cameraId);return next;});
      removeRingConnector(cameraId);
    }
    setExpandedRingCameraId((current)=>current===cameraId?null:current);
    const retryTimer=ringRetryTimersRef.current.get(cameraId);if(retryTimer){window.clearTimeout(retryTimer);ringRetryTimersRef.current.delete(cameraId);}
    ringEventUnsubscribeRef.current.get(cameraId)?.();ringEventUnsubscribeRef.current.delete(cameraId);
    const liveSessionId=ringSessionIdsRef.current.get(cameraId);ringSessionIdsRef.current.delete(cameraId);ringPendingIceRef.current.delete(cameraId);
    const peer=ringPeersRef.current.get(cameraId);ringPeersRef.current.delete(cameraId);peer?.close();
    ringAudioSendersRef.current.delete(cameraId);
    ringMicStreamsRef.current.get(cameraId)?.getTracks().forEach((track)=>track.stop());ringMicStreamsRef.current.delete(cameraId);
    if(liveSessionId)void window.axiom.closeRingLiveView(liveSessionId).catch(()=>{});
  };
  // Push-to-talk: lazily captures (and caches) a microphone stream on
  // first press per camera, then just toggles the cached track's enabled
  // flag on subsequent presses/releases — no repeat permission prompt, no
  // SDP renegotiation (replaceTrack swaps the sender's outgoing track
  // in-place, which is exactly what it's designed for).
  const startRingTalk=async(cameraId:number)=>{
    const sender=ringAudioSendersRef.current.get(cameraId);if(!sender)return;
    try{
      let stream=ringMicStreamsRef.current.get(cameraId);
      if(!stream){
        stream=await openMicrophone();
        ringMicStreamsRef.current.set(cameraId,stream);
        await sender.replaceTrack(stream.getAudioTracks()[0]??null);
      }
      const track=stream.getAudioTracks()[0];if(track)track.enabled=true;
      updateRingView(cameraId,{talking:true,talkError:''});
    }catch(reason){
      const detail=reason instanceof Error?reason.message:String(reason);
      updateRingView(cameraId,{talking:false,talkError:`Microphone unavailable: ${detail}`});
    }
  };
  const stopRingTalk=(cameraId:number)=>{
    const track=ringMicStreamsRef.current.get(cameraId)?.getAudioTracks()[0];if(track)track.enabled=false;
    updateRingView(cameraId,{talking:false});
  };
  const toggleRingMuted=(cameraId:number)=>{
    const view=ringViewsRef.current.get(cameraId);if(!view)return;
    updateRingView(cameraId,{muted:!view.muted});
  };
  // Ring's live-view sessions must always be explicitly closed, unlike the
  // OpenAI realtime pattern which has no server-side session to release —
  // an unmount while any views happen to be open must not leak the
  // main-process WebSocket + ping timer for each of them indefinitely.
  useEffect(()=>()=>{
    for(const timer of ringRetryTimersRef.current.values())window.clearTimeout(timer);
    for(const timer of ringMaterializeTimersRef.current.values())window.clearTimeout(timer);
    for(const unsubscribe of ringEventUnsubscribeRef.current.values())unsubscribe();
    for(const peer of ringPeersRef.current.values())peer.close();
    for(const liveSessionId of ringSessionIdsRef.current.values())void window.axiom.closeRingLiveView(liveSessionId).catch(()=>{});
    for(const stream of ringMicStreamsRef.current.values())stream.getTracks().forEach((track)=>track.stop());
  },[]);

  const send = (event: FormEvent) => { event.preventDefault(); void sendText(input); };

  // A quick composer-side switch for the always-listening realtime pipeline
  // (settings.startMicrophoneOn), distinct from the one-shot push-to-talk
  // voice-button below and from the same setting's checkbox buried in
  // Settings — flips it immediately, no modal, no Save step.
  const toggleHandsFree = async () => {
    if (!settings) return;
    try {
      const next = await window.axiom.saveSettings({ provider: settings.provider, model: settings.model, codingWorkspace: settings.codingWorkspace, startMicrophoneOn: !settings.startMicrophoneOn });
      setSettings(next); setStartMicrophoneOn(next.startMicrophoneOn);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const toggleVoice = async (listenThroughSpeech=false) => {
    if (recording) { recorderRef.current?.stop(); return; }
    try {
      if(!listenThroughSpeech)cancelSpeechTurn(); setError('');discardVoiceCapture.current=false;
      const stream = await openMicrophone();
      recordingStream.current = stream; audioChunks.current = [];
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined); recorderRef.current = recorder;
      const context=new AudioContext(),source=context.createMediaStreamSource(stream),analyser=context.createAnalyser(),samples=new Uint8Array(2048),detector=new VoiceActivityDetector({noiseFloor:settings?.microphoneNoiseFloor,speechThreshold:settings?.microphoneSpeechThreshold}),voicePrintMonitor=await createVoicePrintMonitor(stream);let animation=0;
      analyser.fftSize=2048;analyser.smoothingTimeConstant=.08;source.connect(analyser);voicePrintMonitor.begin();
      // MediaRecorder's first WebM/Opus chunk carries the EBML/container header.
      // Dropping it while maintaining a rolling "pre-roll" produces a corrupt
      // recording on both Electron/Windows and Electron/macOS. Recordings are
      // already bounded by VoiceActivityDetector, so retain the complete stream
      // and discard the whole capture later when no speech was detected.
      recorder.ondataavailable = (event) => { if(event.data.size)audioChunks.current.push(event.data); };
      const monitor=()=>{if(recorder.state!=='recording')return;analyser.getByteTimeDomainData(samples);const level=audioRms(samples),activity=detector.process(level,performance.now());if(activity==='speech-start'){setSpeakerStatus('listening');void window.axiom.reportDeviceActivity().then(setSyncStatus).catch(()=>{});dispatch({type:'mode',mode:protectedVoiceMode(speechTurn.current.active,'listening')});}if(!speechTurn.current.active)dispatch({type:'energy',energy:Math.min(1,.32+level*4.5)});if((activity==='speech-end'||activity==='max-duration')&&recorder.state==='recording'){recorder.stop();return;}animation=requestAnimationFrame(monitor);};
      recorder.onstop = async () => {
        cancelAnimationFrame(animation);source.disconnect();void context.close();setRecording(false); recordingStream.current?.getTracks().forEach((track) => track.stop()); recordingStream.current = null;recorderRef.current=null;
        const discard=discardVoiceCapture.current||!detector.heardSpeech||!audioChunks.current.length;discardVoiceCapture.current=false;
        if(discard){void voicePrintMonitor.dispose();setVoiceProcessing(false);dispatch({type:'mode',mode:protectedVoiceMode(speechTurn.current.active,'idle')});if(!speechTurn.current.active)dispatch({type:'energy',energy:.2});return;}
        setVoiceProcessing(true);
        try {
          let print:VoicePrint|null=null;try{print=await voicePrintMonitor.finish();}finally{await voicePrintMonitor.dispose();}const match=await verifySpeaker(print);if(!match.accepted){dispatch({type:'mode',mode:protectedVoiceMode(speechTurn.current.active,'idle')});if(!speechTurn.current.active)dispatch({type:'energy',energy:.2});return;}if(speechTurn.current.active)cancelSpeechTurn();
          dispatch({ type: 'mode', mode: 'thinking' }); dispatch({ type: 'energy', energy: .72 });
          const blob = new Blob(audioChunks.current, { type: recorder.mimeType || 'audio/webm' });
          const transcriptionStarted=performance.now();const result = await window.axiom.transcribeAudio({ audio: await blob.arrayBuffer(), mimeType: blob.type });const sttMs=Math.round(performance.now()-transcriptionStarted);pendingSttMs.current=sttMs;
          if(!result.text.trim()){dispatch({type:'mode',mode:'idle'});dispatch({type:'energy',energy:.2});return;}
          setInput(result.text); await sendText(result.text,undefined,'voice');
        } catch (reason) {
          const detail=reason instanceof Error?reason.message:String(reason);
          setError(`Voice input failed: ${detail.replace(/^Error invoking remote method '[^']+':\s*/i,'')}`);
          dispatch({ type: 'mode', mode: 'error' });
        }
        finally{setVoiceProcessing(false);}
      };
      recorder.start(120);setRecording(true);if(!listenThroughSpeech){dispatch({ type: 'mode', mode: 'listening' }); dispatch({ type: 'energy', energy: .5 });}animation=requestAnimationFrame(monitor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); dispatch({ type: 'mode', mode: 'error' }); }
  };

  useEffect(()=>{
    if(!settings?.startMicrophoneOn){if(recording&&recorderRef.current?.state==='recording'){discardVoiceCapture.current=true;recorderRef.current.stop();}return;}
    // Realtime is the primary path. The buffered recorder is a deliberate
    // fallback only after the WebRTC connection has actually failed; this
    // avoids both microphones racing during session negotiation.
    if(realtimeVoice!=='fault')return;
    if(settings.syncEnabled&&syncStatus&&!syncStatus.voiceOwnedHere){if(recording&&recorderRef.current?.state==='recording'){discardVoiceCapture.current=true;recorderRef.current.stop();}return;}
    if(!settings.hasOpenAIKey||!startupGreetingComplete||recording||voiceProcessing||busy||settingsOpen||speechTurn.current.active||speakerStatus==='enrolling')return;
    const cooldown=Math.max(0,1200-(performance.now()-lastSpeechEndedAt.current));
    const timer=window.setTimeout(()=>{if(!recorderRef.current&&!speechTurn.current.active)void toggleVoice();},Math.max(240,cooldown));
    return()=>window.clearTimeout(timer);
  },[settings?.startMicrophoneOn,settings?.hasOpenAIKey,settings?.syncEnabled,syncStatus?.voiceOwnedHere,startupGreetingComplete,recording,voiceProcessing,busy,settingsOpen,visual.mode,realtimeVoice,speakerStatus]);

  // Full-duplex barge-in: echo-cancelled monitoring continues while Axiom
  // speaks. VoiceActivityDetector only stops playback after sustained human
  // speech, then the same capture flows through normal transcription.
  useEffect(()=>{
    if(realtimeVoice!=='fault'||visual.mode!=='speaking'||!settings?.startMicrophoneOn||recording||settingsOpen||!settings.hasOpenAIKey)return;
    if(settings.syncEnabled&&syncStatus&&!syncStatus.voiceOwnedHere)return;
    const timer=window.setTimeout(()=>{if(speechTurn.current.active&&!recorderRef.current)void toggleVoice(true);},180);
    return()=>window.clearTimeout(timer);
  },[visual.mode,settings?.startMicrophoneOn,settings?.hasOpenAIKey,settings?.syncEnabled,syncStatus?.voiceOwnedHere,recording,settingsOpen,realtimeVoice]);

  useEffect(()=>()=>{discardVoiceCapture.current=true;if(recorderRef.current?.state==='recording')recorderRef.current.stop();recordingStream.current?.getTracks().forEach((track)=>track.stop());},[]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if(event.key==='Escape'&&recording&&recorderRef.current?.state==='recording'){event.preventDefault();discardVoiceCapture.current=true;recorderRef.current.stop();return;}
      if (event.key === 'Escape' && speechTurn.current.active) { event.preventDefault(); cancelSpeechTurn(); return; }
      if (event.shiftKey && event.code === 'KeyJ' && !event.repeat && !busy && !settingsOpen) { event.preventDefault(); void toggleVoice(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [recording, busy, settingsOpen]);

  const saveSettings = async (close = false) => {
    try {
      const next = await window.axiom.saveSettings({ appearance, provider:providerDraft, model: modelDraft, autoFailover, fallbackOrder,codingProvider,researchProvider, openAIKey: keyDraft || undefined, anthropicKey:anthropicKeyDraft||undefined, geminiKey:geminiKeyDraft||undefined, speechProvider:speechProviderDraft, elevenLabsKey:elevenKeyDraft||undefined, elevenLabsVoiceId:voiceIdDraft, elevenLabsVoiceName:voiceNameDraft, elevenLabsModel:elevenModelDraft, voiceStability, voiceSimilarity, voiceStyle, voiceSpeed,startMicrophoneOn,updateFeedUrl:updateFeedDraft,preferredMicrophoneId:microphoneIdDraft,preferredMicrophoneLabel:microphoneLabelDraft,microphoneNoiseFloor,microphoneSpeechThreshold,speakerLockEnabled, codingWorkspace: workspaceDraft,godsEyeViewPath:godsEyeViewPathDraft,automaticBackupsEnabled,deviceName:deviceNameDraft,syncEnabled:syncEnabledDraft,syncFolder:syncFolderDraft,syncPassphrase:syncPassphraseDraft||undefined,ownerOverridePhrase:ownerOverrideDraft||undefined });
      setAppearance(next.appearance);
      setSettings(next);setMouthOffsetMs(next.mouthCalibration.offsetMs);setMouthGain(next.mouthCalibration.gain);setMouthAttack(next.mouthCalibration.attack);setMouthRelease(next.mouthCalibration.release); setKeyDraft('');setAnthropicKeyDraft('');setGeminiKeyDraft('');setElevenKeyDraft('');setSyncPassphraseDraft('');setOwnerOverrideDraft('');setSyncStatus(await window.axiom.getSyncStatus()); setSettingsStatus('Settings saved securely.'); if(close)setSettingsOpen(false); setError(''); dispatch({ type: 'mode', mode: 'success' });
      void window.axiom.lastSettingsSnapshot().then(setSettingsSnapshot);
      setTimeout(() => dispatch({ type: 'mode', mode: 'idle' }), 900);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const testProvider=async(provider:AIProvider|'elevenlabs')=>{try{setSettingsStatus(`Testing ${provider}…`);const result=await window.axiom.testProvider(provider);setSettingsStatus(result.message);}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const clearCredential=async(provider:AIProvider|'elevenlabs')=>{try{const clear=provider==='openai'?{clearOpenAIKey:true}:provider==='anthropic'?{clearAnthropicKey:true}:provider==='gemini'?{clearGeminiKey:true}:{clearElevenLabsKey:true};const next=await window.axiom.saveSettings({provider:providerDraft,model:modelDraft,codingWorkspace:workspaceDraft,...clear});setSettings(next);setSettingsStatus(`${provider==='openai'?'OpenAI':provider==='anthropic'?'Anthropic':provider==='gemini'?'Gemini':'ElevenLabs'} credential removed.`);}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const clearOwnerOverride=async()=>{try{const next=await window.axiom.saveSettings({provider:providerDraft,model:modelDraft,codingWorkspace:workspaceDraft,clearOwnerOverridePhrase:true});setSettings(next);setSettingsStatus('Owner override phrase removed.');}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const loadVoices=async()=>{try{await saveSettings();setSettingsStatus('Loading your ElevenLabs voice library…');const next=await window.axiom.listElevenLabsVoices();setVoices(next);setSettingsStatus(`${next.length} ElevenLabs voices loaded.`);}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const previewVoice=async()=>{try{await saveSettings();const result=await window.axiom.synthesizeSpeech('Hello. I am Axiom. This is the voice you selected.');const url=URL.createObjectURL(new Blob([result.audio],{type:result.mimeType}));const audio=new Audio(url);audio.onended=()=>URL.revokeObjectURL(url);await audio.play();setSettingsStatus('Voice preview playing.');}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const calibrateMouth=async()=>{if(mouthCalibrating)return;setMouthCalibrating(true);setSettingsStatus(`Calibrating mouth motion against ${voiceNameDraft||speechProviderDraft}…`);let context:AudioContext|null=null;try{await saveSettings();const result=await window.axiom.synthesizeSpeech('Axiom neural articulation calibration. Power, vision, motion, and response synchronized.');if(!result.alignment)throw new Error('This voice provider did not return character timestamps. Select an ElevenLabs voice for exact calibration.');context=new AudioContext();const buffer=await context.decodeAudioData(result.audio.slice(0)),channel=buffer.getChannelData(0),frame=Math.max(64,Math.floor(buffer.sampleRate*.01)),levels:number[]=[];for(let offset=0;offset<channel.length;offset+=frame){let sum=0;const end=Math.min(channel.length,offset+frame);for(let index=offset;index<end;index++)sum+=channel[index]*channel[index];levels.push(Math.sqrt(sum/Math.max(1,end-offset)));}const baseline=[...levels].sort((a,b)=>a-b)[Math.floor(levels.length*.15)]??0,peak=Math.max(...levels),gate=baseline+(peak-baseline)*.09,onsetIndex=levels.findIndex((value)=>value>gate),audioOnset=Math.max(0,onsetIndex)*.01,characterIndex=result.alignment.characters.findIndex((char)=>char.trim().length>0),alignedOnset=characterIndex>=0?result.alignment.characterStartTimesSeconds[characterIndex]:0,offset=Math.round(Math.max(-180,Math.min(180,(alignedOnset-audioOnset)*1000))),active=levels.filter((value)=>value>gate),average=active.reduce((sum,value)=>sum+value,0)/Math.max(1,active.length),gain=Math.max(.75,Math.min(1.45,.12/Math.max(.03,average))),calibratedAt=new Date().toISOString();setMouthOffsetMs(offset);setMouthGain(gain);const next=await window.axiom.saveSettings({model:modelDraft,mouthOffsetMs:offset,mouthGain:gain,mouthAttack:.66,mouthRelease:.5,mouthCalibratedAt:calibratedAt});setSettings(next);setMouthAttack(.66);setMouthRelease(.5);setSettingsStatus(`Mouth calibrated to ${voiceNameDraft||speechProviderDraft} · ${offset>=0?'+':''}${offset} ms · ${gain.toFixed(2)}× articulation.`);await speak('Calibration complete. My voice and articulation are now synchronized.');}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}finally{if(context)void context.close();setMouthCalibrating(false);}};
  const calibrateMicrophone=async()=>{if(microphoneCalibrating)return;let stream:MediaStream|null=null,context:AudioContext|null=null;setMicrophoneCalibrating(true);setSettingsStatus('Calibrating ambient noise — stay quiet for 2 seconds…');try{stream=await openMicrophone(microphoneIdDraft);context=new AudioContext();const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser(),samples=new Float32Array(2048),levels:number[]=[];analyser.fftSize=2048;source.connect(analyser);if(context.state==='suspended')await context.resume();const started=performance.now();await new Promise<void>((resolve)=>{const read=()=>{analyser.getFloatTimeDomainData(samples);let sum=0;for(const value of samples)sum+=value*value;levels.push(Math.sqrt(sum/samples.length));if(performance.now()-started>=2400){resolve();return;}requestAnimationFrame(read);};read();});source.disconnect();levels.sort((a,b)=>a-b);const floor=Math.max(.001,Math.min(.12,levels[Math.floor(levels.length*.65)]??.006)),threshold=Math.max(.012,Math.min(.14,floor*2.8+.004)),calibratedAt=new Date().toISOString();setMicrophoneNoiseFloor(floor);setMicrophoneSpeechThreshold(threshold);const next=await window.axiom.saveSettings({model:modelDraft,preferredMicrophoneId:microphoneIdDraft,preferredMicrophoneLabel:microphoneLabelDraft,microphoneNoiseFloor:floor,microphoneSpeechThreshold:threshold,microphoneCalibratedAt:calibratedAt});setSettings(next);setSettingsStatus(`Microphone calibrated · ambient ${floor.toFixed(4)} · speech gate ${threshold.toFixed(4)}.`);}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}finally{stream?.getTracks().forEach((track)=>track.stop());if(context)void context.close();setMicrophoneCalibrating(false);}};
  const synchronizeNow=async()=>{try{await saveSettings();setSettingsStatus('Synchronizing encrypted identity…');const status=await window.axiom.syncNow();setSyncStatus(status);setMessages(await window.axiom.loadHistory());setMemories(await window.axiom.listMemories());setGoals(await window.axiom.listGoals());setSettingsStatus(`Identity synchronized · ${status.peers.length} peer device${status.peers.length===1?'':'s'} linked.`);}catch(reason){setSyncStatus(await window.axiom.getSyncStatus().catch(()=>null));setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};
  const moveFallback=(provider:AIProvider,direction:-1|1)=>setFallbackOrder((current)=>{const index=current.indexOf(provider),target=index+direction;if(index<0||target<0||target>=current.length)return current;const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next;});
  const runDiagnostics=async()=>{setDiagnosticsBusy(true);const results:Array<{label:string;ok:boolean;detail:string}>=[];try{const devices=await navigator.mediaDevices.enumerateDevices();const cameras=devices.filter((device)=>device.kind==='videoinput').length,mics=devices.filter((device)=>device.kind==='audioinput').length;const platformPermissions=await window.axiom.getPlatformPermissions();results.push({label:'PRESENCE TRACKING',ok:tracking.status==='locked',detail:tracking.status==='locked'?`${tracking.pose.source} lock · ${tracking.pose.fps} FPS · ${Math.round(tracking.pose.confidence*100)}% confidence`:`Camera ${tracking.status}; ${cameras} video device(s) found.`},{label:'MICROPHONE',ok:mics>0,detail:`${mics} audio input device(s) found.`},...platformPermissions.filter((item)=>item.required).map((item)=>({label:`OS ${item.label.toUpperCase()}`,ok:item.state==='granted',detail:item.detail})),{label:`${settings?.secureStorageLabel?.toUpperCase()||'SECURE STORAGE'}`,ok:Boolean(settings?.encryptionAvailable),detail:settings?.encryptionAvailable?`${settings.secureStorageLabel} available.`:'Secure credential storage unavailable.'},{label:'BUILD WORKSPACE',ok:Boolean(workspaceDraft.trim()),detail:workspaceDraft||'Not configured.'});for(const provider of(['openai','anthropic','gemini'] as AIProvider[])){const configured=settings?.[provider==='openai'?'hasOpenAIKey':provider==='anthropic'?'hasAnthropicKey':'hasGeminiKey'];if(!configured){results.push({label:`${provider.toUpperCase()} CORE`,ok:false,detail:'Not configured (optional).'});continue;}try{const test=await window.axiom.testProvider(provider);results.push({label:`${provider.toUpperCase()} CORE`,ok:test.ok,detail:test.message});}catch(reason){results.push({label:`${provider.toUpperCase()} CORE`,ok:false,detail:reason instanceof Error?reason.message:String(reason)});}}if(settings?.hasElevenLabsKey){try{const test=await window.axiom.testProvider('elevenlabs');results.push({label:'ELEVENLABS VOICE',ok:test.ok,detail:test.message});}catch(reason){results.push({label:'ELEVENLABS VOICE',ok:false,detail:reason instanceof Error?reason.message:String(reason)});}}setDiagnostics(results);setProviderHealth(await window.axiom.getProviderHealth());}finally{setDiagnosticsBusy(false);}};
  const applyVoiceSettings=(next:PublicSettings)=>{setSettings(next);setSpeechProviderDraft(next.speechProvider);setVoiceIdDraft(next.elevenLabsVoiceId);setVoiceNameDraft(next.elevenLabsVoiceName);setElevenModelDraft(next.elevenLabsModel);setVoiceStability(next.voiceStability);setVoiceSimilarity(next.voiceSimilarity);setVoiceStyle(next.voiceStyle);setVoiceSpeed(next.voiceSpeed);setMouthOffsetMs(next.mouthCalibration.offsetMs);setMouthGain(next.mouthCalibration.gain);setMouthAttack(next.mouthCalibration.attack);setMouthRelease(next.mouthCalibration.release);};
  const saveVoiceProfile=async()=>{try{await saveSettings();const next=await window.axiom.saveVoiceProfile(voiceProfileName);applyVoiceSettings(next);setVoiceProfileName('');setSettingsStatus('Voice profile saved.');}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}};

  const addPanelItem = async (event: FormEvent) => {
    event.preventDefault(); const text=panelDraft.trim();if(!text)return;
    if(activeView==='MEMORY'){await window.axiom.addMemory(text,memoryKind);setMemories(await window.axiom.listMemories());}
    if(activeView==='GOALS'){await window.axiom.addGoal(text);setGoals(await window.axiom.listGoals());}
    setPanelDraft('');
  };
  const forgetMemory=async(id:string)=>{try{setMemories(await window.axiom.forgetMemory(id));}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  const forgetSelfCorrection=async(id:string)=>{try{setSelfCorrections(await window.axiom.forgetSelfCorrection(id));}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  const revertSettings=async()=>{setRevertingSettings(true);try{const next=await window.axiom.revertLastSettingsChange();setSettings(next);setSettingsSnapshot(await window.axiom.lastSettingsSnapshot());setSettingsStatus('Reverted to the previous settings.');}catch(reason){setSettingsStatus(reason instanceof Error?reason.message:String(reason));}finally{setRevertingSettings(false);}};

  const captureDisplay = async () => {
    if (captureBusy) return;
    try { setCaptureBusy(true); setError(''); const capture=await window.axiom.captureScreen();setScreenCapture(capture);setToolEvents((current)=>[{name:'screen_capture',status:'verified' as const,summary:'Primary display attached for one request.',at:capture.capturedAt},...current].slice(0,12));dispatch({ type: 'mode', mode: 'success' }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); dispatch({ type: 'mode', mode: 'error' }); }
    finally { setCaptureBusy(false); }
  };
  const captureCamera=async()=>{try{setCaptureBusy(true);setError('');const frame=tracking.captureFrame();if(!frame)throw new Error('The camera is not ready. Enable Presence Link and face the camera.');setCameraCapture(frame);setScreenCapture(null);await recognition.recognize();setToolEvents((current)=>[{name:'camera_observation',status:'verified' as const,summary:'Local camera frame captured for one request.',at:frame.capturedAt},...current].slice(0,12));}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setCaptureBusy(false);}};
  const enrollPerson=async()=>{
    const name=personName.trim();if(!name)return;
    enrollmentCancelRef.current=false;enrollmentNarratedRef.current='';
    setEnrollmentBusy(true);setEnrollmentProgress(null);setEnrollmentResult(null);setError('');setSaveEnrollmentError('');
    await speak(`Starting a guided face scan for ${name}. Look straight at the camera and hold still.`);
    try{
      const{groups,validation}=await recognition.captureEnrollment(()=>({yaw:trackingPoseRef.current.yaw,pitch:trackingPoseRef.current.pitch}),setEnrollmentProgress,()=>enrollmentCancelRef.current);
      setEnrollmentResult({name,groups,validation});
      if(enrollmentCancelRef.current)await speak('Scan stopped.');
      else if(validation.accepted)await speak(`Scan complete. ${validation.posesCompleted} of ${ENROLLMENT_POSES.length} angles captured. Say or click Save Enrollment to finish, or Retry to scan again.`);
      else await speak(`${validation.reason} Click Retry to try again.`);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setEnrollmentBusy(false);}
  };
  const cancelEnrollment=()=>{enrollmentCancelRef.current=true;};
  const discardEnrollment=()=>{setEnrollmentResult(null);setEnrollmentProgress(null);setSaveEnrollmentError('');};
  const saveEnrollment=async()=>{
    if(!enrollmentResult)return;
    setEnrollmentSaving(true);setError('');setSaveEnrollmentError('');
    try{
      const saved=await recognition.commitEnrollment(enrollmentResult.name,enrollmentResult.groups);
      setToolEvents((current)=>[{name:'remember_person',status:'verified' as const,summary:`${saved.name} saved to local face memory across ${enrollmentResult.validation.posesCompleted} angles.`,at:new Date().toISOString()},...current].slice(0,12));
      await speak(`${saved.name} is saved. I will recognize you across a range of head angles now.`);
      setPersonName('');setEnrollmentResult(null);setEnrollmentProgress(null);
    }catch(reason){
      const message=reason instanceof Error?reason.message:String(reason);
      setError(message);setSaveEnrollmentError(message);
      // Deliberately does NOT touch enrollmentResult.validation.accepted: a
      // failed save (e.g. consent not yet granted) should stay retryable
      // without forcing the whole 5-pose scan over again.
    }
    finally{setEnrollmentSaving(false);}
  };
  // Narrates each guided-enrollment step through Axiom's real voice: the user's
  // head is turned away from the screen for several of these poses by design,
  // so on-screen text alone is not a usable feedback channel.
  useEffect(()=>{
    if(!enrollmentProgress)return;
    const key=`${enrollmentProgress.poseIndex}:${enrollmentProgress.status}`;
    if(enrollmentNarratedRef.current===key)return;
    enrollmentNarratedRef.current=key;
    if(enrollmentProgress.status==='waiting'&&enrollmentProgress.poseIndex>0)void speak(enrollmentProgress.instruction);
    else if(enrollmentProgress.status==='done')void speak('Got it.');
    else if(enrollmentProgress.status==='skipped')void speak("Let's move on.");
  },[enrollmentProgress]);
  // A single reminder partway through the per-pose timeout: if the pose still
  // has not registered, repeat the instruction once rather than leaving the
  // user guessing in silence for the full 15 seconds.
  useEffect(()=>{
    if(!enrollmentProgress||enrollmentProgress.status==='done'||enrollmentProgress.status==='skipped')return;
    const{poseIndex,instruction}=enrollmentProgress;
    const timer=window.setTimeout(()=>{const latest=enrollmentProgressRef.current;if(latest&&latest.poseIndex===poseIndex&&latest.status!=='done'&&latest.status!=='skipped')void speak(`Still waiting. ${instruction}`);},7500);
    return()=>window.clearTimeout(timer);
  },[enrollmentProgress?.poseIndex]);
  const enrollSpeaker=async()=>{
    const name=(speakerName||visiblePersonName||personName).trim();
    if(!name){setEnrollmentStatus('Enter your name before enrolling your voice.');return;}
    let stream:MediaStream|null=null;
    try{
      enrollingSpeakerRef.current=true;
      if(recorderRef.current?.state==='recording'){discardVoiceCapture.current=true;recorderRef.current.stop();}
      setSpeakerStatus('enrolling');setEnrollmentStatus('LOADING WAVLM…');
      await new Promise((resolve)=>setTimeout(resolve,220));
      stream=await openMicrophone();
      await speak(`Starting a guided voice scan for ${name}, across a few different conditions so I recognize you reliably.`);
      let succeeded=0,lastSaved:import('../shared/contracts').SpeakerProfile[]=[];
      for(let index=0;index<VOICE_ENROLLMENT_STEPS.length;index+=1){
        const step=VOICE_ENROLLMENT_STEPS[index];
        setVoiceStepIndex(index);
        await speak(step.instruction);
        setEnrollmentStatus(`STEP ${index+1}/${VOICE_ENROLLMENT_STEPS.length} · ${step.label} · SPEAK NOW`);
        const print=await captureVoicePrint(stream,5000,(remaining)=>setEnrollmentStatus(`STEP ${index+1}/${VOICE_ENROLLMENT_STEPS.length} · ${step.label} · ${(remaining/1000).toFixed(1)}s · KEEP SPEAKING`));
        const quality=speakerEvidenceQuality(print);
        if(!print||!quality.strong){await speak("That one wasn't clear enough. Let's move on.");continue;}
        lastSaved=await window.axiom.enrollSpeaker(name,print.vector);succeeded+=1;
        await speak('Got it.');
      }
      setVoiceStepIndex(-1);
      if(succeeded<MIN_VOICE_STEPS_REQUIRED)throw new Error(`Only ${succeeded} of ${VOICE_ENROLLMENT_STEPS.length} conditions produced a clear sample; at least ${MIN_VOICE_STEPS_REQUIRED} are required. Move closer, reduce background noise, and try again.`);
      const saved=lastSaved.find((item)=>item.name.toLowerCase()===name.toLowerCase());
      setSettings((current)=>current?{...current,speakerProfiles:lastSaved,speakerLockEnabled:true}:current);
      setSpeakerLockEnabled(true);setSpeakerName(name);setSpeakerStatus('verified');setSpeakerTrustSource('voice');
      const trust=createSpeakerTrust(name,1,'voice');speakerTrustRef.current=trust;verifiedSpeakerRef.current={name,score:1,verifiedAt:trust.verifiedAt};
      setEnrollmentStatus(`${name.toUpperCase()} VERIFIED · ${succeeded}/${VOICE_ENROLLMENT_STEPS.length} CONDITIONS · ${saved?.sampleCount??succeeded}/5 WAVLM SAMPLES`);
      setToolEvents((current)=>[{name:'speaker_enrollment',status:'verified' as const,summary:`${name} enrolled across ${succeeded} of ${VOICE_ENROLLMENT_STEPS.length} conditions (${saved?.sampleCount??succeeded}/5 WavLM samples).`,at:new Date().toISOString()},...current].slice(0,12));
      await speak(`${name}, your voice is enrolled across ${succeeded} condition${succeeded===1?'':'s'}.`);
    }catch(reason){setSpeakerStatus('rejected');setEnrollmentStatus(reason instanceof Error?reason.message:String(reason));}
    finally{enrollingSpeakerRef.current=false;setVoiceStepIndex(-1);stream?.getTracks().forEach((track)=>track.stop());}
  };
  const forgetSpeaker=async(id:string)=>{try{const profiles=await window.axiom.forgetSpeaker(id);setSettings((current)=>current?{...current,speakerProfiles:profiles}:current);setSpeakerStatus(profiles.length?'setup':'setup');setEnrollmentStatus(profiles.length?'Voice profile removed.':'No voice enrolled. Axiom will accept any speaker until you enroll one.');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};

  const clearConversation = async () => {
    if (!confirmClearHistory) { setConfirmClearHistory(true); return; }
    await window.axiom.clearHistory(); setMessages([]); setConfirmClearHistory(false);
  };
  const togglePermission=async(permission:PermissionInfo)=>{try{setPermissions(await window.axiom.setPermission(permission.id,!permission.enabled));}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};

  const adaptiveEfficient=appearance.motionProfile==='adaptive'&&Boolean(telemetry&&telemetry.cpuPercent>72);
  const effectiveMotion=adaptiveEfficient?'efficient':appearance.motionProfile;
  const shellStyle={'--theme-rgb':hexRgb(appearance.accentHex),'--theme-solid':appearance.accentHex,'--glow-strength':String(appearance.glowIntensity)} as CSSProperties;
  return <main className={`shell mode-${visual.mode} theme-${appearance.color} motion-${effectiveMotion} density-${appearance.density}`} style={shellStyle}>
    <div className="cinematic-atmosphere" aria-hidden="true"><i /><i /><i /></div>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">A</span><div><strong>AXIOM</strong><small>PRIVATE COMPANION / WORKING TITLE</small></div></div>
      <div className="top-state"><i /> {statusText}</div>
      <div className="top-actions"><button className="history-button" onClick={()=>{setHistoryOpen(true);setConfirmClearHistory(false);}}>HISTORY <b>{messages.length}</b></button><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">⌁</button></div>
    </header>

    <aside className="rail">
      <div className="rail-head"><span>AXIOM</span><b>COMMAND DECK</b><i /></div>
      <div className="rail-primary">
        {primaryNav.map((item)=><button key={item.label} className={`primary-node ${item.action==='settings'?(settingsOpen?'active':''):activeView===item.view?'active':''}`} onClick={()=>item.action==='settings'?setSettingsOpen(true):setActiveView(item.view)}><i className="p-icon">{item.glyph}</i><span><b>{item.label}</b><span>{item.detail}</span></span></button>)}
      </div>
      <button type="button" className={`more-toggle${moreNavExpanded?' open':''}`} onClick={()=>setMoreNavOpen((current)=>!current)} aria-expanded={moreNavExpanded}>
        <span className="mt-chevron">▸</span><b>MORE</b><span>{secondaryNav.length} MODULES</span>
      </button>
      {moreNavExpanded&&<div className="more-list open">
        {secondaryNav.map((item)=><button key={item.label} className={`more-node${activeView===item.view?' active':''}`} onClick={()=>setActiveView(item.view)}><i>{item.glyph}</i>{item.label} · {item.detail}</button>)}
      </div>}
      <div className="quick-status">
        <div className="qs-label">QUICK STATUS</div>
        <button type="button" className={`living-core${settings?.startMicrophoneOn?' on':''}`} onClick={()=>void toggleHandsFree()} aria-pressed={Boolean(settings?.startMicrophoneOn)} aria-label={settings?.startMicrophoneOn?'Turn off hands-free listening':'Turn on hands-free listening'}>
          <div className="core-stack">
            <canvas ref={livingCoreCanvasRef} width={150} height={150}/>
            <div className="core-3d"><i className="core-ring-3d"/><i className="core-ring-3d r2"/><i className="core-ring-3d r3"/><i className="core-ring-3d r4"/><i className="core-inner-glow"/><span className="core-3d-glyph">💀</span></div>
          </div>
          <span className="core-label"><b>SYSTEM CORE</b><span>{settings?.startMicrophoneOn?'HANDS-FREE LISTENING':'STANDBY'}</span></span>
        </button>
        {ringViews.size>0&&(()=>{const peek=[...ringViews.values()][0];return<button type="button" className="qs-camera" onClick={()=>setActiveView('CONVERSE')}><span className="qs-cam-thumb"><i className="rec"/><i className="cam-sweep"/></span><span><b>{peek.camera.name.toUpperCase()}</b><span>{peek.connectionState==='ready'?'LIVE · TAP TO OPEN':peek.connectionState.toUpperCase()}</span></span></button>;})()}
        <div className="qs-vitals">
          <svg viewBox="0 0 100 22" preserveAspectRatio="none"><defs><linearGradient id="railVitalsGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgb(70,232,255)" stopOpacity=".5"/><stop offset="100%" stopColor="rgb(70,232,255)" stopOpacity="0"/></linearGradient></defs>{(()=>{const max=Math.max(...cpuHistory,10)*1.2,coords=cpuHistory.map((value,index)=>[index*(100/(cpuHistory.length-1)),22-(value/max)*22]),line=`M ${coords.map((point)=>point.join(' ')).join(' L ')}`;return<><path className="qs-vfill" fill="url(#railVitalsGrad)" d={`${line} L 100 22 L 0 22 Z`}/><path className="qs-vline" d={line}/></>;})()}</svg>
          <b><ScrambleValue value={`${Math.round(telemetry?.cpuPercent??0)}%`}/></b>
        </div>
      </div>
      <div className="rail-footer"><span className="node-orbit"><i className={settings?.hasSelectedAIKey ? 'online' : ''} /></span><div><b>{settings?.hasSelectedAIKey ? `${settings.provider.toUpperCase()} CORE` : 'CORE OFFLINE'}</b><span>{settings?.hasSelectedAIKey ? 'ENCRYPTED UPLINK' : 'SETUP REQUIRED'}</span></div><em>AXM</em></div>
    </aside>

    <section className="stage" ref={ringStageRef}>
      <div className="stage-coordinate">AZM 041.28° / ELV 17.03°</div>
      <canvas ref={ringParticleCanvasRef} className="ring-particle-canvas" aria-hidden="true"/>
      {cameraFeedOpen&&<section className="live-camera-window"><header><div><i/><b>LIVE CAMERA / LOCAL</b><span>{tracking.status==='locked'?`${tracking.pose.source.toUpperCase()} LOCK · ${tracking.pose.fps} FPS`:tracking.status.toUpperCase()}</span></div><button onClick={()=>setCameraFeedOpen(false)} aria-label="Close live camera">×</button></header><div className="camera-body"><div className="camera-stage"><video ref={liveCameraRef} muted playsInline autoPlay/><canvas ref={detectionOverlayRef} className="detection-overlay"/></div><aside className="camera-sidebar"><div className="camera-stats"><div><span>STATUS</span><b>{tracking.status.toUpperCase()}</b></div><div><span>SOURCE</span><b>{tracking.pose.source==='none'?'—':tracking.pose.source.toUpperCase()}</b></div><div><span>FPS</span><b>{tracking.pose.fps}</b></div><div><span>IDENTITY</span><b>{recognition.observation?(recognition.observation.unknown?'UNRECOGNIZED':recognition.observation.name.toUpperCase()):'—'}</b></div>{recognition.observation&&!recognition.observation.unknown&&<div><span>MATCH</span><b>{Math.round(recognition.observation.confidence*100)}%</b></div>}{recognition.observation&&!recognition.observation.unknown&&<div><span>LIVENESS</span><b>{liveness.live?'CONFIRMED':'CHECKING'}</b></div>}</div><CameraControlsPanel cameraControls={cameraControls} onSet={(key,value)=>void setCameraControl(key,value)} onReset={(key)=>void resetCameraControl(key)} compact/></aside></div><footer><span>PRIVATE PREVIEW</span><b>A frame is sent to the active AI only when you explicitly ask Axiom to look.</b></footer></section>}
      {activeView === 'CONVERSE' ? <>
      {ringViews.size>0&&<svg className="ring-connectors" aria-hidden="true" ref={ringConnectorSvgRef}/>}
      {ringViews.size>0&&<div className="ring-panel-layer" aria-label="Live Ring cameras">{[...ringViews.entries()].map(([cameraId,view],index)=>{
        const expanded=expandedRingCameraId===cameraId;
        // Divide the real vertical space between the neural-readouts
        // widget (ends ~132px down — see the ringStageHeight comment
        // above) and the composer/identity-line (starts ~150px up)
        // evenly among however many cameras are actually open, shrinking
        // the diameter as more join so none overlap — a fixed percentage
        // arc had no way to do this and just overlapped once 3 were open.
        const safeTop=150,safeBottom=150;
        const available=Math.max(200,ringStageHeight-safeTop-safeBottom);
        const rowHeight=available/ringViews.size;
        const maxDiameter=ringViews.size<=1?230:ringViews.size===2?200:ringViews.size===3?170:140;
        const diameter=Math.max(110,Math.min(rowHeight-70,maxDiameter));
        const panelTop=safeTop+rowHeight*index+(rowHeight-diameter)/2;
        return(<div key={cameraId} ref={(el)=>{if(el)ringPanelElsRef.current.set(cameraId,el);else ringPanelElsRef.current.delete(cameraId);}} className={`ring-panel ${view.materializePhase}${expanded?' expanded':''}`} style={{'--panel-index':index,'--panel-top':`${panelTop}px`,'--panel-diameter':`${diameter}px`} as CSSProperties}>
          <div className="ring-sketch" aria-hidden="true"><svg viewBox="0 0 236 236"><circle cx="118" cy="118" r="114.7"/></svg></div>
          <div className="ring-rgb-flicker" aria-hidden="true"/>
          {Array.from({length:8},(_,tickIndex)=><span key={tickIndex} className="ring-tick" aria-hidden="true" style={{transform:`translate(-50%,-50%) rotate(${tickIndex*45}deg) translateY(calc(-1 * var(--panel-radius)))`} as CSSProperties}/>)}
          <div className="ring-panel-frame">
            <div className="camera-stage">
              <video ref={(el)=>{if(el)ringVideoElsRef.current.set(cameraId,el);else ringVideoElsRef.current.delete(cameraId);}} muted={view.muted} playsInline autoPlay/>
              <span className="ring-scan-sweep"/>
            </div>
          </div>
          <div className="ring-caption">
            <span className="ring-rec-dot"/>
            <b>{view.camera.name.toUpperCase()}</b>
            <span className="ring-status">{view.connectionState.toUpperCase()}</span>
            <button className="ring-expand-toggle" onClick={()=>{setExpandedRingCameraId(expanded?null:cameraId);trackRingConnector(cameraId,500);}} aria-label={expanded?`Shrink ${view.camera.name}`:`Expand ${view.camera.name}`}>{expanded?'⤡':'⤢'}</button>
            <button onClick={()=>toggleRingMuted(cameraId)} aria-label={view.muted?`Unmute ${view.camera.name}`:`Mute ${view.camera.name}`} aria-pressed={!view.muted}>{view.muted?'🔇':'🔊'}</button>
            <button className={`ring-talk-button ${view.talking?'talking':''}`} onMouseDown={()=>void startRingTalk(cameraId)} onMouseUp={()=>stopRingTalk(cameraId)} onMouseLeave={()=>stopRingTalk(cameraId)} onTouchStart={(event)=>{event.preventDefault();void startRingTalk(cameraId);}} onTouchEnd={(event)=>{event.preventDefault();stopRingTalk(cameraId);}} aria-label={`Hold to talk to ${view.camera.name}`}>🎙</button>
            <button onClick={()=>closeRingLiveView(cameraId)} aria-label={`Close ${view.camera.name}`}>×</button>
          </div>
          {view.connectionState==='fault'&&<div className="ring-tile-fault">{view.faultReason||'Connection failed.'}</div>}
          {view.talkError&&<div className="ring-tile-fault">{view.talkError}</div>}
        </div>);
      })}</div>}
      <div className="neural-readouts" aria-label="Live Axiom status">
        <button onClick={()=>setActiveView('RUNTIME')}><small>CORE LOAD</small><b><ScrambleValue value={`${Math.round(telemetry?.cpuPercent??0)}%`}/></b><i style={{'--meter':`${Math.round(telemetry?.cpuPercent??0)}%`} as CSSProperties}/></button>
        <button onClick={()=>setActiveView('WEB')}><small>INTEL LINK</small><b>{operational?.probes.some((probe)=>probe.id.includes('web')&&probe.state==='ready')?'LIVE':'READY'}</b><span>↗</span></button>
        <button onClick={()=>setActiveView('SCREEN')}><small>ROOM VISION</small><b>{tracking.status.toUpperCase()}</b><span>◉</span></button>
        <button onClick={()=>setActiveView('RUNTIME')}><small>ACTIVE WORK</small><b><ScrambleValue value={`${runtime?.metrics.activeTasks??0} TASKS`}/></b><span>⌁</span></button>
      </div>
      <canvas ref={cognitionCanvasRef} className="cognition-field" width={1000} height={1000} aria-hidden="true"/>
      {godsEye.phase!=='closed'&&<div ref={godsEyePanelRef} className={`gods-eye-panel ${godsEye.phase}`}>
        <div className="gods-eye-frame">
          {Array.from({length:4},(_,index)=><span key={index} className={`gods-eye-bracket bracket-${index}`} aria-hidden="true"/>)}
          <span className="gods-eye-scan-sweep" aria-hidden="true"/>
          <header>
            <div><i/><b>GOD'S EYE VIEW</b><span>{godsEye.status==='ready'?'LIVE FEED':godsEye.status==='error'?'UPLINK FAILED':'INITIALIZING'}</span></div>
            <button onClick={closeGodsEye} aria-label="Close God's Eye View">×</button>
          </header>
          <div className="gods-eye-body" ref={godsEyeContentRef}>
            {godsEye.status==='loading'&&<div className="gods-eye-overlay"><span className="gods-eye-spinner" aria-hidden="true"/><b>ACQUIRING SATELLITE UPLINK…</b><small>Starting the local server — first launch can take up to 20 seconds.</small></div>}
            {godsEye.status==='error'&&<div className="gods-eye-overlay gods-eye-error"><b>UPLINK FAILED</b><small>{godsEye.error}</small></div>}
          </div>
        </div>
      </div>}
      <ModdedSkullAvatar mode={visual.mode} energy={visual.energy} tracking={tracking.pose} mouth={mouth} appearance={appearance} onEyesClick={()=>void openGodsEye()} />
      <div ref={ringSkullAnchorRef} className="ring-skull-anchor" aria-hidden="true"/>
      {(screenCapture||cameraCapture) && <div className="screen-attachment"><img src={(cameraCapture||screenCapture)!.dataUrl} alt="Attached visual capture"/><div><b>{cameraCapture?'CAMERA ATTACHED':'SCREEN ATTACHED'}</b><span>{(cameraCapture||screenCapture)!.width} × {(cameraCapture||screenCapture)!.height} / ONE REQUEST</span></div><button onClick={()=>{setScreenCapture(null);setCameraCapture(null);}} aria-label="Remove visual attachment">×</button></div>}
      <div className="identity-line"><span className={latest?.role==='assistant'&&!streamingText&&!busy&&latest.tone?`reply-tone-${latest.tone}`:undefined}>{recording ? 'LISTENING — HANDS FREE' : voiceProcessing ? 'UNDERSTANDING VOICE' : streamingText ? visual.mode === 'speaking' ? 'LIVE VOICE STREAM' : 'RESPONDING' : latest?.role==='assistant'&&latest.tone==='concern'&&!busy?'AXIOM FLAGGED A CONCERN':latest?.role==='assistant'&&latest.tone==='uncertain'&&!busy?'AXIOM IS UNCERTAIN':statusText}</span></div>
      <form className="composer" onSubmit={send}>
        <button type="button" className={`voice-button ${recording ? 'recording' : ''}`} onClick={() => void toggleVoice()} aria-label={recording ? 'Send voice command now' : 'Start voice command'}>{recording ? '■' : '◉'}</button>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Tell Axiom what you need…" disabled={busy} />
        <button className="send-button" disabled={!input.trim() || busy} aria-label="Send">↗</button>
        <button type="button" className={`hands-free-button ${settings?.startMicrophoneOn ? 'active' : ''}`} onClick={()=>void toggleHandsFree()} aria-label={settings?.startMicrophoneOn?'Turn off hands-free listening':'Turn on hands-free listening'} aria-pressed={Boolean(settings?.startMicrophoneOn)} title={settings?.startMicrophoneOn?'Hands-free listening is on':'Hands-free listening is off'}>🎧</button>
      </form>
      <div className="voice-hint">{recording?'HANDS-FREE LISTENING':'PRESS'} {recording?<><span>•</span> PAUSE NATURALLY TO SEND</>:<><kbd>SHIFT</kbd> + <kbd>J</kbd> TO SPEAK</>} <span>•</span> <kbd>ESC</kbd> STOPS VOICE</div>
      {error && <div className="error-strip">{error}</div>}
      </> : <section className="module-panel">
        <header><span>AXIOM / {activeView}</span><h1>{currentModule?.title}</h1><p>{currentModule?.description}</p></header>
        {error && <div className="error-strip">{error}</div>}
        {activeView !== 'MEMORY' && activeView !== 'GOALS' && activeView !== 'RUNTIME' && <><div className="module-grid">{visiblePermissions.map((permission)=><article key={permission.id}><i className={permission.enabled?'enabled':''}/><div><b>{permission.label}</b><span>{permission.risk.toUpperCase()} ACCESS / {permission.enabled?'ALLOWED':'BLOCKED'}</span></div><button onClick={()=>void togglePermission(permission)}>{permission.enabled?'BLOCK':'ALLOW'}</button></article>)}</div>{activeView==='CAPABILITIES'&&<div className="audit-panel"><header><span>SECURITY AUDIT / {audit.length} EVENTS</span>{audit.length>0&&<button onClick={()=>void window.axiom.clearAudit().then(()=>setAudit([]))}>CLEAR</button>}</header>{audit.slice(0,8).map((item)=><article key={item.id}><i className={item.status}/><p><b>{item.name.replaceAll('_',' ')}</b><span>{item.summary}</span></p><time>{new Date(item.at).toLocaleString([], {hour:'2-digit',minute:'2-digit'})}</time></article>)}</div>}{activeView==='AUTOMATE'&&<div className="control-matrix"><div className="control-matrix-head"><span>{settings?.platform==='macos'?'MACOS ACCESSIBILITY ENGINE':'MICROSOFT WINAPP ENGINE'}</span><b>{settings?.platformLabel?.toUpperCase()||'SYSTEM'} CONTROL MAP</b></div><div>{(settings?.platform==='macos'?macAutomationCapabilities:automationCapabilities).map((capability)=><article key={capability.code}><strong>{capability.code}</strong><p><b>{capability.title}</b><span>{capability.detail}</span></p></article>)}</div></div>}{activeView==='BUILD'&&<div className="build-lab"><div className="build-lab-head"><span>ACTIVE WORKSPACE</span><b>{settings?.codingWorkspace||'NOT CONFIGURED'}</b></div><div className="build-pipeline">{buildStages.map((stage)=><article key={stage.code}><strong>{stage.code}</strong><p><b>{stage.title}</b><span>{stage.detail}</span></p></article>)}</div><div className="build-guard"><i/><p><b>CHECKPOINT-FIRST AUTONOMY</b><span>Axiom can code independently here. Publishing, installing, secrets, and destructive changes still stop for you.</span></p></div></div>}{activeView==='SCREEN'&&<div className="camera-intel"><div className="vision-capture"><div className="vision-preview">{(cameraCapture||screenCapture)?<img src={(cameraCapture||screenCapture)!.dataUrl} alt="Latest visual capture"/>:<div><i/><b>VISION SENSOR READY</b><span>Presence stays on-device. A frame leaves the computer only when you ask Axiom to analyze it.</span></div>}</div><div className="vision-actions"><button onClick={()=>void captureCamera()} disabled={captureBusy}>CAPTURE CAMERA</button><button onClick={()=>void captureDisplay()} disabled={captureBusy}>CAPTURE DISPLAY</button>{(cameraCapture||screenCapture)&&<button onClick={()=>{setInput(cameraCapture?'Describe everyone and everything you see in the camera, including what each person appears to be doing.':'Analyze the attached screen. Tell me what is visible, identify anything important, and suggest the best next action.');setActiveView('CONVERSE');}}>ASK AXIOM</button>}</div></div><CameraControlsPanel cameraControls={cameraControls} onSet={(key,value)=>void setCameraControl(key,value)} onReset={(key)=>void resetCameraControl(key)}/><section className="people-console"><header><b>LOCAL PERSON MEMORY</b><span>{recognition.state.toUpperCase()} / {recognition.people.length} SAVED</span></header><div className="recognition-now"><i className={recognition.observation&&!recognition.observation.unknown?(liveness.live?'known':'pending'):''}/><p><b>{recognition.observation?.name||'NO FACE LOCK'}</b><span>{recognition.observation?`${Math.round(recognition.observation.confidence*100)}% match confidence`:'Face the camera to identify or enroll a person.'}</span></p></div>{recognition.observation&&!recognition.observation.unknown&&<div className={`liveness-state ${liveness.live?'live':''}`}><i/><p><b>{liveness.live?'LIVENESS CONFIRMED':liveness.reason==='motionless'?'AWAITING NATURAL MOTION':liveness.reason==='no-blink-observed'?'AWAITING A BLINK':'OBSERVING…'}</b><span>{liveness.live?'A genuine blink and head motion were observed — this match is trusted for identity-sensitive requests.':'A face match alone is not trusted for identity-sensitive requests until Axiom observes a real blink and natural head motion, which a photo cannot produce.'}</span></p></div>}{enrollmentBusy&&enrollmentProgress?<div className="guided-enrollment"><header><b>GUIDED ENROLLMENT · STEP {enrollmentProgress.poseIndex+1}/{enrollmentProgress.poseCount}</b><span>{enrollmentProgress.label}</span></header><div className={`guided-video-frame ${ENROLLMENT_POSES[enrollmentProgress.poseIndex]?.matches(tracking.pose.yaw,tracking.pose.pitch)?'matched':''}`}><video ref={enrollmentVideoRef} muted playsInline autoPlay/></div><p className="guided-instruction">🔊 {enrollmentProgress.instruction}</p><div className="guided-steps">{ENROLLMENT_POSES.map((pose,index)=><i key={pose.id} className={index<enrollmentProgress!.poseIndex||(index===enrollmentProgress!.poseIndex&&enrollmentProgress!.status==='done')?'done':index===enrollmentProgress!.poseIndex?enrollmentProgress!.status==='capturing'?'active':enrollmentProgress!.status==='skipped'?'skipped':'active':''}/>)}</div><div className="guided-capture-count">{enrollmentProgress.status==='skipped'?'Could not reach this angle in time — moving on…':`${enrollmentProgress.capturedInPose}/${enrollmentProgress.samplesNeeded} samples at this angle`}</div><button className="secondary" onClick={cancelEnrollment}>STOP</button></div>:enrollmentResult?<div className="guided-enrollment guided-review"><header><b>SCAN COMPLETE</b><span>{enrollmentResult.validation.posesCompleted}/{ENROLLMENT_POSES.length} ANGLES</span></header><div className="guided-review-list">{ENROLLMENT_POSES.map((pose)=><div key={pose.id} className={(enrollmentResult.groups[pose.id]?.length??0)>0?'ok':'missed'}><i/><span>{pose.label}</span></div>)}</div>{!enrollmentResult.validation.accepted&&<p className="guided-instruction">{enrollmentResult.validation.reason}</p>}{saveEnrollmentError&&<p className="guided-instruction guided-save-error">⚠ {saveEnrollmentError}</p>}<div className="settings-actions"><button className="secondary" onClick={discardEnrollment}>CANCEL</button><button className="secondary" onClick={()=>void enrollPerson()}>RETRY</button>{enrollmentResult.validation.accepted&&<button className="primary" disabled={enrollmentSaving} onClick={()=>void saveEnrollment()}>{enrollmentSaving?'SAVING…':'SAVE ENROLLMENT'}</button>}</div></div>:<div className="person-enroll"><input value={personName} onChange={(event)=>setPersonName(event.target.value)} placeholder="Name the visible person…"/><button onClick={()=>void enrollPerson()} disabled={!personName.trim()||enrollmentBusy}>START GUIDED ENROLLMENT</button></div>}<div className="people-roster">{recognition.people.map((person)=><article key={person.id}><span>{person.primary?'★':'●'}</span><b>{person.name}</b><button onClick={()=>void recognition.forget(person.id)}>FORGET</button></article>)}</div></section></div>}{currentModule?.actions && <div className="quick-actions">{currentModule.actions.map((action)=><button key={action} onClick={()=>{setInput(action);setActiveView('CONVERSE');}}><span>TRY COMMAND</span>{action}</button>)}</div>}</>}
        {activeView === 'AUTOMATE' && <SmartHomePanel onCommand={(command)=>{setInput(command);setActiveView('CONVERSE');}}/>}
        {activeView === 'WEB' && <IntelPanel messages={messages} events={toolEvents} busy={busy} onCommand={(command)=>{setActiveView('CONVERSE');void sendText(command);}}/>}
        {activeView === 'SCREEN' && <section className="speaker-console"><header><b>CONTINUOUS MULTIMODAL IDENTITY</b><span>{speakerStatus.toUpperCase()} / {settings?.speakerProfiles?.length??0} ENROLLED</span></header><div className={`speaker-lock-state ${speakerStatus}`}><i/><p><b>{speakerStatus==='verified'?`${speakerName||'SPEAKER'} VERIFIED · ${speakerTrustSource.replace('-',' ').toUpperCase()}`:speakerStatus==='rejected'?'UNKNOWN SPEAKER':speakerStatus==='noise'?'IDENTITY INDETERMINATE':speakerStatus==='enrolling'?'GUIDED VOICE SCAN IN PROGRESS':settings?.speakerProfiles?.length?'VOICE LOCK ARMED':'ENROLLMENT REQUIRED'}</b><span>{enrollmentStatus}</span></p></div>{voiceStepIndex>=0&&<div className="guided-steps">{VOICE_ENROLLMENT_STEPS.map((step,index)=><i key={step.id} className={index<voiceStepIndex?'done':index===voiceStepIndex?'active':''}/>)}</div>}{voiceStepIndex>=0&&<div className="voice-enrollment-script"><b>READ ALOUD</b><p>“{VOICE_ENROLLMENT_SCRIPT}”</p></div>}<div className="person-enroll"><input value={speakerName} onChange={(event)=>setSpeakerName(event.target.value)} placeholder="Name this speaker…"/><button onClick={()=>void enrollSpeaker()} disabled={!speakerName.trim()||speakerStatus==='enrolling'}>{speakerStatus==='enrolling'?'LISTENING…':'START GUIDED VOICE SCAN'}</button></div><div className="people-roster speaker-roster">{settings?.speakerProfiles?.map((profile)=><article key={profile.id}><span>{profile.primary?'★':'◉'}</span><b>{profile.name} · {profile.sampleCount}/5 · {profile.model==='wavlm-base-plus-sv'?'WAVLM':'LEGACY'}</b><button onClick={()=>void forgetSpeaker(profile.id)}>FORGET</button></article>)}</div></section>}
        {activeView === 'SCREEN' && <DesktopGraphPanel graph={desktopGraph} busy={desktopGraphBusy} onRefresh={refreshDesktopGraph}/>} 
        {activeView === 'RUNTIME' && <><SystemDiagnosticsPanel telemetry={telemetry} onRefresh={async()=>setTelemetry(await window.axiom.getSystemTelemetry())}/><RuntimeCorePanel runtime={runtime} operational={operational} onRefresh={async()=>{await Promise.all([refreshRuntime(),window.axiom.getOperationalSnapshot(true).then(setOperational)]);}} onResume={async(task)=>{setActiveView('CONVERSE');await sendText(task.title,task.id);}}/></>} 
        {activeView === 'MEMORY' && <><form className="panel-entry memory-entry" onSubmit={addPanelItem}><select value={memoryKind} onChange={(event)=>setMemoryKind(event.target.value as MemoryKind)}>{(['fact','preference','person','project','decision','instruction'] as MemoryKind[]).map((kind)=><option key={kind} value={kind}>{kind.toUpperCase()}</option>)}</select><input value={panelDraft} onChange={(event)=>setPanelDraft(event.target.value)} placeholder="Add an explicit memory with provenance…"/><button>STORE</button></form><MemoryFabricPanel memories={memories} onForget={forgetMemory}/><section className="self-corrections-panel"><header><b>SELF-CORRECTIONS</b><span>{selfCorrections.length} LESSON{selfCorrections.length===1?'':'S'}</span></header><p className="settings-hint">Distinct from memory above — not facts about you, lessons about Axiom's own past mistakes, applied automatically to a matching future request.</p>{selfCorrections.length?selfCorrections.map((item)=><article key={item.id} className="self-correction-item"><div><b>{item.pattern}</b><span>{item.mistake}</span><span className="fix">→ {item.fix}</span></div><button onClick={()=>void forgetSelfCorrection(item.id)}>FORGET</button></article>):<div className="empty-state">No self-corrections recorded yet.</div>}</section></>}
        {activeView === 'GOALS' && <MissionControlPanel/>}
      </section>}
    </section>

    <aside className="telemetry">
      <div className="telemetry-bus" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="live-clock"><small>LOCAL NODE / CST</small><b>{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b><span>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()} <i /></span></div>
      <section className="ledger recent-activity"><header><span>CH–01</span><b>EVENT TRACE</b><em>LIVE</em></header>{toolEvents.length ? toolEvents.slice(0,5).map((tool, index) => <div className="event" key={`${tool.at}-${index}`}><span className="event-code">{String(index+1).padStart(2,'0')}</span><i className={tool.status} /><div><b>{tool.name.replaceAll('_', ' ')}</b><span>{tool.summary}</span></div><time>{new Date(tool.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>) : <div className="event"><span className="event-code">01</span><i className="verified"/><div><b>SYSTEM INITIALIZED</b><span>Neural interface ready</span></div><time>NOW</time></div>}</section>
      <VitalArray telemetry={telemetry} onOpen={()=>setActiveView('RUNTIME')}/>
      <OperationalTruth snapshot={operational} busy={busy} event={toolEvents[0]} onOpen={()=>setActiveView('RUNTIME')} onRefresh={()=>void window.axiom.getOperationalSnapshot(true).then(setOperational).catch(()=>{})}/>
      <section className="theme-reactor"><header><span>CH–05</span><b>VISUAL REACTOR</b><em>{appearance.motionProfile.toUpperCase()}</em></header><div className="theme-reactor-body"><label aria-label="Custom interface color"><input type="color" value={appearance.accentHex} onChange={(event)=>setAppearance((current)=>({...current,accentHex:event.target.value}))}/><i/></label><div><b>{appearance.color.toUpperCase()} / {appearance.emotion.toUpperCase()}</b><span>Whole-system accent · {Math.round(appearance.glowIntensity*100)}% glow</span></div><button onClick={()=>setSettingsOpen(true)}>TUNE</button></div><div className="theme-swatches">{(Object.keys(appearancePalette) as AppearanceColor[]).map((color)=><button key={color} aria-label={`Set ${color} theme`} className={appearance.color===color?'active':''} style={{'--swatch':appearancePalette[color]} as CSSProperties} onClick={()=>{const next={...appearance,color,accentHex:appearancePalette[color]};setAppearance(next);void window.axiom.saveSettings({model:modelDraft,appearance:next}).then((saved)=>setSettings(saved));}}/>)}</div></section>
      <section className={`presence presence-${tracking.status} ${presenceIdentityState.kind==='known'?'presence-known':''}`}><header><span>CH–04</span><b>PRESENCE LINK</b><em>{presenceIdentityState.kind==='known'?'ID LOCK':presenceIdentityState.kind==='unknown'?'UNVERIFIED':'SCAN'}</em></header><div className="presence-row"><span className="presence-reticle"><i/><b/><b/></span><div><b>{presenceIdentityState.kind==='known'?`${(presenceIdentityState.name||'TRUSTED PERSON').toUpperCase()} VERIFIED`:presenceIdentityState.kind==='unknown'?'UNRECOGNIZED FACE':tracking.status === 'locked' ? `${tracking.pose.source.toUpperCase()} LOCK / VERIFYING ID` : tracking.status === 'busy' ? 'CAMERA BUSY' : tracking.status.toUpperCase()}</b><span>{presenceIdentityState.kind==='known'?`Trusted multi-frame face match · ${recognition.observations.length} face${recognition.observations.length===1?'':'s'} visible.`:presenceIdentityState.kind==='unknown'?`No enrolled match for the visible face · ${recognition.observations.length} face${recognition.observations.length===1?'':'s'} visible.`:tracking.status === 'locked' ? `I see a person. Verifying against ${recognition.people.length} trusted face profile${recognition.people.length===1?'':'s'}…` : tracking.status === 'denied' ? 'Camera permission denied — retry after enabling access' : tracking.status === 'busy' ? 'Camera occupied — close the other app and retry' : tracking.status === 'error' ? 'Tracker fault — CPU recovery is available' : tracking.enabled ? 'Looking for you…' : 'Camera remains off'}</span></div><button onClick={() => tracking.status === 'busy' || tracking.status === 'denied' || tracking.status === 'error' || tracking.status === 'lost' ? tracking.retry() : tracking.setEnabled(!tracking.enabled)}>{tracking.status === 'busy' || tracking.status === 'denied' || tracking.status === 'error' || tracking.status === 'lost' ? 'RETRY' : tracking.enabled ? 'DISABLE' : 'ENABLE'}</button></div></section>
    </aside>

    {historyOpen && <div className="conversation-shade" onMouseDown={(event)=>{if(event.target===event.currentTarget)setHistoryOpen(false);}}><section className="conversation-log"><header><div><span>SESSION ARCHIVE</span><h2>Conversation history</h2></div><button onClick={()=>setHistoryOpen(false)}>×</button></header><div className="conversation-scroll">{messages.length?messages.map((message)=><article key={message.id} className={`${message.role}${message.tone?` reply-tone-${message.tone}`:''}`}><div><b>{message.role==='user'?'ROBBIE':'AXIOM'}</b>{message.tone==='concern'&&<em className="tone-badge">CONCERN</em>}{message.tone==='uncertain'&&<em className="tone-badge">UNCERTAIN</em>}<time>{new Date(message.createdAt).toLocaleString()}</time></div><p><MessageText text={message.text}/></p></article>):<div className="empty-state">No conversation history yet.</div>}</div><footer><span>{messages.length} encrypted local messages</span><button className={confirmClearHistory?'confirm':''} onClick={()=>void clearConversation()}>{confirmClearHistory?'CONFIRM CLEAR':'CLEAR HISTORY'}</button></footer></section></div>}

    {settingsOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="settings-card">
        <header><div><span>SECURE CONFIGURATION / ALL SYSTEMS</span><h2>Axiom Control Center</h2></div><button onClick={() => setSettingsOpen(false)}>×</button></header>
        <p>Tune appearance, intelligence, voice, identity, autonomy, services, devices, and performance in one place. Credentials are encrypted by {settings?.secureStorageLabel||'the operating system'} and never exposed to web content.</p>
        <div className="setup-progress"><div className={settings?.hasSelectedAIKey?'done':''}><i>01</i><span>AI CORE</span></div><div className={(speechProviderDraft==='system'||speechProviderDraft==='openai'&&settings?.hasOpenAIKey||speechProviderDraft==='elevenlabs'&&settings?.hasElevenLabsKey)?'done':''}><i>02</i><span>VOICE</span></div><div className={tracking.status==='locked'?'done':''}><i>03</i><span>PRESENCE</span></div><div className={diagnostics.length&&diagnostics.every((item)=>item.ok||item.detail.includes('optional'))?'done':''}><i>04</i><span>DIAGNOSTICS</span></div></div>
        <div className="settings-commandbar"><div><span>FIND A SETTING</span><input value={settingsQuery} onChange={(event)=>setSettingsQuery(event.target.value)} placeholder="Search voice, color, model, camera, sync…"/></div><nav>{settingSections.filter((section)=>!settingsQuery||`${section.label} ${section.terms}`.toLowerCase().includes(settingsQuery.toLowerCase())).map((section)=><button key={section.id} onClick={()=>jumpToSettingsSection(section.id)}>{section.label}<span>↘</span></button>)}</nav></div>
        <div className="settings-essentials">
          <button type="button" className="settings-essential" onClick={()=>jumpToSettingsSection('settings-ai')}><b>AI PROVIDER</b><span>{providerDraft==='anthropic'?'Claude':providerDraft.toUpperCase()} · {modelDraft}</span><i className={settings?.hasSelectedAIKey?'ok':''}>{settings?.hasSelectedAIKey?'CONNECTED':'NEEDS A KEY'}</i></button>
          <button type="button" className="settings-essential" onClick={()=>jumpToSettingsSection('settings-voice')}><b>VOICE</b><span>{speechProviderDraft==='elevenlabs'?(voiceNameDraft||'ElevenLabs'):speechProviderDraft.toUpperCase()}</span><i className={speechProviderDraft==='system'||speechProviderDraft==='openai'&&settings?.hasOpenAIKey||speechProviderDraft==='elevenlabs'&&settings?.hasElevenLabsKey?'ok':''}>{speechProviderDraft==='system'||speechProviderDraft==='openai'&&settings?.hasOpenAIKey||speechProviderDraft==='elevenlabs'&&settings?.hasElevenLabsKey?'READY':'NEEDS A KEY'}</i></button>
          <button type="button" className="settings-essential" onClick={()=>jumpToSettingsSection('settings-permissions')}><b>PERMISSIONS</b><span>{permissions.filter((item)=>item.enabled).length} of {permissions.length} categories</span><i className="ok">{permissions.every((item)=>item.enabled)?'ALL ALLOWED':'SOME BLOCKED'}</i></button>
        </div>
        <div className="settings-scroll">
          <SettingsSection id="settings-appearance" icon={settingSections[0].icon} title={settingSections[0].label} summary={settingSections[0].summary} open={openSettingsSection==='settings-appearance'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-appearance'?null:'settings-appearance')}>
          <section className="appearance-console"><div className="appearance-preview"><div className="mini-orbit"><i/><b>A</b></div><p><b>LIVE VISUAL IDENTITY</b><span>Ask Axiom: “Make your whole interface violet, cinematic, and focused.”</span></p></div><div className="appearance-palette">{(Object.keys(appearancePalette) as AppearanceColor[]).map((color)=><button key={color} className={appearance.color===color?'active':''} style={{'--swatch':appearancePalette[color]} as CSSProperties} onClick={()=>setAppearance((current)=>({...current,color,accentHex:appearancePalette[color]}))}><i/>{color}</button>)}</div><div className="appearance-controls"><label>CUSTOM ACCENT <input type="color" value={appearance.accentHex} onChange={(event)=>setAppearance((current)=>({...current,accentHex:event.target.value}))}/><b>{appearance.accentHex.toUpperCase()}</b></label><label>GLOW <b>{Math.round(appearance.glowIntensity*100)}%</b><input type="range" min=".35" max="1.5" step=".05" value={appearance.glowIntensity} onChange={(event)=>setAppearance((current)=>({...current,glowIntensity:Number(event.target.value)}))}/></label><label>MOTION PROFILE<select value={appearance.motionProfile} onChange={(event)=>setAppearance((current)=>({...current,motionProfile:event.target.value as Appearance['motionProfile']}))}><option value="adaptive">Adaptive — balances motion and load</option><option value="cinematic">Cinematic — full ambient motion</option><option value="efficient">Efficient — GPU transforms, fewer layers</option><option value="reduced">Reduced — accessibility / lowest load</option></select></label><label>INTERFACE DENSITY<select value={appearance.density} onChange={(event)=>setAppearance((current)=>({...current,density:event.target.value as Appearance['density']}))}><option value="compact">Compact</option><option value="balanced">Balanced</option><option value="spacious">Spacious</option></select></label></div></section>
          </SettingsSection>
          <SettingsSection id="settings-ai" icon={settingSections[1].icon} title={settingSections[1].label} summary={settingSections[1].summary} open={openSettingsSection==='settings-ai'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-ai'?null:'settings-ai')}>
          <div className="provider-tabs">{(['openai','anthropic','gemini'] as AIProvider[]).map((provider)=><button key={provider} className={providerDraft===provider?'selected':''} onClick={()=>{setProviderDraft(provider);setModelDraft(settings?.providerModels[provider]||providerDefaults[provider]);}}><i className={settings?.[provider==='openai'?'hasOpenAIKey':provider==='anthropic'?'hasAnthropicKey':'hasGeminiKey']?'stored':''}/>{provider==='anthropic'?'CLAUDE':provider.toUpperCase()}<small>{providerHealth.find((item)=>item.provider===provider)?.state.toUpperCase()||'UNKNOWN'}</small></button>)}</div>
          <div className="settings-grid provider-keys">
            <label>OpenAI key <em>{settings?.hasOpenAIKey?'SAVED':'EMPTY'}</em><input type="password" value={keyDraft} onChange={(event)=>setKeyDraft(event.target.value)} placeholder={settings?.hasOpenAIKey?'Encrypted — enter to replace':'sk-proj-…'} autoComplete="off"/>{settings?.hasOpenAIKey&&<button className="key-clear" onClick={()=>void clearCredential('openai')}>REMOVE SAVED KEY</button>}</label>
            <label>Anthropic key <em>{settings?.hasAnthropicKey?'SAVED':'EMPTY'}</em><input type="password" value={anthropicKeyDraft} onChange={(event)=>setAnthropicKeyDraft(event.target.value)} placeholder={settings?.hasAnthropicKey?'Encrypted — enter to replace':'sk-ant-…'} autoComplete="off"/>{settings?.hasAnthropicKey&&<button className="key-clear" onClick={()=>void clearCredential('anthropic')}>REMOVE SAVED KEY</button>}</label>
            <label>Gemini key <em>{settings?.hasGeminiKey?'SAVED':'EMPTY'}</em><input type="password" value={geminiKeyDraft} onChange={(event)=>setGeminiKeyDraft(event.target.value)} placeholder={settings?.hasGeminiKey?'Encrypted — enter to replace':'AIza…'} autoComplete="off"/>{settings?.hasGeminiKey&&<button className="key-clear" onClick={()=>void clearCredential('gemini')}>REMOVE SAVED KEY</button>}</label>
            <label>Owner override phrase <em>{settings?.hasOwnerOverridePhrase?'SAVED':'EMPTY'}</em><input type="password" value={ownerOverrideDraft} onChange={(event)=>setOwnerOverrideDraft(event.target.value)} placeholder={settings?.hasOwnerOverridePhrase?'Encrypted — enter to replace':'A secret phrase, 8+ characters — not your name'} autoComplete="off"/>{settings?.hasOwnerOverridePhrase&&<button className="key-clear" onClick={()=>void clearOwnerOverride()}>REMOVE PHRASE</button>}<span className="settings-hint">If Presence Link can't confirm you biometrically, say or type any message containing the word "override" plus this exact phrase to restore full trust for that turn. Locks out for 10 minutes after 5 wrong attempts.</span></label>
          </div>
          <div className="settings-grid compact"><label>Active model<input list="model-options" value={modelDraft} onChange={(event)=>setModelDraft(event.target.value)}/><datalist id="model-options"><option value="gpt-5.6-luna"/><option value="gpt-5.6-terra"/><option value="claude-sonnet-5"/><option value="gemini-3.6-flash"/></datalist></label><button className="secondary" onClick={()=>void (async()=>{await saveSettings();await testProvider(providerDraft);})()}>TEST AI CONNECTION</button></div>
          <div className="adaptive-router"><div><label className="toggle-line"><input type="checkbox" checked={autoFailover} onChange={(event)=>setAutoFailover(event.target.checked)}/><span><b>AUTOMATIC SAFE FAILOVER</b><small>Recover ordinary conversation automatically. Desktop, file-write, installation, and other mutating requests are never replayed.</small></span></label><div className="task-routes"><label>CODING CORE<select value={codingProvider} onChange={(event)=>setCodingProvider(event.target.value as AIProvider)}>{fallbackOrder.map((provider)=><option key={provider} value={provider}>{provider==='anthropic'?'Claude':provider}</option>)}</select></label><label>LIVE RESEARCH CORE<select value={researchProvider} onChange={(event)=>setResearchProvider(event.target.value as AIProvider)}>{fallbackOrder.map((provider)=><option key={provider} value={provider}>{provider==='anthropic'?'Claude':provider}</option>)}</select></label></div></div><div className="fallback-order"><b>FALLBACK PRIORITY</b>{fallbackOrder.map((provider,index)=><div key={provider}><span>{index+1}</span><strong>{provider==='anthropic'?'CLAUDE':provider.toUpperCase()}</strong><button disabled={index===0} onClick={()=>moveFallback(provider,-1)}>↑</button><button disabled={index===fallbackOrder.length-1} onClick={()=>moveFallback(provider,1)}>↓</button></div>)}</div></div>
          </SettingsSection>
          <SettingsSection id="settings-voice" icon={settingSections[2].icon} title={settingSections[2].label} summary={settingSections[2].summary} open={openSettingsSection==='settings-voice'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-voice'?null:'settings-voice')}>
          <div className="provider-tabs voice-tabs">{(['elevenlabs','openai','system'] as SpeechProvider[]).map((provider)=><button key={provider} className={speechProviderDraft===provider?'selected':''} onClick={()=>setSpeechProviderDraft(provider)}>{provider.toUpperCase()}</button>)}</div>
          <div className="voice-delivery"><label>DELIVERY SPEED <b>{voiceSpeed.toFixed(2)}×</b><input type="range" min=".7" max="1.2" step=".01" value={voiceSpeed} onChange={(event)=>setVoiceSpeed(Number(event.target.value))}/><small>Applies to OpenAI, ElevenLabs, and system voices.</small></label></div>
          <label className="toggle-line microphone-startup"><input type="checkbox" checked={startMicrophoneOn} onChange={(event)=>setStartMicrophoneOn(event.target.checked)}/><span><b>HANDS-FREE CONVERSATION</b><small>Enabled by default. Axiom detects when you finish speaking, responds automatically, then resumes listening.</small></span></label>
          <label className="toggle-line microphone-startup"><input type="checkbox" checked={speakerLockEnabled} onChange={(event)=>setSpeakerLockEnabled(event.target.checked)}/><span><b>PERSONAL VOICE LOCK</b><small>When an enrolled profile exists, only a verified speaker reaches Axiom. Background voices and unrecognized people are silently rejected.</small></span></label>
          {speakerLockEnabled&&!settings?.speakerProfiles?.length&&<div className="connector-message fault">⚠ Voice Lock is on, but no voice is enrolled yet — it isn't protecting anything right now. Any speaker, including background noise or a TV, is currently accepted. Complete a <b>START GUIDED VOICE SCAN</b> on the SCREEN tab to actually activate it.</div>}
          <div className="microphone-console"><div className="settings-grid compact"><label>Active microphone<select value={microphoneIdDraft} onChange={(event)=>{const device=microphones.find((item)=>item.deviceId===event.target.value);setMicrophoneIdDraft(event.target.value);setMicrophoneLabelDraft(device?.label||'System default');}}><option value="">System default</option>{microphones.filter((device)=>device.deviceId&&device.deviceId!=='default').map((device,index)=><option value={device.deviceId} key={device.deviceId}>{device.label||`Microphone ${index+1}`}</option>)}</select></label><button className="secondary" onClick={()=>void calibrateMicrophone()} disabled={microphoneCalibrating}>{microphoneCalibrating?'SAMPLING ROOM…':'CALIBRATE NOISE FLOOR'}</button></div><div className="microphone-readout"><span>AMBIENT <b>{microphoneNoiseFloor.toFixed(4)}</b></span><span>SPEECH GATE <b>{microphoneSpeechThreshold.toFixed(4)}</b></span><span>{settings?.microphoneCalibratedAt?`CALIBRATED ${new Date(settings.microphoneCalibratedAt).toLocaleString()}`:'ADAPTIVE DEFAULT ACTIVE'}</span></div></div>
          {speechProviderDraft==='elevenlabs'&&<div className="voice-console">
            <div className="settings-grid compact"><label>ElevenLabs key <em>{settings?.hasElevenLabsKey?'SAVED':'EMPTY'}</em><input type="password" value={elevenKeyDraft} onChange={(event)=>setElevenKeyDraft(event.target.value)} placeholder={settings?.hasElevenLabsKey?'Encrypted — enter to replace':'xi-api-key'} autoComplete="off"/>{settings?.hasElevenLabsKey&&<button className="key-clear" onClick={()=>void clearCredential('elevenlabs')}>REMOVE SAVED KEY</button>}</label><button className="secondary" onClick={()=>void loadVoices()}>LOAD MY VOICES</button></div>
            <div className="settings-grid"><label>Voice<select value={voiceIdDraft} onChange={(event)=>{const voice=voices.find((item)=>item.voiceId===event.target.value);setVoiceIdDraft(event.target.value);setVoiceNameDraft(voice?.name||'Custom voice');}}><option value={voiceIdDraft}>{voiceNameDraft||'Selected voice'}</option>{voices.filter((voice)=>voice.voiceId!==voiceIdDraft).map((voice)=><option key={voice.voiceId} value={voice.voiceId}>{voice.name} — {voice.category}</option>)}</select></label><label>Voice model<select value={elevenModelDraft} onChange={(event)=>setElevenModelDraft(event.target.value)}><option value="eleven_flash_v2_5">Flash v2.5 — fastest</option><option value="eleven_turbo_v2_5">Turbo v2.5 — balanced</option><option value="eleven_multilingual_v2">Multilingual v2 — quality</option></select></label></div>
            <div className="voice-sliders"><label>Stability <b>{voiceStability.toFixed(2)}</b><input type="range" min="0" max="1" step=".01" value={voiceStability} onChange={(event)=>setVoiceStability(Number(event.target.value))}/></label><label>Similarity <b>{voiceSimilarity.toFixed(2)}</b><input type="range" min="0" max="1" step=".01" value={voiceSimilarity} onChange={(event)=>setVoiceSimilarity(Number(event.target.value))}/></label><label>Style <b>{voiceStyle.toFixed(2)}</b><input type="range" min="0" max="1" step=".01" value={voiceStyle} onChange={(event)=>setVoiceStyle(Number(event.target.value))}/></label></div>
            <div className="mouth-calibration"><div><b>VOICE-SPECIFIC MOUTH CALIBRATION</b><span>{voiceNameDraft||'Selected voice'} · {mouthOffsetMs>=0?'+':''}{mouthOffsetMs} ms · {mouthGain.toFixed(2)}× · timestamp driven</span></div><button className="secondary" onClick={()=>void calibrateMouth()} disabled={mouthCalibrating}>{mouthCalibrating?'ANALYZING VOICE…':'AUTO-CALIBRATE MOUTH'}</button></div>
            <div className="voice-profiles"><div><input value={voiceProfileName} onChange={(event)=>setVoiceProfileName(event.target.value)} placeholder="Name this voice profile…"/><button className="secondary" onClick={()=>void saveVoiceProfile()} disabled={!voiceProfileName.trim()}>SAVE PROFILE</button></div>{settings?.voiceProfiles.map((profile)=><button key={profile.id} className={settings.activeVoiceProfileId===profile.id?'active':''} onClick={()=>void window.axiom.activateVoiceProfile(profile.id).then(applyVoiceSettings)}><span>{profile.name}<small>{profile.provider.toUpperCase()} · {profile.elevenLabsVoiceName}</small></span><i onClick={(event)=>{event.stopPropagation();void window.axiom.deleteVoiceProfile(profile.id).then(applyVoiceSettings);}}>×</i></button>)}</div>
            <div className="settings-actions"><button className="secondary" onClick={()=>window.open('https://elevenlabs.io/app/voice-lab','_blank','noopener,noreferrer')}>CREATE / CLONE VOICE</button><button className="secondary" onClick={()=>void testProvider('elevenlabs')}>TEST ELEVENLABS</button><button className="secondary" onClick={()=>void previewVoice()}>PREVIEW VOICE</button></div>
          </div>}
          {speechProviderDraft==='openai'&&<p className="context-note">Uses OpenAI’s natural speech voice. An OpenAI key must be saved even if another AI brain is active.</p>}
          {speechProviderDraft==='system'&&<p className="context-note">Uses a {settings?.platformLabel||'computer'} system voice with no cloud speech charge.</p>}
          <p className="context-note">Microphone transcription currently uses OpenAI’s speech-to-text API, so voice commands require an OpenAI key. Typed commands use whichever AI provider is active.</p>
          </SettingsSection>
          <SettingsSection id="settings-trust" icon={settingSections[3].icon} title={settingSections[3].label} summary={settingSections[3].summary} open={openSettingsSection==='settings-trust'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-trust'?null:'settings-trust')}>
          <div className="trust-tiers">
            <article><b>RUNS AUTOMATICALLY</b><span>Read-only and reversible actions — searching, reading files, checking status, undoable settings changes (see REVERT above). No approval step; these already never needed one.</span></article>
            <article><b>ALWAYS ASKS FIRST</b><span>Money, sending anything external (email, messages), destructive deletes, and PowerShell execution. This line does not move — not a setting, not something a request in chat can turn off.</span></article>
          </div>
          </SettingsSection>
          <SettingsSection id="settings-permissions" icon={settingSections[4].icon} title={settingSections[4].label} summary={settingSections[4].summary} open={openSettingsSection==='settings-permissions'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-permissions'?null:'settings-permissions')}>
          <p className="context-note">Every category Axiom can act in, grouped and explicit. Turn any of these off to block it outright — Axiom will say the capability is disabled rather than silently doing nothing. These toggles don't override the line above: destructive actions (closing an app, deleting a file, running PowerShell) always pause for a one-time approval regardless of these settings. Approve one by saying <b>APPROVE</b> plus the code Axiom gives you, or from the pending queue in the RUNTIME tab's PERMISSION KERNEL panel.</p>
          {PERMISSION_CATEGORIES.map((category)=>{const items=permissions.filter((permission)=>category.ids.includes(permission.id));if(!items.length)return null;return <div key={category.label} className="permission-category"><header><b>{category.label}</b><span>{category.detail}</span></header><div className="module-grid">{items.map((permission)=><article key={permission.id}><i className={permission.enabled?'enabled':''}/><div><b>{permission.label}</b><span>{permission.risk.toUpperCase()} ACCESS / {permission.enabled?'ALLOWED':'BLOCKED'}</span></div><button onClick={()=>void togglePermission(permission)}>{permission.enabled?'BLOCK':'ALLOW'}</button></article>)}</div></div>;})}
          {uncategorizedPermissions.length>0&&<div className="permission-category"><header><b>OTHER</b><span>Everything else Axiom is currently registered to do.</span></header><div className="module-grid">{uncategorizedPermissions.map((permission)=><article key={permission.id}><i className={permission.enabled?'enabled':''}/><div><b>{permission.label}</b><span>{permission.risk.toUpperCase()} ACCESS / {permission.enabled?'ALLOWED':'BLOCKED'}</span></div><button onClick={()=>void togglePermission(permission)}>{permission.enabled?'BLOCK':'ALLOW'}</button></article>)}</div></div>}
          </SettingsSection>
          <SettingsSection id="settings-changelog" icon={settingSections[5].icon} title={settingSections[5].label} summary={settingSections[5].summary} open={openSettingsSection==='settings-changelog'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-changelog'?null:'settings-changelog')}>
          <div className="behavior-changelog">
            {BEHAVIOR_CHANGELOG.map((entry)=><article key={entry.version}><b>v{entry.version}</b><span>{entry.summary}</span></article>)}
          </div>
          </SettingsSection>
          <SettingsSection id="settings-control" icon={settingSections[6].icon} title={settingSections[6].label} summary={settingSections[6].summary} open={openSettingsSection==='settings-control'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-control'?null:'settings-control')}>
          <label>Coding workspace<input value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder={settings?.platform==='macos'?'/Users/you/Documents/Axiom Projects':'C:\\Users\\You\\Documents\\Axiom Projects'} /></label>
          <label>God's Eye View project folder <em>{settings?.platform==='macos'?'MAC ONLY — FOR NOW':'AVAILABLE ON MAC ONLY'}</em><input value={godsEyeViewPathDraft} onChange={(event)=>setGodsEyeViewPathDraft(event.target.value)} placeholder="/Users/you/Desktop/gods-eye-view" /></label>
          <p className="context-note">Click either eye on the skull to open your God's Eye View globe embedded in Axiom's window. Windows support is planned but not built yet.</p>
          <label className="toggle-line microphone-startup"><input type="checkbox" checked={automaticBackupsEnabled} onChange={(event)=>setAutomaticBackupsEnabled(event.target.checked)}/><span><b>DAILY VERIFIED BACKUPS</b><small>After 2:00 AM, the background runtime writes one integrity-checked Axiom backup per day to your Desktop.</small></span></label>
          {settingsSnapshot&&<div className="settings-revert-row"><span><b>LAST CHANGE</b> {settingsSnapshot.label} · {new Date(settingsSnapshot.at).toLocaleString([], {hour:'2-digit',minute:'2-digit'})}</span><button className="secondary" disabled={revertingSettings} onClick={()=>void revertSettings()}>{revertingSettings?'REVERTING…':'REVERT'}</button></div>}
          </SettingsSection>
          <SettingsSection id="settings-services" icon={settingSections[7].icon} title={settingSections[7].label} summary={settingSections[7].summary} open={openSettingsSection==='settings-services'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-services'?null:'settings-services')}>
          <ConnectorMatrix/>
          </SettingsSection>
          <SettingsSection id="settings-sync" icon={settingSections[8].icon} title={settingSections[8].label} summary={settingSections[8].summary} open={openSettingsSection==='settings-sync'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-sync'?null:'settings-sync')}>
          <div className="sync-console">
            <p>Continue as the same Axiom on Windows and Mac. Shared memory is end-to-end encrypted; API keys, permissions, local paths, and camera settings stay on each computer.</p>
            <div className="settings-grid"><label>This device<input value={deviceNameDraft} onChange={(event)=>setDeviceNameDraft(event.target.value)} placeholder="Robbie's MacBook"/></label><label>Shared cloud folder<input value={syncFolderDraft} onChange={(event)=>setSyncFolderDraft(event.target.value)} placeholder={settings?.platform==='macos'?'/Users/you/Library/Mobile Documents/…/Axiom Sync':'C:\\Users\\You\\OneDrive\\Axiom Sync'}/></label></div>
            <div className="settings-grid compact"><label>Shared sync passphrase <em>{settings?.hasSyncPassphrase?'SAVED ON THIS DEVICE':'REQUIRED'}</em><input type="password" value={syncPassphraseDraft} onChange={(event)=>setSyncPassphraseDraft(event.target.value)} placeholder={settings?.hasSyncPassphrase?'Encrypted — enter only to replace':'At least 12 characters'} autoComplete="new-password"/></label><button className="secondary" onClick={()=>void synchronizeNow()} disabled={!syncEnabledDraft}>SYNC NOW</button></div>
            <label className="toggle-line"><input type="checkbox" checked={syncEnabledDraft} onChange={(event)=>setSyncEnabledDraft(event.target.checked)}/><span><b>ENCRYPTED CROSS-DEVICE CONTINUITY</b><small>Sync conversation context, memories, goals, commitments, skills, voice profiles, appearance, and active-device presence every 12 seconds.</small></span></label>
            <div className={`sync-state ${syncStatus?.state||'off'}`}><i/><p><b>{syncStatus?.state==='ready'?'IDENTITY LINK READY':syncStatus?.state==='syncing'?'SYNCHRONIZING':syncStatus?.state==='error'?'SYNC NEEDS ATTENTION':syncEnabledDraft?'FINISH SYNC SETUP':'SYNC IS OFF'}</b><span>{syncStatus?.lastError||(syncStatus?.lastSyncAt?`${syncStatus.peers.length} peer device(s) · ${syncStatus.voiceOwnedHere?'voice active here':`voice active on ${syncStatus.voiceOwner?.name||'another device'}`} · last sync ${new Date(syncStatus.lastSyncAt).toLocaleString()}`:'Choose a folder available through OneDrive, iCloud Drive, or Dropbox on both computers.')}</span></p></div>
            {Boolean(syncStatus?.peers.length)&&<div className="sync-peers">{syncStatus!.peers.map((peer)=>{const heartbeat=peer.heartbeatAt||peer.lastSeenAt,online=Date.now()-Date.parse(heartbeat)<40_000;return <div key={peer.id}><i className={online?'online':''}/><p><b>{peer.name}</b><span>{peer.platform.toUpperCase()} · {peer.architecture} · {online?(peer.sessionState==='active'?'ACTIVE NOW':'ONLINE / IDLE'):`OFFLINE · seen ${new Date(peer.lastSeenAt).toLocaleString()}`}</span></p></div>;})}</div>}
          </div>
          </SettingsSection>
          <SettingsSection id="settings-updates" icon={settingSections[9].icon} title={settingSections[9].label} summary={settingSections[9].summary} open={openSettingsSection==='settings-updates'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-updates'?null:'settings-updates')}>
          <div className="backup-console">
            <p>Axiom is running version {appVersion||'—'}. A configured update feed lets Axiom check for a newer signed release, verify its checksum before download completes, and open the installer for you to run — Axiom never installs anything without you seeing it happen.</p>
            <div className="settings-grid compact">
              <label>Update feed URL <em>{updateFeedDraft?'CONFIGURED':'NOT CONFIGURED'}</em><input value={updateFeedDraft} onChange={(event)=>setUpdateFeedDraft(event.target.value)} placeholder="https://updates.example.com/axiom/manifest.json"/></label>
              <button className="secondary" disabled={updateCheckBusy||!updateFeedDraft} onClick={()=>{
                setUpdateCheckBusy(true);setUpdateResult(null);
                void window.axiom.saveSettings({model:modelDraft,codingWorkspace:workspaceDraft,updateFeedUrl:updateFeedDraft} as never)
                  .then(()=>window.axiom.checkForUpdate())
                  .then((result)=>{setUpdateResult(result);setSettingsStatus(result.ok?(result.updateAvailable?`Update available: ${result.latestVersion}.`:'Axiom is up to date.'):result.error||'Update check failed.');})
                  .catch((reason)=>setSettingsStatus(String(reason)))
                  .finally(()=>setUpdateCheckBusy(false));
              }}>{updateCheckBusy?'CHECKING…':'CHECK FOR UPDATES'}</button>
            </div>
            {updateResult&&<div className={`update-state ${updateResult.ok?(updateResult.updateAvailable?'available':'current'):'error'}`}>
              <i/>
              <p>
                <b>{!updateResult.ok?'CHECK FAILED':updateResult.mustUpdate?'THIS VERSION IS NO LONGER SUPPORTED':updateResult.updateAvailable?`UPDATE AVAILABLE: ${updateResult.latestVersion}`:'UP TO DATE'}</b>
                <span>{!updateResult.ok?updateResult.error:updateResult.updateAvailable?(updateResult.notes||'Download and verify before installing.'):`Running the latest published version (${updateResult.currentVersion}).`}</span>
              </p>
            </div>}
            {updateResult?.ok&&updateResult.updateAvailable&&<div className="settings-actions">
              {!updatePath
                ? <button className="secondary" disabled={updateDownloadBusy} onClick={()=>{
                    setUpdateDownloadBusy(true);
                    void window.axiom.downloadUpdate()
                      .then((result)=>{if(result.ok&&result.path){setUpdatePath(result.path);setSettingsStatus('Update downloaded and its checksum verified. Ready to open.');}else setSettingsStatus(result.error||'Download failed.');})
                      .catch((reason)=>setSettingsStatus(String(reason)))
                      .finally(()=>setUpdateDownloadBusy(false));
                  }}>{updateDownloadBusy?'DOWNLOADING + VERIFYING…':'DOWNLOAD & VERIFY UPDATE'}</button>
                : <button className="primary" onClick={()=>void window.axiom.openUpdateInstaller(updatePath).then(()=>setSettingsStatus('Installer opened. Finish the install, then restart Axiom.')).catch((reason)=>setSettingsStatus(String(reason)))}>OPEN VERIFIED INSTALLER</button>}
            </div>}
          </div>
          </SettingsSection>
          <SettingsSection id="settings-data" icon={settingSections[10].icon} title={settingSections[10].label} summary={settingSections[10].summary} open={openSettingsSection==='settings-data'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-data'?null:'settings-data')}>
          <div className="backup-console">
            <p>Export a plain-text copy of everything Axiom has recorded about you — conversation, memory, enrolled face and voice data, and presence history — to inspect or move elsewhere. Or permanently erase all of it from this computer.</p>
            <div className="settings-actions">
              <button className="secondary" onClick={()=>void window.axiom.exportAllData().then((result)=>setSettingsStatus(`Data export saved: ${result.path} (${Math.round(result.bytes/1024)} KB).`)).catch((reason)=>setSettingsStatus(String(reason)))}>EXPORT MY DATA</button>
            </div>
            <div className="erase-zone">
              <p><b>PERMANENTLY ERASE ALL LOCAL DATA</b> — conversation, memory, biometric enrollments, visitor evidence, generated media, API keys, and sync identity. This cannot be undone. Type <code>DELETE ALL AXIOM DATA</code> to confirm.</p>
              <div className="settings-grid compact">
                <input value={eraseConfirmText} onChange={(event)=>setEraseConfirmText(event.target.value)} placeholder="DELETE ALL AXIOM DATA"/>
                <button className="danger" disabled={eraseBusy||eraseConfirmText!=='DELETE ALL AXIOM DATA'} onClick={()=>{
                  setEraseBusy(true);
                  void window.axiom.eraseAllData(eraseConfirmText)
                    .then(async(result)=>{setSettings(await window.axiom.getSettings());setMessages([]);setEraseConfirmText('');setSettingsStatus(`All local Axiom data was erased. ${result.filesRemoved} file(s) removed.`);})
                    .catch((reason)=>setSettingsStatus(String(reason instanceof Error?reason.message:reason)))
                    .finally(()=>setEraseBusy(false));
                }}>{eraseBusy?'ERASING…':'ERASE EVERYTHING'}</button>
              </div>
            </div>
          </div>
          </SettingsSection>
          <SettingsSection id="settings-consent" icon={settingSections[11].icon} title={settingSections[11].label} summary={settingSections[11].summary} open={openSettingsSection==='settings-consent'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-consent'?null:'settings-consent')}>
          <div className="backup-console">
            {settings?.biometricConsent?.acknowledged
              ? <div className="consent-granted"><i/><p><b>ACKNOWLEDGED {settings.biometricConsent.at?new Date(settings.biometricConsent.at).toLocaleString():''}</b><span>Face and voice identity capture are permitted on this device. Withdrawing stops all future capture immediately.</span></p></div>
              : <div className="backup-warning"><i/><p><b>REQUIRED BEFORE ANY BIOMETRIC CAPTURE</b><span>Face and voice identity are paused until this is acknowledged.</span></p></div>}
            <ul className="consent-terms">
              <li><b>What is collected</b> — mathematical face descriptors and voice embeddings for people you enroll, used only to recognize who Axiom is talking to.</li>
              <li><b>Where it is stored</b> — only on this computer, encrypted by {settings?.secureStorageLabel||'operating-system secure storage'}. Raw microphone audio is never sent for identification, and biometric templates are excluded from cross-device sync.</li>
              <li><b>How long it is kept</b> — enrolled identities are kept until you delete them.</li>
              <li><b>Your responsibility</b> — people whose faces or voices you enroll have rights over their biometric data in many jurisdictions. You are the operator: obtain consent from anyone you enroll.</li>
            </ul>
            <div className="settings-actions">
              {settings?.biometricConsent?.acknowledged
                ? <button className="secondary" onClick={()=>void window.axiom.saveSettings({model:modelDraft,codingWorkspace:workspaceDraft,withdrawBiometricConsent:true}).then((next)=>{setSettings(next);setSettingsStatus('Biometric consent withdrawn. Face and voice identity are off; no further capture will occur.');}).catch((reason)=>setSettingsStatus(String(reason)))}>WITHDRAW CONSENT</button>
                : <button className="secondary" onClick={()=>void window.axiom.saveSettings({model:modelDraft,codingWorkspace:workspaceDraft,acknowledgeBiometricConsent:true}).then((next)=>{setSettings(next);setSettingsStatus('Biometric consent recorded.');}).catch((reason)=>setSettingsStatus(String(reason)))}>I ACKNOWLEDGE AND CONSENT</button>}
            </div>
          </div>
          </SettingsSection>
          <SettingsSection id="settings-backup" icon={settingSections[12].icon} title={settingSections[12].label} summary={settingSections[12].summary} open={openSettingsSection==='settings-backup'} onToggle={()=>setOpenSettingsSection((current)=>current==='settings-backup'?null:'settings-backup')}>
          <div className="backup-console">
            <p>A plain backup only works on this computer: credentials are sealed with a key that never leaves this machine. A portable backup re-encrypts every secret under a passphrase you choose, so it can be restored on your other computer — including across Windows and Mac.</p>
            {Boolean(settings?.unreadableCredentials?.length)&&<div className="backup-warning"><i/><p><b>SAVED BUT UNREADABLE ON THIS DEVICE</b><span>{settings!.unreadableCredentials.join(', ')}. These were encrypted on a different machine or profile. Re-enter them above, or restore a portable backup.</span></p></div>}
            <div className="settings-grid compact">
              <label>Backup passphrase <em>{backupPassphrase.length>=12?'READY':'AT LEAST 12 CHARACTERS'}</em><input type="password" value={backupPassphrase} onChange={(event)=>setBackupPassphrase(event.target.value)} placeholder="You will need this exact passphrase to restore" autoComplete="new-password"/></label>
              <button className="secondary" disabled={backupBusy||backupPassphrase.length<12} onClick={()=>{
                setBackupBusy(true);
                void window.axiom.createPortableBackup(backupPassphrase)
                  .then((result)=>setSettingsStatus(`Portable backup saved: ${result.path} · ${result.secrets} secret(s) re-encrypted${result.skipped.length?` · ${result.skipped.length} unreadable secret(s) omitted`:''}`))
                  .catch((reason)=>setSettingsStatus(String(reason instanceof Error?reason.message:reason)))
                  .finally(()=>setBackupBusy(false));
              }}>{backupBusy?'WORKING…':'CREATE PORTABLE BACKUP'}</button>
            </div>
            <div className="settings-actions">
              <button className="secondary" disabled={backupBusy} onClick={()=>{
                void window.axiom.chooseBackupFile().then((file)=>{
                  if(!file)return;
                  if(backupPassphrase.length<12){setSettingsStatus('Enter the passphrase that was used to create that backup, then choose the file again.');return;}
                  setBackupBusy(true);
                  return window.axiom.restorePortableBackup(file,backupPassphrase)
                    .then(async(result)=>{setSettings(await window.axiom.getSettings());setSettingsStatus(`Restored ${result.restored} secret(s) from ${new Date(result.createdAt).toLocaleString()}${result.skipped.length?` · ${result.skipped.length} could not be decrypted`:''}. Re-encrypted for this device.`);})
                    .catch((reason)=>setSettingsStatus(String(reason instanceof Error?reason.message:reason)))
                    .finally(()=>setBackupBusy(false));
                }).catch((reason)=>setSettingsStatus(String(reason)));
              }}>RESTORE FROM PORTABLE BACKUP…</button>
            </div>
          </div>
          <div className="diagnostic-console">{platformPermissionStatus.filter((item)=>item.required).map((item)=><div key={item.id} className={item.state==='granted'?'ok':'warn'}><i/><p><b>MACOS {item.label.toUpperCase()}</b><span>{item.detail}</span></p>{item.state!=='granted'&&<button onClick={()=>void window.axiom.openPlatformPermission(item.id)}>OPEN SETTINGS</button>}</div>)}<button className="secondary" onClick={()=>void runDiagnostics()} disabled={diagnosticsBusy}>{diagnosticsBusy?'RUNNING HARDWARE + PROVIDER CHECKS…':'RUN COMPLETE DIAGNOSTICS'}</button>{diagnostics.map((item)=><div key={item.label} className={item.ok?'ok':'warn'}><i/><p><b>{item.label}</b><span>{item.detail}</span></p></div>)}</div>
          </SettingsSection>
        </div>
        <div className="settings-footer"><div><div className="security-note"><i /> {settings?.secureStorageLabel?.toUpperCase()||'SECURE STORAGE'}: {settings?.encryptionAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}</div>{settingsStatus&&<span className="settings-status">{settingsStatus}</span>}</div><div className="settings-footer-actions"><button className="secondary" onClick={()=>void window.axiom.createBackup().then((result)=>setSettingsStatus(`Verified backup saved: ${result.path}`)).catch((reason)=>setSettingsStatus(String(reason)))}>BACK UP AXIOM</button><button className="primary" onClick={()=>void saveSettings(true)}>SAVE ALL SETTINGS</button></div></div>
      </section>
    </div>}
  </main>;
}
