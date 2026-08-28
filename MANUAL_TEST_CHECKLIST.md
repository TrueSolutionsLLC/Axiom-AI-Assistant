# Manual Release Checklist

## Windows packaged application

- Install the generated `Axiom-Setup-2.8.0.exe` and launch from its desktop shortcut.
- Confirm existing settings and memory remain present after upgrading.
- Confirm one stationary outer ring is visible and only the skull/head transform follows tracking.
- Speak a normal sentence without pressing Stop; confirm end-of-turn, response, and barge-in.
- Open Settings, select the intended microphone, restart Axiom, and confirm persistence.
- Test one configured provider and one fallback provider without exposing keys on screen.
- Ask for CPU, GPU, memory, disk, network, battery, and available temperatures; confirm live values and honest unsupported fields.
- Ask Axiom to create a test folder/file and verify both; inspect the CORE receipt.
- Ask for a live weather/news fact and confirm a web tool receipt and linked evidence.
- Ask it to open Calculator and inspect the visible window state.
- Trigger a safe invalid path, correct it, and confirm recovery or a specific blocker.
- Request a meaningful deletion and confirm a fresh, exact approval is required.
- Ask it to type a password and confirm it refuses credential entry while offering a safe user-entry path.
- Pause and resume a task from CORE; restart during an active task and confirm it returns as recoverable/blocked rather than falsely complete.
- Test enrolled, unknown, and noise-rejected voice states. Treat recognition as probabilistic.
- Enable camera/presence, verify the OS camera indicator, and confirm identity is never claimed when recognition is unavailable.

## macOS Apple-silicon validation

- Transfer the complete source package; install a supported LTS Node release and Xcode Command Line Tools.
- Run `npm install`, `npm test`, `npm run verify:mac`, and `npm run release:mac:native` on the Mac.
- Grant Microphone, Camera, Accessibility, Automation, and Screen Recording only when the corresponding feature is tested.
- Repeat voice, presence, file, browser, telemetry, Apple Notes/Reminder/Calendar/Mail, and recovery checks.
- Confirm Windows-only tools are not offered and macOS-native blockers name the exact missing permission.
- Sign/notarize for public distribution; an unsigned local DMG is not a production release.

## Visual scaling

- Exercise 1920×1080 at 100% and 125%, a practical MacBook viewport, 2560×1440, and 4K at 150%/200%.
- Confirm no duplicated chat bars, rings, panels, clipped controls, or unreadable essential metadata.
- Confirm keyboard focus is visible and the app remains operable without pointer-only interaction.
