/**
 * The fly's body as the rules see it: how far it reaches, where a held ball sits, how fast it walks.
 * Single owner for these numbers so the presentation can draw reach rings, grasp poses and gait
 * from the same values the engine uses. Metres and metres per second.
 */
import type { FlyBody, Vec2 } from './model';
import { vec } from './model';

/** A fly this close to a free cue ball on its turn picks it up (ball-in-hand). */
export const GRAB_REACH_M = 0.1;
/** The held cue ball sits this far ahead of the fly along its heading; it is also the release point. */
export const CARRY_OFFSET_M = 0.04;
/** Distance from body centre to where the throw leaves the hand. Equal to the carry offset by construction. */
export const STRIKE_REACH_M = CARRY_OFFSET_M;
/** Walking speed on the table surface. */
export const WALK_SPEED_MPS = 1.8;

/** Where a held cue ball sits, and where a throw is released from: CARRY_OFFSET_M ahead along the heading. */
export function graspPoint(fly: FlyBody): Vec2 {
  return vec(fly.pos.x + Math.cos(fly.heading) * CARRY_OFFSET_M, fly.pos.y + Math.sin(fly.heading) * CARRY_OFFSET_M);
}
