import type { Ball, FlyBody, MatchState, RuleEvent, Shot, Table, Vec2 } from './model';
import { vec } from './model';

/** Fixed step. 120 Hz keeps two-ball contact stable without substeps. */
export const DT = 1 / 120;

export interface PhysicsParams {
  /** Rolling deceleration, m/s^2. */
  readonly rollingDecel: number;
  readonly ballRestitution: number;
  readonly cushionRestitution: number;
}

export const DEMO_PHYSICS: PhysicsParams = {
  rollingDecel: 0.35,
  ballRestitution: 0.93,
  cushionRestitution: 0.75,
};

/** Below this speed a rolling ball is snapped to rest so it cannot creep forever. */
const STOP_EPS = 1e-4;

export const FLY_WALK_SPEED = 1.2;
export const FLY_REACH = 0.08;
const FLY_LUNGE_SPEED = 0.6;
const AIM_SECONDS = 0.25;
const STRIKE_SECONDS = 0.12;
const RECOVER_SECONDS = 0.3;
const ARRIVE_EPS = 0.01;
/** Phase timers accumulate DT; the epsilon absorbs float drift so 30 ticks always equals 0.25 s. */
const T_EPS = 1e-9;

/** Standard 9-ft table in metres, six pockets. */
export function standardTable(): Table {
  const length = 2.54;
  const width = 1.27;
  const hx = length / 2;
  const hy = width / 2;
  return {
    length,
    width,
    ballRadius: 0.028575,
    pocketRadius: 0.06,
    pockets: [vec(-hx, -hy), vec(-hx, hy), vec(hx, -hy), vec(hx, hy), vec(0, -hy), vec(0, hy)],
  };
}

export interface PhysicsResult {
  readonly cue: Ball;
  readonly object: Ball;
  /** contact / pocket events only. Never life events. */
  readonly events: RuleEvent[];
}

export function speedOf(ball: Ball): number {
  return Math.hypot(ball.vel.x, ball.vel.y);
}

function roll(ball: Ball, decel: number): Ball {
  if (ball.pocketed) return ball;
  const speed = speedOf(ball);
  if (speed < STOP_EPS) {
    return speed === 0 ? ball : { ...ball, vel: vec(0, 0) };
  }
  const next = Math.max(0, speed - decel * DT);
  const k = next / speed;
  const vel = vec(ball.vel.x * k, ball.vel.y * k);
  return { ...ball, vel, pos: vec(ball.pos.x + vel.x * DT, ball.pos.y + vel.y * DT) };
}

function collide(a: Ball, b: Ball, radius: number, e: number): { a: Ball; b: Ball; hit: boolean } {
  if (a.pocketed || b.pocketed) return { a, b, hit: false };
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy);
  const minD = 2 * radius;
  if (d >= minD) return { a, b, hit: false };
  const nx = d > 0 ? dx / d : 1;
  const ny = d > 0 ? dy / d : 0;
  const van = a.vel.x * nx + a.vel.y * ny;
  const vbn = b.vel.x * nx + b.vel.y * ny;
  // Overlapping but separating: only push apart, no second impulse.
  const approaching = van - vbn > 0;
  const overlap = minD - d;
  const push = overlap / 2 + 1e-6;
  const aPos = vec(a.pos.x - nx * push, a.pos.y - ny * push);
  const bPos = vec(b.pos.x + nx * push, b.pos.y + ny * push);
  if (!approaching) return { a: { ...a, pos: aPos }, b: { ...b, pos: bPos }, hit: false };
  const mean = (van + vbn) / 2;
  const half = (e * (van - vbn)) / 2;
  const vanNew = mean - half;
  const vbnNew = mean + half;
  const aVel = vec(a.vel.x + (vanNew - van) * nx, a.vel.y + (vanNew - van) * ny);
  const bVel = vec(b.vel.x + (vbnNew - vbn) * nx, b.vel.y + (vbnNew - vbn) * ny);
  return { a: { pos: aPos, vel: aVel, pocketed: false }, b: { pos: bPos, vel: bVel, pocketed: false }, hit: true };
}

