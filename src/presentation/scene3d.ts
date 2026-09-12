/*
 * Renderer, lighting, shadow and particle-burst setup ported from flyway-surfer `dist/scene.js` (MIT),
 * shivareddy42/flyway-surfer commit d00e185. The fly rig and helpers live in ./fly-rig.ts; the railway
 * world is replaced by the pool table in ./table.ts.
 */
import * as T from 'three';
import type { BrainView } from '../controllers/connectome-pilot';
import { createNeuralActivity } from './neural-activity';
import type { Frame, PlayerId, RuleEvent, Table, Vec2 } from '../core/model';
import { animateFly, box, colors, makeFly, mat, mesh, sphere, type FlyRig } from './fly-rig';
import { buildTable, FLOOR_COLOR } from './table';

/**
 * Three.js diorama: table plus flies ported from flyway-surfer `dist/scene.js` (MIT):
 * makeFly() geometry, wing/leg animation, palette, lighting, shadow and camera setup.
 * Reads Frame only. Never holds the live MatchState.
 */
export interface Scene3D {
  brain(view: BrainView): void;
  update(frame: Frame, dt: number, render?: boolean): void;
  resize(w: number, h: number): void;
  readonly canvas: HTMLCanvasElement;
}

export interface ScenePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Game top-down (x along the table, y across) to scene space (x along, y up, z across) at ball-centre height. */
export function toScene(v: Vec2, table: Table): ScenePoint {
  return { x: v.x, y: table.ballRadius, z: v.y };
}

/** The fly faces local -z; heading 0 in game space points along +x. */
export function headingToRotationY(heading: number): number {
  return -heading - Math.PI / 2;
}

const FLY_LENGTH_IN_BALL_RADII = 3.6;
// Steep enough that a fly standing on the near side of the cue ball does not hide it.
const CAMERA_ELEVATION = (55 * Math.PI) / 180;
const CAMERA_DISTANCE = 5;
const FRAME_MARGIN = 0.16;
const EFFECT_WINDOW_TICKS = 6;
const FLASH_SECONDS = 0.3;
const DEFAULT_TABLE = { length: 2.54, width: 1.27 };

