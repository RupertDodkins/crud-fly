/*
 * Ported from flyway-surfer `dist/scene.js` (MIT), shivareddy42/flyway-surfer commit d00e185:
 * the `mat`/`mesh`/`rod` helpers, the colour palette, `makeFly()` and the wing-beat / leg-gait
 * animation from `update()`. The railway world, swatter and sugar are not ported.
 */
import * as T from 'three';
import type { FlyPhase } from '../core/model';

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
}

export function makeFly(lengthMetres: number): FlyRig {
  const s = lengthMetres / SOURCE_LENGTH;
  const root = new T.Group();
  const g = new T.Group();
  g.scale.setScalar(s);
  g.position.y = -SOURCE_FEET_Y * s;
  root.add(g);
  const flashable: T.Mesh[] = [];
  const track = (m: T.Mesh): T.Mesh => {
    flashable.push(m);
    return m;
  };

  track(mesh(g, sphere, mat(0x304d40, 0.3, 0.4), [0, 0.97, 0.23], [0.46, 0.48, 0.73]));
  track(mesh(g, sphere, mat(0x445d41, 0.32, 0.45), [0, 1.12, -0.37], [0.47, 0.43, 0.45]));
  track(mesh(g, sphere, 0x476f43, [0, 1.03, -0.65], [0.35, 0.32, 0.26]));
  for (const side of [-1, 1] as const) {
    track(mesh(g, sphere, mat(0xd92657, 0.2, 0.22), [side * 0.37, 1.21, -0.52], [0.3, 0.35, 0.32]));
    mesh(g, sphere, mat(0xff9dac, 0.16), [side * 0.5, 1.37, -0.66], [0.075, 0.12, 0.045]);
    mesh(g, sphere, 0xfff7dd, [side * 0.5, 1.43, -0.64], [0.03, 0.055, 0.025]);
    rod(g, [side * 0.19, 1.48, -0.65], [side * 0.29, 1.72, -0.79], 0.023, 0x172e27);
    mesh(g, sphere, 0x152e26, [side * 0.29, 1.72, -0.79], [0.05, 0.045, 0.04]);
  }
  for (let i = 0; i < 4; i++) {
    const line = mesh(g, new T.TorusGeometry(0.39, 0.018, 5, 32), 0x1d352a, [0, 0.93, 0.28 + i * 0.17]);
    line.rotation.x = Math.PI / 2;
    line.scale.set(1 - i * 0.08, 0.95, 1);
  }

  const wings: { pivot: T.Group; side: 1 | -1 }[] = [];
  const wingMat = new T.MeshPhysicalMaterial({
    color: 0xe5fff1,
    transparent: true,
    opacity: 0.7,
    roughness: 0.25,
    metalness: 0.08,
    side: T.DoubleSide,
    depthWrite: false,
  });
  for (const side of [-1, 1] as const) {
    const pivot = new T.Group();
    pivot.position.set(side * 0.17, 1.42, 0.1);
    g.add(pivot);
    const wing = mesh(pivot, sphere, wingMat, [side * 0.61, 0, 0.48], [0.44, 0.037, 0.95]);
    wing.rotation.y = side * 0.6;
    wing.castShadow = false;
    for (let j = 0; j < 3; j++) {
      const geometry = new T.BufferGeometry().setFromPoints([
        new T.Vector3(0, 0.044, 0),
        new T.Vector3(side * (0.2 + j * 0.12), 0.045, 0.58),
        new T.Vector3(side * (0.35 + j * 0.23), 0.046, 1.1),
      ]);
      pivot.add(new T.Line(geometry, new T.LineBasicMaterial({ color: 0x78a899, transparent: true, opacity: 0.6 })));
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
      rod(leg, [0, 0, 0], [side * 0.35, -0.31, z], 0.033, 0x1f3328);
      rod(leg, [side * 0.35, -0.31, z], [side * 0.53, -0.79, z + 0.17], 0.027, 0x1f3328);
      mesh(leg, sphere, 0xe1fa71, [side * 0.55, -0.81, z + 0.14], [0.12, 0.082, 0.2]);
      legs.push({ leg, side, index: i });
    }
  }

  return { root, body: g, wings, legs, flashable, scale: s };
}

export interface FlyPose {
  readonly phase: FlyPhase;
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
  const { phase, phaseT, t, dt } = pose;
  const walking = phase === 'approach';
  const excited = phase === 'approach' || phase === 'strike';

  for (const { pivot, side } of rig.wings) {
    pivot.rotation.z = side * (Math.sin(t * (excited ? 95 : 70)) * 0.23 - 0.1);
    pivot.rotation.y = side * 0.13;
  }

  const gaitRate = walking ? T.MathUtils.clamp(23 * (pose.speed / 0.35), 12, 34) : 0;
  const gaitAmp = walking ? 0.35 : 0;
  for (const { leg, side, index } of rig.legs) {
    const ph = t * gaitRate + index * 2.3 + side * 2;
    leg.rotation.x = Math.sin(ph) * gaitAmp;
    leg.rotation.z = Math.cos(ph) * (walking ? 0.09 : 0);
  }

  const s = rig.scale;
  const crouch = phase === 'aim' ? 0.85 : 1;
  rig.body.scale.y += (s * crouch - rig.body.scale.y) * (1 - Math.exp(-14 * dt));

  const lunge = phase === 'strike' ? STRIKE_LUNGE * (1 - Math.exp(-phaseT * 40)) : 0;
  rig.body.position.z += (-lunge - rig.body.position.z) * (1 - Math.exp(-(phase === 'strike' ? 60 : 12) * dt));

  const hop = phase === 'recover' ? RECOVER_HOP * Math.sin(Math.PI * Math.min(phaseT / RECOVER_DURATION, 1)) : 0;
  const bob = phase === 'idle' ? Math.sin(t * 5) * 0.0015 : 0;
  rig.body.position.y = -SOURCE_FEET_Y * s + hop + bob;
}
