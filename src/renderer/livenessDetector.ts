/**
 * Passive liveness detection from MediaPipe FaceLandmarker signal alone — no
 * additional model, camera frame, or network call. Built because face
 * recognition previously granted "FACE VERIFIED" trust from a single static
 * match with no defense against a printed photo or a phone screen held up to
 * the camera.
 *
 * Design: require BOTH a genuine blink cycle (eyes closed, then open again)
 * AND real yaw/pitch variance within a short rolling window. This defeats a
 * flat photo specifically. Yaw/pitch here are computed from landmark ratios
 * (nose position relative to eye midpoint) that stay fixed for a flat image
 * regardless of how the physical photo is rotated or shaken — unlike roll,
 * which a shaking photo can fake by tilting in the camera's 2D plane, so roll
 * is deliberately excluded from the pose-variance signal.
 *
 * Honest limit: this defeats a still photo. It does NOT defeat a video replay
 * of the person on a second screen, which can show real blinks and real head
 * motion. That needs a trained anti-spoofing model (texture/moiré/reflection
 * analysis), which is a separate, larger piece of work.
 */

export interface LivenessSample {
  at: number;
  yaw: number;
  pitch: number;
  blinkLeft: number;
  blinkRight: number;
}

export type LivenessReason = 'insufficient-samples' | 'no-blink-observed' | 'motionless' | 'live';

export interface LivenessState {
  live: boolean;
  reason: LivenessReason;
  blinkObserved: boolean;
  poseVariance: number;
  sampleCount: number;
  windowMs: number;
}

export const LIVENESS_WINDOW_MS = 3000;
const MIN_SAMPLES = 6;
const BLINK_CLOSED = 0.35;
const BLINK_OPEN = 0.75;
const MIN_POSE_VARIANCE = 0.018;

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const stddev = (values: number[]): number => { const m = mean(values); return Math.sqrt(mean(values.map((value) => (value - m) ** 2))); };

/** True if the sample sequence contains a full closed-then-open blink cycle. */
function hasBlinkCycle(samples: LivenessSample[]): boolean {
  let wasClosed = false;
  for (const sample of samples) {
    const eyeOpen = Math.min(sample.blinkLeft, sample.blinkRight);
    if (eyeOpen < BLINK_CLOSED) wasClosed = true;
    else if (wasClosed && eyeOpen > BLINK_OPEN) return true;
  }
  return false;
}

export function assessLiveness(samples: LivenessSample[], now = samples.at(-1)?.at ?? Date.now()): LivenessState {
  const windowed = samples.filter((sample) => now - sample.at <= LIVENESS_WINDOW_MS && now - sample.at >= 0);
  if (windowed.length < MIN_SAMPLES) return { live: false, reason: 'insufficient-samples', blinkObserved: false, poseVariance: 0, sampleCount: windowed.length, windowMs: LIVENESS_WINDOW_MS };

  const blinkObserved = hasBlinkCycle(windowed);
  const poseVariance = stddev(windowed.map((sample) => sample.yaw)) + stddev(windowed.map((sample) => sample.pitch));

  if (!blinkObserved) return { live: false, reason: 'no-blink-observed', blinkObserved: false, poseVariance, sampleCount: windowed.length, windowMs: LIVENESS_WINDOW_MS };
  if (poseVariance < MIN_POSE_VARIANCE) return { live: false, reason: 'motionless', blinkObserved: true, poseVariance, sampleCount: windowed.length, windowMs: LIVENESS_WINDOW_MS };
  return { live: true, reason: 'live', blinkObserved: true, poseVariance, sampleCount: windowed.length, windowMs: LIVENESS_WINDOW_MS };
}

/** Bounded ring buffer for feeding assessLiveness from a live tracking loop. */
export class LivenessBuffer {
  private samples: LivenessSample[] = [];
  push(sample: LivenessSample): void {
    this.samples.push(sample);
    const cutoff = sample.at - LIVENESS_WINDOW_MS * 2;
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
  }
  assess(now?: number): LivenessState { return assessLiveness(this.samples, now); }
  clear(): void { this.samples = []; }
}
