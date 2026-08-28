# Security baseline

- Renderer has no Node.js integration.
- Context isolation and Chromium sandbox are enabled.
- API keys are handled only in the main process and encrypted with Electron `safeStorage` where available.
- Renderer IPC is allowlisted through a narrow preload API.
- Remote navigation and unexpected window creation are denied.
- Tool execution is registry-based and risk-classified.
- Destructive, external-write, credential, purchase, and account-changing tools require explicit user approval.
- Secrets must never be written to logs, renderer storage, crash reports, or conversation history.
