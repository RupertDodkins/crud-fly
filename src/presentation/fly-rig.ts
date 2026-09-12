/*
 * Ported from flyway-surfer `dist/scene.js` (MIT), shivareddy42/flyway-surfer commit d00e185:
 * the `mat`/`mesh`/`rod` helpers, the colour palette, `makeFly()` and the wing-beat / leg-gait
 * animation from `update()`. The railway world, swatter and sugar are not ported.
 */
import * as T from 'three';
import { loadFlybody } from './flybody';
import type { FlyPhase } from '../core/model';
import { STRIKE_REACH_M } from '../core/embodiment';

export const colors = {
  mint: 0x87c9b1,
  cream: 0xf8edc5,
  dark: 0x193e35,
  pink: 0xf34684,
  lime: 0xd9fd66,
  orange: 0xffa644,
} as const;

export const sphere = new T.SphereGeometry(1, 24, 16);
export const box = new T.BoxGeometry(1, 1, 1);
export const cylinder = new T.CylinderGeometry(1, 1, 1, 24);

export type Vec3Tuple = readonly [number, number, number];

const mats = new Map<string, T.MeshStandardMaterial>();

export function mat(color: number, rough = 0.55, metal = 0): T.MeshStandardMaterial {
  const key = `${color}-${rough}-${metal}`;
  let m = mats.get(key);
  if (!m) {
    m = new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    mats.set(key, m);
  }
  return m;
}

export function mesh(
  parent: T.Object3D,
  geo: T.BufferGeometry,
  material: number | T.Material,
  position: Vec3Tuple = [0, 0, 0],
  scale: Vec3Tuple = [1, 1, 1],
): T.Mesh {
  const m = new T.Mesh(geo, typeof material === 'number' ? mat(material) : material);
  m.position.set(...position);
  m.scale.set(...scale);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export function rod(parent: T.Object3D, a: Vec3Tuple, b: Vec3Tuple, r: number, color: number): T.Mesh {
  const va = new T.Vector3(...a);
  const vb = new T.Vector3(...b);
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  const m = mesh(parent, cylinder, color, [mid.x, mid.y, mid.z], [r, va.distanceTo(vb), r]);
  m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), vb.sub(va).normalize());
  return m;
}

/** Source-unit extents of the fly: nose-to-tail length and the height of the shoe soles above the group origin. */
const SOURCE_LENGTH = 1.9;
const SOURCE_FEET_Y = 0.058;

export interface FlyRig {
  /** Placed at the fly's feet on the cloth and rotated by heading. */
  readonly root: T.Group;
  /** Scaled child holding the geometry; crouch, lunge and hop are applied here. */
  readonly body: T.Group;
  readonly wings: readonly { readonly pivot: T.Group; readonly side: 1 | -1 }[];
  readonly legs: readonly { readonly leg: T.Group; readonly side: 1 | -1; readonly index: number }[];
  /** Body meshes recoloured by the life-lost flash. */
  readonly flashable: readonly T.Mesh[];
  readonly scale: number;
  readonly ready: () => boolean;
  readonly animateAnatomy: (pose: FlyPose) => void;
}

