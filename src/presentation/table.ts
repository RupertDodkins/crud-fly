import * as T from 'three';
import type { Table } from '../core/model';
import { box, colors, cylinder, mat, mesh } from './fly-rig';

export const CLOTH_COLOR = 0x2f6b5a;
/** Legal stance depth as a fraction of table length. Mirrors DEMO_RULES.shortEndDepth; the Frame does not carry rules. */
export const LEGAL_ZONE_DEPTH = 0.15;

export const RAIL_WIDTH = 0.06;
export const RAIL_HEIGHT = 0.035;
const CLOTH_THICKNESS = 0.03;
const APRON_HEIGHT = 0.12;
const LEG_HEIGHT = 0.5;
export const FLOOR_Y = -(CLOTH_THICKNESS + APRON_HEIGHT + LEG_HEIGHT);

export function buildTable(table: Table): T.Group {
  const g = new T.Group();
  const { length: L, width: W } = table;
  const outerL = L + 2 * RAIL_WIDTH;
  const outerW = W + 2 * RAIL_WIDTH;

  mesh(g, box, mat(CLOTH_COLOR, 0.92), [0, -CLOTH_THICKNESS / 2, 0], [L, CLOTH_THICKNESS, W]);

  const rail = mat(colors.cream, 0.6);
  for (const sz of [-1, 1]) {
    mesh(g, box, rail, [0, RAIL_HEIGHT / 2, sz * (W / 2 + RAIL_WIDTH / 2)], [outerL, RAIL_HEIGHT, RAIL_WIDTH]);
  }
  for (const sx of [-1, 1]) {
    mesh(g, box, rail, [sx * (L / 2 + RAIL_WIDTH / 2), RAIL_HEIGHT / 2, 0], [RAIL_WIDTH, RAIL_HEIGHT, W]);
  }

  mesh(g, box, mat(colors.dark, 0.7), [0, -CLOTH_THICKNESS - APRON_HEIGHT / 2, 0], [outerL, APRON_HEIGHT, outerW]);

  const legY = -CLOTH_THICKNESS - APRON_HEIGHT - LEG_HEIGHT / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mesh(g, cylinder, mat(colors.dark, 0.7), [sx * (L / 2 - 0.18), legY, sz * (W / 2 - 0.12)], [0.05, LEG_HEIGHT, 0.05]);
    }
  }

  // Pocket cups run from below the cloth to just above the rails so corner pockets read as holes cut through the rail.
  const pocketMat = mat(0x0b1a16, 0.95);
  const cupH = CLOTH_THICKNESS + RAIL_HEIGHT + 0.004;
  for (const p of table.pockets) {
    const cup = mesh(g, cylinder, pocketMat, [p.x, cupH / 2 - CLOTH_THICKNESS, p.y], [table.pocketRadius, cupH, table.pocketRadius]);
    cup.castShadow = false;
  }

  const zone = new T.MeshStandardMaterial({ color: colors.lime, transparent: true, opacity: 0.16, roughness: 1, depthWrite: false });
  const depth = L * LEGAL_ZONE_DEPTH;
  for (const sx of [-1, 1]) {
    const band = mesh(g, box, zone, [sx * (L / 2 - depth / 2), 0.0015, 0], [depth, 0.001, W]);
    band.castShadow = false;
  }

  const floor = mesh(g, box, mat(colors.mint, 0.95), [0, FLOOR_Y - 0.01, 0], [16, 0.02, 16]);
  floor.castShadow = false;

  return g;
}
