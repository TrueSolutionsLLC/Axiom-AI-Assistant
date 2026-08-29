# Axiom on Windows and Mac

Axiom has one shared identity with separate device security boundaries.

## What follows you

- Recent conversation context
- Governed memories
- Goals and commitments
- Saved skills and specialist agents
- Voice profiles (the ElevenLabs API key is still entered per device)
- Skull appearance and emotional state
- Linked-device presence and the active voice device

## What stays local

- OpenAI, Anthropic, Gemini, and ElevenLabs API keys
- Permissions and approvals
- Coding-workspace and filesystem paths
- Camera and microphone permissions/calibration
- Desktop-control observations and audit evidence

## Choose the shared folder

Use a folder that is physically synchronized by a provider already installed on both computers. OneDrive, Dropbox, or iCloud Drive are suitable. Do not point Axiom at its live data file.

Examples:

- Windows: `C:\Users\YourName\OneDrive\Axiom Sync`
- Mac with OneDrive: `/Users/yourname/Library/CloudStorage/OneDrive-Personal/Axiom Sync`
- Mac with iCloud Drive: `/Users/yourname/Library/Mobile Documents/com~apple~CloudDocs/Axiom Sync`

The local paths can differ. They only need to represent the same cloud folder.

## Link the Windows PC

1. Open Axiom Settings.
2. Find **Axiom Identity Sync**.
3. Give this computer a human name such as `Robbie PC`.
4. Enter the shared cloud-folder path.
5. Create a strong passphrase of at least 12 characters.
6. Enable **Encrypted Cross-Device Continuity**.
7. Press **Sync Now**, then save settings.

## Build the Apple-silicon Mac version

The target Mac is Apple silicon, so use the optimized `arm64` package.

Install Apple's command-line tools once with `xcode-select --install`. Then open Terminal in the Axiom source folder and run:

```bash
./BUILD-AXIOM-MAC.command
```

(The script is already executable in the repo — no `chmod +x` needed. If your Mac's copy somehow isn't, `chmod +x BUILD-AXIOM-MAC.command` first. Don't run `chmod` on a copy that already has it set and is otherwise unmodified — git sees the permission flip as a local change and will refuse a later `git pull` that also touches this file until it's discarded with `git checkout -- BUILD-AXIOM-MAC.command`.)

The builder verifies macOS arm64, Node 22+, Xcode tools, the bundled local WavLM model and entitlements; it then installs dependencies, builds the app, runs the complete test suite, packages the DMG, and writes an SHA-256 manifest.
It also completes Electron's binary installation explicitly if npm's install-script policy deferred it, preventing the incomplete-Electron error seen in the earlier 2.0.1 source package.

`BUILD-AXIOM-MAC.command` now handles this itself — if npm reports that a package's install script was blocked (a real npm safety feature; onnxruntime-node's script sets up the native binary the local memory-embedding model needs, so this can silently leave the model non-functional rather than producing a build error), the script approves it automatically and reinstalls. If you're running the steps manually instead of through the script, the approval subcommand's name differs across npm versions — try `npm install-scripts approve <package>` and `npm approve-scripts <package>`; whichever one your npm actually has will work, then repeat `npm install` (or `npm ci`).

The DMG is created in `release/` as `Axiom-<version>-arm64.dmg` (the version comes from `package.json`).

For local testing before signing/notarization, macOS may require Control-clicking Axiom and choosing **Open**. Public distribution should use an Apple Developer ID certificate and notarization.

## Link the Mac

1. Install and open Axiom.
2. Grant microphone and camera access when macOS requests it.
3. Grant Accessibility, Automation, and Screen Recording only for the capabilities you want Axiom to use. In **System Settings → Privacy & Security → Accessibility**, enable Axiom; this is required for pressing buttons, filling fields, selecting menus, and controlling windows outside the chat.
4. Enter API keys on the Mac; they are protected by macOS Keychain and are intentionally not copied from Windows.
5. In **Axiom Identity Sync**, name the Mac (for example `Robbie MacBook`), select the Mac path for the same cloud folder, enter the exact same passphrase, enable sync, and press **Sync Now**.

## Active-device behavior

The computer most recently used owns hands-free voice. Axiom propagates that activity through the encrypted sync folder so the other linked computer stops auto-listening. The Sync panel shows where voice is active and when each peer was last seen.

## Recovery

- A wrong passphrase never overwrites readable data; sync reports the exact shard it could not unlock.
- An unreadable shard does not stop this computer from publishing its own data. Axiom merges every shard it can read, writes its own, and then reports which files it could not unlock and why — a shard still downloading from the cloud provider, or one written with a different passphrase.
- Each computer writes its own encrypted `.axsync` shard, so simultaneous writes do not corrupt one shared database.
- Deletions are represented by encrypted tombstones so a forgotten memory is not restored by an older device.
- Use **Back Up Axiom** on each device before major upgrades.
