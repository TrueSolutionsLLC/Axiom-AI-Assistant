import { describe, expect, it } from 'vitest';
import { ENROLLMENT_POSES, validateEnrollmentSamples } from './faceEnrollmentGuide';

const near = (base: number[], jitter = 0.01): number[] => base.map((v) => v + (Math.random() * 2 - 1) * jitter);
const vec = (seed: number): number[] => Array.from({ length: 128 }, (_, i) => Math.sin(seed + i) * 0.5);

describe('ENROLLMENT_POSES', () => {
  it('defines a distinguishable target for every advertised pose', () => {
    expect(ENROLLMENT_POSES.map((p) => p.id)).toEqual(['center', 'left', 'right', 'up', 'down']);
    // Adjacent poses must not both match the same yaw/pitch, or the guided
    // flow could silently accept "left" samples while the user is centered.
    expect(ENROLLMENT_POSES.find((p) => p.id === 'center')!.matches(0, 0)).toBe(true);
    // yaw>0 is the user's own left in useFaceTracking.ts's raw camera
    // coordinates — see the comment in faceEnrollmentGuide.ts. Getting this
    // backwards is exactly the bug a live user hit ("turn left" required
    // turning right instead), so this pins the correct sign explicitly.
    expect(ENROLLMENT_POSES.find((p) => p.id === 'left')!.matches(0, 0)).toBe(false);
    expect(ENROLLMENT_POSES.find((p) => p.id === 'left')!.matches(0.5, 0)).toBe(true);
    expect(ENROLLMENT_POSES.find((p) => p.id === 'right')!.matches(0.5, 0)).toBe(false);
    expect(ENROLLMENT_POSES.find((p) => p.id === 'right')!.matches(-0.5, 0)).toBe(true);
    expect(ENROLLMENT_POSES.find((p) => p.id === 'up')!.matches(0, -0.4)).toBe(true);
    expect(ENROLLMENT_POSES.find((p) => p.id === 'down')!.matches(0, -0.4)).toBe(false);
  });
});

describe('validateEnrollmentSamples', () => {
  it('accepts a full, consistent five-pose capture', () => {
    const groups = Object.fromEntries(ENROLLMENT_POSES.map((pose, index) => [pose.id, [near(vec(index * 10)), near(vec(index * 10))]]));
    const result = validateEnrollmentSamples(groups);
    expect(result.accepted).toBe(true);
    expect(result.posesCompleted).toBe(5);
    expect(result.totalSamples).toBe(10);
  });

  it('accepts a partial capture that still clears the minimum pose count', () => {
    const groups = Object.fromEntries(ENROLLMENT_POSES.slice(0, 4).map((pose, index) => [pose.id, [near(vec(index * 10)), near(vec(index * 10))]]));
    expect(validateEnrollmentSamples(groups).accepted).toBe(true);
  });

  it('refuses a capture with too few completed poses', () => {
    const groups = Object.fromEntries(ENROLLMENT_POSES.slice(0, 3).map((pose, index) => [pose.id, [near(vec(index * 10)), near(vec(index * 10))]]));
    const result = validateEnrollmentSamples(groups);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/at least 4/i);
  });

  it('refuses when samples within one pose are inconsistent — likely movement or a person swap', () => {
    const groups: Record<string, number[][]> = { center: [vec(1), vec(1)], left: [vec(2), vec(2)], right: [vec(3), vec(3)], up: [vec(4), vec(99)] };
    const result = validateEnrollmentSamples(groups);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/up samples were not consistent/i);
  });

  it('refuses a capture with enough poses but too few total samples', () => {
    const groups = Object.fromEntries(ENROLLMENT_POSES.slice(0, 4).map((pose, index) => [pose.id, [near(vec(index * 10))]]));
    const result = validateEnrollmentSamples(groups);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/at least 6/i);
  });

  it('never accepts an empty capture', () => {
    expect(validateEnrollmentSamples({}).accepted).toBe(false);
  });
});
