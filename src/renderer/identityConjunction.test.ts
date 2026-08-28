import { describe, expect, it } from 'vitest';
import { resolveVoiceFaceTrust } from './identityConjunction';

describe('resolveVoiceFaceTrust', () => {
  it('confirms when voice and a known face agree', () => {
    expect(resolveVoiceFaceTrust('Robbie', { name: 'Robbie', unknown: false })).toEqual({ tier: 'confirmed', name: 'Robbie' });
  });

  it('confirms case-insensitively with surrounding whitespace tolerated', () => {
    expect(resolveVoiceFaceTrust(' Robbie ', { name: 'ROBBIE', unknown: false })).toEqual({ tier: 'confirmed', name: 'Robbie' });
  });

  it('allows voice-only trust when no camera signal exists at all', () => {
    expect(resolveVoiceFaceTrust('Robbie', null)).toEqual({ tier: 'voice-only', name: 'Robbie' });
  });

  it('refuses trust when the camera shows an unknown person — the case that matters for unattended watching', () => {
    // A different person's voice happening to score above the WavLM threshold
    // (measured false-accept rate: 25-33%) must not borrow the owner's trust
    // just because nobody is confirming it against the camera.
    const result = resolveVoiceFaceTrust('Robbie', { name: 'Unknown person', unknown: true });
    expect(result.tier).toBe('conflict');
  });

  it('refuses trust when the camera shows a different known person', () => {
    const result = resolveVoiceFaceTrust('Robbie', { name: 'Alex', unknown: false });
    expect(result).toEqual({ tier: 'conflict', voiceName: 'Robbie', faceName: 'Alex' });
  });
});
