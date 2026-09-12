import { describe, expect, it } from 'vitest';
import { vec } from '../../src/core/model';
import type { Ball, Vec2 } from '../../src/core/model';
import { DEMO_PHYSICS, standardTable, stepBalls, timeToStop } from '../../src/core/physics';

const still = (x: number, y: number): Ball => ({ pos: vec(x, y), vel: vec(0, 0), pocketed: false });

describe('physics', () => {
  it('head-on equal-mass collision with restitution 1 swaps velocities', () => {
    const table = standardTable();
    const params = { rollingDecel: 0, ballRestitution: 1, cushionRestitution: 1 };
    const r = table.ballRadius;
    const cue: Ball = { pos: vec(-2 * r - 0.004, 0), vel: vec(1, 0), pocketed: false };
    const object: Ball = { pos: vec(0, 0), vel: vec(-0.5, 0), pocketed: false };
    const out = stepBalls(cue, object, table, params, 0);
    expect(out.events).toMatchObject([{ kind: 'contact', tick: 0, pos: out.object.pos }]);
    expect(Math.abs(out.cue.vel.x - -0.5)).toBeLessThan(1e-6);
    expect(Math.abs(out.object.vel.x - 1)).toBeLessThan(1e-6);
    expect(Math.abs(out.cue.vel.y)).toBeLessThan(1e-6);
    expect(Math.abs(out.object.vel.y)).toBeLessThan(1e-6);
  });

  it('a ball rolling into a corner pocket gets pocketed', () => {
    const table = standardTable();
    const hx = table.length / 2;
    const hy = table.width / 2;
    let object: Ball = { pos: vec(hx - 0.2, hy - 0.2), vel: vec(Math.SQRT1_2, Math.SQRT1_2), pocketed: false };
    let cue = still(-1, 0);
    let pocketEvent = false;
    for (let tick = 0; tick < 240 && !object.pocketed; tick++) {
      const out = stepBalls(cue, object, table, DEMO_PHYSICS, tick);
      cue = out.cue;
      object = out.object;
      if (out.events.some((e) => e.kind === 'pocket' && e.ball === 'object')) pocketEvent = true;
    }
    expect(object.pocketed).toBe(true);
    expect(pocketEvent).toBe(true);
    expect(object.vel).toEqual(vec(0, 0));
  });

  it('cushions rebound with restitution and balls stay on the table', () => {
    const table = standardTable();
    let ball: Ball = { pos: vec(0.5, 0), vel: vec(0, 2), pocketed: false };
    const cue = still(-1, 0);
    for (let tick = 0; tick < 120; tick++) ball = stepBalls(cue, ball, table, DEMO_PHYSICS, tick).object;
    expect(ball.vel.y).toBeLessThan(0);
    expect(Math.abs(ball.pos.y)).toBeLessThanOrEqual(table.width / 2 - table.ballRadius + 1e-9);
  });

  it('a held cue ball takes part in nothing: no rolling, no contact, no pocket, while the object still rolls', () => {
    const table = standardTable();
    // Cue overlapping the object and "moving" toward it; held, so nothing may happen to either from that.
    const cue: Ball = { pos: vec(0.01, 0), vel: vec(1, 0), pocketed: false };
    const object: Ball = { pos: vec(0.03, 0), vel: vec(0.5, 0), pocketed: false };
    const out = stepBalls(cue, object, table, DEMO_PHYSICS, 5, true);
    expect(out.events).toEqual([]);
    expect(out.cue).toBe(cue);
    expect(out.object.vel.x).toBeCloseTo(0.5 - DEMO_PHYSICS.rollingDecel / 120, 9);
    expect(out.object.vel.y).toBe(0);
    expect(out.object.pos.x).toBeGreaterThan(0.03);
    // Same input with a free cue ball is a collision.
    expect(stepBalls(cue, object, table, DEMO_PHYSICS, 5, false).events).toMatchObject([{ kind: 'contact', tick: 5, pos: { x: expect.any(Number), y: expect.any(Number) } }]);
    // A held cue ball sitting over a pocket is not captured.
    const overPocket: Ball = { pos: table.pockets[0] as Vec2, vel: vec(0, 0), pocketed: false };
    expect(stepBalls(overPocket, still(0, 0), table, DEMO_PHYSICS, 6, true).cue.pocketed).toBe(false);
    expect(stepBalls(overPocket, still(0, 0), table, DEMO_PHYSICS, 6, false).cue.pocketed).toBe(true);
  });

  it('timeToStop is speed over deceleration', () => {
    const ball: Ball = { pos: vec(0, 0), vel: vec(0.7, 0), pocketed: false };
    expect(timeToStop(ball, DEMO_PHYSICS, 0.02)).toBeCloseTo(2, 9);
    expect(timeToStop(still(0, 0), DEMO_PHYSICS, 0.02)).toBe(Infinity);
  });
});
