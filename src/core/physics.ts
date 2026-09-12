import type { Ball, FlyBody, MatchState, RuleEvent, Shot, Table, Vec2 } from './model';

/** Fixed step. 120 Hz keeps two-ball contact stable without substeps. */
export const DT = 1 / 120;

export interface PhysicsParams {
  /** Rolling deceleration, m/s^2. */
  readonly rollingDecel: number;
  readonly ballRestitution: number;
  readonly cushionRestitution: number;
}

export const DEMO_PHYSICS: PhysicsParams = {
  rollingDecel: 0.35,
  ballRestitution: 0.93,
  cushionRestitution: 0.75,
};

/** Standard 9-ft table in metres, six pockets. */
export function standardTable(): Table {
  throw new Error('not implemented');
}

export interface PhysicsResult {
  readonly cue: Ball;
  readonly object: Ball;
  /** contact / pocket events only. Never life events. */
  readonly events: RuleEvent[];
}

/** One fixed step of ball motion. Pure. Deterministic for identical inputs (no Math.random, no Date). */
export function stepBalls(cue: Ball, object: Ball, table: Table, params: PhysicsParams, tick: number): PhysicsResult {
  throw new Error('not implemented');
}

/** Convert a validated shot into a cue-ball velocity. The only way force enters the table. */
export function applyShot(cue: Ball, shot: Shot, maxSpeed: number): Ball {
  throw new Error('not implemented');
}

/** Seconds until a rolling ball stops under constant deceleration. Infinity if already stopped. */
export function timeToStop(ball: Ball, params: PhysicsParams, stoppedSpeed: number): number {
  throw new Error('not implemented');
}

/** Move the fly body one step toward its target / through its phase machine. Returns whether the strike landed this tick. */
export function stepFly(fly: FlyBody, target: Vec2 | null, cue: Ball, table: Table): { fly: FlyBody; struck: boolean } {
  throw new Error('not implemented');
}

/** FNV-1a over the quantised numeric fields of state. Used for replay checkpoints. */
export function hashState(state: MatchState): string {
  throw new Error('not implemented');
}
