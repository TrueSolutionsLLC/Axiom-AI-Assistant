/**
 * Decides whether an accepted voice match may be granted full trust, given
 * whatever the camera currently sees.
 *
 * Measured empirically (2026-08-24, against real audio from 4 different
 * people through Axiom's own WavLM pipeline): a strong voice-only match had a
 * 25-33% false-accept rate at Axiom's actual operating thresholds. The
 * previous code granted full 'verified' trust from voice alone whenever
 * similarity cleared the threshold, without ever checking whether the camera
 * agreed — face was consulted only in the weaker fallback paths, backwards
 * from what accuracy requires. This is the fix: face corroboration is now
 * required whenever a face signal exists at all.
 */

export interface FaceSignal { name: string; unknown: boolean }

export type VoiceFaceOutcome =
  | { tier: 'confirmed'; name: string }
  /** No camera signal at all (camera off, or nobody in frame) — voice alone
   * still works, e.g. speaking from another room, but should never be treated
   * as equivalent to a camera-confirmed match. */
  | { tier: 'voice-only'; name: string }
  /** Voice claims one identity while the camera shows a different or unknown
   * person. This is the case that actually matters for unattended watching —
   * a stranger's voice must not borrow the owner's trust just because it
   * happened to score above threshold. Never grants trust. */
  | { tier: 'conflict'; voiceName: string; faceName?: string };

export function resolveVoiceFaceTrust(voiceName: string, face: FaceSignal | null): VoiceFaceOutcome {
  const name = voiceName.trim();
  if (!face) return { tier: 'voice-only', name };
  if (face.unknown) return { tier: 'conflict', voiceName: name, faceName: undefined };
  if (face.name.trim().toLowerCase() === name.toLowerCase()) return { tier: 'confirmed', name };
  return { tier: 'conflict', voiceName: name, faceName: face.name };
}
