import { loadSomaPositions } from '../src/brain/positions';
import { loadFlybody } from '../src/presentation/flybody';
// Isolated fixtures and frozen hero replay for presentation review.
import type { Ball, FlyBody, FlyPhase, Frame, Player, RuleEvent, Table, Vec2 } from '../src/core/model';
import { createComposite } from '../src/presentation/composite';
import { createConnectomePilot, parseCircuit } from '../src/controllers/connectome-pilot';
import circuit from '../src/brain/flight-v1.json';
import { createHeuristic } from '../src/controllers/heuristic';
import { DEMO_RULES, rulesInForce } from '../src/core/rules';
import { DEMO_PHYSICS } from '../src/core/physics';
import { parseTape } from '../src/replay/codec';
import { createSession, replayController } from '../src/core/session';
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
      const standOff = 0.08;
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
      { const step = Math.min(Math.max(0, dist - table.ballRadius), 0.7 * DT);
        s.fly.pos = { x: s.fly.pos.x + Math.cos(s.fly.heading) * step, y: s.fly.pos.y + Math.sin(s.fly.heading) * step }; }
      if (!contactSeen && s.phaseT >= 0.12) {
        contactSeen = true;
        s.log.push({ kind: 'legal_shot', player: 0, tick: s.tick });
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

await loadFlybody();
const stage = document.getElementById('stage')!;
const label = document.getElementById('label')!;
const scene = createScene3D(stage, new URLSearchParams(location.search).has('detail'));

// ?t=SECONDS fast-forwards the script so a specific phase can be screenshotted deterministically; ?pause=1 freezes there.
const params = new URL(location.href).searchParams;
let paused = params.has('pause');
let replay: ReturnType<typeof createSession> | null = null;
if (params.has('replay')) {
  const tape = parseTape(await (await fetch('/replays/hero.json')).json());
  const commands: [Map<number, import('../src/core/model').PlayerCommand>, Map<number, import('../src/core/model').PlayerCommand>] = [new Map(), new Map()];
  for (const c of tape.commands) commands[c.player].set(c.tick, c.cmd);
  replay = createSession({ seed: tape.seed, rules: tape.rules, physics: tape.physics, names: tape.names,
    controllers: [replayController(tape.controllerIds[0], commands[0]), replayController(tape.controllerIds[1], commands[1])] });
}
const pilot = params.has('live') ? createConnectomePilot('connectome', parseCircuit(circuit), undefined, loadSomaPositions()) : null;
if (pilot) scene.brain(pilot.brain());
if (pilot) replay = createSession({ seed: 42, rules: DEMO_RULES, physics: DEMO_PHYSICS, names: ['FLY', 'BOT'], controllers: [pilot, createHeuristic('heuristic', 42 * 31 + 2)] });
const current = () => replay?.frame() ?? frame();
const step = () => { if (replay) replay.step(); else stepScript(); };
const skipSeconds = Math.max(0, Number(params.get('t') ?? 0));
for (let i = 0; i < Math.round(skipSeconds * HZ); i++) { step(); scene.update(current(), DT, false); }

const toggle = document.getElementById('toggle')!;
toggle.textContent = paused ? 'Play' : 'Pause';
toggle.addEventListener('click', () => { paused = !paused; toggle.textContent = paused ? 'Play' : 'Pause'; });
document.getElementById('step')!.addEventListener('click', () => { paused = true; toggle.textContent = 'Play'; step(); scene.update(current(), DT); });

let recorder: MediaRecorder | null = null;
const composite = params.has('capture') ? createComposite() : null;
if (composite) {
  stage.style.width = '960px'; stage.style.height = '720px'; scene.resize(960, 720);
  composite.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
  document.body.appendChild(composite.canvas);
}
if (params.has('capture')) {
  const chunks: Blob[] = [];
  recorder = new MediaRecorder((composite?.canvas ?? scene.canvas).captureStream(60), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 10_000_000 });
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.onstop = () => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const link = document.createElement('a'); link.href = reader.result; link.download = 'crud-fly-visual-candidate.webm'; link.textContent = 'Download clip';
      document.getElementById('controls')!.appendChild(link);
    };
    reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
  };
  recorder.start();
}
let last = performance.now();
let acc = 0;
const captureEnd = skipSeconds + Number(params.get('seconds') ?? 12);
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  while (acc >= DT) { if (!paused) step(); acc -= DT; }
  const f = current();
  scene.update(f, dt);
  composite?.draw(scene.canvas, f, {
    title: pilot ? 'Simulated neural activity' : 'Frozen hero replay', telemetry: pilot?.telemetry() ?? null,
    rulesInForce: rulesInForce(DEMO_RULES), totalRules: 47, startingLives: 3,
    logTail: f.log.filter(e => e.kind === 'life_lost' || e.kind === 'pocket' || e.kind === 'serve_fault' || e.kind === 'match_over').slice(-6).map(e => {
      if (e.kind === 'life_lost') return `LIFE LOST ${f.players[e.player].name}: ${e.reason.replace(/_/g, ' ')}`;
      if (e.kind === 'pocket') return `POCKET: ${e.ball} ball`;
      if (e.kind === 'serve_fault') return `SERVE FAULT ${f.players[e.player].name} (${e.attempt})`;
      return e.kind === 'match_over' ? `MATCH OVER: ${f.players[e.winner].name}` : '';
    }),
    finePrint: 'FLY is driven by the connectome pilot; BOT is a scripted heuristic with no brain. Real recorded connectivity (MaleCNS v1.0 subset, 1,072 neurons). Artificial game sensors, simplified dynamics, hand-designed decoder. Not a brain. Not learning. Rules are demo defaults.',
  });
  label.textContent = `tick ${f.tick}  phase ${f.players[0].fly.phase} ${f.players[0].fly.phaseT.toFixed(3)}s  log ${f.log.length}`;
  if (recorder?.state === 'recording' && (f.tick / HZ >= captureEnd || replay?.done())) { recorder.stop(); paused = true; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
