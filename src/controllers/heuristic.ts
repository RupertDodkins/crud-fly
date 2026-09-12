import type { Controller, Observation, PlayerCommand } from '../core/model';

/**
 * Phase 1 fly and the permanent opponent. Walk to the legal short end, wait for a shootable object
 * ball, aim at its predicted position, shoot with force proportional to distance, with a small seeded
 * imperfection so it is not a laser. No learning, and labelled as such.
 */
export function createHeuristic(id: string, seed: number, opts?: { readonly aimNoise?: number }): Controller {
  throw new Error('not implemented');
}

/** Shared by both controllers: where to stand. Pure. */
export function stanceFor(obs: Observation): PlayerCommand {
  throw new Error('not implemented');
}
