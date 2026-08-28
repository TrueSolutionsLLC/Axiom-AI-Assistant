import type { CompanionState } from '../shared/contracts';

/**
 * Audio playback owns the avatar's visual state until playback actually ends.
 * An always-on microphone can hear Axiom's speakers and report speech while
 * Axiom is talking; that must not visually silence the mouth.
 */
export const protectedVoiceMode = (
  speechPlaybackActive: boolean,
  fallback: Extract<CompanionState, 'idle' | 'listening'>,
): CompanionState => speechPlaybackActive ? 'speaking' : fallback;

/** Keep articulating from real mouth data even if an unrelated status event
 * briefly changes the surrounding HUD mode. The speech finisher explicitly
 * resets mouthOpen to zero, so this cannot leave the jaw moving after audio. */
export const isSpeechArticulating = (mode: CompanionState, mouthOpen: number): boolean =>
  mode === 'speaking' || mouthOpen > .012;
