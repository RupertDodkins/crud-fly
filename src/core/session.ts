import type { Controller, Frame, MatchState, PlayerCommand, PlayerId } from './model';
import type { CrudRules } from './rules';
import type { PhysicsParams } from './physics';
import type { Tape } from '../replay/codec';

export interface SessionConfig {
  readonly seed: number;
  readonly rules: CrudRules;
  readonly physics: PhysicsParams;
  readonly controllers: readonly [Controller, Controller];
  readonly names?: readonly [string, string];
  /** Record a state hash every N ticks into the tape. */
  readonly hashEvery?: number;
}

/**
 * The only writer of MatchState. Each step: build observations, ask controllers, clamp commands via
 * rules, move flies, apply landed strikes, step balls, adjudicate, append to tape.
 */
export interface Session {
  step(): void;
  frame(): Frame;
  tape(): Tape;
  /** True once turn.kind === 'over'. */
  done(): boolean;
}

export function createSession(config: SessionConfig): Session {
  throw new Error('not implemented');
}

/** Initial state for a seed and rules. Object ball is already rolling so the first viewer sees motion. */
export function initialState(seed: number, rules: CrudRules, names: readonly [string, string]): MatchState {
  throw new Error('not implemented');
}

/** Bounded view for one player. Pure. */
export function observe(state: MatchState, rules: CrudRules, physics: PhysicsParams, me: PlayerId): import('./model').Observation {
  throw new Error('not implemented');
}

/** Drive a session with recorded commands instead of live controllers. Used by replay and tests. */
export function replayController(id: string, commands: ReadonlyMap<number, PlayerCommand>): Controller {
  throw new Error('not implemented');
}
