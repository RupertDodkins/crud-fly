/*
 * Renderer, lighting, shadow and particle-burst setup ported from flyway-surfer `dist/scene.js` (MIT),
 * shivareddy42/flyway-surfer commit d00e185. The fly rig and helpers live in ./fly-rig.ts; the railway
 * world is replaced by the pool table in ./table.ts.
 */
import * as T from 'three';
import type { Frame, PlayerId, RuleEvent, Table, Vec2 } from '../core/model';
import { animateFly, box, colors, makeFly, mat, mesh, sphere, type FlyRig } from './fly-rig';
import { buildTable } from './table';

/**
 * Three.js diorama: table plus flies ported from flyway-surfer `dist/scene.js` (MIT):
 * makeFly() geometry, wing/leg animation, palette, lighting, shadow and camera setup.
 * Reads Frame only. Never holds the live MatchState.
 */
export interface Scene3D {
  update(frame: Frame, dt: number): void;
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

const FLY_LENGTH_IN_BALL_RADII = 3;
// Steep enough that a fly standing on the near side of the cue ball does not hide it.
const CAMERA_ELEVATION = (66 * Math.PI) / 180;
const CAMERA_DISTANCE = 5;
const FRAME_MARGIN = 0.2;
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

export function createScene3D(container: HTMLElement): Scene3D {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.07;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const scene = new T.Scene();
  scene.background = new T.Color(colors.mint);

  scene.add(new T.HemisphereLight(0xd9f4ff, 0x8582ab, 1.85));
  const sun = new T.DirectionalLight(0xffe6b5, 3.0);
  sun.position.set(-1.4, 2.7, -2.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1.9, right: 1.9, top: 1.5, bottom: -1.5, near: 0.5, far: 8 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);
  const rim = new T.DirectionalLight(0xbbe7ff, 1.1);
  rim.position.set(0.8, 0.8, 0.8);
  scene.add(rim);

  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  camera.position.set(0, Math.sin(CAMERA_ELEVATION) * CAMERA_DISTANCE, Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);

  let aspect = 1;
  let tableDims: { length: number; width: number } = DEFAULT_TABLE;

  function frameCamera(): void {
    const halfL = tableDims.length / 2 + FRAME_MARGIN;
    const halfW = tableDims.width / 2 + FRAME_MARGIN;
    // Vertical extent of the tilted table on screen plus headroom for the flies and rails.
    const needH = halfW * Math.sin(CAMERA_ELEVATION) + 0.12;
    const hw = Math.max(halfL, needH * aspect);
    const hh = hw / aspect;
    camera.left = -hw;
    camera.right = hw;
    camera.top = hh;
    camera.bottom = -hh;
    camera.updateProjectionMatrix();
  }

  let tableKey = '';
  let tableGroup: T.Group | null = null;
  const flies: FlyActor[] = [];
  const balls = {
    cue: mesh(scene, sphere, mat(colors.cream, 0.25, 0.05)),
    object: mesh(scene, sphere, mat(colors.pink, 0.25, 0.05)),
  };
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
      const rig = makeFly(table.ballRadius * FLY_LENGTH_IN_BALL_RADII);
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
      m.scale.setScalar(0.006);
      m.castShadow = false;
      scene.add(m);
      particles.push({ mesh: m, vx: (Math.random() - 0.5) * 0.6, vy: 0.35 + Math.random() * 0.45, vz: (Math.random() - 0.5) * 0.6, life: 0.65 });
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
      p.mesh.scale.setScalar(Math.max(0.0001, 0.009 * p.life));
      if (p.life <= 0) {
        scene.remove(p.mesh);
        particlePool.push(p.mesh);
        particles.splice(i, 1);
      }
    }
  }

  let lastEffectTick = -1;
  function fireEffects(frame: Frame): void {
    if (frame.tick < lastEffectTick) lastEffectTick = -1;
    const tail = frame.log.slice(-8);
    let newest = lastEffectTick;
    for (const e of tail) {
      if (e.tick <= lastEffectTick || frame.tick - e.tick > EFFECT_WINDOW_TICKS) continue;
      newest = Math.max(newest, e.tick);
      applyEffect(frame, e);
    }
    lastEffectTick = newest;
  }
  function applyEffect(frame: Frame, e: RuleEvent): void {
    switch (e.kind) {
      case 'contact': {
        const p = toScene(frame.cue.pos, frame.table);
        burst(p.x, p.y, p.z, colors.cream, 12);
        break;
      }
      case 'pocket': {
        const ball = e.ball === 'cue' ? frame.cue : frame.object;
        const p = toScene(ball.pos, frame.table);
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

  let elapsed = 0;

  function update(frame: Frame, dt: number): void {
    elapsed += dt;
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
      animateFly(actor.rig, { phase: fly.phase, phaseT: fly.phaseT, speed: actor.speed, t: elapsed, dt });
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
    renderer.render(scene, camera);
  }

  function resize(w: number, h: number): void {
    if (w < 1 || h < 1) return;
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    aspect = w / h;
    frameCamera();
  }

  const rect = container.getBoundingClientRect();
  resize(rect.width || 1, rect.height || 1);
  new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    resize(r.width, r.height);
  }).observe(container);

  return { update, resize, canvas };
}
