import type { Controller, Frame, MatchState, Observation, Player, PlayerCommand, PlayerId, RuleEvent, Vec2 } from './model';
import { vec } from './model';
import type { CrudRules } from './rules';
import { activeShooter, adjudicateWith, clampCommand, endSign, legalZone, respawnObject, retrievedCue, validateShot, xorshift32 } from './rules';
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

const DEFAULT_NAMES: readonly [string, string] = ['Fly A', 'Fly B'];
const PLAYERS: readonly [PlayerId, PlayerId] = [0, 1];

function sameVec(a: Vec2 | null, b: Vec2): boolean {
  return a !== null && a.x === b.x && a.y === b.y;
}

export function createSession(config: SessionConfig): Session {
  const names = config.names ?? DEFAULT_NAMES;
  const hashEvery = Math.max(1, config.hashEvery ?? 60);
  const { rules, physics, controllers } = config;
  let state = initialState(config.seed, rules, names);
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
      if (active !== p || fly.shot !== null || (fly.phase !== 'idle' && fly.phase !== 'approach')) return;
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

    const events: RuleEvent[] = [];
    let cue = state.cue;
    for (const p of PLAYERS) {
      const before = state.players[p].fly;
      const r = stepFly(before, targets[p], cue, state.table);
      let fly = r.fly;
      if (r.struck && before.shot) {
        if (activeShooter(state.turn) === p) {
          const reason = validateShot(state, rules, p, before.shot);
          if (reason === null) {
            cue = applyShot(cue, before.shot, rules.maxShotSpeed);
            events.push({ kind: 'legal_shot', player: p, tick });
          } else {
            events.push({ kind: 'life_lost', player: p, reason, tick });
          }
        }
        fly = { ...fly, shot: null };
      }
      state = withFly(state, p, fly);
    }

    const pr = stepBalls(cue, state.object, state.table, physics, tick);
    events.push(...pr.events);
    const adj = adjudicateWith({ ...state, cue: pr.cue, object: pr.object }, rules, physics, events);
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

/** Initial state for a seed and rules. Object ball is already rolling so the first viewer sees motion. */
export function initialState(seed: number, rules: CrudRules, names: readonly [string, string]): MatchState {
  const table = standardTable();
  const spawn = respawnObject(xorshift32((seed >>> 0) ^ 0x9e3779b9), 0);
  const cue = retrievedCue(table, 0, spawn.object);
  const mkPlayer = (id: PlayerId): Player => ({
    id,
    name: names[id],
    lives: rules.startingLives,
    fly: { pos: vec(endSign(id) * (table.length / 2 - 0.1), 0), heading: id === 0 ? 0 : Math.PI, phase: 'idle', phaseT: 0, shot: null },
  });
  return {
    tick: 0,
    table,
    cue,
    object: spawn.object,
    players: [mkPlayer(0), mkPlayer(1)],
    turn: { kind: 'serve', shooter: 0, attempt: 1 },
    log: [],
    rng: spawn.rng,
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
    legalZone: legalZone(state.table, rules, me),
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
