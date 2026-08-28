import { describe, expect, it } from 'vitest';
import { isSpeechArticulating, protectedVoiceMode } from './speechVisualGuard';

describe('speech visual ownership', () => {
  it('does not let microphone VAD steal the speaking state during playback', () => {
    expect(protectedVoiceMode(true, 'listening')).toBe('speaking');
    expect(protectedVoiceMode(true, 'idle')).toBe('speaking');
  });

  it('allows listening and idle after playback has actually ended', () => {
    expect(protectedVoiceMode(false, 'listening')).toBe('listening');
    expect(protectedVoiceMode(false, 'idle')).toBe('idle');
  });

  it('keeps valid articulation alive through a transient HUD state collision', () => {
    expect(isSpeechArticulating('listening', .64)).toBe(true);
    expect(isSpeechArticulating('idle', .18)).toBe(true);
    expect(isSpeechArticulating('idle', 0)).toBe(false);
  });
});
