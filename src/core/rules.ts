import type { Ball, LifeLostReason, MatchState, PlayerCommand, PlayerId, RuleEvent, Shot, Table, Turn } from './model';
import { vec } from './model';
import { DT, speedOf, timeToStop, type PhysicsParams } from './physics';

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

/** Pause after a life loss so the consequence is legible before the balls respawn. */
export const RESOLVE_TICKS = 90;
/** After contact, the cue ball is handed to the next shooter once it stops or after this many ticks. */
export const HANDOFF_GRACE_TICKS = 60;
export const RESPAWN_OBJECT_SPEED = 1.0;
/** Distance in from the short end at which a retrieved cue ball is placed. */
export const CUE_RETRIEVE_INSET = 0.22;
const CUE_RETRIEVE_MAX_Y = 0.4;
/** Spread of the respawned object ball's direction around the long axis, radians. */
const RESPAWN_SPREAD = Math.PI / 6;

export function xorshift32(state: number): number {
  let x = state >>> 0;
  if (x === 0) x = 0x9e3779b9;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Uniform [0,1) from an xorshift state word. */
export function unit01(state: number): number {
  return (state >>> 0) / 4294967296;
}

/** Sign of the short end a player owns: player 0 shoots from x<0, player 1 from x>0. */
export function endSign(player: PlayerId): -1 | 1 {
  return player === 0 ? -1 : 1;
}

export function other(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

export function legalZone(table: Table, rules: CrudRules, player: PlayerId): { xMin: number; xMax: number } {
  const half = table.length / 2;
  const depth = rules.shortEndDepth * table.length;
  return player === 0 ? { xMin: -half, xMax: -half + depth } : { xMin: half - depth, xMax: half };
}

/** Who may strike the cue ball right now, if anyone. */
export function activeShooter(turn: Turn): PlayerId | null {
  switch (turn.kind) {
    case 'serve':
    case 'awaiting_shot':
      return turn.shooter;
    default:
      return null;
  }
}

/** Where a retrieved cue ball is put down for `player`: near their end, roughly in line with the object ball. */
export function retrievedCue(table: Table, player: PlayerId, object: Ball): Ball {
  const x = endSign(player) * (table.length / 2 - CUE_RETRIEVE_INSET);
  const y = Math.max(-CUE_RETRIEVE_MAX_Y, Math.min(CUE_RETRIEVE_MAX_Y, object.pocketed ? 0 : object.pos.y * 0.5));
  return { pos: vec(x, y), vel: vec(0, 0), pocketed: false };
}

/** Object ball rolling from the centre, away from the server, in a seeded direction. */
export function respawnObject(rng: number, server: PlayerId): { object: Ball; rng: number } {
  const next = xorshift32(rng);
  const spread = (unit01(next) - 0.5) * 2 * RESPAWN_SPREAD;
  const angle = (server === 0 ? 0 : Math.PI) + spread;
  return {
    object: { pos: vec(0, 0), vel: vec(Math.cos(angle) * RESPAWN_OBJECT_SPEED, Math.sin(angle) * RESPAWN_OBJECT_SPEED), pocketed: false },
    rng: next,
  };
}

const REFERENCE_NUMERICS: readonly (keyof CrudRules)[] = ['startingLives', 'serveAttempts', 'stoppedSpeed', 'shortEndDepth', 'minTravel', 'maxShotSpeed'];
/** Rules that are always in force regardless of switches: no cues, object must keep moving, lives, serve attempts, short-end stance. */
const CORE_RULE_COUNT = 5;

/** Count of rule switches enabled, for the `RULES IN FORCE: n / 47` counter. */
export function rulesInForce(rules: CrudRules): number {
  let n = CORE_RULE_COUNT;
  if (rules.forbidShootingBackwards) n += 1;
  if (rules.forbidLongSideShots) n += 1;
  n += 1; // pocketPenalty always names someone
  for (const key of REFERENCE_NUMERICS) {
    if (rules[key] !== DEMO_RULES[key]) n += 1;
  }
  return n;
}

function facesTable(angle: number, shooter: PlayerId): boolean {
  return Math.cos(angle) * -endSign(shooter) >= 0;
}

/** Whether the shooter may take this shot right now. Returns the reason if not. */
export function validateShot(state: MatchState, rules: CrudRules, shooter: PlayerId, shot: Shot): LifeLostReason | null {
  const fly = state.players[shooter].fly;
  const zone = legalZone(state.table, rules, shooter);
  if (rules.forbidLongSideShots && (fly.pos.x < zone.xMin || fly.pos.x > zone.xMax)) return 'shot_from_long_side';
  if (rules.forbidShootingBackwards && !facesTable(shot.angle, shooter)) return 'shot_backwards';
  return null;
}

function normAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Clamp a command to what the rules allow from this position (angle window, force cap). Never throws. */
export function clampCommand(state: MatchState, rules: CrudRules, shooter: PlayerId, cmd: PlayerCommand): PlayerCommand {
  if (cmd.kind !== 'shoot') return cmd;
  const forceRaw = Number.isFinite(cmd.shot.force) ? cmd.shot.force : 0;
  const force = Math.max(0, Math.min(1, forceRaw));
  let angle = Number.isFinite(cmd.shot.angle) ? normAngle(cmd.shot.angle) : -endSign(shooter) === 1 ? 0 : Math.PI;
  if (rules.forbidShootingBackwards && !facesTable(angle, shooter)) {
    angle = Math.sin(angle) >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  return { kind: 'shoot', shot: { angle, force } };
}

interface Step {
  state: MatchState;
  events: RuleEvent[];
}

function setPlayerLives(state: MatchState, player: PlayerId, lives: number): MatchState {
  const players = state.players.map((p) => (p.id === player ? { ...p, lives } : p)) as unknown as MatchState['players'];
  return { ...state, players };
}

function loseLife(step: Step, player: PlayerId, reason: LifeLostReason, tick: number): Step {
  const lives = Math.max(0, step.state.players[player].lives - 1);
  const lost: RuleEvent = { kind: 'life_lost', player, reason, tick };
  let state = setPlayerLives(step.state, player, lives);
  const events = [...step.events, lost];
  if (lives === 0) {
    const winner = other(player);
    events.push({ kind: 'match_over', winner, tick });
    state = { ...state, turn: { kind: 'over', winner } };
  } else {
    state = { ...state, turn: { kind: 'resolving', outcome: lost } };
  }
  return { state, events };
}

function serveFault(step: Step, rules: CrudRules, shooter: PlayerId, attempt: 1 | 2 | 3, tick: number): Step {
  const events = [...step.events, { kind: 'serve_fault', player: shooter, attempt, tick } as RuleEvent];
  if (attempt >= rules.serveAttempts) return loseLife({ state: step.state, events }, shooter, 'three_serve_faults', tick);
  const spawn = respawnObject(step.state.rng, shooter);
  const nextAttempt = Math.min(3, attempt + 1) as 1 | 2 | 3;
  return {
    state: {
      ...step.state,
      object: spawn.object,
      cue: retrievedCue(step.state.table, shooter, spawn.object),
      rng: spawn.rng,
      turn: { kind: 'serve', shooter, attempt: nextAttempt },
    },
    events,
  };
}

function deadlineFor(state: MatchState, physics: PhysicsParams, rules: CrudRules): number {
  const t = timeToStop(state.object, physics, rules.stoppedSpeed);
  return Number.isFinite(t) ? state.tick + Math.ceil(t / DT) : state.tick;
}

function lastContactTick(state: MatchState, events: readonly RuleEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.kind === 'contact') return e.tick;
  }
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (e && e.kind === 'contact') return e.tick;
  }
  return -Infinity;
}

