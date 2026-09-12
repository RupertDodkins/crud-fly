import type { Ball, Controller, Observation, PlayerCommand, Vec2 } from '../core/model';
import { vec } from '../core/model';
import { activeShooter, endSign, unit01, xorshift32 } from '../core/rules';

/** Stand this far behind the cue ball, along the line away from the object ball. */
const STANCE_OFFSET = 0.07;
const ZONE_MARGIN = 0.03;
const ARRIVED = 0.05;
/** Close enough to the cue ball that the strike lunge will reach it. */
const NEAR_CUE = 0.13;
/** The controller cannot see rules; these mirror DEMO_RULES for prediction only. */
const ASSUMED_MAX_SHOT_SPEED = 6;
const ASSUMED_DECEL = 0.35;
/** Aim (0.25 s) + strike (0.12 s): the object ball keeps moving between deciding and releasing the cue ball. */
const STRIKE_LATENCY = 0.37;
const SHOOTABLE_OBJECT_SPEED = 0.06;
const FORCE_BASE = 0.35;
const FORCE_PER_METRE = 0.1;
const POCKET_WINDOW = (15 * Math.PI) / 180;
/** 0.04 rad (the original default) missed a 5.7 cm ball from 1.6 m about half the time. */
const DEFAULT_AIM_NOISE = 0.012;

const WAIT: PlayerCommand = { kind: 'wait' };

function sub(a: Vec2, b: Vec2): Vec2 {
  return vec(a.x - b.x, a.y - b.y);
}

function len(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

function unit(v: Vec2, fallback: Vec2): Vec2 {
  const l = len(v);
  return l > 1e-9 ? vec(v.x / l, v.y / l) : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Shared by both controllers: where to stand. Pure. */
export function stanceFor(obs: Observation): PlayerCommand {
  const { cue, object, legalZone, myFly, table } = obs;
  const toward = vec(-endSign(obs.me), 0);
  const dir = object.pocketed ? toward : unit(sub(object.pos, cue.pos), toward);
  const target = vec(
    clamp(cue.pos.x - dir.x * STANCE_OFFSET, legalZone.xMin + ZONE_MARGIN, legalZone.xMax - ZONE_MARGIN),
    clamp(cue.pos.y - dir.y * STANCE_OFFSET, -table.width / 2, table.width / 2),
  );
  if (len(sub(myFly.pos, target)) <= ARRIVED) return WAIT;
  return { kind: 'move', target };
}

/** Where a decelerating ball will be after `t` seconds, ignoring cushions. */
function advance(ball: Ball, t: number, stopsIn: number): Vec2 {
  const speed = len(ball.vel);
  if (speed < 1e-9) return ball.pos;
  const decel = Number.isFinite(stopsIn) && stopsIn > 0 ? speed / stopsIn : 0;
  const tt = Number.isFinite(stopsIn) ? Math.min(t, stopsIn) : t;
  const s = speed * tt - 0.5 * decel * tt * tt;
  return vec(ball.pos.x + (ball.vel.x / speed) * s, ball.pos.y + (ball.vel.y / speed) * s);
}

/** Seconds for the cue ball to cover `s` metres from `v0` under constant deceleration. */
function travelTime(s: number, v0: number): number {
  const disc = v0 * v0 - 2 * ASSUMED_DECEL * s;
  if (disc <= 0) return v0 / ASSUMED_DECEL;
  return (v0 - Math.sqrt(disc)) / ASSUMED_DECEL;
}

function planShot(obs: Observation, noise: number): { shot: { angle: number; force: number }; pocketAim: boolean } {
  const { cue, object, table } = obs;
  const force = Math.min(1, FORCE_BASE + FORCE_PER_METRE * len(sub(object.pos, cue.pos)));
  const cueSpeed = force * ASSUMED_MAX_SHOT_SPEED;
  let predicted = object.pos;
  let t = travelTime(len(sub(object.pos, cue.pos)), cueSpeed);
  for (let i = 0; i < 2; i++) {
    predicted = advance(object, STRIKE_LATENCY + t, obs.objectStopsIn);
    t = travelTime(len(sub(predicted, cue.pos)), cueSpeed);
  }
  const lineToObject = unit(sub(predicted, cue.pos), vec(-endSign(obs.me), 0));
  let aimPoint = predicted;
  let bestPocketDist = Infinity;
  for (const pocket of table.pockets) {
    const toPocket = unit(sub(pocket, predicted), lineToObject);
    if (toPocket.x * lineToObject.x + toPocket.y * lineToObject.y <= 0) continue;
    const ghost = vec(predicted.x - toPocket.x * 2 * table.ballRadius, predicted.y - toPocket.y * 2 * table.ballRadius);
    const lineToGhost = unit(sub(ghost, cue.pos), lineToObject);
    const cos = lineToGhost.x * lineToObject.x + lineToGhost.y * lineToObject.y;
    const d = len(sub(pocket, predicted));
    if (cos >= Math.cos(POCKET_WINDOW) && d < bestPocketDist) {
      bestPocketDist = d;
      aimPoint = ghost;
    }
  }
  const angle = Math.atan2(aimPoint.y - cue.pos.y, aimPoint.x - cue.pos.x) + noise;
  return { shot: { angle, force }, pocketAim: bestPocketDist < Infinity };
}

/**
 * Phase 1 fly and the permanent opponent. Walk to the legal short end, wait for a shootable object
 * ball, aim at its predicted position, shoot with force proportional to distance, with a small seeded
 * imperfection so it is not a laser. No learning, and labelled as such.
 */
export function createHeuristic(id: string, seed: number, opts?: { readonly aimNoise?: number }): Controller {
  const aimNoise = opts?.aimNoise ?? DEFAULT_AIM_NOISE;
  let rng = xorshift32((seed >>> 0) ^ 0x2545f491);
  let last = { angle: 0, force: 0, noise: 0, pocketAim: 0 };
  return {
    id,
    label: 'heuristic',
    decide(obs: Observation): PlayerCommand {
      if (activeShooter(obs.turn) !== obs.me) return stanceFor(obs);
      const fly = obs.myFly;
      if (fly.shot !== null || (fly.phase !== 'idle' && fly.phase !== 'approach')) return WAIT;
      if (len(sub(fly.pos, obs.cue.pos)) > NEAR_CUE) return stanceFor(obs);
      const shootable = !obs.object.pocketed && (obs.turn.kind === 'serve' || len(obs.object.vel) > SHOOTABLE_OBJECT_SPEED);
      if (!shootable) return WAIT;
      rng = xorshift32(rng);
      const noise = (unit01(rng) - 0.5) * 2 * aimNoise;
      const plan = planShot(obs, noise);
      last = { angle: plan.shot.angle, force: plan.shot.force, noise, pocketAim: plan.pocketAim ? 1 : 0 };
      return { kind: 'shoot', shot: plan.shot };
    },
    telemetry: () => ({ aimAngle: last.angle, force: last.force, aimNoise: last.noise, pocketAim: last.pocketAim }),
  };
}
