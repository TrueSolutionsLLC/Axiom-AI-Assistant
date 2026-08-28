/**
 * Guided multi-angle face enrollment, modeled on the Face ID pattern: prompt
 * for a sequence of head poses instead of grabbing whatever the camera sees in
 * one sitting. Built because the previous flow captured 6 frames in ~1.5s
 * while the user sat still facing forward — every sample was effectively the
 * same angle, which is why a face system enrolled once tends to start
 * rejecting the same person under different lighting or angle later.
 *
 * Axiom has no depth sensor, so this cannot build a literal 3D mesh the way
 * Face ID does. What it can do is use the yaw/pitch already computed by
 * MediaPipe (see useFaceTracking.ts) to confirm the user actually turned to
 * each requested angle before capturing that pose's samples — genuine
 * multi-angle diversity, not just repeated frontal shots.
 */

export type EnrollmentPoseId = 'center' | 'left' | 'right' | 'up' | 'down';

export interface EnrollmentPoseTarget {
  id: EnrollmentPoseId;
  label: string;
  instruction: string;
  matches(yaw: number, pitch: number): boolean;
}

// Thresholds give real headroom above the ±0.14 center deadzone but stay
// reachable with a comfortable head turn — not a strained one. The first
// shipped version used 0.32/0.22, tuned with no way to calibrate against a
// real camera; real testing showed roughly half of users could not reach
// left/right in time. Loosened, and paired with a longer timeout plus spoken
// guidance (App.tsx) rather than a silent, unreadable-while-turned countdown.
export const ENROLLMENT_POSES: EnrollmentPoseTarget[] = [
  { id: 'center', label: 'CENTER', instruction: 'Look straight at the camera and hold still.', matches: (yaw, pitch) => Math.abs(yaw) < 0.14 && Math.abs(pitch) < 0.14 },
  // yaw comes from useFaceTracking.ts's raw (unmirrored) camera coordinates:
  // (nose.x - eyeMidX). Turning the head to the user's own left moves the nose
  // toward larger x in that raw frame, so yaw goes POSITIVE for "left" — the
  // opposite of what the on-screen mirrored preview makes it look like. This
  // was backwards in the first shipped version; confirmed by a live user
  // report ("I have to turn right when it says left").
  { id: 'left', label: 'TURN LEFT', instruction: 'Slowly turn your head to the left.', matches: (yaw) => yaw > 0.22 },
  { id: 'right', label: 'TURN RIGHT', instruction: 'Slowly turn your head to the right.', matches: (yaw) => yaw < -0.22 },
  { id: 'up', label: 'CHIN UP', instruction: 'Tilt your chin up slightly.', matches: (_yaw, pitch) => pitch < -0.16 },
  { id: 'down', label: 'CHIN DOWN', instruction: 'Tilt your chin down slightly.', matches: (_yaw, pitch) => pitch > 0.16 },
];

export const SAMPLES_PER_POSE = 2;
export const MIN_POSES_REQUIRED = 4;
export const MIN_SAMPLES_REQUIRED = 6;
/** Per-pose capture window. Long enough to hear the spoken instruction, react,
 * and hold the pose — the old 8s was tuned only against silent on-screen text. */
export const POSE_TIMEOUT_MS = 15_000;
/** Max pairwise distance allowed WITHIN one pose's samples — the head barely
 * moves during that pose's brief capture window, so these should be near
 * identical. This is deliberately tighter than the old single global
 * threshold, which had to be loose enough to tolerate real angle variety and
 * therefore could not reliably catch a mid-capture person swap. */
const WITHIN_POSE_MAX_DISTANCE = 0.34;

const distance = (a: number[], b: number[]): number => {
  let sum = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) { const delta = a[index] - b[index]; sum += delta * delta; }
  return Math.sqrt(sum);
};

export interface EnrollmentValidation {
  accepted: boolean;
  reason?: string;
  posesCompleted: number;
  totalSamples: number;
}

/** Validates a completed (or abandoned) guided capture session. */
export function validateEnrollmentSamples(groups: Partial<Record<EnrollmentPoseId, number[][]>>): EnrollmentValidation {
  const entries = Object.entries(groups) as [EnrollmentPoseId, number[][]][];
  const nonEmpty = entries.filter(([, samples]) => samples.length > 0);
  const totalSamples = nonEmpty.reduce((sum, [, samples]) => sum + samples.length, 0);

  for (const [id, samples] of nonEmpty) {
    if (samples.length < 2) continue;
    const spread = Math.max(...samples.flatMap((left, index) => samples.slice(index + 1).map((right) => distance(left, right))));
    if (spread > WITHIN_POSE_MAX_DISTANCE) return { accepted: false, reason: `The ${id} samples were not consistent — face movement during capture, or more than one person in frame. Try again holding each pose steady.`, posesCompleted: nonEmpty.length, totalSamples };
  }

  if (nonEmpty.length < MIN_POSES_REQUIRED) return { accepted: false, reason: `Only ${nonEmpty.length} of ${ENROLLMENT_POSES.length} poses were captured; at least ${MIN_POSES_REQUIRED} are required for a reliable enrollment.`, posesCompleted: nonEmpty.length, totalSamples };
  if (totalSamples < MIN_SAMPLES_REQUIRED) return { accepted: false, reason: `Only ${totalSamples} usable samples were captured; at least ${MIN_SAMPLES_REQUIRED} are required.`, posesCompleted: nonEmpty.length, totalSamples };
  return { accepted: true, posesCompleted: nonEmpty.length, totalSamples };
}