/**
 * Turn machine.
 *
 *   serve{shooter, attempt}
 *     object ball rolling from a respawn; cue ball placed at the shooter's end.
 *     legal_shot            -> awaiting_shot{shooter, deadlineTick, serveAttempt: attempt}
 *     illegal strike        -> life_lost(reason)                         -> resolving | over
 *     object stops/pocketed -> serve_fault; attempt < serveAttempts      -> serve{attempt+1} (object respawned)
 *                              attempt == serveAttempts                  -> life_lost(three_serve_faults)
 *   awaiting_shot{shooter, deadlineTick, serveAttempt?}
 *     the shooter has struck (or re-struck) and the cue ball is in flight.
 *     contact               -> in_play{lastShooter: shooter}
 *     object pocketed       -> serve? serve_fault : life_lost(object_ball_pocketed) per pocketPenalty
 *                              (last_shooter = the opponent who set it moving, next_shooter = shooter)
 *     object stops          -> serve? serve_fault : life_lost(object_ball_stopped) for shooter
 *     cue stops/pocketed    -> cue retrieved to the shooter's end; the shooter may strike again
 *     illegal strike        -> life_lost(reason)
 *   in_play{lastShooter}
 *     contact has happened; the object ball is the next shooter's problem.
 *     object pocketed       -> life_lost(object_ball_pocketed) per pocketPenalty
 *     object stops          -> life_lost(object_ball_stopped) for lastShooter (a dead hit)
 *     cue stops/pocketed or HANDOFF_GRACE_TICKS since contact
 *                           -> cue retrieved to the opponent's end; awaiting_shot{shooter: opponent}
 *   resolving{outcome}
 *     RESOLVE_TICKS after outcome.tick -> both balls respawn; serve{shooter: opponent of penalised, attempt 1}
 *   over{winner}
 *     terminal.
 *
 * Every life loss appends life_lost; reaching zero lives appends match_over and moves to over.
 * The cue ball being pocketed is never penalised; it is simply retrieved. minTravel is not enforced.
 */
export function adjudicate(state: MatchState, rules: CrudRules, physicsEvents: readonly RuleEvent[]): { state: MatchState; events: RuleEvent[] } {
  return adjudicateWith(state, rules, DEFAULT_ADJUDICATION_PHYSICS, physicsEvents);
}

