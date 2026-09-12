import type { Controller, Frame, MatchState, Observation, Player, PlayerCommand, PlayerId, RuleEvent, Vec2 } from './model';
import { vec } from './model';
import type { ContactMark, CrudRules } from './rules';
import {
  activeShooter,
  adjudicateWith,
  canGrab,
  carryPoint,
  clampCommand,
  endSign,
  footSpot,
  grabCue,
  heldBy,
  legalZone,
  nearerEnd,
  validateShot,
  xorshift32,
} from './rules';
import type { PhysicsParams } from './physics';
import { applyShot, hashState, standardTable, stepBalls, stepFly, timeToStop } from './physics';
import type { Tape, TapeCommand } from '../replay/codec';

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
 * The only writer of MatchState. Each step: observe -> decide -> clamp -> stepFly -> grab check ->
 * strike landing (release) -> carry update -> stepBalls (held cue skipped) -> adjudicate -> tape.
 */
export interface Session {
  step(): void;
  frame(): Frame;
  tape(): Tape;
  /** True once turn.kind === 'over'. */
  done(): boolean;
}

const DEFAULT_NAMES: readonly [string, string] = ['Fly A', 'Fly B'];
const PLAYERS: readonly [PlayerId, PlayerId] = [0, 1];
/** Initial fly stance: this far in from each short end, on the centre line. */
const FLY_START_INSET = 0.1;

function sameVec(a: Vec2 | null, b: Vec2): boolean {
  return a !== null && a.x === b.x && a.y === b.y;
}

export function createSession(config: SessionConfig): Session {
  const names = config.names ?? DEFAULT_NAMES;
  const hashEvery = Math.max(1, config.hashEvery ?? 60);
  const { rules, physics, controllers } = config;
  let state = initialState(config.seed, rules, names);
  /** Last cue-on-object contact; lives beside the state because `Turn` has no contact fields. */
  let contact: ContactMark | null = null;
  const targets: [Vec2 | null, Vec2 | null] = [null, null];
  const commands: TapeCommand[] = [];
  const hashes: { tick: number; hash: string }[] = [];

  function applyCommand(p: PlayerId, cmd: PlayerCommand): void {
    const active = activeShooter(state.turn);
    const fly = state.players[p].fly;
    if (cmd.kind === 'move') {
      if (sameVec(targets[p], cmd.target)) return;
      targets[p] = cmd.target;
      commands.push({ tick: state.tick, player: p, cmd });
      return;
    }
    if (cmd.kind === 'shoot') {
      // Only the active shooter, only with the ball in hand, only when not already mid-throw.
      if (active !== p || !fly.carrying || fly.shot !== null || (fly.phase !== 'idle' && fly.phase !== 'approach')) return;
      commands.push({ tick: state.tick, player: p, cmd });
      state = withFly(state, p, { ...fly, shot: cmd.shot });
    }
  }

  function step(): void {
    const tick = state.tick;
    const over = state.turn.kind === 'over';

    if (!over) {
      for (const p of PLAYERS) {
        const obs = observe(state, rules, physics, p);
        applyCommand(p, clampCommand(state, rules, p, controllers[p].decide(obs)));
      }
    }

    // Flies move first; a held cue ball follows its fly later in the tick.
    const struck: [boolean, boolean] = [false, false];
    for (const p of PLAYERS) {
      const r = stepFly(state.players[p].fly, targets[p], state.cue, state.table);
      struck[p] = r.struck;
      state = withFly(state, p, r.fly);
    }

    // Ball-in-hand: whoever's clock is running picks the ball up when they reach it.
    for (const p of PLAYERS) {
      if (canGrab(state, p)) {
        state = grabCue(state, rules, physics, p);
        break;
      }
    }

    // Strike landing = the throw. Legal or not, the ball leaves the hand with the shot velocity.
    const events: RuleEvent[] = [];
    let cue = state.cue;
    for (const p of PLAYERS) {
      const fly = state.players[p].fly;
      if (!struck[p] || !fly.shot) continue;
      if (activeShooter(state.turn) === p && fly.carrying) {
        const reason = validateShot(state, rules, p, fly.shot);
        cue = applyShot({ pos: carryPoint(fly), vel: vec(0, 0), pocketed: false }, fly.shot, rules.maxShotSpeed);
        events.push(reason === null ? { kind: 'legal_shot', player: p, tick, pos: carryPoint(fly) } : { kind: 'life_lost', player: p, reason, tick });
        state = withFly(state, p, { ...fly, shot: null, carrying: false });
      } else {
        state = withFly(state, p, { ...fly, shot: null });
      }
    }

    // Carry update: a held cue ball sits in the fly's grasp and is inert.
    const holder = heldBy(state);
    if (holder !== null) cue = { pos: carryPoint(state.players[holder].fly), vel: vec(0, 0), pocketed: false };

    const pr = stepBalls(cue, state.object, state.table, physics, tick, holder !== null);
    events.push(...pr.events);
    const adj = adjudicateWith({ ...state, cue: pr.cue, object: pr.object }, rules, physics, events, contact);
    contact = adj.contact;
    state = { ...adj.state, log: adj.events.length ? [...adj.state.log, ...adj.events] : adj.state.log, tick: tick + 1 };

    if (state.tick % hashEvery === 0) hashes.push({ tick: state.tick, hash: hashState(state) });
  }

  return {
    step,
    frame: () => state,
    done: () => state.turn.kind === 'over',
    tape: () => {
      const last = hashes[hashes.length - 1];
      const all = last && last.tick === state.tick ? hashes.slice() : [...hashes, { tick: state.tick, hash: hashState(state) }];
      return {
        version: 1,
        seed: config.seed,
        rules,
        physics,
        controllerIds: [controllers[0].id, controllers[1].id],
        names,
        commands: commands.slice(),
        hashes: all,
        finalTick: state.tick,
      };
    },
  };
}

