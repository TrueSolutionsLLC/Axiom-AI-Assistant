# Axiom 2.5.0 — Mission Runtime

This release closes the feature gaps found in the source-backed comparison with the installed Jarvis application while preserving Axiom's clean-room implementation and stronger permission model.

## New operational systems

- Persistent background runtime for scheduled specialist agents, reminders, commitments, visual monitors, generated media jobs and automatic daily backups.
- Mission Control UI with a fast to-do matrix, manual/interval/daily agent schedules, camera/display monitor controls, run history and background event tape.
- Dedicated Global Intelligence deck. World, weather, market, technology and custom current-information requests require live source execution rather than stale model memory.
- Provider citation metadata is converted into visible, clickable HTTPS source links; unsafe protocols are discarded and URLs are not read aloud by speech synthesis.
- Short-term conversation context is bounded independently from durable memory, cutting the verified normal response path to roughly 1.5–2.5 seconds in final package QA.
- Detached neon Cursor Guide overlay. It is click-through, points at verified screen coordinates and expires automatically.

## Connected services

- Google Desktop OAuth with Gmail read/modify/send and Calendar read/create.
- Shopify Admin GraphQL sales queries.
- Meta Graph API advertising insights.
- Dropbox folder listing.
- Secrets remain encrypted in Windows DPAPI or macOS Keychain-backed secure storage. External writes still require one-time approval.

## Creative tools

- OpenAI GPT Image generation to the local Pictures/Axiom Generated folder.
- OpenAI Sora video jobs with asynchronous status polling and native completion notification.
- Cost estimates and a fresh approval are shown before chargeable generation begins.

## Mac controls

- Generic native Accessibility inspection and control.
- Apple Mail draft composition, Notes creation, Reminders creation, Calendar events, Music transport, system volume and window controls.
- The Settings diagnostics show macOS Camera, Microphone, Screen Recording and Accessibility permission status and open the correct System Settings pane.

## Verification

- 21 automated test files / 103 tests.
- Main-process and renderer production builds.
- Visual QA of every module, settings, Mission Control, Global Intelligence, desktop world model and runtime permission kernel.
- Operations QA of to-do CRUD, scheduler lifecycle, visual monitors, connectors, media ledger and Cursor Guide.
- Installed-package QA of provider health, live web citations, camera playback, stationary-ring/head separation, live face/body tracking, WavLM model loading, hands-free recovery and speech performance.

Third-party connections still require credentials issued by those services. Google requires a Desktop OAuth client ID; Shopify, Meta and Dropbox require appropriately scoped access tokens. Axiom cannot create those credentials on the user's behalf.