/** Only the deceleration matters here (for deadline estimates); demo value keeps `adjudicate` pure and self-contained. */
const DEFAULT_ADJUDICATION_PHYSICS: PhysicsParams = { rollingDecel: 0.35, ballRestitution: 0.93, cushionRestitution: 0.75 };

export function adjudicateWith(
  state: MatchState,
  rules: CrudRules,
  physics: PhysicsParams,
  physicsEvents: readonly RuleEvent[],
): { state: MatchState; events: RuleEvent[] } {
  const tick = state.tick;
  let step: Step = { state, events: [...physicsEvents] };

  const penalty = physicsEvents.find((e) => e.kind === 'life_lost');
  if (penalty && penalty.kind === 'life_lost' && state.turn.kind !== 'over' && state.turn.kind !== 'resolving') {
    step = { state, events: physicsEvents.filter((e) => e !== penalty) };
    return loseLife(step, penalty.player, penalty.reason, tick);
  }

  const has = (kind: RuleEvent['kind']): boolean => physicsEvents.some((e) => e.kind === kind);
  const objPocketed = physicsEvents.some((e) => e.kind === 'pocket' && e.ball === 'object');
  const cuePocketed = physicsEvents.some((e) => e.kind === 'pocket' && e.ball === 'cue');
  const objStopped = !state.object.pocketed && speedOf(state.object) < rules.stoppedSpeed;
  const cueStopped = !state.cue.pocketed && speedOf(state.cue) < rules.stoppedSpeed;

  const turn = state.turn;
  switch (turn.kind) {
    case 'serve': {
      if (has('legal_shot')) {
        const s = step.state;
        return {
          ...step,
          state: { ...s, turn: { kind: 'awaiting_shot', shooter: turn.shooter, deadlineTick: deadlineFor(s, physics, rules), serveAttempt: turn.attempt } },
        };
      }
      if (objStopped || objPocketed) return serveFault(step, rules, turn.shooter, turn.attempt, tick);
      if (cuePocketed) return { ...step, state: { ...step.state, cue: retrievedCue(state.table, turn.shooter, state.object) } };
      return step;
    }
    case 'awaiting_shot': {
      if (has('contact')) {
        step = { ...step, state: { ...step.state, turn: { kind: 'in_play', lastShooter: turn.shooter } } };
        return inPlay(step, rules, physics, turn.shooter, tick, objPocketed, objStopped, cueStopped, cuePocketed);
      }
      if (objPocketed) {
        if (turn.serveAttempt !== undefined) return serveFault(step, rules, turn.shooter, turn.serveAttempt, tick);
        const culprit = rules.pocketPenalty === 'last_shooter' ? other(turn.shooter) : turn.shooter;
        return loseLife(step, culprit, 'object_ball_pocketed', tick);
      }
      if (objStopped) {
        if (turn.serveAttempt !== undefined) return serveFault(step, rules, turn.shooter, turn.serveAttempt, tick);
        return loseLife(step, turn.shooter, 'object_ball_stopped', tick);
      }
      if (cueStopped || cuePocketed) {
        return { ...step, state: { ...step.state, cue: retrievedCue(state.table, turn.shooter, state.object) } };
      }
      return step;
    }
    case 'in_play':
      return inPlay(step, rules, physics, turn.lastShooter, tick, objPocketed, objStopped, cueStopped, cuePocketed);
    case 'resolving': {
      if (tick < turn.outcome.tick + RESOLVE_TICKS) return step;
      const penalised: PlayerId = turn.outcome.kind === 'life_lost' ? turn.outcome.player : 0;
      const server = other(penalised);
      const spawn = respawnObject(step.state.rng, server);
      return {
        ...step,
        state: {
          ...step.state,
          object: spawn.object,
          cue: retrievedCue(state.table, server, spawn.object),
          rng: spawn.rng,
          turn: { kind: 'serve', shooter: server, attempt: 1 },
        },
      };
    }
    case 'over':
      return step;
  }
}

function inPlay(
  step: Step,
  rules: CrudRules,
  physics: PhysicsParams,
  lastShooter: PlayerId,
  tick: number,
  objPocketed: boolean,
  objStopped: boolean,
  cueStopped: boolean,
  cuePocketed: boolean,
): Step {
  if (objPocketed) {
    const culprit = rules.pocketPenalty === 'last_shooter' ? lastShooter : other(lastShooter);
    return loseLife(step, culprit, 'object_ball_pocketed', tick);
  }
  if (objStopped) return loseLife(step, lastShooter, 'object_ball_stopped', tick);
  const sinceContact = tick - lastContactTick(step.state, step.events);
  if (cueStopped || cuePocketed || sinceContact >= HANDOFF_GRACE_TICKS) {
    const next = other(lastShooter);
    const s = step.state;
    const cue = retrievedCue(s.table, next, s.object);
    return {
      ...step,
      state: { ...s, cue, turn: { kind: 'awaiting_shot', shooter: next, deadlineTick: deadlineFor(s, physics, rules) } },
    };
  }
  return step;
}
