import type { Ball, Controller, Observation, PlayerCommand, Vec2 } from '../core/model';
import { vec } from '../core/model';
import { CARRY_OFFSET, isTurnOf, unit01, xorshift32 } from '../core/rules';

type Zone = Observation['legalEnds'][number];

/** Stop issuing new move targets once this close. */
const ARRIVED = 0.02;
/** Keep this far off the side cushions when standing in an end band. */
const SIDE_MARGIN = 0.06;
/** Waiting flies stand off the centre line so they are not in the throwing lane. */
const WAIT_Y = 0.35;
/** The controller cannot see rules or physics; these mirror the demo values for prediction only. */
const ASSUMED_MAX_SHOT_SPEED = 6;
const ASSUMED_DECEL = 0.35;
const ASSUMED_WALK_SPEED = 1.8;
/** Aim (0.25 s) + strike (0.12 s): the object ball keeps moving between deciding and releasing the cue ball. */
const STRIKE_LATENCY = 0.37;
const SHOOTABLE_OBJECT_SPEED = 0.06;
/** Cue ball slower than this is treated as resting when fetching it. */
const RESTING_CUE_SPEED = 0.05;
/** Longest intercept lead when chasing a rolling cue ball, seconds. */
const MAX_CHASE_LEAD = 1.0;
/** Don't carry the ball to an end the object ball is already parked in (expanded by this margin). */
const OBJECT_END_MARGIN = 0.1;
/** My own throw is still in flight and moving away: stand and watch rather than sprint after it. */
const IN_FLIGHT_SPEED = 1.0;
/** How far inside the legal band the carrier stops before throwing, metres. */
const ZONE_EDGE_INSET = 0.03;
const FORCE_BASE = 0.35;
const FORCE_PER_METRE = 0.1;
/** Only try a pocket when the cut (object-to-pocket line vs cue line) is this shallow. */
const MAX_CUT = (30 * Math.PI) / 180;
/** Aim a little inside the true ghost ball so a thin cut still makes contact under aim noise. */
const GHOST_FRACTION = 0.85;
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

function centre(z: Zone): number {
  return (z.xMin + z.xMax) / 2;
}

function inZone(z: Zone, x: number, margin = 0): boolean {
  return x >= z.xMin - margin && x <= z.xMax + margin;
}

function clampToTable(p: Vec2, obs: Observation): Vec2 {
  const hx = obs.table.length / 2 - obs.table.ballRadius;
  const hy = obs.table.width / 2 - obs.table.ballRadius;
  return vec(clamp(p.x, -hx, hx), clamp(p.y, -hy, hy));
}