export function makeFly(lengthMetres: number, ballRadius = lengthMetres / 3.6, bodyColor = 0xae772d): FlyRig {
  const s = lengthMetres / SOURCE_LENGTH;
  const noseOffset = STRIKE_LUNGE - STRIKE_REACH_M + ballRadius;
  const root = new T.Group();
  const body = new T.Group();
  const g = new T.Group();
  body.add(g);
  // The engine root reaches the ball surface. Keep the visible nose behind it.
  g.position.z = 0.91 + noseOffset / s;
  body.scale.setScalar(s);
  body.position.y = -SOURCE_FEET_Y * s;
  root.add(body);
  const flashable: T.Mesh[] = [];
  const track = (m: T.Mesh): T.Mesh => {
    flashable.push(m);
    return m;
  };

  track(mesh(g, sphere, mat(0xa16824, 0.52), [0, 0.91, 0.27], [0.34, 0.33, 0.68]));
  track(mesh(g, sphere, mat(0xb7873c, 0.6), [0, 1.03, -0.3], [0.34, 0.37, 0.4]));
  track(mesh(g, sphere, mat(0xd4a557, 0.58), [0, 0.99, -0.65], [0.26, 0.27, 0.24]));
  const bristles: T.Vector3[] = [];
  for (let i = 0; i < 150; i++) {
    const theta = i * 2.399963;
    const z = 1 - 2 * (i + 0.5) / 150;
    const radial = Math.sqrt(1 - z * z);
    const n = new T.Vector3(radial * Math.cos(theta), Math.abs(radial * Math.sin(theta)), z);
    const base = new T.Vector3(n.x * 0.35, 1.02 + n.y * 0.36, -0.28 + n.z * 0.42);
    bristles.push(base, base.clone().addScaledVector(n, 0.065 + (i % 4) * 0.013));
  }
  g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(bristles), new T.LineBasicMaterial({ color: 0x4c351e })));
  for (const side of [-1, 1] as const) {
    const eye = mesh(g, sphere, mat(0xa62714, 0.44), [side * 0.235, 1.07, -0.67], [0.19, 0.25, 0.205]);
    const facets = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), mat(0xcb4226, 0.5), 180);
    const transform = new T.Object3D();
    for (let i = 0; i < 180; i++) {
      const y = 1 - 2 * (i + 0.5) / 180;
      const r = Math.sqrt(1 - y * y), theta = i * 2.399963;
      transform.position.set(r * Math.cos(theta), y, r * Math.sin(theta));
      transform.scale.setScalar(0.082);
      transform.updateMatrix(); facets.setMatrixAt(i, transform.matrix);
    }
    eye.add(facets);
    rod(g, [side * 0.09, 1.08, -0.85], [side * 0.16, 1.14, -0.96], 0.018, 0x9a6e31);
    rod(g, [side * 0.16, 1.14, -0.96], [side * 0.23, 1.33, -0.97], 0.004, 0x483322);
  }
  for (let i = 0; i < 5; i++) {
    const z = 0.13 + i * 0.15;
    const radius = Math.sqrt(1 - ((z - 0.27) / 0.68) ** 2);
    mesh(g, new T.TorusGeometry(1, 0.027, 5, 40), 0x68411e, [0, 0.91, z], [0.342 * radius, 0.332 * radius, 0.3]);
  }

  const wings: { pivot: T.Group; side: 1 | -1 }[] = [];
  const wingMat = new T.MeshPhysicalMaterial({
    color: 0xe2ddd0,
    transparent: true,
    opacity: 0.32,
    roughness: 0.25,
    metalness: 0.08,
    side: T.DoubleSide,
    depthWrite: false,
  });
  for (const side of [-1, 1] as const) {
    const pivot = new T.Group();
    pivot.position.set(side * 0.17, 1.42, 0.1);
    g.add(pivot);
    const wing = mesh(pivot, sphere, wingMat, [side * 0.61, 0, 0.48], [0.34, 0.008, 0.85]);
    wing.rotation.y = side * 0.6;
    wing.castShadow = false;
    for (let j = 0; j < 5; j++) {
      const geometry = new T.BufferGeometry().setFromPoints([
        new T.Vector3(0, 0.044, 0),
        new T.Vector3(side * (0.2 + j * 0.12), 0.045, 0.58),
        new T.Vector3(side * (0.35 + j * 0.23), 0.046, 1.1),
      ]);
      pivot.add(new T.Line(geometry, new T.LineBasicMaterial({ color: 0x8b7856, transparent: true, opacity: 0.6 })));
    }
    wings.push({ pivot, side });
  }

  const legs: { leg: T.Group; side: 1 | -1; index: number }[] = [];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      const leg = new T.Group();
      leg.position.set(side * 0.32, 0.95, (i - 1) * 0.38);
      g.add(leg);
      const z = (i - 1) * 0.26;
      rod(leg, [0, 0, 0], [side * 0.35, -0.31, z], 0.026, 0xb68538);
      rod(leg, [side * 0.35, -0.31, z], [side * 0.53, -0.79, z + 0.17], 0.016, 0x9d712e);
      mesh(leg, sphere, 0x50371e, [side * 0.55, -0.88, z + 0.14], [0.027, 0.012, 0.09]);
      rod(leg, [side * 0.53, -0.79, z + 0.17], [side * 0.55, -0.88, z + 0.1], 0.01, 0x775026);
      legs.push({ leg, side, index: i });
    }
  }

  let anatomy: Awaited<ReturnType<typeof loadFlybody>> | undefined;
  if (typeof document !== 'undefined') {
    void loadFlybody(bodyColor).then(loaded => {
      anatomy = loaded;
      loaded.group.position.z += noseOffset / s;
      body.add(loaded.group);
      g.visible = false;
      loaded.group.traverse(node => { if (node instanceof T.Mesh) flashable.push(node); });
    }).catch(error => console.error('FlyBody asset could not load; showing procedural fly.', error));
  }
  return { root, body, wings, legs, flashable, scale: s, ready: () => !!anatomy,
    animateAnatomy: pose => anatomy?.animate(pose) };

}

