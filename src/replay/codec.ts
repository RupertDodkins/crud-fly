import type { PlayerCommand, PlayerId } from '../core/model';
import type { CrudRules } from '../core/rules';
import type { PhysicsParams } from '../core/physics';

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

export function parseTape(json: unknown): Tape {
  throw new Error('not implemented');
}

/** Re-run the tape through a fresh session and return the hashes it produces. Equal hashes = reproduced. */
export function replayTape(tape: Tape): { hashes: Tape['hashes']; ok: boolean } {
  throw new Error('not implemented');
}
