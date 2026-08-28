# Commissioned modification migration manifest

Migration completed from Robbie's post-baseline Jarvis modification set into Axiom's independently authored Electron/React codebase.

## Exact commissioned assets

| Original mod asset | Axiom destination | Status |
|---|---|---|
| `reference-screen.png` | `public/mod-assets/reference-screen.png` | Exact file migrated and used as the reference master background |
| `reference-skull.png` | `public/mod-assets/skull-closed.png` | Exact closed-mouth pose migrated |
| `reference-skull-half.png` | `public/mod-assets/skull-half.png` | Exact half-open pose migrated |
| `reference-skull-open.png` | `public/mod-assets/skull-open.png` | Exact open-mouth pose migrated |

## Reimplemented modification systems

- Full-screen reference composition, scan layer, startup curtain, particle atmosphere, orbital reticles and perspective floor grid.
- Nine-region left navigation mapped onto working Axiom chat, tool, screen, file, web, automation, memory, settings and starred/goal views.
- Recent Activity, System Status, Active Tool and live Presence Link telemetry.
- Audio-analyser mouth movement with closed, half-open and open pose blending, width/rounding deformation and speech glow.
- Independent glowing eyes, iris gaze, natural and camera-driven blinking, emotional color response and speech response.
- Conversational idle/listening/speaking motion plus camera-follow translation, yaw, pitch and roll.
- MediaPipe face landmarks, iris gaze and blendshape eyelids, with full-person Pose Landmarker fallback for across-room tracking.
- User-requested color/emotion control through Axiom's safe appearance tool.
- First visual lock acknowledgement: “Visual link established. I see you.”

## Licensed equivalents

The old modification directory also contained downloaded third-party runtimes and models. They were not user-created assets and were not blindly copied. Axiom uses maintained, documented equivalents:

- Old embedded Three.js/OBJ experiment → npm Three.js plus the audited CC0 Khronos skull fallback.
- Old face-api and browser person-detector bundles → official Apache-2.0 MediaPipe Face and Pose Landmarker runtimes/models.
- Old inline script/CSS patches → independently authored TypeScript, React and CSS modules listed above.

No purchased-assistant source file was copied into Axiom.

**2026-08-28 update:** the four exact-migrated files in the table above (`reference-screen.png`, `skull-closed.png`, `skull-half.png`, `skull-open.png`) were removed from the shipped app. They had been superseded by a separate, newly-authored image set (`axiom-skull-*.png`, used by `ModdedSkullAvatar.tsx`) but were still being bundled unused, carrying the "distribution clearance pending" status recorded in `docs/ASSET_PROVENANCE.md`. Kept in this manifest as historical record of the original migration; see `ASSET_PROVENANCE.md` for current status.

## 0.6 performance pass

- Removed the duplicate baked command-bar layer with a dedicated clean plate.
- Added Responses API server-sent-event streaming through Electron IPC.
- Added latency-aware tool routing so ordinary conversation sends no irrelevant tool schemas.
- Reduced repeated transcript context while retaining the most recent six exchanges.
- Streamed final answers after tool execution instead of waiting for speech generation.
- Live benchmarks on 2026-08-14: 0.85 seconds to first chat text, 1.94 seconds to first verified-tool answer text, and 1.69 seconds for a short HD voice synthesis request.

## 0.7 presence and voice pass

- Starts synthesizing complete sentences while the remaining assistant response is still streaming.
- Upgraded speech to `gpt-4o-mini-tts` with a calm, natural companion delivery instruction.
- Added barge-in behavior: starting microphone capture stops current speech; Escape also stops voice immediately.
- Added Shift+J push-to-talk and a live on-screen shortcut hint.
- Replaced repetitive talking oscillation with irregular conversational nods, glances, micro-saccades and distance-responsive depth.
- Added Face Landmarker GPU-to-CPU fallback, automatic camera-track recovery, inference fault isolation and a visible RETRY control.
- Added tracking lock confidence and clearer live diagnostics without transmitting camera frames.
- Persisted user-requested companion color and emotional expression across restarts.
- Split Screen, Files, Web and Automate into distinct working navigation panels with relevant permission state and executable command starters.
- Live development benchmarks on 2026-08-19: 0.58–0.97 seconds to first text and 1.67–2.24 seconds to first audible streamed sentence.

## 0.8 visual intelligence pass

- Added explicit primary-display capture with a visible preview and one-request attachment lifecycle.
- Added multimodal Responses API input so the configured GPT-5.6 model can analyze the attached screen.
- Screen images are captured only on button press, never stored in history, and discarded from the renderer after the request completes.
- Added live CPU and memory sampling with animated telemetry bars.
- Added a polished encrypted local conversation-history drawer with two-step destructive clearing.
- Added a local startup briefing and guaranteed follow-up visual-lock acknowledgement without speech overlap.
- Screen captures now create a visible verified activity-ledger event.
- Expanded automated QA to cover all seven navigation modules, history visibility, live telemetry, screen capture dimensions, multimodal interpretation, and post-request attachment disposal.
- Added a purpose-built transparent Axiom wireframe-skull identity and embedded it in the Windows executable, installer and uninstaller instead of shipping Electron's generic icon.
- Promoted that same icon identity into the live companion: the exact closed-pose master plus identity-locked half/open mouth frames, analyser-driven three-pose interpolation, corrected opaque mouth compositing, reactive gaze, blinking, emotion and camera-follow motion.
- Live development benchmarks on 2026-08-19: 0.79 seconds to first text, 1.84 seconds to first audible sentence, and 1.22 seconds for verified screen interpretation.