function pocketCheck(ball: Ball, table: Table): Ball {
  if (ball.pocketed) return ball;
  for (const p of table.pockets) {
    if (Math.hypot(ball.pos.x - p.x, ball.pos.y - p.y) <= table.pocketRadius) {
      return { pos: p, vel: vec(0, 0), pocketed: true };
    }
  }
  return ball;
}

function cushion(ball: Ball, table: Table, e: number): Ball {
  if (ball.pocketed) return ball;
  const hx = table.length / 2 - table.ballRadius;
  const hy = table.width / 2 - table.ballRadius;
  let { x, y } = ball.pos;
  let { x: vx, y: vy } = ball.vel;
  if (x < -hx) {
    x = -hx;
    if (vx < 0) vx = -vx * e;
  } else if (x > hx) {
    x = hx;
    if (vx > 0) vx = -vx * e;
  }
  if (y < -hy) {
    y = -hy;
    if (vy < 0) vy = -vy * e;
  } else if (y > hy) {
    y = hy;
    if (vy > 0) vy = -vy * e;
  }
  if (x === ball.pos.x && y === ball.pos.y && vx === ball.vel.x && vy === ball.vel.y) return ball;
  return { ...ball, pos: vec(x, y), vel: vec(vx, vy) };
}

/** One fixed step of ball motion. Pure. Deterministic for identical inputs (no Math.random, no Date). */
export function stepBalls(cue: Ball, object: Ball, table: Table, params: PhysicsParams, tick: number): PhysicsResult {
  const events: RuleEvent[] = [];
  let c = roll(cue, params.rollingDecel);
  let o = roll(object, params.rollingDecel);
  const hit = collide(c, o, table.ballRadius, params.ballRestitution);
  c = hit.a;
  o = hit.b;
  if (hit.hit) events.push({ kind: 'contact', tick });
  // Pockets before cushions so a ball reaching a corner is captured rather than bounced.
  const cP = pocketCheck(c, table);
  if (cP.pocketed && !c.pocketed) events.push({ kind: 'pocket', ball: 'cue', tick });
  const oP = pocketCheck(o, table);
  if (oP.pocketed && !o.pocketed) events.push({ kind: 'pocket', ball: 'object', tick });
  return {
    cue: cushion(cP, table, params.cushionRestitution),
    object: cushion(oP, table, params.cushionRestitution),
    events,
  };
}

/** Convert a validated shot into a cue-ball velocity. The only way force enters the table. */
export function applyShot(cue: Ball, shot: Shot, maxSpeed: number): Ball {
  const s = shot.force * maxSpeed;
  return { ...cue, vel: vec(Math.cos(shot.angle) * s, Math.sin(shot.angle) * s) };
}

