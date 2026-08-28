import { describe, expect, it } from 'vitest';
import { assessLiveness, LivenessBuffer, LivenessSample } from './livenessDetector';

// Synthesizes a sample stream at ~22fps (the app's real detection cadence)
// over a given duration, letting each test vary yaw/pitch/blink independently.
function synth(durationMs: number, at: (t: number) => Omit<LivenessSample, 'at'>): LivenessSample[] {
  const samples: LivenessSample[] = [];
  for (let t = 0; t <= durationMs; t += 45) samples.push({ at: t, ...at(t) });
  return samples;
}

describe('assessLiveness', () => {
  it('reports insufficient-samples before enough frames arrive', () => {
    const samples = synth(90, () => ({ yaw: 0.1, pitch: 0.05, blinkLeft: 1, blinkRight: 1 }));
    expect(assessLiveness(samples).reason).toBe('insufficient-samples');
  });

  it('refuses a perfectly static photo: no blink, no pose variance', () => {
    // A flat image detected continuously produces a fixed landmark geometry.
    const samples = synth(3000, () => ({ yaw: 0.12, pitch: -0.04, blinkLeft: 0.9, blinkRight: 0.9 }));
    const result = assessLiveness(samples);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('no-blink-observed');
  });

  it('refuses a photo shaken by hand: motion without genuine blink or pose change', () => {
    // Physically shaking a flat photo can jitter noise slightly but produces
    // no real blink cycle and negligible yaw/pitch change (those come from
    // landmark ratios baked into the fixed image, not physical hand motion).
    const samples = synth(3000, (t) => ({ yaw: 0.1 + Math.sin(t / 40) * 0.002, pitch: -0.03 + Math.cos(t / 55) * 0.002, blinkLeft: 0.88, blinkRight: 0.9 }));
    const result = assessLiveness(samples);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('no-blink-observed');
  });

  it('refuses a real face that never blinks and never moves: no false "live" from motion alone', () => {
    const samples = synth(3000, (t) => ({ yaw: 0.05 + Math.sin(t / 90) * 0.1, pitch: 0.02 + Math.cos(t / 110) * 0.08, blinkLeft: 1, blinkRight: 1 }));
    const result = assessLiveness(samples);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('no-blink-observed');
    expect(result.poseVariance).toBeGreaterThan(0.018);
  });

  it('refuses genuine blinks with a perfectly motionless head (still requires pose variance)', () => {
    const samples = synth(3000, (t) => {
      const blinking = t > 1200 && t < 1350;
      const eye = blinking ? 0.1 : 1;
      return { yaw: 0.1, pitch: 0.02, blinkLeft: eye, blinkRight: eye };
    });
    const result = assessLiveness(samples);
    expect(result.blinkObserved).toBe(true);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('motionless');
  });

  it('accepts a real person: natural blink cycle plus small continuous head motion', () => {
    const samples = synth(3000, (t) => {
      const blinking = t > 1400 && t < 1520;
      const eye = blinking ? 0.15 : 0.95;
      return { yaw: Math.sin(t / 260) * 0.1, pitch: Math.cos(t / 310) * 0.07, blinkLeft: eye, blinkRight: eye };
    });
    const result = assessLiveness(samples);
    expect(result.live).toBe(true);
    expect(result.reason).toBe('live');
    expect(result.blinkObserved).toBe(true);
  });

  it('only credits a blink that actually reopens, not a permanently closed eye', () => {
    // Eyes close and stay closed: could be a bad crop or a person looking down,
    // but it is not a completed blink cycle and must not grant trust.
    const samples = synth(3000, (t) => { const eye = t > 1200 ? 0.1 : 1; return { yaw: Math.sin(t / 200) * 0.1, pitch: 0, blinkLeft: eye, blinkRight: eye }; });
    const result = assessLiveness(samples);
    expect(result.blinkObserved).toBe(false);
  });

  it('only looks at the recent window, so a stale blink from long ago does not count', () => {
    const early = synth(200, (t) => { const eye = t > 90 && t < 140 ? 0.1 : 0.95; return { yaw: Math.sin(t / 100) * 0.15, pitch: 0, blinkLeft: eye, blinkRight: eye }; });
    const later = synth(3000, () => ({ yaw: 0.05, pitch: 0.05, blinkLeft: 0.9, blinkRight: 0.9 })).map((sample) => ({ ...sample, at: sample.at + 6000 }));
    const result = assessLiveness([...early, ...later]);
    expect(result.blinkObserved).toBe(false);
    expect(result.reason).toBe('no-blink-observed');
  });
});

describe('LivenessBuffer', () => {
  it('bounds memory by discarding samples well outside the assessment window', () => {
    const buffer = new LivenessBuffer();
    for (let t = 0; t <= 20000; t += 45) buffer.push({ at: t, yaw: 0.05, pitch: 0.05, blinkLeft: 0.9, blinkRight: 0.9 });
    const assessed = buffer.assess(20000);
    // Only samples within roughly the last two assessment windows should remain.
    expect(assessed.sampleCount).toBeLessThan(200);
  });

  it('reaches a live verdict fed frame-by-frame, matching the batch result', () => {
    const buffer = new LivenessBuffer();
    const samples = synth(3000, (t) => {
      const blinking = t > 1400 && t < 1520;
      const eye = blinking ? 0.15 : 0.95;
      return { yaw: Math.sin(t / 260) * 0.1, pitch: Math.cos(t / 310) * 0.07, blinkLeft: eye, blinkRight: eye };
    });
    for (const sample of samples) buffer.push(sample);
    expect(buffer.assess(3000).live).toBe(true);
  });

  it('clear() resets state so a new person is never trusted from a stale buffer', () => {
    const buffer = new LivenessBuffer();
    const samples = synth(3000, (t) => { const eye = t > 1400 && t < 1520 ? 0.15 : 0.95; return { yaw: Math.sin(t / 260) * 0.1, pitch: 0.05, blinkLeft: eye, blinkRight: eye }; });
    for (const sample of samples) buffer.push(sample);
    expect(buffer.assess(3000).live).toBe(true);
    buffer.clear();
    expect(buffer.assess(3000).reason).toBe('insufficient-samples');
  });
});
