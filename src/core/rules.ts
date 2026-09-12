import type { Ball, FlyBody, LifeLostReason, MatchState, Player, PlayerCommand, PlayerId, RuleEvent, Shot, Table, Turn, Vec2 } from './model';
import { vec } from './model';
import { CARRY_OFFSET_M, GRAB_REACH_M, graspPoint } from './embodiment';
import { DT, speedOf, timeToStop, type PhysicsParams } from './physics';

/**
 * Crud rules as configuration. Every boolean is one of the "47 caveats"; the HUD counts how many are
 * enabled and which have fired. Defaults are the public common core (ACPA / Official Crud League),
 * labelled DEMO in the UI because every table has its own house rules.
 */
export interface CrudRules {
  readonly startingLives: number;
  readonly serveAttempts: number;
  /** Object ball speed below which it counts as stopped, m/s. */
  readonly stoppedSpeed: number;
  /** Fraction of table length from each short end that counts as a legal stance. Either end, any shooter. */
  readonly shortEndDepth: number;
  /** Minimum object-ball travel after contact, metres. 6 inches in the canon. Under this, the hitter loses (dead ball). */
  readonly minTravel: number;
  /** Serve: object ball is placed this far from the receiver's end, on the centre line. 6 inches in the canon. */
  readonly footSpotInset: number;
  readonly forbidShootingBackwards: boolean;
  readonly forbidLongSideShots: boolean;
  /**
   * Who loses a life when the object ball is pocketed. `last_shooter` is the canon: the player who struck
   * before the pocketer, i.e. the defender; with two players that is the pocketer's opponent.
   * `next_shooter` is the house alternative: the pocketer.
   */
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
  footSpotInset: 0.1524,
  forbidShootingBackwards: true,
  forbidLongSideShots: true,
  pocketPenalty: 'last_shooter',
  maxShotSpeed: 6,
};

/** Pause after a life loss so the consequence is legible before the serve is set up. */
export const RESOLVE_TICKS = 90;
/** Body constants live in embodiment.ts; re-exported here under the names the rules use. */
export const GRAB_REACH = GRAB_REACH_M;
export const CARRY_OFFSET = CARRY_OFFSET_M;
/** Distance in from the short end at which a pocketed cue ball is put back on the table. */
export const CUE_RETRIEVE_INSET = 0.22;

/** Short-end index: 0 is the x<0 end, 1 is the x>0 end. Same domain as PlayerId, but nobody owns an end. */
export type EndIndex = 0 | 1;

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

/**
 * Sign of a short end: end 0 is x<0, end 1 is x>0. Placement helper only (initial fly positions,
 * foot spot, cue respawn). It never decides legality: any shooter may throw from either end.
 */
export function endSign(end: EndIndex): -1 | 1 {
  return end === 0 ? -1 : 1;
}

/** The short end nearer to an x position. Ties go to end 1. */
export function nearerEnd(x: number): EndIndex {
  return x < 0 ? 0 : 1;
}

