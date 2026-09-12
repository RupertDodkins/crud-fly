import type { PlayerCommand, PlayerId } from '../core/model';
import type { CrudRules } from '../core/rules';
import type { PhysicsParams } from '../core/physics';
import { createSession, replayController } from '../core/session';

export const TAPE_VERSION = 1;

export interface TapeCommand {
  readonly tick: number;
  readonly player: PlayerId;
  readonly cmd: PlayerCommand;
}

/** Everything needed to reproduce a match bit-for-bit, plus checkpoints to prove it did. */
export interface Tape {
  readonly version: typeof TAPE_VERSION;
  readonly seed: number;
  readonly rules: CrudRules;
  readonly physics: PhysicsParams;
  readonly controllerIds: readonly [string, string];
  readonly names: readonly [string, string];
  readonly commands: readonly TapeCommand[];
  readonly hashes: readonly { readonly tick: number; readonly hash: string }[];
  readonly finalTick: number;
}

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(path: string, expected: string): never {
  throw new Error(`tape: ${path} must be ${expected}`);
}

function num(o: Obj, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${key}`, 'a finite number');
  return v;
}

function bool(o: Obj, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail(`${path}.${key}`, 'a boolean');
  return v;
}

function str(o: Obj, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`${path}.${key}`, 'a string');
  return v;
}

function pair(x: unknown, path: string): readonly [string, string] {
  if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string') fail(path, 'two strings');
  return [x[0], x[1]];
}

function vec2(x: unknown, path: string): { x: number; y: number } {
  if (!isObj(x)) fail(path, 'a vector');
  return { x: num(x, 'x', path), y: num(x, 'y', path) };
}

function command(x: unknown, path: string): PlayerCommand {
  if (!isObj(x)) fail(path, 'a command');
  switch (x['kind']) {
    case 'wait':
      return { kind: 'wait' };
    case 'move':
      return { kind: 'move', target: vec2(x['target'], `${path}.target`) };
    case 'shoot': {
      const shot = x['shot'];
      if (!isObj(shot)) fail(`${path}.shot`, 'a shot');
      return { kind: 'shoot', shot: { angle: num(shot, 'angle', `${path}.shot`), force: num(shot, 'force', `${path}.shot`) } };
    }
    default:
      return fail(`${path}.kind`, 'wait | move | shoot');
  }
}

function rules(x: unknown): CrudRules {
  if (!isObj(x)) fail('rules', 'an object');
  const p = 'rules';
  const pocketPenalty = x['pocketPenalty'];
  if (pocketPenalty !== 'last_shooter' && pocketPenalty !== 'next_shooter') fail(`${p}.pocketPenalty`, 'last_shooter | next_shooter');
  return {
    startingLives: num(x, 'startingLives', p),
    serveAttempts: num(x, 'serveAttempts', p),
    stoppedSpeed: num(x, 'stoppedSpeed', p),
    shortEndDepth: num(x, 'shortEndDepth', p),
    minTravel: num(x, 'minTravel', p),
    footSpotInset: num(x, 'footSpotInset', p),
    forbidShootingBackwards: bool(x, 'forbidShootingBackwards', p),
    forbidLongSideShots: bool(x, 'forbidLongSideShots', p),
    pocketPenalty,
    maxShotSpeed: num(x, 'maxShotSpeed', p),
  };
}

function physics(x: unknown): PhysicsParams {
  if (!isObj(x)) fail('physics', 'an object');
  return {
    rollingDecel: num(x, 'rollingDecel', 'physics'),
    ballRestitution: num(x, 'ballRestitution', 'physics'),
    cushionRestitution: num(x, 'cushionRestitution', 'physics'),
  };
}

export function parseTape(json: unknown): Tape {
  if (!isObj(json)) fail('tape', 'an object');
  if (json['version'] !== TAPE_VERSION) fail('version', String(TAPE_VERSION));
  const commandsRaw = json['commands'];
  const hashesRaw = json['hashes'];
  if (!Array.isArray(commandsRaw)) fail('commands', 'an array');
  if (!Array.isArray(hashesRaw)) fail('hashes', 'an array');
  const commands = commandsRaw.map((c, i): TapeCommand => {
    const path = `commands[${i}]`;
    if (!isObj(c)) fail(path, 'an object');
    const player = c['player'];
    if (player !== 0 && player !== 1) fail(`${path}.player`, '0 | 1');
    return { tick: num(c, 'tick', path), player, cmd: command(c['cmd'], `${path}.cmd`) };
  });
  const hashes = hashesRaw.map((h, i) => {
    const path = `hashes[${i}]`;
    if (!isObj(h)) fail(path, 'an object');
    return { tick: num(h, 'tick', path), hash: str(h, 'hash', path) };
  });
  return {
    version: TAPE_VERSION,
    seed: num(json, 'seed', 'tape'),
    rules: rules(json['rules']),
    physics: physics(json['physics']),
    controllerIds: pair(json['controllerIds'], 'controllerIds'),
    names: pair(json['names'], 'names'),
    commands,
    hashes,
    finalTick: num(json, 'finalTick', 'tape'),
  };
}

/** Re-run the tape through a fresh session and return the hashes it produces. Equal hashes = reproduced. */
export function replayTape(tape: Tape): { hashes: Tape['hashes']; ok: boolean } {
  const byPlayer: [Map<number, PlayerCommand>, Map<number, PlayerCommand>] = [new Map(), new Map()];
  for (const c of tape.commands) byPlayer[c.player].set(c.tick, c.cmd);
  // The first checkpoint sits at hashEvery; the recorder appends a final hash at finalTick.
  const first = tape.hashes[0];
  const hashEvery = first && first.tick > 0 ? first.tick : 60;
  const session = createSession({
    seed: tape.seed,
    rules: tape.rules,
    physics: tape.physics,
    controllers: [replayController(tape.controllerIds[0], byPlayer[0]), replayController(tape.controllerIds[1], byPlayer[1])],
    names: tape.names,
    hashEvery,
  });
  for (let i = 0; i < tape.finalTick; i++) session.step();
  const hashes = session.tape().hashes;
  const ok =
    hashes.length === tape.hashes.length && hashes.every((h, i) => tape.hashes[i]?.tick === h.tick && tape.hashes[i]?.hash === h.hash);
  return { hashes, ok };
}