interface Particle {
  readonly mesh: T.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

interface FlyActor {
  readonly rig: FlyRig;
  prev: Vec2 | null;
  speed: number;
  flash: number;
}

export function createScene3D(container: HTMLElement, detail = false): Scene3D {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.VSMShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.07;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  container.appendChild(canvas);

  let neural: ReturnType<typeof createNeuralActivity> | undefined;
  let neuralTexture: T.CanvasTexture | undefined;
  const overlay = new T.Scene();
  const statusCanvas = document.createElement('canvas');
  statusCanvas.width = 600; statusCanvas.height = 350;
  const statusContext = statusCanvas.getContext('2d')!;
  const statusTexture = new T.CanvasTexture(statusCanvas);
  statusTexture.colorSpace = T.SRGBColorSpace;
  const statusSprite = new T.Sprite(new T.SpriteMaterial({ map: statusTexture, depthTest: false, toneMapped: false }));
  overlay.add(statusSprite);
  function drawStatus(frame: Frame): void {
    const { turn } = frame;
    let title: string, action: string;
    if (turn.kind === 'serve' || turn.kind === 'awaiting_shot') {
      const player = frame.players[turn.shooter];
      title = `${player.name}'S TURN`;
      action = player.fly.phase === 'strike' ? 'Throwing cue' : player.fly.phase === 'aim' ? 'Aiming'
        : player.fly.carrying ? 'Cue ball in hand' : 'Retrieving cue';
    } else if (turn.kind === 'in_play') {
      title = 'BALL IN PLAY'; action = `${frame.players[turn.lastShooter].name} threw`;
    } else if (turn.kind === 'over') {
      title = 'MATCH OVER'; action = `${frame.players[turn.winner].name} wins`;
    } else {
      title = 'RESETTING'; action = turn.outcome.kind === 'life_lost' ? 'Life lost' : 'Next turn';
    }
    statusContext.clearRect(0, 0, 600, 350);
    statusContext.fillStyle = '#25372f';
    statusContext.font = 'bold 42px Menlo, Consolas, monospace'; statusContext.fillText(title, 8, 65);
    statusContext.font = '29px Menlo, Consolas, monospace'; statusContext.fillText(action, 8, 115);
    statusContext.font = '23px Menlo, Consolas, monospace';
    statusContext.fillText('Close-up: FLY', 8, 235);
    statusContext.fillText('FLY amber / BOT blue', 8, 278);
    statusTexture.needsUpdate = true;
  }

  const detailCamera = new T.OrthographicCamera(-0.1, 0.1, 0.065, -0.065, 0.01, 2);
  const overlayCamera = new T.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const neuralSprite = new T.Sprite(new T.SpriteMaterial({ depthTest: false }));
  overlay.add(neuralSprite);
  function brain(view: BrainView): void {
    neuralTexture?.dispose();
    neural = createNeuralActivity(view);
    neuralTexture = new T.CanvasTexture(neural.canvas);
    neuralTexture.colorSpace = T.SRGBColorSpace;
    neuralSprite.material.map = neuralTexture;
    neuralSprite.material.needsUpdate = true;
    resize(container.clientWidth, container.clientHeight);
  }
  const scene = new T.Scene();
  scene.background = new T.Color(FLOOR_COLOR);

  scene.add(new T.HemisphereLight(0xfff6e8, 0x727978, 2.1));
  const sun = new T.DirectionalLight(0xffeed5, 1.9);
  sun.position.set(-0.7, 4.0, -0.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.blurSamples = 8;
  sun.shadow.radius = 4;
  Object.assign(sun.shadow.camera, { left: -1.9, right: 1.9, top: 1.5, bottom: -1.5, near: 0.5, far: 8 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.002;
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);
  const rim = new T.DirectionalLight(0xe3edff, 0.65);
  rim.position.set(0.8, 0.8, 0.8);
  scene.add(rim);

  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  camera.position.set(0, Math.sin(CAMERA_ELEVATION) * CAMERA_DISTANCE, Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);

  let aspect = 1;
  let tableDims: { length: number; width: number } = DEFAULT_TABLE;

  function frameCamera(): void {
    const azimuth = (aspect < 1 ? 62 : 10) * Math.PI / 180;
    camera.position.set(Math.sin(azimuth) * Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE,
      Math.sin(CAMERA_ELEVATION) * CAMERA_DISTANCE, Math.cos(azimuth) * Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const right = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [-0.65, 0.13]) {
      const corner = new T.Vector3(x * (tableDims.length / 2 + 0.08), y, z * (tableDims.width / 2 + 0.08));
      const px = corner.dot(right), py = corner.dot(up);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const hw = Math.max((maxX - minX) / 2 + FRAME_MARGIN / 2, ((maxY - minY) / 2 + FRAME_MARGIN / 2) * aspect);
    const hh = hw / aspect;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camera.left = cx - hw; camera.right = cx + hw;
    camera.top = cy + hh; camera.bottom = cy - hh;
    camera.updateProjectionMatrix();
  }

  const numberCanvas = document.createElement('canvas');
  numberCanvas.width = numberCanvas.height = 128;
  const numberContext = numberCanvas.getContext('2d')!;
  numberContext.fillStyle = '#f8edc5';
  numberContext.beginPath(); numberContext.arc(64, 64, 60, 0, Math.PI * 2); numberContext.fill();
  numberContext.fillStyle = '#15191b'; numberContext.font = 'bold 92px sans-serif';
  numberContext.textAlign = 'center'; numberContext.textBaseline = 'middle'; numberContext.fillText('8', 64, 68);
  const numberTexture = new T.CanvasTexture(numberCanvas);
  numberTexture.colorSpace = T.SRGBColorSpace;

  let tableKey = '';
  let tableGroup: T.Group | null = null;
  const flies: FlyActor[] = [];
  const balls = {
    cue: mesh(scene, sphere, mat(colors.cream, 0.25, 0.05)),
    object: mesh(scene, sphere, mat(0x15191b, 0.25, 0.05)),
  };
  const numberPatch = mesh(balls.object, new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: numberTexture, transparent: true }), [0, 1.006, 0], [0.85, 0.85, 1]);
  numberPatch.rotation.x = -Math.PI / 2;
  numberPatch.castShadow = false;

  const aimLine = mesh(scene, box, new T.MeshStandardMaterial({ color: colors.lime, emissive: colors.lime, emissiveIntensity: 0.4, roughness: 1 }));
  aimLine.castShadow = false;
  aimLine.visible = false;

  function ensureWorld(table: Table): void {
    const key = `${table.length}|${table.width}|${table.ballRadius}|${table.pocketRadius}|${table.pockets.length}`;
    if (key === tableKey) return;
    tableKey = key;
    tableDims = { length: table.length, width: table.width };
    if (tableGroup) scene.remove(tableGroup);
    tableGroup = buildTable(table);
    scene.add(tableGroup);
    for (const f of flies) scene.remove(f.rig.root);
    flies.length = 0;
    for (let i = 0; i < 2; i++) {
      const rig = makeFly(table.ballRadius * FLY_LENGTH_IN_BALL_RADII, table.ballRadius, i === 0 ? 0xae772d : 0x526b82);
      scene.add(rig.root);
      flies.push({ rig, prev: null, speed: 0, flash: 0 });
    }
    for (const b of [balls.cue, balls.object]) b.scale.setScalar(table.ballRadius);
    frameCamera();
  }

  const particlePool: T.Mesh[] = [];
  const particles: Particle[] = [];
  function burst(x: number, y: number, z: number, color: number, count = 9): void {
    for (let i = 0; i < count; i++) {
      const m = particlePool.pop() ?? mesh(scene, box, color);
      m.material = mat(color);
      m.position.set(x, y, z);
      m.scale.setScalar(0.012);
      m.castShadow = false;
      scene.add(m);
      particles.push({ mesh: m, vx: (((i * 0.61803398875 + x * 0.37 + z * 0.13) % 1 + 1) % 1 - 0.5) * 0.6, vy: 0.35 + (i % 5) / 5 * 0.45, vz: (((i * 0.38196601125 + z * 0.29) % 1 + 1) % 1 - 0.5) * 0.6, life: 0.65 });
    }
  }
  function stepParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= dt;
      p.vy -= dt * 1.8;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.x += dt * 5;
      p.mesh.rotation.z += dt * 7;
      p.mesh.scale.setScalar(Math.max(0.0001, 0.025 * p.life));
      if (p.life <= 0) {
        scene.remove(p.mesh);
        particlePool.push(p.mesh);
        particles.splice(i, 1);
      }
    }
  }

