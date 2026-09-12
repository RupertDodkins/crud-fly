import type { Ball, FlyBody, Observation, Table, Turn, Vec2 } from '../../src/core/model';

export const TABLE: Table = {
  length: 2.54,
  width: 1.27,
  ballRadius: 0.028575,
  pocketRadius: 0.06,
  pockets: [
    { x: -1.27, y: -0.635 },
    { x: 0, y: -0.635 },
    { x: 1.27, y: -0.635 },
    { x: -1.27, y: 0.635 },
    { x: 0, y: 0.635 },
    { x: 1.27, y: 0.635 },
  ],
};

export function ball(pos: Vec2, vel: Vec2 = { x: 0, y: 0 }): Ball {
  return { pos, vel, pocketed: false };
}

export function fly(pos: Vec2, heading: number): FlyBody {
  return { pos, heading, phase: 'idle', phaseT: 0, shot: null };
}

export interface ObsOverrides {
  readonly cue?: Ball;
  readonly object?: Ball;
  readonly myFly?: FlyBody;
  readonly turn?: Turn;
  readonly me?: 0 | 1;
  /** Defaults to "the cue ball is within grasp distance of the fly", which is the engine's own invariant for a held ball. */
  readonly carrying?: boolean;
}

/** A held cue ball sits 0.04 m ahead of its fly; anything within this of the fly reads as in hand. */
const GRASP = 0.06;

/** Player 0 standing in the x<0 end band, heading +x (toward the table centre), cue ball in hand. */
export function observation(o: ObsOverrides = {}): Observation {
  const me = o.me ?? 0;
  const cue = o.cue ?? ball({ x: -1.08, y: 0 });
  const myFly = o.myFly ?? fly({ x: -1.1, y: 0 }, 0);
  const carrying = o.carrying ?? Math.hypot(cue.pos.x - myFly.pos.x, cue.pos.y - myFly.pos.y) <= GRASP;
  return {
    me,
    tick: 100,
    table: TABLE,
    cue,
    object: o.object ?? ball({ x: 0.2, y: 0.1 }, { x: -0.6, y: 0 }),
    myFly: carrying ? { ...myFly, carrying: true } : myFly,
    myLives: 3,
    theirLives: 3,
    turn: o.turn ?? { kind: 'awaiting_shot', shooter: me, deadlineTick: 500 },
    legalEnds: [
      { xMin: -1.27, xMax: -0.889 },
      { xMin: 0.889, xMax: 1.27 },
    ],
    carrying,
    objectStopsIn: 4,
  };
}

/**
 * A pair of observations identical except the object ball (position and velocity) is mirrored across
 * the fly's heading axis. The fly is on the axis, heading +x, and the cue ball sits just ahead of it.
 * Returned as [ballOnLeft, ballOnRight] using the encoder's convention: negative bearing is left,
 * so with heading 0 the left ball has negative y.
 */
export function mirroredPair(): readonly [Observation, Observation] {
  const flyPos = { x: -1.1, y: 0 };
  const cue = ball({ x: -1.08, y: 0 });
  const make = (sy: number) =>
    observation({
      myFly: fly(flyPos, 0),
      cue,
      object: ball({ x: -0.6, y: 0.3 * sy }, { x: -0.8, y: -0.2 * sy }),
    });
  return [make(-1), make(1)];
}
