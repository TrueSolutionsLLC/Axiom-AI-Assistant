# Axiom Production Readiness Gate

This document is the release contract. A capability is marketable only after its gate is supported by retained evidence from the target hardware. Passing unit tests is necessary, but it is not the same as passing this gate.

*Last reconciled against the shipping app on 2026-08-28 (v3.20.2) — two rows removed features had drifted onto (Office Sentry, Home Assistant, both fully removed from the codebase) were corrected. For what's actually shipped since, the in-app changelog (Settings → Changelog, or `BEHAVIOR_CHANGELOG` in `src/renderer/App.tsx`) is the authoritative, version-by-version record; this document tracks readiness gates, not feature history.*

## Release rule

- **PASS**: implemented, automated tests pass, and the target-device acceptance test has a retained receipt.
- **CONDITIONAL**: implemented and automated, but the named real-device acceptance test has not yet been completed.
- **BLOCKED**: a required production component, credential, device, certificate, or test is missing.
- A production release requires every critical row to be **PASS**, zero unresolved P0/P1 defects, signed artifacts, recovery testing, and a successful 72-hour unattended run.

## Current gate

| Capability | Current state | Evidence present | Evidence still required |
|---|---|---|---|
| Windows installation and launch | CONDITIONAL | NSIS build; main/renderer build; packaged visual QA; a real `--dir` packaged build was extracted and its native dependencies verified to actually load and run (this caught and fixed a real bug where a required dependency was silently excluded from every packaged build — see PRODUCTION_READINESS entry in the in-app changelog, v3.20.1) | Clean-PC install, uninstall/reinstall, Defender/SmartScreen behavior, trusted Authenticode signature |
| Windows background operation | CONDITIONAL | Tray lifecycle, launch-at-login, close-to-background | 72-hour run covering sleep/resume, network loss, reconnect, and Windows restart while hands-free voice and any connected Ring cameras stay live |
| Mac Apple-silicon app | BLOCKED | arm64 build scripts, entitlements, source verification | Native build on the M5 Mac, camera/mic/screen/accessibility grants, signed and notarized DMG, Gatekeeper test |
| Conversation and voice | CONDITIONAL | hands-free state machine, provider fallback, real streaming verified for the OpenAI path (Anthropic/Gemini remain one-shot, not token-streamed), automated test suite (`npm test` — current count and pass/fail state is authoritative, not a number frozen in this document) | Live microphone turn-taking, interruption, noise, latency, and 100-turn soak test on each target computer |
| Face identity and presence | CONDITIONAL | local descriptors, consensus tracking, encrypted-at-rest biometric templates | Robbie enrollment set across lighting/angles; false-accept and false-reject acceptance set; departure/return test |
| Neural speaker identity | CONDITIONAL | local WavLM/ECAPA-style embedding path and encrypted templates | Multi-speaker confusion test with background TV/audio and target microphone |
| Homebridge smart-home control | CONDITIONAL | accessory read/control routes, fresh-approval gate for locks/security, simulated bridge tests | Real Homebridge instance (Insecure Mode) with a light/lock/sensor matrix, disconnect/reconnect, approval-path tests |
| Computer control | CONDITIONAL | Windows UI Automation/tool routing and verification receipts | App-by-app task matrix on installed applications; macOS Accessibility/AppleScript matrix |
| Live web research | CONDITIONAL | web-search and persistent-browser routes | Live search, YouTube, login-preserving browser, offline recovery, and provider-failure tests |
| Local semantic memory | CONDITIONAL | offline sentence-embedding retrieval, implicit capture, conflict detection, real-model integration tests; native ONNX dependency verified end-to-end in a real packaged Windows build (extracted app.asar, rebuilt native binary, real inference against the bundled model) | The equivalent real-packaged-build verification on the Mac target (different chip, arm64-only, only buildable on the target Mac) |
| Memory and cross-device continuity | CONDITIONAL | durable local memory, encrypted sync payloads, conflict merge | Simultaneous Windows/Mac edits, disconnect/reconnect, corruption restore, identity continuity test |
| Credential and biometric protection | CONDITIONAL | OS secure storage for secrets; biometric templates encrypted at rest | Migration test, backup/restore test, account-switch test, independent security review |
| Crash and task recovery | CONDITIONAL | renderer reload, durable task journal, interrupted-task recovery | Main-process crash injection, renderer crash loop, power-loss simulation, corrupted-store recovery |
| Updates and rollback | CONDITIONAL | Manifest-driven update check, SHA-256 integrity verification before any installer is offered (tampered/truncated downloads are deleted, never opened), HTTPS-only feed, manual install via the OS's own installer, 10 automated tests including a live tampering-detection test against a real HTTP server | A real hosted HTTPS feed, signed and notarized installers (an unsigned build still fails at the OS's own gate even with a valid update check), staged rollout, and rollback/failed-update recovery |
| Observability and support | CONDITIONAL | runtime probes, diagnostics log, audit receipts, capability view | Redaction audit, log rotation, exportable support bundle, user-visible health history |

## Mandatory acceptance suites

1. **Conversation:** 100 turns; median end-of-speech-to-first-audio under 1.5 seconds on a healthy low-latency provider; no self-listening loops; interruption works.
2. **Identity:** at least 50 owner samples and 50 non-owner samples across expected room conditions; thresholds and failures retained, not estimated.
3. **Watchdog:** superseded — the always-on camera-watchdog system (formerly "Office Sentry") was removed entirely at the owner's request; face/voice recognition is now used for personalization only, not continuous monitoring. This suite no longer applies.
4. **Computer control:** a versioned matrix of common tasks in every supported application; every action must produce success evidence or a truthful blocked state.
5. **Homebridge:** read state, safe device control, security-device approval, and unavailable-hub recovery using a real Homebridge instance.
6. **Continuity:** two-device concurrent use, encrypted sync, conflict resolution, offline edits, recovery from one damaged sync file, and correct active-device awareness.
7. **Packaging:** clean install, upgrade, uninstall, preserved user data, signed binary verification, malware scan, and rollback on both platforms.
8. **Recovery:** renderer crash, main-process crash, provider outage, expired credentials, disk-full condition, and corrupt local state.

## Claims that must not be published yet

- “Production ready,” “works flawlessly,” “recognizes you perfectly,” or “controls anything” without qualification.
- Continuous monitoring while the computer is asleep or the camera is unavailable.
- A signed/notarized Mac release until Apple signing and notarization complete.
- Reliable control of an application or smart device that is not in the retained acceptance matrix.

## External inputs required to finish the gate

- The target Windows PC with its real microphone, camera, applications, and security software.
- The target M5 MacBook Pro with an Apple Developer ID identity for distribution outside the Mac App Store.
- A configured Homebridge instance (Config UI X, running in Insecure Mode) and its sign-in credentials.
- At least one consenting non-owner for identity rejection testing.
- A code-signing certificate and a private update-distribution endpoint.

Until every critical row is PASS, builds are release candidates, not production releases.
