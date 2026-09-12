import { describe, expect, it } from 'vitest';
import type { Controller, Frame, Observation, PlayerCommand } from '../../src/core/model';
import { createSession } from '../../src/core/session';
import { CARRY_OFFSET, DEMO_RULES, GRAB_REACH, carryPoint } from '../../src/core/rules';
import { DEMO_PHYSICS, DT, FLY_WALK_SPEED } from '../../src/core/physics';
import { createHeuristic } from '../../src/controllers/heuristic';
import { parseTape, replayTape } from '../../src/replay/codec';

function run(seed: number, seconds: number, onFrame?: (f: Frame) => void) {
  const session = createSession({
    seed,
    rules: DEMO_RULES,
    physics: DEMO_PHYSICS,
    controllers: [createHeuristic('a', seed), createHeuristic('b', seed + 1)],
    hashEvery: 30,
  });
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    session.step();
    onFrame?.(session.frame());
  }
  return session;
}

const WAIT: PlayerCommand = { kind: 'wait' };
const idle: Controller = { id: 'idle', label: 'idle', decide: () => WAIT };

describe('session', () => {
  it('same seed twice produces an identical hash sequence', () => {
    const a = run(7, 10).tape();
    const b = run(7, 10).tape();
    expect(a.hashes.length).toBeGreaterThan(10);
    expect(b.hashes).toEqual(a.hashes);
    expect(run(8, 10).tape().hashes).not.toEqual(a.hashes);
  });

  it('a 20 s tape replays with matching hashes, including through JSON', () => {
    const tape = run(11, 20).tape();
    expect(replayTape(tape).ok).toBe(true);
    const roundTrip = parseTape(JSON.parse(JSON.stringify(tape)));
    expect(replayTape(roundTrip).ok).toBe(true);
    expect(() => parseTape({ ...tape, commands: 'nope' })).toThrow();
    expect(() => parseTape({ ...tape, version: 99 })).toThrow();
  });

  it('a tampered tape fails replay', () => {
    const tape = run(3, 5).tape();
    const shoot = tape.commands.findIndex((c) => c.cmd.kind === 'shoot');
    expect(shoot).toBeGreaterThanOrEqual(0);
    const commands = tape.commands.map((c, i) => (i === shoot && c.cmd.kind === 'shoot' ? { ...c, cmd: { kind: 'shoot' as const, shot: { ...c.cmd.shot, angle: c.cmd.shot.angle + 0.5 } } } : c));
    expect(replayTape({ ...tape, commands }).ok).toBe(false);
  });

  it('40 s heuristic matches on seeds 1..5: real rallies, both flies run around the table, no illegal throw ever', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const minX = [Infinity, Infinity];
      const maxX = [-Infinity, -Infinity];
      const frame = run(seed, 40, (f) => {
        for (const p of [0, 1] as const) {
          minX[p] = Math.min(minX[p] as number, f.players[p].fly.pos.x);
          maxX[p] = Math.max(maxX[p] as number, f.players[p].fly.pos.x);
        }
      }).frame();
      const count = (kind: string) => frame.log.filter((e) => e.kind === kind).length;
      expect(count('contact'), `seed ${seed} contacts`).toBeGreaterThanOrEqual(5);
      expect(count('legal_shot'), `seed ${seed} shots`).toBeGreaterThanOrEqual(5);
      for (const p of [0, 1] as const) {
        expect(minX[p], `seed ${seed} P${p} crossed to x<0`).toBeLessThan(0);
        expect(maxX[p], `seed ${seed} P${p} crossed to x>0`).toBeGreaterThan(0);
      }
      const reasons = frame.log.filter((e) => e.kind === 'life_lost').map((e) => (e.kind === 'life_lost' ? e.reason : ''));
      expect(reasons, `seed ${seed} reasons`).not.toContain('shot_from_long_side');
      expect(reasons, `seed ${seed} reasons`).not.toContain('shot_backwards');
    }
  });

  it('heuristic contact rate over ten seeds stays at or above 60%', () => {
    let shots = 0;
    let contacts = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const log = run(seed, 30).frame().log;
      shots += log.filter((e) => e.kind === 'legal_shot').length;
      // A throw can contact more than once (rebounds); count throws that contacted at least once.
      let pending = false;
      for (const e of log) {
        if (e.kind === 'legal_shot') pending = true;
        else if (e.kind === 'contact' && pending) {
          contacts += 1;
          pending = false;
        }
      }
    }
    expect(shots).toBeGreaterThan(50);
    expect(contacts / shots).toBeGreaterThanOrEqual(0.6);
  });

  it('grab: on its clock a fly within GRAB_REACH picks up a resting cue ball, the ball tracks the fly, and physics ignores it', () => {
    // Player 0 serves. Script: throw sideways so the serve misses, wait for the fault, fetch the ball, then walk
    // straight through the (stationary) object ball with the cue in hand.
    let phase: 'throw' | 'fetch' | 'walk' = 'throw';
    const scripted: Controller = {
      id: 'scripted',
      label: 'scripted',
      decide(obs: Observation): PlayerCommand {
        const fly = obs.myFly;
        if (fly.shot !== null || (fly.phase !== 'idle' && fly.phase !== 'approach')) return WAIT;
        if (phase === 'throw') {
          if (obs.turn.kind === 'serve' && obs.turn.attempt === 1 && obs.carrying) return { kind: 'shoot', shot: { angle: Math.PI / 2 - 0.3, force: 0.25 } };
          if (obs.turn.kind === 'serve' && obs.turn.attempt === 2) phase = 'fetch';
          return WAIT;
        }
        if (phase === 'fetch') {
          if (obs.carrying) phase = 'walk';
          else return { kind: 'move', target: obs.cue.pos };
        }
        return { kind: 'move', target: { x: obs.object.pos.x + 0.3, y: obs.object.pos.y } };
      },
    };
    const session = createSession({ seed: 1, rules: DEMO_RULES, physics: DEMO_PHYSICS, controllers: [scripted, idle] });

    let faultTick = -1;
    let grabTick = -1;
    let distanceAtGrab = Infinity;
    let carriedTicks = 0;
    let passedThrough = false;
    let prev = session.frame();
    for (let i = 0; i < 120 * 20 && !passedThrough; i++) {
      session.step();
      const f = session.frame();
      const fly = f.players[0].fly;
      if (faultTick < 0 && f.log.some((e) => e.kind === 'serve_fault')) faultTick = f.tick;
      if (faultTick >= 0 && grabTick < 0 && fly.carrying) {
        grabTick = f.tick;
        distanceAtGrab = Math.hypot(prev.players[0].fly.pos.x - prev.cue.pos.x, prev.players[0].fly.pos.y - prev.cue.pos.y);
      }
      if (grabTick >= 0 && fly.carrying) {
        carriedTicks += 1;
        // The held ball sits CARRY_OFFSET ahead of the fly and is inert.
        expect(f.cue.pos).toEqual(carryPoint(fly));
        expect(f.cue.vel).toEqual({ x: 0, y: 0 });
        expect(f.cue.pocketed).toBe(false);
        // The object ball on the fly's path never moves and no contact is registered.
        expect(f.object.vel).toEqual({ x: 0, y: 0 });
        expect(f.object.pos).toEqual(prev.object.pos);
        if (fly.pos.x > f.object.pos.x + 0.1) passedThrough = true;
      }
      prev = f;
    }
    expect(faultTick).toBeGreaterThan(0);
    expect(grabTick).toBeGreaterThan(faultTick);
    // Grabbed as soon as the previous tick was outside reach and this tick's walk brought it inside.
    expect(distanceAtGrab).toBeLessThanOrEqual(GRAB_REACH + FLY_WALK_SPEED * DT + 1e-9);
    expect(carriedTicks).toBeGreaterThan(30);
    expect(passedThrough).toBe(true);
    const log = session.frame().log;
    expect(log.filter((e) => e.kind === 'contact')).toEqual([]);
    expect(log.filter((e) => e.kind === 'life_lost')).toEqual([]);
    expect(session.frame().turn).toEqual({ kind: 'serve', shooter: 0, attempt: 2 });
    expect(CARRY_OFFSET).toBeLessThan(GRAB_REACH);
  });
});
