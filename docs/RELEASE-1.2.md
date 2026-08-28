# Axiom 1.2 release notes

## Adaptive intelligence

- Retains an independent model choice for OpenAI, Anthropic, and Gemini.
- Tracks provider readiness, latency, and failures without exposing credentials.
- Uses a user-ordered fallback chain for ordinary non-mutating requests.
- Routes coding and live-research prompts to independently selected preferred providers.
- Never automatically replays desktop control, file writes, installs, publishing, purchases, or other mutating requests.

## Voice and presence

- Saves up to 24 named voice profiles.
- Links to ElevenLabs VoiceLab for consent-managed voice creation or cloning, then loads the resulting voice through the user's own account.
- Modulates speech speed, stability, and style subtly with Axiom's current emotional state.
- Keeps immediate tap/keyboard interruption before listening to the user.
- Uses MediaPipe's facial transformation matrix for head rotation, face landmarks for screen position and gaze, and full-body pose as the across-room fallback.
- Reports tracking source, confidence, inference FPS, and measured motion in the live UI.

## Control and recovery

- Adds staged onboarding and one-click device/provider diagnostics.
- Adds per-capability allow/block controls enforced in the main process.
- Persists up to 500 verified, blocked, or failed tool events in the local audit ledger.
- Logs renderer/child-process failures and performs one bounded renderer recovery attempt.
