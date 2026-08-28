import { describe, expect, it } from 'vitest';
import { MIN_VOICE_STEPS_REQUIRED, VOICE_ENROLLMENT_SCRIPT, VOICE_ENROLLMENT_STEPS } from './voiceEnrollmentGuide';

describe('guided voice enrollment script',()=>{
  // "Speak naturally for five seconds" with nothing to say tended to
  // produce hesitant, quiet, or too-short samples. A fixed reference
  // sentence fixes that — but only if it's actually long enough to be
  // worth reading and the same one is used for every condition, so
  // distance/volume stays the only intentional variable across steps.
  it('is a real sentence long enough to fill a five-second capture window',()=>{
    expect(VOICE_ENROLLMENT_SCRIPT.trim().length).toBeGreaterThan(40);
    expect(VOICE_ENROLLMENT_SCRIPT.split(/\s+/).length).toBeGreaterThanOrEqual(12);
  });

  it('points every step at reading the on-screen sentence, not a spoken-aloud repeat-after-me', () => {
    for (const step of VOICE_ENROLLMENT_STEPS) {
      expect(step.instruction).toMatch(/read/i);
      expect(step.instruction).not.toContain(VOICE_ENROLLMENT_SCRIPT);
    }
  });

  it('keeps three conditions and the existing pass threshold',()=>{
    expect(VOICE_ENROLLMENT_STEPS).toHaveLength(3);
    expect(MIN_VOICE_STEPS_REQUIRED).toBeLessThanOrEqual(VOICE_ENROLLMENT_STEPS.length);
  });
});
