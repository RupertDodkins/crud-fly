// Hand-authored Frame fixture driving createScene3D without the core session (which is not implemented yet).
import type { Ball, FlyBody, FlyPhase, Frame, Player, RuleEvent, Table, Vec2 } from '../src/core/model';
import { createScene3D } from '../src/presentation/scene3d';

const table: Table = {
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

const HZ = 120;
const DT = 1 / HZ;

interface Script {
  phase: FlyPhase;
  phaseT: number;
  cue: { pos: Vec2; vel: Vec2; pocketed: boolean };
  object: { pos: Vec2; vel: Vec2; pocketed: boolean };
  fly: { pos: Vec2; heading: number };
  log: RuleEvent[];
  tick: number;
  lives: [number, number];
}

const START_FLY: Vec2 = { x: -1.05, y: 0.3 };
const START_CUE: Vec2 = { x: -0.95, y: -0.05 };
const START_OBJECT: Vec2 = { x: 0.35, y: 0.1 };

function fresh(): Script {
  return {
    phase: 'idle',
    phaseT: 0,
    cue: { pos: START_CUE, vel: { x: 0, y: 0 }, pocketed: false },
    object: { pos: START_OBJECT, vel: { x: 0.08, y: 0.03 }, pocketed: false },
    fly: { pos: START_FLY, heading: 0 },
    log: [],
    tick: 0,
    lives: [3, 3],
  };
}

const PHASE_LENGTH: Record<FlyPhase, number> = { idle: 1.2, approach: Infinity, aim: 0.9, strike: 0.25, recover: 0.6 };

function integrate(b: Script['cue'], friction: number): void {
  const speed = Math.hypot(b.vel.x, b.vel.y);
  if (speed < 0.005) {
    b.vel = { x: 0, y: 0 };
    return;
  }
  const k = Math.max(0, 1 - (friction * DT) / speed);
  b.vel = { x: b.vel.x * k, y: b.vel.y * k };
  let x = b.pos.x + b.vel.x * DT;
  let y = b.pos.y + b.vel.y * DT;
  const r = table.ballRadius;
  if (Math.abs(x) > table.length / 2 - r) {
    x = Math.sign(x) * (table.length / 2 - r);
    b.vel = { x: -b.vel.x * 0.8, y: b.vel.y };
  }
  if (Math.abs(y) > table.width / 2 - r) {
    y = Math.sign(y) * (table.width / 2 - r);
    b.vel = { x: b.vel.x, y: -b.vel.y * 0.8 };
  }
  b.pos = { x, y };
}

function collide(s: Script): boolean {
  const dx = s.object.pos.x - s.cue.pos.x;
  const dy = s.object.pos.y - s.cue.pos.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > table.ballRadius * 2) return false;
  const nx = dx / d;
  const ny = dy / d;
  const rel = (s.cue.vel.x - s.object.vel.x) * nx + (s.cue.vel.y - s.object.vel.y) * ny;
  if (rel <= 0) return false;
  s.cue.vel = { x: s.cue.vel.x - rel * nx, y: s.cue.vel.y - rel * ny };
  s.object.vel = { x: s.object.vel.x + rel * nx, y: s.object.vel.y + rel * ny };
  return true;
}

let s = fresh();
let contactSeen = false;

function stepScript(): void {
  s.tick += 1;
  s.phaseT += DT;
  const toCue = { x: s.cue.pos.x - s.fly.pos.x, y: s.cue.pos.y - s.fly.pos.y };
  const dist = Math.hypot(toCue.x, toCue.y);

  switch (s.phase) {
    case 'idle':
      if (s.phaseT > PHASE_LENGTH.idle) enter('approach');
      break;
    case 'approach': {
      s.fly.heading = Math.atan2(toCue.y, toCue.x);
      const standOff = table.ballRadius * 2.2;
      if (dist <= standOff + 0.002) {
        enter('aim');
      } else {
        const v = 0.35;
        s.fly.pos = { x: s.fly.pos.x + Math.cos(s.fly.heading) * v * DT, y: s.fly.pos.y + Math.sin(s.fly.heading) * v * DT };
      }
      break;
    }
    case 'aim':
      s.fly.heading = Math.atan2(toCue.y, toCue.x);
      if (s.phaseT > PHASE_LENGTH.aim) enter('strike');
      break;
    case 'strike':
      if (!contactSeen && s.phaseT > 0.08) {
        contactSeen = true;
        const a = shotAngle();
        s.cue.vel = { x: Math.cos(a) * 1.9, y: Math.sin(a) * 1.9 };
      }
      if (s.phaseT > PHASE_LENGTH.strike) enter('recover');
      break;
    case 'recover':
      if (s.phaseT > PHASE_LENGTH.recover) enter('idle');
      break;
  }

  integrate(s.cue, 0.6);
  integrate(s.object, 0.6);
  if (collide(s)) s.log.push({ kind: 'contact', tick: s.tick });

  for (const [name, b] of [['cue', s.cue], ['object', s.object]] as const) {
    if (b.pocketed) continue;
    for (const p of table.pockets) {
      if (Math.hypot(b.pos.x - p.x, b.pos.y - p.y) < table.pocketRadius) {
        b.pocketed = true;
        b.vel = { x: 0, y: 0 };
        s.log.push({ kind: 'pocket', ball: name, tick: s.tick });
        s.log.push({ kind: 'life_lost', player: name === 'cue' ? 0 : 1, reason: 'object_ball_pocketed', tick: s.tick });
        s.lives[name === 'cue' ? 0 : 1] -= 1;
      }
    }
  }

  if (s.tick > HZ * 9) {
    const lives = s.lives;
    s = fresh();
    s.lives = lives;
    contactSeen = false;
  }
}

function shotAngle(): number {
  return Math.atan2(s.object.pos.y - s.cue.pos.y, s.object.pos.x - s.cue.pos.x) + 0.04;
}

function enter(phase: FlyPhase): void {
  s.phase = phase;
  s.phaseT = 0;
  if (phase === 'strike') contactSeen = false;
  if (phase === 'idle') {
    s.log.push({ kind: 'life_lost', player: 1, reason: 'object_ball_stopped', tick: s.tick });
    s.lives[1] = Math.max(0, s.lives[1] - 1);
  }
}

function player(id: 0 | 1, fly: FlyBody, lives: number): Player {
  return { id, name: id === 0 ? 'connectome pilot' : 'heuristic', lives, fly };
}

function frame(): Frame {
  const shot = s.phase === 'aim' || s.phase === 'strike' ? { angle: shotAngle(), force: 0.55 } : null;
  const shooter: FlyBody = { pos: s.fly.pos, heading: s.fly.heading, phase: s.phase, phaseT: s.phaseT, shot };
  const idler: FlyBody = { pos: { x: 1.1, y: -0.25 }, heading: Math.PI, phase: 'idle', phaseT: s.phaseT, shot: null };
  const cue: Ball = s.cue;
  const object: Ball = s.object;
  return {
    tick: s.tick,
    table,
    cue,
    object,
    players: [player(0, shooter, s.lives[0]), player(1, idler, s.lives[1])],
    turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: s.tick + 600 },
    log: s.log,
    rng: 1,
  };
}

const stage = document.getElementById('stage')!;
const label = document.getElementById('label')!;
const scene = createScene3D(stage);

let last = performance.now();
let acc = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  while (acc >= DT) {
    stepScript();
    acc -= DT;
  }
  scene.update(frame(), dt);
  label.textContent = `tick ${s.tick}  phase ${s.phase} ${s.phaseT.toFixed(2)}s  log ${s.log.length}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