  let observedEvents = 0;
  function fireEffects(frame: Frame): void {
    if (frame.log.length < observedEvents) observedEvents = 0;
    for (const event of frame.log.slice(observedEvents)) {
      if (frame.tick - event.tick <= EFFECT_WINDOW_TICKS) applyEffect(frame, event);
    }
    observedEvents = frame.log.length;
  }
  function applyEffect(frame: Frame, e: RuleEvent): void {
    switch (e.kind) {
      case 'legal_shot': {
        const pos = e.pos ?? frame.cue.pos;
        burst(pos.x, frame.table.ballRadius, pos.y, colors.lime, 18);
        break;
      }
      case 'contact': {
        const p = toScene(e.pos ?? frame.cue.pos, frame.table);
        burst(p.x, p.y, p.z, colors.cream, 12);
        break;
      }
      case 'pocket': {
        const ball = e.ball === 'cue' ? frame.cue : frame.object;
        const p = toScene(e.pos ?? ball.pos, frame.table);
        burst(p.x, p.y, p.z, colors.orange, 14);
        break;
      }
      case 'life_lost': {
        const f = flies[e.player];
        if (f) f.flash = FLASH_SECONDS;
        break;
      }
      default:
        break;
    }
  }

  const pinkFlash = mat(colors.pink, 0.4);
  const originalMats = new WeakMap<T.Mesh, T.Material | T.Material[]>();
  function applyFlash(f: FlyActor): void {
    const on = f.flash > 0;
    for (const m of f.rig.flashable) {
      if (on) {
        if (!originalMats.has(m)) originalMats.set(m, m.material);
        m.material = pinkFlash;
      } else {
        const orig = originalMats.get(m);
        if (orig) {
          m.material = orig;
          originalMats.delete(m);
        }
      }
    }
  }

  function placeBall(m: T.Mesh, ball: Frame['cue'], table: Table): void {
    m.visible = !ball.pocketed;
    const p = toScene(ball.pos, table);
    m.position.set(p.x, p.y, p.z);
  }

  let previousTick = -1;