function moveTo(obs: Observation, target: Vec2): PlayerCommand {
  if (len(sub(obs.myFly.pos, target)) <= ARRIVED) return WAIT;
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

/** Not my clock: stand at the end farther from the cue ball, off the centre line, out of the shooter's way. */
function waitingSpot(obs: Observation): Vec2 {
  const end = obs.cue.pos.x >= 0 ? 0 : 1;
  const y = obs.myFly.pos.y >= 0 ? WAIT_Y : -WAIT_Y;
  return clampToTable(vec(centre(obs.legalEnds[end]), y), obs);
}

/** My clock, no ball: run to where the cue ball will be when I get there. The engine grabs it within reach. */
function chaseTarget(obs: Observation): Vec2 {
  const { cue, myFly } = obs;
  const speed = len(cue.vel);
  if (speed < RESTING_CUE_SPEED) return cue.pos;
  const away = sub(cue.pos, myFly.pos);
  const receding = cue.vel.x * away.x + cue.vel.y * away.y > 0;
  if (obs.turn.kind === 'awaiting_shot' && speed > IN_FLIGHT_SPEED && receding) return myFly.pos;
  const stopsIn = speed / ASSUMED_DECEL;
  let target = cue.pos;
  for (let i = 0; i < 2; i++) {
    const lead = clamp(len(sub(target, myFly.pos)) / ASSUMED_WALK_SPEED, 0, MAX_CHASE_LEAD);
    target = advance(cue, lead, stopsIn);
  }
  return clampToTable(target, obs);
}

/** Seconds ahead to look when judging whether the object ball is heading into an end band. */
const END_LOOKAHEAD = 1.0;

/**
 * Ball in hand: the nearer short end, unless the object ball is parked in it or about to roll into it
 * (a throw from there would be sideways or backwards); keep my lane (y). `avoid` forces the other end.
 */
function carryTarget(obs: Observation): { end: 0 | 1; target: Vec2 } {
  const { legalEnds, myFly, object, table } = obs;
  const byDistance = ([0, 1] as const).slice().sort((a, b) => Math.abs(myFly.pos.x - centre(legalEnds[a])) - Math.abs(myFly.pos.x - centre(legalEnds[b])));
  let end = byDistance[0] as 0 | 1;
  const soon = advance(object, END_LOOKAHEAD, obs.objectStopsIn);
  const objectIn = (z: Zone): boolean => !object.pocketed && (inZone(z, object.pos.x, OBJECT_END_MARGIN) || inZone(z, soon.x, OBJECT_END_MARGIN));
  if (objectIn(legalEnds[end])) end = byDistance[1] as 0 | 1;
  const y = clamp(myFly.pos.y, -(table.width / 2 - SIDE_MARGIN), table.width / 2 - SIDE_MARGIN);
  // Stop just inside the band's table-side edge: a legal throw from there is as good as one from the rail,
  // and it saves the walk. Nudged inward so a rounding error cannot leave the fly a hair outside the zone.
  const z = legalEnds[end];
  const edgeX = end === 0 ? z.xMax - ZONE_EDGE_INSET : z.xMin + ZONE_EDGE_INSET;
  return { end, target: vec(edgeX, y) };
}

/** A throw from a short end must head into the table; a sideways/backwards fold is a certain miss. */
function facesTable(angle: number, flyX: number): boolean {
  return Math.cos(angle) * -Math.sign(flyX) > 1e-6;
}

/** Where the ball leaves the hand: CARRY_OFFSET ahead of the fly once it has turned toward the object ball. */
function releasePoint(obs: Observation): Vec2 {
  const fly = obs.myFly;
  const toward = unit(sub(obs.object.pos, fly.pos), vec(fly.pos.x <= 0 ? 1 : -1, 0));
  return vec(fly.pos.x + toward.x * CARRY_OFFSET, fly.pos.y + toward.y * CARRY_OFFSET);
}

function planShot(obs: Observation, noise: number): { shot: { angle: number; force: number }; pocketAim: boolean } {
  const { object, table } = obs;
  const origin = releasePoint(obs);
  const force = Math.min(1, FORCE_BASE + FORCE_PER_METRE * len(sub(object.pos, origin)));
  const cueSpeed = force * ASSUMED_MAX_SHOT_SPEED;
  let predicted = object.pos;
  let t = travelTime(len(sub(object.pos, origin)), cueSpeed);
  for (let i = 0; i < 2; i++) {
    predicted = advance(object, STRIKE_LATENCY + t, obs.objectStopsIn);
    t = travelTime(len(sub(predicted, origin)), cueSpeed);
  }
  // The object ball is coming at my end and the intercept lands behind me: meet it where it is instead.
  if (!facesTable(Math.atan2(predicted.y - origin.y, predicted.x - origin.x), origin.x)) predicted = object.pos;
  const lineToObject = unit(sub(predicted, origin), vec(origin.x <= 0 ? 1 : -1, 0));
  let aimPoint = predicted;
  let bestPocketDist = Infinity;
  for (const pocket of table.pockets) {
    const toPocket = unit(sub(pocket, predicted), lineToObject);
    const cut = toPocket.x * lineToObject.x + toPocket.y * lineToObject.y;
    if (cut < Math.cos(MAX_CUT)) continue;
    const offset = GHOST_FRACTION * 2 * table.ballRadius;
    const ghost = vec(predicted.x - toPocket.x * offset, predicted.y - toPocket.y * offset);
    const d = len(sub(pocket, predicted));
    if (d < bestPocketDist) {
      bestPocketDist = d;
      aimPoint = ghost;
    }
  }
  const angle = Math.atan2(aimPoint.y - origin.y, aimPoint.x - origin.x) + noise;
  return { shot: { angle, force }, pocketAim: bestPocketDist < Infinity };
}

/**
 * Phase 1 fly and the permanent opponent. Ball-in-hand Crud: when it is not my clock, wait at the far
 * end; when it is, fetch the cue ball wherever it lies, carry it to the nearer short end, and throw at
 * the object ball's predicted position with force proportional to distance and a small seeded
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
      const fly = obs.myFly;
      if (fly.shot !== null || (fly.phase !== 'idle' && fly.phase !== 'approach')) return WAIT;
      if (obs.turn.kind === 'resolving' || obs.turn.kind === 'over') return WAIT;
      if (!isTurnOf(obs.turn, obs.me)) return moveTo(obs, waitingSpot(obs));
      if (!obs.carrying) return moveTo(obs, chaseTarget(obs));
      if (!obs.legalEnds.some((z) => inZone(z, fly.pos.x))) return moveTo(obs, carryTarget(obs).target);
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