/** Seconds until a rolling ball stops under constant deceleration. Infinity if already stopped. */
export function timeToStop(ball: Ball, params: PhysicsParams, stoppedSpeed: number): number {
  if (ball.pocketed) return Infinity;
  const speed = speedOf(ball);
  if (speed < stoppedSpeed) return Infinity;
  if (params.rollingDecel <= 0) return Infinity;
  return speed / params.rollingDecel;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function walkToward(pos: Vec2, target: Vec2, maxStep: number): { pos: Vec2; heading: number; arrived: boolean } {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  const heading = Math.atan2(dy, dx);
  if (d <= maxStep) return { pos: target, heading, arrived: true };
  const k = maxStep / d;
  return { pos: vec(pos.x + dx * k, pos.y + dy * k), heading, arrived: false };
}

/** Move the fly body one step toward its target / through its phase machine. Returns whether the strike landed this tick. */
export function stepFly(fly: FlyBody, target: Vec2 | null, cue: Ball, table: Table): { fly: FlyBody; struck: boolean } {
  const t = fly.phaseT + DT;
  switch (fly.phase) {
    case 'idle': {
      if (fly.shot) return { fly: { ...fly, phase: 'aim', phaseT: 0 }, struck: false };
      if (target && dist(fly.pos, target) > ARRIVE_EPS) return { fly: { ...fly, phase: 'approach', phaseT: 0 }, struck: false };
      return { fly: { ...fly, phaseT: t }, struck: false };
    }
    case 'approach': {
      if (fly.shot) return { fly: { ...fly, phase: 'aim', phaseT: 0 }, struck: false };
      if (!target) return { fly: { ...fly, phase: 'idle', phaseT: 0 }, struck: false };
      const w = walkToward(fly.pos, target, FLY_WALK_SPEED * DT);
      if (w.arrived) return { fly: { ...fly, pos: w.pos, heading: w.heading, phase: 'idle', phaseT: 0 }, struck: false };
      return { fly: { ...fly, pos: w.pos, heading: w.heading, phaseT: t }, struck: false };
    }
    case 'aim': {
      const heading = Math.atan2(cue.pos.y - fly.pos.y, cue.pos.x - fly.pos.x);
      if (t + T_EPS >= AIM_SECONDS) return { fly: { ...fly, heading, phase: 'strike', phaseT: 0 }, struck: false };
      return { fly: { ...fly, heading, phaseT: t }, struck: false };
    }
    case 'strike': {
      const gap = dist(fly.pos, cue.pos);
      const room = Math.max(0, gap - table.ballRadius);
      const w = room > 0 ? walkToward(fly.pos, cue.pos, Math.min(room, FLY_LUNGE_SPEED * DT)) : { pos: fly.pos, heading: fly.heading, arrived: true };
      if (t + T_EPS >= STRIKE_SECONDS) {
        const struck = dist(w.pos, cue.pos) <= FLY_REACH;
        return { fly: { ...fly, pos: w.pos, heading: w.heading, phase: 'recover', phaseT: 0 }, struck };
      }
      return { fly: { ...fly, pos: w.pos, heading: w.heading, phaseT: t }, struck: false };
    }
    case 'recover': {
      if (t + T_EPS >= RECOVER_SECONDS) return { fly: { ...fly, phase: 'idle', phaseT: 0, shot: null }, struck: false };
      return { fly: { ...fly, phaseT: t }, struck: false };
    }
  }
}

const PHASE_INDEX: Record<FlyBody['phase'], number> = { idle: 0, approach: 1, aim: 2, strike: 3, recover: 4 };

/** FNV-1a over the quantised numeric fields of state. Used for replay checkpoints. */
export function hashState(state: MatchState): string {
  const nums: number[] = [];
  const q = (v: number): void => {
    nums.push(Math.round(v * 1e6));
  };
  const ball = (b: Ball): void => {
    q(b.pos.x);
    q(b.pos.y);
    q(b.vel.x);
    q(b.vel.y);
    q(b.pocketed ? 1 : 0);
  };
  ball(state.cue);
  ball(state.object);
  for (const p of state.players) {
    q(p.lives);
    q(p.fly.pos.x);
    q(p.fly.pos.y);
    q(p.fly.heading);
    q(PHASE_INDEX[p.fly.phase]);
    q(p.fly.phaseT);
    q(p.fly.shot ? p.fly.shot.angle : -1);
    q(p.fly.shot ? p.fly.shot.force : -1);
  }
  const t = state.turn;
  switch (t.kind) {
    case 'serve':
      nums.push(1, t.shooter, t.attempt);
      break;
    case 'awaiting_shot':
      nums.push(2, t.shooter, t.deadlineTick, t.serveAttempt ?? 0);
      break;
    case 'in_play':
      nums.push(3, t.lastShooter);
      break;
    case 'resolving':
      nums.push(4, t.outcome.tick);
      break;
    case 'over':
      nums.push(5, t.winner);
      break;
  }
  q(state.tick);
  q(state.rng);

  let h = 0x811c9dc5;
  for (const n of nums) {
    const s = String(n) + ',';
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}