export function other(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

/** Legal stance band at short end `end` (0 = x<0, 1 = x>0). Both bands are legal for every shooter. */
export function legalZone(table: Table, rules: CrudRules, end: EndIndex): { xMin: number; xMax: number } {
  const half = table.length / 2;
  const depth = rules.shortEndDepth * table.length;
  return end === 0 ? { xMin: -half, xMax: -half + depth } : { xMin: half - depth, xMax: half };
}

/** Which short-end band contains `x`, if any. */
export function zoneContaining(table: Table, rules: CrudRules, x: number): EndIndex | null {
  for (const end of [0, 1] as const) {
    const z = legalZone(table, rules, end);
    if (x >= z.xMin && x <= z.xMax) return end;
  }
  return null;
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

/**
 * Whose clock is running: the shooter during serve / awaiting_shot, the opponent of the last hitter
 * during in_play (they must fetch the cue ball and hit the object before it stops). Nobody otherwise.
 */
export function isTurnOf(turn: Turn, player: PlayerId): boolean {
  switch (turn.kind) {
    case 'serve':
    case 'awaiting_shot':
      return turn.shooter === player;
    case 'in_play':
      return turn.lastShooter !== player;
    default:
      return false;
  }
}

/** The cue ball has no `held` field; it is held when some fly is carrying it. */
export function heldBy(state: MatchState): PlayerId | null {
  for (const p of state.players) if (p.fly.carrying) return p.id;
  return null;
}

/** Where a held cue ball sits and where a throw is released. Alias of embodiment.graspPoint. */
export const carryPoint = graspPoint;

/** Serve placement: on the centre line, `footSpotInset` in from the receiver's end. */
export function footSpot(table: Table, rules: CrudRules, receiverEnd: EndIndex): Vec2 {
  return vec(endSign(receiverEnd) * (table.length / 2 - rules.footSpotInset), 0);
}

/** A pocketed cue ball is put back at the centre of the nearer short end, stationary. */
export function respawnCue(table: Table, nearX: number): Ball {
  return { pos: vec(endSign(nearerEnd(nearX)) * (table.length / 2 - CUE_RETRIEVE_INSET), 0), vel: vec(0, 0), pocketed: false };
}

const REFERENCE_NUMERICS: readonly (keyof CrudRules)[] = ['startingLives', 'serveAttempts', 'stoppedSpeed', 'shortEndDepth', 'minTravel', 'footSpotInset', 'maxShotSpeed'];
/** Rules that are always in force regardless of switches: no cues, ball-in-hand, object must keep moving, lives, serve attempts, six-inch rule. */
const CORE_RULE_COUNT = 6;

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

/** A throw from a short end must go toward the table, not into the cushion behind the fly. */
function facesTable(angle: number, flyX: number): boolean {
  if (flyX === 0) return true;
  // Tolerance: a throw folded to exactly ±π/2 has cos ≈ 6e-17 and must count as along the cushion, not backwards.
  return Math.cos(angle) * -Math.sign(flyX) >= -1e-9;
}

/** Whether the shooter may take this shot from where its fly stands. Returns the reason if not. Either end is legal. */
export function validateShot(state: MatchState, rules: CrudRules, shooter: PlayerId, shot: Shot): LifeLostReason | null {
  const fly = state.players[shooter].fly;
  if (rules.forbidLongSideShots && zoneContaining(state.table, rules, fly.pos.x) === null) return 'shot_from_long_side';
  if (rules.forbidShootingBackwards && !facesTable(shot.angle, fly.pos.x)) return 'shot_backwards';
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
  const flyX = state.players[shooter].fly.pos.x;
  const forceRaw = Number.isFinite(cmd.shot.force) ? cmd.shot.force : 0;
  const force = Math.max(0, Math.min(1, forceRaw));
  let angle = Number.isFinite(cmd.shot.angle) ? normAngle(cmd.shot.angle) : flyX <= 0 ? 0 : Math.PI;
  if (rules.forbidShootingBackwards && !facesTable(angle, flyX)) {
    angle = Math.sin(angle) >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  return { kind: 'shoot', shot: { angle, force } };
}

/**
 * The last cue-on-object contact. `Turn` carries no contact fields, so the session keeps this beside
 * the state and hands it to the adjudicator every tick. Cleared whenever a serve is set up.
 */
export interface ContactMark {
  /** Object ball position at the moment of contact; six-inch travel is measured from here. */
  readonly objectPos: Vec2;
  /** Who threw the cue ball that made this contact. */
  readonly by: PlayerId;
  readonly tick: number;
  /** Set when the throw was a serve, so a short dead ball is a serve fault rather than a lost life. */
  readonly serveAttempt?: 1 | 2 | 3;
}

export interface Adjudication {
  state: MatchState;
  events: RuleEvent[];
  contact: ContactMark | null;
}

function setPlayers(state: MatchState, update: (p: Player) => Player): MatchState {
  return { ...state, players: [update(state.players[0]), update(state.players[1])] };
}

function setPlayerLives(state: MatchState, player: PlayerId, lives: number): MatchState {
  return setPlayers(state, (p) => (p.id === player ? { ...p, lives } : p));
}

function setCarrying(state: MatchState, holder: PlayerId | null): MatchState {
  return setPlayers(state, (p) => {
    const carrying = p.id === holder;
    if ((p.fly.carrying ?? false) === carrying) return p;
    return { ...p, fly: { ...p.fly, carrying } };
  });
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function loseLife(step: Adjudication, player: PlayerId, reason: LifeLostReason, tick: number): Adjudication {
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
  return { state, events, contact: step.contact };
}

/** Who pays for a pocketed object ball, given who sent it in. */
function pocketLoser(rules: CrudRules, pocketer: PlayerId): PlayerId {
  return rules.pocketPenalty === 'last_shooter' ? other(pocketer) : pocketer;
}

/** Object ball stationary on the foot spot at the end nearer the receiver's fly. */
function placeObjectForServe(state: MatchState, rules: CrudRules, server: PlayerId): Ball {
  const receiverEnd = nearerEnd(state.players[other(server)].fly.pos.x);
  return { pos: footSpot(state.table, rules, receiverEnd), vel: vec(0, 0), pocketed: false };
}

/**
 * Serve setup after a life loss: the loser serves with the cue ball in hand; the object ball waits on
 * the foot spot at the receiver's end. Contact history is cleared.
 */
function startServe(step: Adjudication, rules: CrudRules, server: PlayerId): Adjudication {
  let state = setCarrying(step.state, server);
  state = {
    ...state,
    object: placeObjectForServe(state, rules, server),
    cue: { pos: carryPoint(state.players[server].fly), vel: vec(0, 0), pocketed: false },
    turn: { kind: 'serve', shooter: server, attempt: 1 },
  };
  return { state, events: step.events, contact: null };
}

/**
 * A serve attempt failed (no contact, or a dead ball under six inches). The object ball goes back to
 * the foot spot; the cue ball lies where it stopped (or is respawned if pocketed) and the server
 * fetches it again. The last allowed attempt failing costs a life.
 */
function serveFault(step: Adjudication, rules: CrudRules, server: PlayerId, attempt: 1 | 2 | 3, tick: number): Adjudication {
  const events = [...step.events, { kind: 'serve_fault', player: server, attempt, tick } as RuleEvent];
  if (attempt >= rules.serveAttempts) return loseLife({ ...step, events }, server, 'three_serve_faults', tick);
  const s = step.state;
  const nextAttempt = Math.min(3, attempt + 1) as 1 | 2 | 3;
  return {
    state: {
      ...s,
      object: placeObjectForServe(s, rules, server),
      cue: s.cue.pocketed ? respawnCue(s.table, s.players[server].fly.pos.x) : s.cue,
      turn: { kind: 'serve', shooter: server, attempt: nextAttempt },
    },
    events,
    contact: null,
  };
}

function deadlineFor(state: MatchState, physics: PhysicsParams, rules: CrudRules): number {
  const t = timeToStop(state.object, physics, rules.stoppedSpeed);
  return Number.isFinite(t) ? state.tick + Math.ceil(t / DT) : state.tick;
}

/**
 * Whether `player` may pick up the cue ball this tick. Their clock must be running, the ball must be
 * free and on the table, and the fly must not be mid-throw. During a serve attempt in flight the ball
 * must come to rest first, so a missed serve is always adjudicated as a fault.
 */
export function canGrab(state: MatchState, player: PlayerId): boolean {
  const { turn, cue } = state;
  if (cue.pocketed || heldBy(state) !== null) return false;
  if (!isTurnOf(turn, player)) return false;
  if (turn.kind === 'awaiting_shot' && turn.serveAttempt !== undefined) return false;
  const fly = state.players[player].fly;
  if (fly.phase !== 'idle' && fly.phase !== 'approach') return false;
  return dist(fly.pos, cue.pos) <= GRAB_REACH;
}

/**
 * Ball-in-hand pickup. Sets `carrying`, snaps the cue ball into the fly's grasp, and if the rally was
 * in_play moves the turn to awaiting_shot for the new shooter. Caller checks `canGrab`.
 */
export function grabCue(state: MatchState, rules: CrudRules, physics: PhysicsParams, player: PlayerId): MatchState {
  let s = setCarrying(state, player);
  s = { ...s, cue: { pos: carryPoint(s.players[player].fly), vel: vec(0, 0), pocketed: false } };
  if (s.turn.kind === 'in_play') {
    s = { ...s, turn: { kind: 'awaiting_shot', shooter: player, deadlineTick: deadlineFor(s, physics, rules) } };
  }
  return s;
}

/**
 * Turn machine. Ball-in-hand; nobody owns an end; the clock is the object ball's motion.
 *
 *   serve{shooter S, attempt}
 *     object ball stationary on the foot spot at the receiver's end; S fetches/carries the cue ball
 *     and throws from either short end. A stationary object ball is by design here, never a stop.
 *     legal_shot            -> awaiting_shot{S, deadlineTick, serveAttempt: attempt}
 *     illegal throw         -> ball released anyway; life_lost(S, reason)   -> resolving | over
 *     cue pocketed          -> cue respawned at the end nearer S, stationary; still serve
 *   awaiting_shot{shooter S, deadlineTick, serveAttempt?}
 *     S holds the cue ball, is fetching it, or has thrown it and it is in flight.
 *     contact               -> in_play{lastShooter: S}; ContactMark{objectPos, by: S, tick, serveAttempt?}
 *                              (the opponent's clock starts now)
 *     object pocketed       -> life_lost(pocketLoser(lastContact.by ?? other(S)), object_ball_pocketed)
 *     serveAttempt set:
 *       cue stops/pocketed  -> serve_fault(S, attempt); attempt < serveAttempts -> serve{attempt+1}
 *                                                         attempt == serveAttempts -> life_lost(S, three_serve_faults)
 *                              (S may not pick the ball up again until it has come to rest)
 *     serveAttempt unset:
 *       object stops        -> lastContact && travel(lastContact) < minTravel
 *                                ? life_lost(lastContact.by, object_short_travel)   [dead ball]
 *                                : life_lost(S, object_ball_stopped)                [too slow]
 *       cue stops           -> nothing; S fetches it again (grab -> carrying)
 *       cue pocketed        -> cue respawned at the end nearer S; S fetches it
 *     grab by S (session)   -> carrying = true; cue tracks the fly; turn unchanged
 *   in_play{lastShooter L}
 *     L's throw has hit; the object ball is other(L)'s problem. ContactMark is from L's hit.
 *     object pocketed       -> life_lost(pocketLoser(L), object_ball_pocketed)
 *                              (last_shooter: other(L), the defender; next_shooter: L)
 *     object stops          -> travel(contact) < minTravel
 *                                ? contact.serveAttempt ? serve_fault(L, attempt) : life_lost(L, object_short_travel)
 *                                : life_lost(other(L), object_ball_stopped)
 *     cue pocketed          -> cue respawned at the end nearer other(L); no penalty
 *     cue stops             -> nothing; other(L) fetches it
 *     grab by other(L)      -> awaiting_shot{shooter: other(L), deadlineTick}; ContactMark kept
 *   resolving{outcome}
 *     RESOLVE_TICKS after outcome.tick -> serve{shooter: loser, attempt 1}: object on the foot spot at
 *     the end nearer the receiver's fly; cue ball in the server's hand; ContactMark cleared.
 *   over{winner}
 *     terminal.
 *
 * Every life loss appends life_lost; reaching zero lives appends match_over and moves to over.
 * The cue ball being pocketed is never penalised; it is respawned and fetched. A held cue ball is
 * never "stopped".
 */
export function adjudicate(
  state: MatchState,
  rules: CrudRules,
  physicsEvents: readonly RuleEvent[],
  contact: ContactMark | null = null,
): Adjudication {
  return adjudicateWith(state, rules, DEFAULT_ADJUDICATION_PHYSICS, physicsEvents, contact);
}

/** Only the deceleration matters here (for deadline estimates); demo value keeps `adjudicate` pure and self-contained. */
const DEFAULT_ADJUDICATION_PHYSICS: PhysicsParams = { rollingDecel: 0.35, ballRestitution: 0.93, cushionRestitution: 0.75 };

export function adjudicateWith(
  state: MatchState,
  rules: CrudRules,
  physics: PhysicsParams,
  physicsEvents: readonly RuleEvent[],
  contact: ContactMark | null,
): Adjudication {
  const tick = state.tick;
  let step: Adjudication = { state, events: [...physicsEvents], contact };

  const penalty = physicsEvents.find((e) => e.kind === 'life_lost');
  if (penalty && penalty.kind === 'life_lost' && state.turn.kind !== 'over' && state.turn.kind !== 'resolving') {
    step = { state, events: physicsEvents.filter((e) => e !== penalty), contact };
    return loseLife(step, penalty.player, penalty.reason, tick);
  }

  const has = (kind: RuleEvent['kind']): boolean => physicsEvents.some((e) => e.kind === kind);
  const objPocketed = physicsEvents.some((e) => e.kind === 'pocket' && e.ball === 'object');
  const cuePocketed = physicsEvents.some((e) => e.kind === 'pocket' && e.ball === 'cue');
  const held = heldBy(state) !== null;
  const objStopped = !state.object.pocketed && speedOf(state.object) < rules.stoppedSpeed;
  const cueStopped = !held && !state.cue.pocketed && speedOf(state.cue) < rules.stoppedSpeed;

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
      if (cuePocketed) return { ...step, state: { ...step.state, cue: respawnCue(state.table, state.players[turn.shooter].fly.pos.x) } };
      return step;
    }
    case 'awaiting_shot': {
      if (has('contact')) {
        const mark: ContactMark =
          turn.serveAttempt !== undefined
            ? { objectPos: state.object.pos, by: turn.shooter, tick, serveAttempt: turn.serveAttempt }
            : { objectPos: state.object.pos, by: turn.shooter, tick };
        step = { state: { ...step.state, turn: { kind: 'in_play', lastShooter: turn.shooter } }, events: step.events, contact: mark };
        return inPlay(step, rules, turn.shooter, mark, tick, objPocketed, objStopped, cuePocketed);
      }
      if (objPocketed) {
        const pocketer = contact ? contact.by : other(turn.shooter);
        return loseLife(step, pocketLoser(rules, pocketer), 'object_ball_pocketed', tick);
      }
      if (turn.serveAttempt !== undefined) {
        if (cueStopped || cuePocketed) return serveFault(step, rules, turn.shooter, turn.serveAttempt, tick);
        return step;
      }
      if (objStopped) {
        if (contact && dist(state.object.pos, contact.objectPos) < rules.minTravel) return loseLife(step, contact.by, 'object_short_travel', tick);
        return loseLife(step, turn.shooter, 'object_ball_stopped', tick);
      }
      if (cuePocketed) return { ...step, state: { ...step.state, cue: respawnCue(state.table, state.players[turn.shooter].fly.pos.x) } };
      return step;
    }
    case 'in_play': {
      // A contact mark always exists here in a live session; the fallback keeps handcrafted states honest.
      const mark: ContactMark = contact ?? { objectPos: state.object.pos, by: turn.lastShooter, tick };
      return inPlay(step, rules, turn.lastShooter, mark, tick, objPocketed, objStopped, cuePocketed);
    }
    case 'resolving': {
      if (tick < turn.outcome.tick + RESOLVE_TICKS) return step;
      const loser: PlayerId = turn.outcome.kind === 'life_lost' ? turn.outcome.player : 0;
      return startServe(step, rules, loser);
    }
    case 'over':
      return step;
  }
}

function inPlay(
  step: Adjudication,
  rules: CrudRules,
  lastShooter: PlayerId,
  mark: ContactMark,
  tick: number,
  objPocketed: boolean,
  objStopped: boolean,
  cuePocketed: boolean,
): Adjudication {
  if (objPocketed) return loseLife(step, pocketLoser(rules, lastShooter), 'object_ball_pocketed', tick);
  if (objStopped) {
    if (dist(step.state.object.pos, mark.objectPos) < rules.minTravel) {
      if (mark.serveAttempt !== undefined) return serveFault(step, rules, lastShooter, mark.serveAttempt, tick);
      return loseLife(step, lastShooter, 'object_short_travel', tick);
    }
    return loseLife(step, other(lastShooter), 'object_ball_stopped', tick);
  }
  if (cuePocketed) {
    const s = step.state;
    return { ...step, state: { ...s, cue: respawnCue(s.table, s.players[other(lastShooter)].fly.pos.x) } };
  }
  return step;
}
