> **This file is frozen at v2.9.1 and stops there** — dozens of versions have shipped since (current: see `package.json`), including the removal of Home Assistant and the entire Office Sentry system referenced below. It's kept as a historical record of that release, not current documentation. For what's actually in the app today, see the in-app changelog (Settings → Changelog) or `BEHAVIOR_CHANGELOG` in `src/renderer/App.tsx`.

# Axiom 2.9.1 — Production Hardening Candidate

## 2.9.1 reliability and privacy hardening

- Added a native tray lifecycle so closing the command-center window no longer silently stops Office Sentry when ambient presence is enabled.
- Added launch-at-login background startup, a single-instance guard, and a clear tray Quit command.
- Added explicit monitoring coverage-gap and restoration receipts across computer suspend/resume.
- Added local Crashpad capture with no automatic upload and bounded, rotating runtime diagnostics.
- Added last-known-good local-state recovery and quarantine of a corrupt primary data file.
- Encrypted face descriptors and neural voice embeddings at rest with Windows DPAPI or macOS Keychain-backed Electron secure storage.
- Refuse new biometric enrollment when operating-system secure storage is unavailable.
- Added a formal production-readiness contract; this build remains a release candidate until the real-device, signing, 72-hour, and Mac gates pass.

# Axiom 2.9.0 — Watchdog + Home Assistant Command Fabric

## 2.9.0 always-on watchdog and smart-home control

- Added a native Home Assistant REST and WebSocket bridge using the user's local URL and encrypted Long-Lived Access Token.
- Added live smart-device inventory and status to the Automate command center.
- Added conversational control for lights, switches, fans, scenes, thermostats, covers, locks, and alarms with post-action state verification.
- Security-critical unlock, secured-entry open, and alarm arming changes require a fresh exact approval.
- Added continuous motion, occupancy, door/window, lock, safety, and alarm event monitoring while Axiom runs.
- Added camera coverage-gap and restoration receipts so Axiom never represents an offline interval as observed.
- Added encrypted local image evidence for unknown-person alerts when operating-system secure storage is available.
- Added automatic return briefings assembled from departure, visitor, smart-sensor, coverage, and arrival receipts.
- Added Home Assistant setup documentation and connector diagnostics.

# Axiom 2.8.3 — Office Sentry Ledger

## 2.8.3 monitored-presence history hotfix

- Added a durable, timestamped Office Sentry event ledger for monitoring sessions, trusted arrivals, departures, and unknown visitors.
- Visitor-history questions now bypass the language model and query local sensor evidence directly.
- Answers distinguish “no event recorded during camera coverage” from proof about periods when Axiom or the camera was offline.
- Migrates existing verified `presence_unknown_visitor` audit receipts, including detections created by 2.8.2.
- Syncs non-biometric presence receipts between linked Axiom devices without copying camera images.
- Added rendered-app QA for the exact question “Did anybody come in my office when I wasn't here?” and verifies that no model call is used.

## 2.8.2 Office Sentry identity hotfix

## 2.8.2 Office Sentry identity hotfix

- Replaced single-frame arrival guesses with multi-frame face consensus before Axiom greets or challenges a person.
- Face enrollment now captures several consistent samples and retains up to eight local angles per trusted person.
- Added continuous room watching so an unknown visitor joining Robbie after the camera is already locked is still detected.
- Added a deterministic private-office boundary: unknown visitors cannot invoke tools, receive a firm request to step outside, and generate a desktop alert plus audit receipt.
- Added direct, evidence-grounded answers to “Who am I?” so remembered identity and current biometric verification cannot be confused.
- Upgraded Presence Link with explicit `ROBBIE VERIFIED`, `IDENTITY UNCONFIRMED`, and red `UNKNOWN VISITOR` states.
- Corrected face-enrollment language so Axiom no longer claims a local biometric record is encrypted when it is stored in the local application data store.

## 2.8.1 visual and browser hotfix

- Restored the complete cranium by correcting the moving-head isolation mask.
- Kept the commissioned outer ring stationary and visually separate from the head.
- Removed collisions between voice identity, state, reply, and composer lanes; automated geometry checks now enforce minimum gaps.
- Added a deterministic, model-independent YouTube search route through Axiom Browser.
- Verified the exact command “Search YouTube for realistic AI avatar motion” against a live YouTube results page.

## Highlights

- Durable task phases from receipt through planning, action, observation, verification, recovery, and terminal outcome.
- Zero-trust completion: actionable requests cannot complete without verified tool evidence.
- Structured, honest blocker reports with the needed condition, verified progress, and next action.
- Runtime capability manifest with platform, permission, mutation, approval, verification, recovery, timeout, and background metadata.
- Expanded action classification and 33-scenario routing benchmark.
- Persisted task attempt budgets, blocker details, next actions, and transition timelines.
- Improved command-center readability across chat, settings, diagnostics, memory, mission control, and operations.
- The commissioned skull and stationary outer ring are preserved.

## Fixed

- Failed or missing tool results could previously be represented as completed tasks.
- Some valid action verbs exposed tools without forcing execution.
- Provider fallback copy could imply completion without readable evidence.
- Runtime task cards hid the actionable blocker and resume route.

## Known limitations

- Native macOS build, signing/notarization, microphone/camera behavior, and Accessibility/Automation control require execution on Apple silicon.
- Third-party connectors require the user’s own valid configuration and may be limited by provider accounts or API policies.
- Temperatures are reported only when firmware, drivers, and the OS expose a sensor.
- Neural voice/face recognition is probabilistic and must not be treated as infallible identity proof.
