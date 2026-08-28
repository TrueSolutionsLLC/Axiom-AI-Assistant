# Axiom Autonomy Audit

## Scope and baseline

Audit date: 2026-08-22. The source, commissioned avatar assets, settings, and runtime data were protected before material changes in the adjacent dated backup directory. The inspected application is an Electron desktop program with a privileged main process, isolated preload bridge, React renderer, local encrypted settings/store, provider adapters, platform automation adapters, and a structured capability registry.

The retained local history contained 200 messages (100 assistant replies). A redacted pattern scan found zero retained generic refusal phrases. That is a finding about the retained window only, not a claim that earlier failures never occurred. Historical user reports and code inspection still demonstrated tool-selection misses and false completion risk.

Before this rebuild, 109 automated tests passed. The most important defect was structural: when no approval was pending, the IPC layer could settle a task as completed even when its tool receipt was failed or missing. Provider fallbacks could also state that a request was completed without readable evidence.

## Root causes and implemented corrections

| Failure class | Root cause | Correction |
|---|---|---|
| False success | Task completion depended on approval state rather than verified receipts | Evidence-aware outcome assessment now requires a verified tool event for action requests |
| Text substituted for action | Action classifier omitted valid command verbs | Expanded action recognition and added a 33-scenario routing benchmark |
| Vague blockers | Provider prose could obscure the actual tool failure | Standard BLOCKED / NEEDED / COMPLETED SO FAR / NEXT ACTION response normalization |
| Weak recovery visibility | Persistent task records lacked explicit runtime phases | Added phases, attempt budgets, blocker, next action, and transition timeline |
| Capability guessing | Permission list was used as a proxy for capabilities | Added one runtime-readable capability manifest with platform, approval, verification, timeout, and recovery metadata |
| Dense UI | Operational modules used decorative microtype | Added a final readability layer and increased composer, task, telemetry, settings, and diagnostic typography |

## Runtime architecture

`main.ts` owns the durable task lifecycle. `openai.ts` routes OpenAI, Anthropic, and Gemini calls and feeds tool results back to the selected provider. `tools.ts` owns capability discovery, selection, permission enforcement, retry behavior, receipt generation, and verification. `runtimeCore.ts` owns risk and evidence-aware terminal outcome rules. `store.ts` persists tasks and migrates older task records. The renderer displays real runtime state through the preload contract; it does not decide whether work succeeded.

The action lifecycle is now:

Received → Interpreting → Planning → Executing → Observing → Verifying → Completed

Approval, recovery, blocker, cancellation, and crash-resume paths are explicit terminal or intermediate states. A task with no verified action receipt cannot enter Completed.

## Evidence

- Production TypeScript and Vite build: passed.
- Unit/integration suite after changes: see `AUTONOMY_BENCHMARK.md`.
- Live Electron navigation/layout probe: passed 11 routes with no renderer errors, failed requests, overflow, or legacy duplicate UI layer.
- Operations probe: passed task, agent, monitor, scheduler, connector, media, and cursor-guide checks.
- Motion probe: stationary ring remained byte-identical while the head transform changed.

## Honest limits

No benchmark can prove unrestricted control of every third-party application. OS permissions, application accessibility trees, API credentials, provider availability, and changing websites remain external constraints. Native Apple-silicon packaging and hardware testing must run on a Mac; this Windows environment cannot honestly certify a DMG, camera, microphone, Accessibility, or Automation permission flow on macOS.

