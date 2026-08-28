# Axiom 2.7.0 — Operational Truth

This release turns Axiom's separate abilities into one observable reliability system. A capability is no longer considered ready because code for it exists; Axiom now probes the complete path, reports its actual state, attempts only safe recovery, and records proof when work succeeds.

## Reliability Fabric

- Startup probes verify the selected AI provider, mandatory live-search route, selected speech engine, microphone and transcription paths, camera, bundled MediaPipe and WavLM assets, native desktop-control adapter, approved file roots, hardware sensor fabric, encrypted credential vault, durable runtime journal, recovery policy, and encrypted device continuity.
- The right-side `OPERATIONAL TRUTH` instrument exposes readiness, current route, executed capability, identity trust, active computer, and measured STT/AI/TTS/first-audio latency.
- CORE includes a detailed probe matrix with live state, evidence, latency, and the correct recovery action for every subsystem.
- A manual `RE-SCAN` performs a fresh end-to-end readiness pass without restarting Axiom.

## Verified real-world action routing

- Common read-only requests—computer statistics, local time, running windows, capabilities, goals, to-dos, commitments, skills, agents, and identity recall—execute a deterministic verified preflight before the language model composes its response.
- This prevents Axiom from answering as a text-only chatbot when an installed local capability can provide the real result.
- Every successful action now carries an action ID, SHA-256 result digest, verification method, checked time, attempt count, and recovery state.
- Empty, malformed, or explicit-error tool output cannot be reported as successful.

## Recovery and performance

- Transient failures on read-only operations receive one short bounded retry. Writes, external actions, approvals, and other mutations are never automatically replayed.
- Safe AI requests retain provider failover; a recently degraded provider moves behind available healthy alternatives for five minutes.
- Provider, transcription, realtime-voice, and speech calls have bounded timeouts so a dead network path cannot leave Axiom indefinitely thinking or listening.
- Conversation telemetry records speech-to-text, first model token, first synthesized segment, first audible output, route completion, and whether recovery was required.

## Identity and continuity

- Fresh face and neural voice evidence are fused into `DUAL VERIFIED`, face-only, voice-only, unknown, noise-rejected, or conflict states.
- If face and voice identify different people, Operational Truth displays an identity conflict and privileged tools remain locked to visitor-safe conversation.
- The active-device lease appears directly in the HUD, so Windows and Mac can show which computer currently owns hands-free voice.

## Verification

- 22 automated test files / 109 tests passing.
- Production TypeScript and renderer builds passing.
- Full interactive visual gate passes all 9 modules, the commissioned skull and stationary outer HUD, hardware reactor, Operational Truth panel, 15 live probe rows, settings, history, memory, mission control, desktop world model, and zero-overflow/error checks.
