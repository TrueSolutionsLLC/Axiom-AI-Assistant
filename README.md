# Axiom

Axiom is a private, local-first AI desktop companion for Windows and Apple-silicon Macs. It talks (by voice or text), sees and remembers who it's talking to on-device, and can take real actions on your computer — opening apps, running PowerShell (with your explicit approval), controlling smart-home devices, browsing the web, and more — all gated behind a visible permission system you control.

Nothing about your conversations, camera, or microphone is sent anywhere except to the AI provider you choose, for the single request you're making. Face and voice recognition run entirely on your machine.

## Requirements

- **Windows 10/11 (x64)** or **Apple silicon Mac (M1 or later)**. There is no Intel Mac or Linux build.
- An API key from at least one AI provider — **OpenAI**, **Anthropic (Claude)**, or **Google (Gemini)**. Axiom needs one of these to hold a conversation at all; everything else is optional.

## Installing

**Windows:** run the `Axiom-Setup-<version>.exe` installer and follow the prompts.

**Mac:** open the `Axiom-<version>-arm64.dmg` and drag Axiom to Applications. On first launch, macOS will ask for permission the first time Axiom actually needs the camera, microphone, or accessibility access — grant these only for the features you plan to use (see below).

## First-run setup

1. Open **Settings** (the button next to Chat in the left rail) → **AI Provider**.
2. Paste in an API key for OpenAI, Anthropic, or Gemini. You can get one from that provider's own developer console — Axiom doesn't issue keys itself. Keys are encrypted at rest using your operating system's own credential store (Windows Credential Manager / macOS Keychain), never stored in plain text.
3. That's it — you can start chatting. Everything else below is optional, and Axiom will tell you in-conversation if you ask for something that needs a setting you haven't configured yet.

### Optional setup

- **Voice** — Settings → Voice lets you enroll your voice (a short guided scan) so Axiom recognizes who's speaking, and choose a text-to-speech voice for replies.
- **Face recognition / presence** — grant camera access when prompted; Axiom will offer to learn your face the first time it sees you.
- **Smart home** — Settings → Connections supports Homebridge (Config UI X) and Ring cameras — see [`docs/HOMEBRIDGE.md`](docs/HOMEBRIDGE.md) for Homebridge setup. Both need their own account credentials, entered in Settings, and are never required for anything else in the app to work.
- **Other connectors** — Google (Gmail/Calendar/Drive), Shopify, Meta Ads, and Dropbox can each be connected from Settings → Connections if you use them; each needs its own OAuth client credentials from that provider's developer console.

## What Axiom can do

Chat, live web search, screen understanding, local file read/write (scoped to Desktop/Documents/Downloads), PowerShell automation (two-step: Axiom proposes the exact command, you approve it explicitly before it runs), desktop/app control, durable memory with semantic recall, goals and to-dos, scheduled agents, smart-home control, and Ring camera live view with two-way audio. The full list of what's currently enabled — and why anything is or isn't available — is visible in-app under **Core → Capabilities**.

## Your data

Everything Axiom remembers — conversation history, saved memories, enrolled faces/voices, settings — lives only on your machine, encrypted where sensitive. Settings → Data lets you export a human-readable copy of everything Axiom has stored, or permanently erase it (a typed confirmation phrase is required, since this can't be undone).

## Updating

Settings → Updates checks for and verifies new versions (SHA-256 checksum, never runs an installer automatically — you're always in control of when an update actually installs).

## More

- [`docs/SECURITY.md`](docs/SECURITY.md) — how permissions, approvals, and credential storage work under the hood.
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — the original product vision this was built against.
- [`CLEAN_ROOM.md`](CLEAN_ROOM.md) — how this project was built without reusing any other product's code or assets.
