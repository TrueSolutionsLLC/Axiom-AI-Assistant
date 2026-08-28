import type { CompanionState } from '../shared/contracts';

export interface VisualState { mode: CompanionState; energy: number; }

export type VisualAction = { type: 'mode'; mode: CompanionState } | { type: 'energy'; energy: number };

export function visualReducer(state: VisualState, action: VisualAction): VisualState {
  if (action.type === 'mode') return { ...state, mode: action.mode };
  return { ...state, energy: Math.max(0, Math.min(1, action.energy)) };
}

export function stateLabel(mode: CompanionState): string {
  return ({ idle: 'PRESENT', listening: 'LISTENING', thinking: 'SYNTHESIZING', speaking: 'RESPONDING', success: 'VERIFIED', warning: 'ATTENTION', error: 'FAULT' })[mode];
}