  let lastRenderKey = '';
  function update(frame: Frame, dt: number, render = true): void {
    const key = `${frame.tick}:${frame.log.length}:${flies.filter(f => f.rig.ready()).length}:${neural?.ready()}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    const elapsed = frame.tick / 120;
    dt = previousTick < 0 ? 0 : Math.max(0, (frame.tick - previousTick) / 120);
    if (frame.tick < previousTick) {
      for (const p of particles) { scene.remove(p.mesh); particlePool.push(p.mesh); }
      particles.length = 0;
      for (const f of flies) { f.prev = null; f.speed = 0; f.flash = 0; }
      observedEvents = 0;
    }
    previousTick = frame.tick;
    ensureWorld(frame.table);
    const { table } = frame;

    placeBall(balls.cue, frame.cue, table);
    placeBall(balls.object, frame.object, table);

    aimLine.visible = false;
    for (let i = 0; i < 2; i++) {
      const player = frame.players[i as PlayerId];
      const actor = flies[i];
      if (!actor) continue;
      const fly = player.fly;
      if (actor.prev && dt > 0) {
        const d = Math.hypot(fly.pos.x - actor.prev.x, fly.pos.y - actor.prev.y);
        actor.speed += (d / dt - actor.speed) * (1 - Math.exp(-10 * dt));
      }
      actor.prev = fly.pos;
      actor.rig.root.position.set(fly.pos.x, 0, fly.pos.y);
      actor.rig.root.rotation.y = headingToRotationY(fly.heading);
      animateFly(actor.rig, { phase: fly.phase, phaseT: fly.phaseT, carrying: fly.carrying ?? false, speed: actor.speed, t: elapsed, dt });
      actor.flash = Math.max(0, actor.flash - dt);
      applyFlash(actor);

      if (fly.phase === 'aim' && fly.shot && !frame.cue.pocketed) {
        const len = 0.12 + fly.shot.force * 0.45;
        const p = toScene(frame.cue.pos, table);
        aimLine.visible = true;
        aimLine.scale.set(len, 0.003, 0.006);
        aimLine.position.set(p.x + Math.cos(fly.shot.angle) * len / 2, 0.003, p.z + Math.sin(fly.shot.angle) * len / 2);
        aimLine.rotation.y = -fly.shot.angle;
      }
    }

    fireEffects(frame);
    stepParticles(dt);
    if (!render) { lastRenderKey = ''; return; }
    if (detail && flies[0]) {
      const target = new T.Box3().setFromObject(flies[0].rig.body).getCenter(new T.Vector3());
      camera.position.copy(target).add(new T.Vector3(0.24, 0.14, 0.25));
      camera.lookAt(target);
      camera.left = -0.15 * aspect; camera.right = 0.15 * aspect;
      camera.top = 0.15; camera.bottom = -0.15;
      camera.updateProjectionMatrix();
    }
    const band = neural && !detail ? Math.min(240, canvas.clientWidth * 0.34) * 350 / 600 + 28 : 0;
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight - band);
    renderer.render(scene, camera);
    if (neural && !detail && flies[0]) {
      const width = Math.min(240, canvas.clientWidth * 0.34);
      const left = width + 30, bottom = canvas.clientHeight - band + 12;
      const height = band - 24;
      const target = new T.Vector3(0, 0.028, 0.055).applyQuaternion(flies[0].rig.root.quaternion).add(flies[0].rig.root.position);
      detailCamera.position.copy(target).add(new T.Vector3(0.16, 0.09, 0.17));
      detailCamera.lookAt(target);
      detailCamera.left = -0.065 * width / height; detailCamera.right = 0.065 * width / height;
      detailCamera.updateProjectionMatrix();
      renderer.setViewport(left, bottom, width, height);
      renderer.setScissor(left, bottom, width, height);
      renderer.setScissorTest(true);
      renderer.render(scene, detailCamera);
      renderer.setScissorTest(false);
    }
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (neural && neuralTexture) {
      drawStatus(frame);
      const statusLeft = Math.min(240, canvas.clientWidth * 0.34) * 2 + 50;
      const statusWidth = Math.min(300, canvas.clientWidth - statusLeft - 10);
      statusSprite.visible = statusWidth > 90;
      statusSprite.scale.set(statusWidth / canvas.clientWidth, statusWidth * 350 / 600 / canvas.clientHeight, 1);
      statusSprite.position.set((statusLeft + statusWidth / 2) / canvas.clientWidth, 0.98 - statusWidth * 350 / 600 / canvas.clientHeight / 2, 0);
      neural.draw();
      neuralTexture.needsUpdate = true;
      const width = Math.min(240, canvas.clientWidth * 0.34);
      const w = width / canvas.clientWidth, h = width * 350 / 600 / canvas.clientHeight;
      neuralSprite.scale.set(w, h, 1);
      neuralSprite.position.set(0.018 + w / 2, 0.98 - h / 2, 0);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, overlayCamera);
      renderer.autoClear = true;
    }
  }

  function resize(w: number, h: number): void {
    if (w < 1 || h < 1) return;
    lastRenderKey = '';
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const band = neural && !detail ? Math.min(240, w * 0.34) * 350 / 600 + 28 : 0;
    aspect = w / Math.max(1, h - band);
    frameCamera();
  }

  const rect = container.getBoundingClientRect();
  resize(rect.width || 1, rect.height || 1);
  new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    resize(r.width, r.height);
  }).observe(container);

  return { update, resize, canvas, brain };
}
