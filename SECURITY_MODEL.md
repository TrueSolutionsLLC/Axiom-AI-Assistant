# Security and Permission Model

Axiom uses risk-aware autonomy. A broad “approve everything” statement does not authorize future destructive or external actions and never authorizes credential entry.

| Risk | Examples | Default |
|---|---|---|
| Read | Time, telemetry, directory listing, live research | Automatic when requested and enabled |
| Local reversible write | Draft, local folder, notification, appearance | Automatic when clearly requested; receipt required |
| Sensitive interaction | UI control, clipboard read, camera, connector reads | Stored permission plus explicit user intent |
| Privileged | PowerShell | Exact two-stage confirmation and output receipt |
| External | Send email, create external calendar event, paid media generation | Fresh action-specific approval |
| Destructive | Delete project data, close consequential work, rollback | Fresh action-specific approval and recovery preview |
| Credentials | Passwords, tokens entered into another app | Refused; user enters secrets directly |

Every executed tool event records action ID, permission ID, risk, status, timestamp, attempts, verification method, and a digest of the result. Verified evidence is distinct from model prose. Read-only transient failures receive a bounded retry; mutations are not blindly replayed. Approval requests include the exact action, target/preview, risk, expiration, and recovery route.

Secrets remain in the existing encrypted local settings mechanism and are excluded from logs, screenshots, benchmark fixtures, and documentation. Camera and voice identity are probabilistic sensor results, not proof of legal identity. Unknown visitors are conversation-only until explicitly authorized or enrolled.

