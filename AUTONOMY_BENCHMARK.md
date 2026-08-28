# Autonomy Benchmark

## Before

- 109 automated tests passed.
- Action completion could be marked from control flow without a verified tool receipt.
- The action gate missed valid verbs including generate, add, and monitor.
- Provider fallbacks could phrase an evidence-free action as completed.

## After

The automated suite now includes a 33-request production routing matrix plus explicit false-success and verified-receipt checks. It covers live research, files, folders, applications, browser interaction, notifications, cursor guidance, Gmail, calendar, Shopify, Meta, Dropbox, media generation, backup, desktop state, clipboard, media control, development, PowerShell approval, telemetry, appearance, time, identity memory, goals, todos, skills, agents, commitments, and visual monitors.

Run:

```powershell
npm test
npm run build
```

Measured acceptance criteria:

| Measure | Result |
|---|---:|
| Routing scenarios | 33/33 |
| False completions in unverified outcome tests | 0 |
| Deterministic mutations requiring verified evidence | 100% |
| Security regression tests | Passing |
| Live UI routes | 11/11 |
| Legacy duplicate layer | Absent |
| Critical renderer errors in visual probe | 0 |
| Ring-motion probe | Ring fixed; head moved |
| Operations probe | Passed |

This is a deterministic regression benchmark, not a claim of 100% success against every live website, provider, microphone, camera, or third-party application. Those require the manual hardware and credential checklist.

