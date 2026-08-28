# Installed Jarvis → Axiom clean-room capability audit

Audit date: 2026-08-21

Authoritative comparison target: the exact application resolved from `C:\Users\Jabry's\Desktop\Jarvis AI.lnk` to `C:\Users\Jabry's\AppData\Local\Programs\Jarvis AI\Jarvis AI.exe`. The installed `resources\app.asar` was inspected locally. This document inventories behavior; Axiom does not ship the paid Jarvis source or copy its implementation.

Status legend: **verified** = implemented and covered by a build/test or direct source evidence; **partial** = useful implementation exists but does not yet match the full Jarvis behavior; **missing** = not implemented in Axiom yet.

## What the installed Jarvis actually exposes

The installed preload/main bridge contains desktop control, screen capture, Higgsfield image/video, scoped files, code execution, PowerShell, clipboard, notifications, self-window control, automatic backup, shared-folder sync, controlled browser automation, Shopify, Meta, Gmail, Cursor Guide, and licensing. Its renderer additionally defines camera open/close/vision, screen vision, appearance/self-modification, presence configuration, affect, face enrollment, history search, notes, to-do/goals, scheduled named agents, watch/monitor jobs, skills, and document export.

## Current comparison

| Area | Installed Jarvis evidence | Axiom 2.5.0 status | Honest result |
|---|---|---|---|
| AI providers | Claude plus OpenAI backup | OpenAI, Claude, Gemini; health checks, routing and failover | **verified / broader** |
| Live web | Anthropic/OpenAI web search and controlled browser | provider-native live search plus persistent semantic browser | **verified** |
| Natural voice | ElevenLabs plus browser speech | OpenAI, ElevenLabs and system voice; VAD, barge-in, speed/style, mouth calibration | **verified / broader** |
| Speaker recognition | No equivalent neural speaker model found | local WavLM speaker verification, adaptive microphone/noise gate, visible identity state | **verified / broader** |
| Camera feed | draggable live feed plus explicit `see_camera` frame | live local feed, explicit frame attachment, camera error truthfulness | **verified in 2.4.5** |
| Face identity | save/forget face and primary user | encrypted local face descriptors, roster, enroll/forget, current-turn verification | **verified** |
| Identity transport | current face state is supplied directly inside the renderer model loop | renderer evidence previously got dropped by Axiom IPC | **fixed in 2.4.5; regression-tested** |
| Presence/head tracking | local person tracking, eye-first/head-follow behavior | local MediaPipe face/body tracking, eye/head following and presence events | **verified; real-camera tuning still device-dependent** |
| Screen understanding | screenshot through desktop bridge | explicit screen capture sent as model vision input | **verified** |
| Windows computer control | coordinate mouse/keyboard/app launching and PowerShell | Microsoft UI Automation, live desktop graph, windows, controls, fields, menus, media, clipboard, guarded PowerShell | **verified / safer and broader** |
| macOS computer control | installed comparison build is Windows-focused | native Accessibility controls plus Apple Mail drafts, Notes, Reminders, Calendar, Music, system volume, browser, windows, files and Build Lab | **verified / broader** |
| Browser automation | Playwright open/read/click/fill/type/chat | persistent browser open/read/click/fill/press/close with guarded external effects | **verified** |
| Files | user-selected root read/write/list | bounded workspace files, checkpoints, verified writes, rollback and delete interlocks | **verified / safer** |
| Coding | arbitrary code plus PowerShell | Build Lab inventory/read/write/check/checkpoint/restore plus confirmed PowerShell | **verified for project work; no unrestricted generic code sandbox** |
| Memory/history | facts, notes, full-history search, memory graph | typed/provenance memory, correction, forgetting, retrieval metrics, encrypted sync | **verified / broader** |
| Goals/to-do | add/complete/remove two lists | durable goals plus a dedicated to-do matrix, completion/removal, runtime tasks, commitments, encrypted sync and recovery | **verified / broader** |
| Skills | saved playbooks | durable named permission-bounded skills | **verified** |
| Agents | named agents, identities, per-agent logs, interval/daily schedules | persistent specialists, manual/interval/daily schedules, run journal, pause/remove, color/voice bindings, autonomous guarded worker | **verified / broader** |
| Monitoring | scheduled screen/camera `watch` and stop | persistent camera/display monitors with bounded duration, polling, trigger/clear reasoning, stop control and native alerts | **verified** |
| Backup | automatic/nightly and manual backup | manual and daily automatic backups with timestamp, byte count and SHA-256 verification | **verified / stronger verification** |
| Cross-device sync | shared-folder settings/history | encrypted history, memory, goals, skills, agents, commitments, identities, voice profiles and presence lease | **verified / broader** |
| Notifications | native notifications | native notifications | **verified** |
| Self appearance | eyes/skull/aura/waveform/HUD, affect and persistent self-modification | guarded color/emotion appearance command | **partial**: no arbitrary persistent CSS/JS self-modification by design |
| Affect/emotion | simulated affect presentation | emotion/color state, voice delivery and animated avatar response | **verified core; fewer named affect presets** |
| Cursor Guide | floating cursor-following tutorial companion | detached click-through neon guide window that points at verified screen coordinates and expires automatically | **verified / safer** |
| Image/video generation | Higgsfield image/video | OpenAI GPT Image and Sora jobs, local artifact ledger, async completion, explicit cost preview and one-time approval | **verified / stronger consent** |
| Gmail | IMAP/SMTP via app password | Google Desktop OAuth with Gmail read/modify/send and Calendar read/create; tokens encrypted locally | **verified / modern OAuth** |
| Shopify | Admin API sales query | scoped Admin GraphQL sales connector with encrypted token and health check | **verified** |
| Meta Ads | insights query | scoped Graph API insights connector with encrypted token, configurable current endpoint and health check | **verified** |
| Global Intel panel | news/markets display | dedicated live-intelligence deck for world, weather, markets, technology and custom queries; mandatory live-source execution | **verified / broader** |
| Document export | txt/csv/md/json/html browser downloads | workspace file creation supports these formats | **verified through file tools** |
| Security/audit | broad renderer bridges and stored credentials | OS credential vault, one-time approval kernel, audit/evidence chain, rollback | **verified / substantially stronger** |