function withFly(state: MatchState, p: PlayerId, fly: Player['fly']): MatchState {
  if (state.players[p].fly === fly) return state;
  const players: [Player, Player] = [state.players[0], state.players[1]];
  players[p] = { ...players[p], fly };
  return { ...state, players };
}

/**
 * Initial state for a seed and rules. Player 0 serves: the cue ball is in its hand at the x<0 end,
 * the object ball waits on the foot spot at the end nearer player 1's fly, and both flies start on
 * the centre line near opposite ends.
 */
export function initialState(seed: number, rules: CrudRules, names: readonly [string, string]): MatchState {
  const table = standardTable();
  const mkPlayer = (id: PlayerId): Player => ({
    id,
    name: names[id],
    lives: rules.startingLives,
    fly: {
      pos: vec(endSign(id) * (table.length / 2 - FLY_START_INSET), 0),
      heading: id === 0 ? 0 : Math.PI,
      phase: 'idle',
      phaseT: 0,
      shot: null,
      carrying: id === 0,
    },
  });
  const players: [Player, Player] = [mkPlayer(0), mkPlayer(1)];
  return {
    tick: 0,
    table,
    cue: { pos: carryPoint(players[0].fly), vel: vec(0, 0), pocketed: false },
    object: { pos: footSpot(table, rules, nearerEnd(players[1].fly.pos.x)), vel: vec(0, 0), pocketed: false },
    players,
    turn: { kind: 'serve', shooter: 0, attempt: 1 },
    log: [],
    rng: xorshift32((seed >>> 0) ^ 0x9e3779b9),
  };
}

/** Bounded view for one player. Pure. */
export function observe(state: MatchState, rules: CrudRules, physics: PhysicsParams, me: PlayerId): Observation {
  return {
    me,
    tick: state.tick,
    table: state.table,
    cue: state.cue,
    object: state.object,
    myFly: state.players[me].fly,
    myLives: state.players[me].lives,
    theirLives: state.players[me === 0 ? 1 : 0].lives,
    turn: state.turn,
    legalEnds: [legalZone(state.table, rules, 0), legalZone(state.table, rules, 1)],
    carrying: state.players[me].fly.carrying === true,
    objectStopsIn: timeToStop(state.object, physics, rules.stoppedSpeed),
  };
}

const WAIT: PlayerCommand = { kind: 'wait' };

/** Drive a session with recorded commands instead of live controllers. Used by replay and tests. */
export function replayController(id: string, commands: ReadonlyMap<number, PlayerCommand>): Controller {
  return {
    id,
    label: 'replay',
    decide: (obs) => commands.get(obs.tick) ?? WAIT,
  };
}
