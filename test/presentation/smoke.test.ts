import { describe, expect, it } from 'vitest';
import { headingToRotationY, toScene } from '../../src/presentation/scene3d';
import { LEGAL_ZONE_DEPTH } from '../../src/presentation/table';
import { animateFly, makeFly } from '../../src/presentation/fly-rig';
import type { Table } from '../../src/core/model';

const table: Table = {
  length: 2.54,
  width: 1.27,
  ballRadius: 0.028575,
  pocketRadius: 0.06,
  pockets: [],
};

describe('scene3d coordinate mapping', () => {
  it('maps the table centre to ball-centre height above the origin', () => {
    expect(toScene({ x: 0, y: 0 }, table)).toEqual({ x: 0, y: table.ballRadius, z: 0 });
  });

  it('maps game x to scene x and game y to scene z', () => {
    const p = toScene({ x: table.length / 2, y: table.width / 2 }, table);
    expect(p).toEqual({ x: table.length / 2, y: table.ballRadius, z: table.width / 2 });
  });

  it('turns heading 0 (+x) into a fly whose nose points along +x', () => {
    const rot = headingToRotationY(0);
    const nose = { x: -Math.sin(rot), z: -Math.cos(rot) };
    expect(nose.x).toBeCloseTo(1);
    expect(nose.z).toBeCloseTo(0);
  });

  it('keeps the legal zone depth at the demo rule value', () => {
    expect(LEGAL_ZONE_DEPTH).toBe(0.15);
  });
});

describe('fly rig', () => {
  it('builds a rig roughly three ball radii long with feet at the origin plane', () => {
    const rig = makeFly(table.ballRadius * 3);
    expect(rig.legs).toHaveLength(6);
    expect(rig.wings).toHaveLength(2);
    expect(rig.flashable.length).toBeGreaterThan(0);
    rig.root.updateMatrixWorld(true);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { leg } of rig.legs) {
      leg.updateMatrixWorld(true);
      const shoe = leg.children[2]!;
      const y = shoe.getWorldPosition(shoe.position.clone()).y;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(minY).toBeGreaterThan(-0.005);
    expect(maxY).toBeLessThan(0.01);
  });

  it('animates every phase without throwing and crouches during aim', () => {
    const rig = makeFly(table.ballRadius * 3);
    for (const phase of ['idle', 'approach', 'aim', 'strike', 'recover'] as const) {
      for (let i = 0; i < 30; i++) {
        animateFly(rig, { phase, phaseT: i / 60, speed: 0.3, t: i / 60, dt: 1 / 60 });
      }
      if (phase === 'aim') expect(rig.body.scale.y).toBeLessThan(rig.scale * 0.9);
      if (phase === 'strike') expect(rig.body.position.z).toBeLessThan(-0.02);
    }
  });
});