## Regressions found and corrected during this audit

1. “Pull up the camera feed” did not match Axiom's narrow camera-analysis phrase detector. A dedicated camera-intent router now opens a visible live preview and attaches a fresh frame to the model.
2. A failed camera frame previously fell through to the model, allowing a false “I cannot access the camera” answer. It now reports the actual Presence Link state and permission recovery path.
3. Live face/voice verification and the unverified-visitor boundary were sent by the renderer but discarded in the main-process request forwarding. Both now reach every provider instruction path.
4. Automated camera QA now proves the feed is visible, playing, and that a captured image is included in the assistant request.

## Axiom 2.5.0 parity closure

Every feature previously classified as **missing** in this source-backed audit now has an implementation and a user-facing control surface. The remaining differences are intentional security boundaries or external setup requirements, not silent missing features:

1. Axiom does not execute arbitrary persistent CSS/JavaScript self-modification. It exposes governed appearance, emotion, eye, avatar, voice-profile and agent-persona controls without granting generated code permanent UI authority.
2. Google requires the distributor or user to register a Desktop OAuth client. Shopify, Meta and Dropbox require appropriately scoped tokens issued by those services. Axiom encrypts them but cannot manufacture third-party credentials.
3. macOS requires the user to grant Camera, Microphone, Screen Recording, Accessibility and Apple Events permissions in System Settings. The settings diagnostics expose the actual state and open the correct pane.
4. Image and video generation depends on the configured provider, account access, current provider availability and user approval of the displayed cost estimate.

This audit is now a testable release contract. `visual-qa.js` verifies all nine application modules, Mission Control, Global Intelligence, connector settings, voice configuration, desktop world model, runtime permission kernel and layout. `operations-qa.js` exercises the real to-do, scheduler, monitor, connector, media-ledger and detached-guide IPC paths. The full automated suite covers the remaining pure logic and regression paths.
