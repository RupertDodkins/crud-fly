import type { LifeLostReason, MatchState, PlayerCommand, PlayerId, RuleEvent, Shot } from './model';

/**
 * Crud rules as configuration. Every boolean is one of the "47 caveats"; the HUD counts how many are
 * enabled and which have fired. Defaults are the public common core, labelled DEMO in the UI because
 * every table has its own house rules.
 */
export interface CrudRules {
  readonly startingLives: number;
  readonly serveAttempts: number;
  /** Object ball speed below which it counts as stopped, m/s. */
  readonly stoppedSpeed: number;
  /** Fraction of table length from each short end that counts as a legal stance. */
  readonly shortEndDepth: number;
  /** Minimum object-ball travel after contact, metres. 6 inches in the canon. */
  readonly minTravel: number;
  readonly forbidShootingBackwards: boolean;
  readonly forbidLongSideShots: boolean;
  /** Who loses a life when the object ball is pocketed: the last shooter, or the player about to shoot. */
  readonly pocketPenalty: 'last_shooter' | 'next_shooter';
  /** Max cue-ball impulse speed, m/s. Caps `Shot.force`. */
  readonly maxShotSpeed: number;
}

export const DEMO_RULES: CrudRules = {
  startingLives: 3,
  serveAttempts: 3,
  stoppedSpeed: 0.02,
  shortEndDepth: 0.15,
  minTravel: 0.1524,
  forbidShootingBackwards: true,
  forbidLongSideShots: true,
  pocketPenalty: 'last_shooter',
  maxShotSpeed: 6,
};

/** Count of rule switches enabled, for the `RULES IN FORCE: n / 47` counter. */
export function rulesInForce(rules: CrudRules): number {
  throw new Error('not implemented');
}

/** Whether the shooter may take this shot right now. Returns the reason if not. */
export function validateShot(state: MatchState, rules: CrudRules, shooter: PlayerId, shot: Shot): LifeLostReason | null {
  throw new Error('not implemented');
}

/** Clamp a command to what the rules allow from this position (angle window, force cap). Never throws. */
export function clampCommand(state: MatchState, rules: CrudRules, shooter: PlayerId, cmd: PlayerCommand): PlayerCommand {
  throw new Error('not implemented');
}

/**
 * Advance the turn machine given what physics reported this tick. Pure. Returns the new state
 * and any events to append. Physics never decides lives; only this does.
 */
export function adjudicate(state: MatchState, rules: CrudRules, physicsEvents: readonly RuleEvent[]): { state: MatchState; events: RuleEvent[] } {
  throw new Error('not implemented');
}
