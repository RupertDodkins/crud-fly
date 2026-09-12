import type { Controller, Frame } from './core/model';
import { DEMO_RULES, rulesInForce } from './core/rules';
import { DEMO_PHYSICS, DT } from './core/physics';
import { createSession } from './core/session';
import { createHeuristic } from './controllers/heuristic';
import { createConnectomePilot, parseCircuit, type BrainView } from './controllers/connectome-pilot';
import circuitJson from './brain/flight-v1.json';
import { loadSomaPositions } from './brain/positions';
import { drawDebug } from './presentation/debug2d';
import { createScene3D } from './presentation/scene3d';
import { createComposite, type HudData } from './presentation/composite';

// Watch mode. ?brain=0 uses heuristic vs heuristic (Phase 1 preview). ?view=2d uses the debug canvas.
// ?seed=N picks the match. ?record=1 starts a WebM capture of the stage and offers it as a download when the match ends.

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 7);
const useBrain = params.get('brain') !== '0';
const view2d = params.get('view') === '2d';
const record = params.get('record') === '1';
const recordSeconds = Number(params.get('seconds') ?? 0);
const FINE_PRINT = 'FLY is driven by the connectome pilot; BOT is a scripted heuristic with no brain. Real recorded connectivity (MaleCNS v1.0 subset, 1,072 neurons). Artificial game sensors, simplified dynamics, hand-designed decoder. Not a brain. Not learning. Rules are demo defaults.';

const stage = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;

const heuristic = (id: string, s: number) => createHeuristic(id, s);
const pilot = useBrain ? createConnectomePilot('connectome', parseCircuit(circuitJson), undefined, loadSomaPositions()) : null;
const controllers: [Controller, Controller] = [pilot ?? heuristic('heuristic-a', seed * 31 + 1), heuristic('heuristic-b', seed * 31 + 2)];

const session = createSession({
  seed,
  rules: DEMO_RULES,
  physics: DEMO_PHYSICS,
  controllers,
  names: ['FLY', 'BOT'],
});

let canvas: HTMLCanvasElement;
let render: (frame: Frame, dt: number) => void;
if (view2d) {
  canvas = document.createElement('canvas');
  stage.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const fit = () => {
    canvas.width = stage.clientWidth * devicePixelRatio;
    canvas.height = stage.clientHeight * devicePixelRatio;
  };
  fit();
  addEventListener('resize', fit);
  render = (frame) => drawDebug(ctx, frame, pilot?.telemetry());
} else {
  const scene = createScene3D(stage);
  canvas = scene.canvas;
  // Optional presentation hook: if the scene exposes `brain(view)`, it receives the read-only per-neuron view once.
  // The view has neuron IDs, live rates and real MaleCNS soma positions (view.soma); see positions-provenance.json.
  const withBrain = scene as unknown as { brain?: (view: BrainView) => void };
  if (pilot && typeof withBrain.brain === 'function') withBrain.brain(pilot.brain());
  addEventListener('resize', () => scene.resize(stage.clientWidth, stage.clientHeight));
  render = (frame, dt) => scene.update(frame, dt);
}

const totalRules = 47;
function logTail(frame: Frame): string[] {
  return frame.log
    .filter((e) => e.kind === 'life_lost' || e.kind === 'pocket' || e.kind === 'serve_fault' || e.kind === 'match_over')
    .slice(-6)
    .map((e) => {
      if (e.kind === 'life_lost') return `LIFE LOST ${frame.players[e.player].name}: ${e.reason.replace(/_/g, ' ')}`;
      if (e.kind === 'pocket') return `POCKET: ${e.ball} ball`;
      if (e.kind === 'serve_fault') return `SERVE FAULT ${frame.players[e.player].name} (${e.attempt})`;
      return `MATCH OVER: ${frame.players[e.winner].name}`;
    });
}

function hudData(frame: Frame): HudData {
  return {
    title: useBrain ? 'Simulated neural activity' : 'Heuristic controller',
    telemetry: pilot?.telemetry() ?? null,
    rulesInForce: rulesInForce(DEMO_RULES),
    totalRules,
    startingLives: DEMO_RULES.startingLives,
    logTail: logTail(frame),
    finePrint: FINE_PRINT,
  };
}

function renderHud(frame: Frame): void {
  const t = pilot?.telemetry();
  const [a, b] = frame.players;
  const lives = (n: number) => '●'.repeat(n) + '○'.repeat(Math.max(0, DEMO_RULES.startingLives - n));
  const tail = logTail(frame);
  const fired = new Set(frame.log.filter((e) => e.kind === 'life_lost').map((e) => e.reason)).size;
  const rows: string[] = [];
  rows.push(`<h1>${useBrain ? 'SIMULATED NEURAL ACTIVITY' : 'HEURISTIC CONTROLLER'}</h1>`);
  if (t) {
    rows.push(`<div class="big">${t.dnLeft.toFixed(2)} <small>DN LEFT</small></div>`);
    rows.push(`<div class="big">${t.dnRight.toFixed(2)} <small>DN RIGHT</small></div>`);
    rows.push(`<div>steer ${(t.angleOffset * (180 / Math.PI)).toFixed(1)}° · force ${t.force.toFixed(2)}</div>`);
    rows.push(`<div>${t.neuronCount} neurons · ${t.edgeCount} edges · activity ${t.activity.toFixed(1)}</div>`);
  }
  rows.push(`<h2>${a.name} ${lives(a.lives)} &nbsp; ${lives(b.lives)} ${b.name}</h2>`);
  rows.push(`<div>RULES IN FORCE: ${rulesInForce(DEMO_RULES)} / ${totalRules} · fired ${fired}</div>`);
  rows.push(`<ul>${tail.map((l) => `<li>${l}</li>`).join('')}</ul>`);
  rows.push(`<p class="fine">${FINE_PRINT}</p>`);
  hud.innerHTML = rows.join('');
}

let recorder: MediaRecorder | null = null;
let composite: ReturnType<typeof createComposite> | null = null;
const chunks: Blob[] = [];
async function save(name: string, body: Blob): Promise<void> {
  const res = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  console.log('saved', await res.text());
}
if (record) {
  composite = createComposite();
  recorder = new MediaRecorder(composite.canvas.captureStream(60), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    void save(`crud-fly-seed${seed}.webm`, new Blob(chunks, { type: 'video/webm' }));
    void save(`hero-seed${seed}.json`, new Blob([JSON.stringify(session.tape())], { type: 'application/json' }));
  };
  recorder.start();
}

let last = performance.now();
let acc = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  while (acc >= DT && !session.done()) {
    session.step();
    acc -= DT;
  }
  const frame = session.frame();
  render(frame, dt);
  renderHud(frame);
  composite?.draw(canvas, frame, hudData(frame));
  const cutoff = recordSeconds > 0 && frame.tick * DT >= recordSeconds;
  if (session.done() || cutoff) {
    if (recorder?.state === 'recording') recorder.stop();
    if (session.done()) return;
    if (cutoff) return;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
