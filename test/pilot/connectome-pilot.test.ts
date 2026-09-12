import { createHeuristic } from '../../src/controllers/heuristic';
import { beforeAll, describe, expect, it } from 'vitest';
import raw from '../../src/brain/flight-v1.json';
import type { Observation, PlayerCommand, Shot } from '../../src/core/model';
import {
  createConnectomePilot,
  DEFAULT_PILOT,
  encodeStimulus,
  parseCircuit,
  type CircuitData,
} from '../../src/controllers/connectome-pilot';
import { ball, fly, mirroredPair, observation } from './fixtures';

let circuit: CircuitData;
beforeAll(() => {
  circuit = parseCircuit(raw as unknown);
});

function expectShot(cmd: PlayerCommand): Shot {
  expect(cmd.kind).toBe('shoot');
  if (cmd.kind !== 'shoot') throw new Error('unreachable');
  return cmd.shot;
}

function freshShot(obs: Observation) {
  const pilot = createConnectomePilot('hero', circuit);
  const shot = expectShot(pilot.decide(obs));
  return { shot, telemetry: pilot.telemetry() };
}

describe('encodeStimulus', () => {
  it('drives the left side more for a ball on the left and mirrors for the right', () => {
    const [leftObs, rightObs] = mirroredPair();
    const l = encodeStimulus(leftObs);
    const r = encodeStimulus(rightObs);
    expect(l.left).toBeGreaterThan(l.right);
    expect(r.right).toBeGreaterThan(r.left);
    expect(l.left).toBeCloseTo(r.right, 12);
    expect(l.right).toBeCloseTo(r.left, 12);
  });

  it('is near zero for a far, receding ball and grows with closing speed', () => {
    const far = encodeStimulus(
      observation({ myFly: fly({ x: -1.1, y: 0 }, 0), object: ball({ x: 1.2, y: 0.3 }, { x: 0.9, y: 0 }) }),
    );
    expect(far.left + far.right).toBeLessThan(0.15);

    const slow = encodeStimulus(observation({ object: ball({ x: -0.6, y: 0 }, { x: -0.2, y: 0 }) }));
    const fast = encodeStimulus(observation({ object: ball({ x: -0.6, y: 0 }, { x: -1.5, y: 0 }) }));
    expect(fast.left + fast.right).toBeGreaterThan(slow.left + slow.right);
    for (const s of [far, slow, fast]) {
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.right).toBeGreaterThanOrEqual(0);
      expect(s.left).toBeLessThanOrEqual(3);
      expect(s.right).toBeLessThanOrEqual(3);
    }
  });
});

