# Capability Matrix

The authoritative machine-readable list is generated at runtime by `capabilityManifest()` in `src/main/tools.ts`. The table below groups the individual tools for human review.

| Area | Windows | macOS | Verification and recovery |
|---|---|---|---|
| Files and folders | Native Node filesystem | Native Node filesystem | Structured result plus artifact/path checks; explicit path error on failure |
| Persistent browser | Chromium session controls | Chromium session controls | Page observation after navigation/click/fill; refresh or reopen route |
| Live research | Provider web-search tool | Provider web-search tool | Web evidence returned to the provider; never silently answered from stale memory |
| Applications/windows | Windows UI Automation and window adapters | Accessibility plus AppleScript/JXA adapters | Re-inspect application/window state; report missing OS permission |
| Clipboard/media | Native Electron/OS bridge | Native Electron/OS bridge | Non-empty result receipt; retry read-only transient failures |
| Shell | Two-stage PowerShell confirmation | Supported macOS semantic adapters; no fake PowerShell | Exact approval and exit/output receipt; dangerous disk commands blocked |
| System telemetry | CPU, GPU, memory, disk, network, battery, temperatures when exposed | Same through supported host sensors | Structured system observation; unsupported sensors labeled unavailable |
| Development | Scoped workspace read/write/checkpoint/test/build | Scoped workspace read/write/checkpoint/test/build | Checkpoint before mutation, command exit result, explicit rollback |
| Camera/presence | Camera and local tracking when enabled | Camera and local tracking when enabled | Sensor/tracker state shown; no identity claim without recognition result |
| Voice | VAD, microphone selection, transcription, provider TTS, ElevenLabs | Same logical pipeline; native permission required | Visible voice fault and provider fallback; hardware QA required per device |
| Memory | Local governed memory, goals, todos, skills, agents, commitments | Same plus optional encrypted cross-device sync | Inspectable source/confidence data; correction and deletion tools |
| Connectors | Google, Shopify, Meta, Dropbox when configured | Same | Provider/API receipts; external mutations require fresh approval |
| Media generation | Cost estimate and approved OpenAI generation | Same | Saved artifact result; external cost requires approval |
| Appearance | Eye color and emotional state commands | Same | Renderer command plus persisted appearance receipt |

Capability status in the app is computed from the registry, current platform, stored permission switches, and adapter availability. “Supported” does not mean an OS permission or third-party credential has already been granted.

