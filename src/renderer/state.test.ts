import { describe, expect, it } from 'vitest';
import { stateLabel, visualReducer } from './state';

describe('visual state engine', () => {
  it('changes modes without losing energy', () => {
    expect(visualReducer({ mode: 'idle', energy: 0.35 }, { type: 'mode', mode: 'thinking' })).toEqual({ mode: 'thinking', energy: 0.35 });
  });

  it('clamps animation energy', () => {
    expect(visualReducer({ mode: 'idle', energy: 0 }, { type: 'energy', energy: 2 }).energy).toBe(1);
    expect(visualReducer({ mode: 'idle', energy: 1 }, { type: 'energy', energy: -2 }).energy).toBe(0);
  });

  it('has a readable label for every state', () => {
    for (const mode of ['idle', 'listening', 'thinking', 'speaking', 'success', 'warning', 'error'] as const) expect(stateLabel(mode).length).toBeGreaterThan(3);
  });
});