export interface FlyPose {
  readonly phase: FlyPhase;
  readonly carrying?: boolean;
  readonly phaseT: number;
  /** Ground speed in m/s, estimated by the caller from successive frames. */
  readonly speed: number;
  /** Scene-wide elapsed seconds driving the oscillators. */
  readonly t: number;
  readonly dt: number;
}

const STRIKE_LUNGE = 0.03;
const RECOVER_HOP = 0.012;
const RECOVER_DURATION = 0.25;

export function animateFly(rig: FlyRig, pose: FlyPose): void {
  const { phase, phaseT, t } = pose;
  const walking = phase === 'approach';
  rig.animateAnatomy(pose);
  const excited = phase === 'approach' || phase === 'strike';

  for (const { pivot, side } of rig.wings) {
    pivot.rotation.z = side * (Math.sin(t * (excited ? 95 : 70)) * 0.23 - 0.1);
    pivot.rotation.y = side * 0.13;
  }

  const gait = walking ? Math.min(1, phaseT / 0.1) : 0;
  for (const { leg, side, index } of rig.legs) {
    const ph = phaseT * 25 + (index % 2 === 0 ? 0 : Math.PI) + (side === 1 ? Math.PI : 0);
    leg.rotation.set(0, Math.sin(ph) * 0.28 * gait, 0);
    leg.position.y = 0.95 + Math.max(0, Math.cos(ph)) * 0.12 * gait;
  }

  const s = rig.scale;
  const ease = (x: number) => { const k = T.MathUtils.clamp(x, 0, 1); return k * k * (3 - 2 * k); };
  const crouch = phase === 'aim' ? 1 - 0.15 * ease(phaseT / 0.12)
    : phase === 'strike' ? 0.85 + 0.15 * ease(phaseT / 0.12) : 1;
  rig.body.scale.y = s * crouch;
  const lunge = phase === 'strike' ? STRIKE_LUNGE * ease(phaseT / 0.1)
    : phase === 'recover' ? STRIKE_LUNGE * (1 - ease(phaseT / RECOVER_DURATION)) : 0;
  rig.body.position.z = -lunge;
  const hop = phase === 'recover' ? RECOVER_HOP * Math.sin(Math.PI * Math.min(phaseT / RECOVER_DURATION, 1)) : 0;
  rig.body.position.y = -SOURCE_FEET_Y * rig.body.scale.y + hop;
}
