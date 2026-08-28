/**
 * Guided multi-condition voice enrollment — the voice equivalent of the
 * multi-angle face scan. A single clean 5-second take at one distance and
 * volume produces an embedding that only really represents that one
 * condition; real usage varies distance from the mic, room noise, and
 * speaking volume. Capturing across a few different conditions gives each
 * enrolled profile more headroom against that real-world variation, the same
 * reasoning that motivated multi-angle face capture.
 */

export interface VoiceEnrollmentStep {
  id: 'normal' | 'quiet' | 'close';
  label: string;
  instruction: string;
}

// The neural speaker-verification model this app uses (WavLM) is
// text-independent — it doesn't need any particular content, so this isn't
// here for the model's benefit. It's here because "speak naturally for five
// seconds" with nothing to say tends to produce hesitant, quiet, or
// too-short samples; reading a fixed sentence produces fluent, consistent
// speech instead. Deliberately the *same* sentence across all three
// conditions, so distance/volume stays the only intentional variable — a
// different sentence per step would just add uncontrolled variation on top
// of the variation the steps already exist to capture.
export const VOICE_ENROLLMENT_SCRIPT = 'The quick brown fox jumps over the lazy dog, while the north wind blows steadily through the quiet valley below.';

// Spoken by TTS, so deliberately short — the sentence itself is shown on
// screen for the user to read at their own pace, not read aloud by Axiom
// first (that would mean hearing it, then repeating it back, three times).
export const VOICE_ENROLLMENT_STEPS: VoiceEnrollmentStep[] = [
  { id: 'normal', label: 'NORMAL', instruction: 'Speak naturally, at your normal distance and volume. Read the sentence on screen aloud.' },
  { id: 'quiet', label: 'QUIET / FAR', instruction: 'Now move a step back from the microphone, or lower your voice, and read it again.' },
  { id: 'close', label: 'CLOSE / LOUD', instruction: 'Now come closer to the microphone, or speak a bit louder, and read it once more.' },
];

/** At least this many of the 3 conditions must produce a usable sample —
 * matches the store's 5-sample cap loosely rather than exactly, since a
 * single failed condition should not block enrollment outright. */
export const MIN_VOICE_STEPS_REQUIRED = 2;
