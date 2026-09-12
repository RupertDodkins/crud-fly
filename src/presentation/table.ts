import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Table } from '../core/model';
import { box, cylinder, mat, mesh } from './fly-rig';

export const CLOTH_COLOR = 0x285b4e;
/** Mirrors the demo rules until the Frame carries selected rule dimensions. */
export const LEGAL_ZONE_DEPTH = 0.15;
export const RAIL_WIDTH = 0.09;
export const RAIL_HEIGHT = 0.04;
const CLOTH_THICKNESS = 0.03;
const APRON_HEIGHT = 0.12;
const LEG_HEIGHT = 0.5;
export const FLOOR_Y = -(CLOTH_THICKNESS + APRON_HEIGHT + LEG_HEIGHT);
export const FLOOR_COLOR = 0xa6a399;

function grain(wood: boolean): T.DataTexture {
  const size = 128, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hash = ((x * 1973 + y * 9277 + x * y * 17) >>> 0) % 101 / 100;
    const value = wood ? 195 + 22 * Math.sin(y * 0.6 + Math.sin(x * 0.04) * 2) + hash * 10 : 218 + hash * 30;
    const i = (y * size + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  const texture = new T.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  texture.repeat.set(wood ? 2 : 24, wood ? 1 : 24);
  return texture;
}

export function buildTable(table: Table): T.Group {
  const g = new T.Group();
  const { length: L, width: W } = table;
  const a = L / 2, b = W / 2, r = table.pocketRadius;
  const feltNoise = grain(false);
  const felt = new T.MeshStandardMaterial({ color: CLOTH_COLOR, roughness: 0.96, map: feltNoise, bumpMap: feltNoise, bumpScale: 0.00018 });
  const wood = new T.MeshStandardMaterial({ color: 0x493021, roughness: 0.42, map: grain(true) });
  const cushion = mat(0x234b40, 0.9);
  const leather = mat(0x211d19, 0.85);
  const brass = mat(0x9e8a5e, 0.42, 0.55);
  const rounded = (w: number, h: number, d: number, radius = 0.007) => new RoundedBoxGeometry(w, h, d, 3, radius);

  // The cloth outline follows the six pocket mouths, leaving actual recesses.
  const cloth = new T.Shape();
  cloth.moveTo(-a + r, -b);
  cloth.lineTo(-r, -b); cloth.absarc(0, -b, r, Math.PI, 0, true);
  cloth.lineTo(a - r, -b); cloth.absarc(a, -b, r, Math.PI, Math.PI / 2, true);
  cloth.lineTo(a, b - r); cloth.absarc(a, b, r, -Math.PI / 2, -Math.PI, true);
  cloth.lineTo(r, b); cloth.absarc(0, b, r, 0, -Math.PI, true);
  cloth.lineTo(-a + r, b); cloth.absarc(-a, b, r, 0, -Math.PI / 2, true);
  cloth.lineTo(-a, -b + r); cloth.absarc(-a, -b, r, Math.PI / 2, 0, true);
  cloth.closePath();
  const bed = mesh(g, new T.ExtrudeGeometry(cloth, { depth: CLOTH_THICKNESS, bevelEnabled: false, curveSegments: 16 }), felt);
  bed.rotation.x = Math.PI / 2;

  const mouth = r * 1.1;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const span = a - 2 * mouth;
      mesh(g, rounded(span, RAIL_HEIGHT, 0.07), wood, [sx * L / 4, 0.018, sz * (b + 0.055)]);
      mesh(g, rounded(span - 0.018, 0.028, 0.03, 0.004), cushion, [sx * L / 4, 0.014, sz * (b + 0.012)]);
    }
    for (const sx of [-1, 1]) mesh(g, rounded(a - 2 * mouth, APRON_HEIGHT, 0.06), wood, [sx * L / 4, -0.09, sz * (b + 0.055)]);
    for (const f of [-0.375, -0.25, -0.125, 0.125, 0.25, 0.375]) {
      mesh(g, new T.OctahedronGeometry(0.004), brass, [L * f, 0.039, sz * (b + 0.055)], [1, 0.18, 1]);
    }
  }
  for (const sx of [-1, 1]) {
    mesh(g, rounded(0.07, RAIL_HEIGHT, W - 2 * mouth), wood, [sx * (a + 0.055), 0.018, 0]);
    mesh(g, rounded(0.03, 0.028, W - 2 * mouth - 0.018, 0.004), cushion, [sx * (a + 0.012), 0.014, 0]);
    mesh(g, rounded(0.06, APRON_HEIGHT, W - 2 * mouth), wood, [sx * (a + 0.055), -0.09, 0]);
    for (const f of [-0.25, 0, 0.25]) mesh(g, new T.OctahedronGeometry(0.004), brass, [sx * (a + 0.055), 0.039, W * f], [1, 0.18, 1]);
  }

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = mesh(g, new T.CylinderGeometry(0.07, 0.045, LEG_HEIGHT, 4), wood, [sx * (a - 0.18), -CLOTH_THICKNESS - APRON_HEIGHT - LEG_HEIGHT / 2, sz * (b - 0.12)]);
    leg.rotation.y = Math.PI / 4;
    mesh(g, rounded(0.066, 0.025, 0.066, 0.003), brass, [sx * (a - 0.18), FLOOR_Y + 0.0125, sz * (b - 0.12)]);
  }

  const pocketWall = new T.MeshStandardMaterial({ color: 0x161514, roughness: 1, side: T.DoubleSide });
  for (const p of table.pockets) {
    mesh(g, new T.CylinderGeometry(r, r * 0.8, 0.11, 40, 1, true), pocketWall, [p.x, -0.055, p.y]);
    mesh(g, cylinder, mat(0x080909, 1), [p.x, -0.112, p.y], [r * 0.8, 0.004, r * 0.8]);
    const lip = mesh(g, new T.TorusGeometry(r + 0.002, 0.005, 8, 40), leather, [p.x, -0.003, p.y]);
    lip.rotation.x = Math.PI / 2;
  }

  const depth = L * LEGAL_ZONE_DEPTH;
  for (const sx of [-1, 1]) {
    const line = mesh(g, box, mat(0x9aaa89, 0.95), [sx * (a - depth), 0.0006, 0], [0.0015, 0.0005, W - 0.025]);
    line.castShadow = false;
  }
  const floor = mesh(g, box, mat(FLOOR_COLOR, 1), [0, FLOOR_Y - 0.01, 0], [16, 0.02, 16]);
  floor.castShadow = false;
  return g;
}