describe('createConnectomePilot', () => {
  it('is deterministic: the same observation from fresh pilots gives an identical shot', () => {
    const obs = mirroredPair()[0];
    const a = freshShot(obs);
    const b = freshShot(obs);
    expect(a.shot).toEqual(b.shot);
    expect(a.telemetry).toEqual(b.telemetry);
  });

  it('mirrors the object ball across the heading: the neural angle offset flips sign', () => {
    const [leftObs, rightObs] = mirroredPair();
    const a = freshShot(leftObs);
    const b = freshShot(rightObs);
    console.log(
      `mirrored pair: left-ball dnL=${a.telemetry.dnLeft.toFixed(4)} dnR=${a.telemetry.dnRight.toFixed(4)} ` +
        `offset=${a.telemetry.angleOffset.toFixed(4)}; right-ball dnL=${b.telemetry.dnLeft.toFixed(4)} ` +
        `dnR=${b.telemetry.dnRight.toFixed(4)} offset=${b.telemetry.angleOffset.toFixed(4)}`,
    );
    expect(Math.abs(a.shot.angle - b.shot.angle)).toBeGreaterThan(1e-3);
    expect(Math.abs(a.telemetry.angleOffset - b.telemetry.angleOffset)).toBeGreaterThan(1e-3);
    expect(a.telemetry.angleOffset).toBeGreaterThan(0);
    expect(b.telemetry.angleOffset).toBeLessThan(0);
    expect(a.telemetry.dnLeft).toBeGreaterThan(a.telemetry.dnRight);
    expect(b.telemetry.dnRight).toBeGreaterThan(b.telemetry.dnLeft);
    expect(a.telemetry.activity).toBeGreaterThan(0);
  });

  it('keeps force in [0.1, 1] and |angleOffset| <= steerGain*maxRate across stimulus extremes', () => {
    const cases: Observation[] = [
      ...mirroredPair(),
      observation({ object: ball({ x: -1.0, y: 0.05 }, { x: -3, y: 0 }) }),
      observation({ object: ball({ x: -1.0, y: -0.05 }, { x: -3, y: 0 }) }),
      observation({ object: ball({ x: 1.2, y: 0.6 }, { x: 2, y: 0 }) }),
      observation({ object: ball({ x: -1.1, y: 0.4 }, { x: 0, y: -4 }) }),
    ];
    const params = { steerGain: 1.5, forceGain: 2 };
    for (const obs of cases) {
      const pilot = createConnectomePilot('hero', circuit, params);
      const shot = expectShot(pilot.decide(obs));
      const t = pilot.telemetry();
      expect(shot.force).toBeGreaterThanOrEqual(0.1);
      expect(shot.force).toBeLessThanOrEqual(1);
      expect(t.force).toBe(shot.force);
      expect(Math.abs(t.angleOffset)).toBeLessThanOrEqual(params.steerGain * DEFAULT_PILOT.maxRate + 1e-9);
      expect(t.dnLeft).toBeGreaterThanOrEqual(0);
      expect(t.dnLeft).toBeLessThanOrEqual(DEFAULT_PILOT.maxRate);
      expect(t.dnRight).toBeGreaterThanOrEqual(0);
      expect(t.dnRight).toBeLessThanOrEqual(DEFAULT_PILOT.maxRate);
      expect(t.neuronCount).toBe(1072);
      expect(t.edgeCount).toBe(26544);
    }
  });

  it('reports real counts and zero activity before any shot', () => {
    const pilot = createConnectomePilot('hero', circuit);
    expect(pilot.label).toBe('connectome pilot');
    expect(pilot.telemetry()).toEqual({
      dnLeft: 0,
      dnRight: 0,
      neuronCount: 1072,
      edgeCount: 26544,
      activity: 0,
      angleOffset: 0,
      force: 0,
    });
  });

  it('delegates stance and timing to the noise-free heuristic when it is not shooting', () => {
    const pilot = createConnectomePilot('hero', circuit);
    const reference = createHeuristic('ref', 0, { aimNoise: 0 });
    const notMyTurn = observation({ turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 500 } });
    expect(pilot.decide(notMyTurn)).toEqual(reference.decide(notMyTurn));
    const outOfReach = observation({
      myFly: fly({ x: -1.2, y: 0.3 }, 0),
      cue: ball({ x: -1.0, y: 0 }),
      object: ball({ x: 0, y: 0 }, { x: -0.5, y: 0 }),
    });
    const cmd = pilot.decide(outOfReach);
    expect(cmd.kind).toBe('move');
    expect(cmd).toEqual(reference.decide(outOfReach));
  });

  it('shoots the heuristic intercept plus a bounded neural offset', () => {
    const pilot = createConnectomePilot('hero', circuit);
    const reference = createHeuristic('ref', 0, { aimNoise: 0 });
    const obs = observation();
    const ours = pilot.decide(obs);
    const theirs = reference.decide(obs);
    if (ours.kind !== 'shoot' || theirs.kind !== 'shoot') throw new Error('both must shoot');
    expect(ours.shot.angle - theirs.shot.angle).toBeCloseTo(pilot.telemetry().angleOffset, 12);
    expect(Math.abs(pilot.telemetry().angleOffset)).toBeLessThanOrEqual(DEFAULT_PILOT.steerGain + 1e-12);
  });
});
