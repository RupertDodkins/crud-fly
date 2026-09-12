import { describe, expect, it } from 'vitest';
import { loadSomaPositions } from '../../src/brain/positions';
import { createConnectomePilot, parseCircuit } from '../../src/controllers/connectome-pilot';
import circuitJson from '../../src/brain/flight-v1.json';

describe('vendored soma positions', () => {
  const circuit = parseCircuit(circuitJson);
  const soma = loadSomaPositions();

  it('covers every unit in circuit order, with NaN only for the declared missing somata', () => {
    expect(soma.um.length).toBe(circuit.units.count * 3);
    let nanUnits = 0;
    for (let i = 0; i < circuit.units.count; i++) if (Number.isNaN(soma.um[i * 3])) nanUnits++;
    expect(nanUnits).toBe(soma.missing);
    expect(soma.missing).toBeLessThan(circuit.units.count * 0.02);
  });

  it('present positions fall inside the whole-CNS bounding box', () => {
    for (let i = 0; i < circuit.units.count; i++) {
      const x = soma.um[i * 3]!;
      if (Number.isNaN(x)) continue;
      for (let k = 0; k < 3; k++) {
        const v = soma.um[i * 3 + k]!;
        expect(v).toBeGreaterThanOrEqual(soma.bbox.min[k]!);
        expect(v).toBeLessThanOrEqual(soma.bbox.max[k]!);
      }
    }
  });

  it('left-labelled units sit on the opposite x side from right-labelled units, on average', () => {
    const mean = (side: 'L' | 'R') => {
      let s = 0;
      let n = 0;
      for (let i = 0; i < circuit.units.count; i++) {
        if (circuit.units.side[i] !== side || Number.isNaN(soma.um[i * 3])) continue;
        s += soma.um[i * 3]!;
        n++;
      }
      return s / n;
    };
    const mid = (soma.bbox.min[0] + soma.bbox.max[0]) / 2;
    expect(Math.sign(mean('L') - mid)).toBe(-Math.sign(mean('R') - mid));
  });

  it('flows through the pilot as a positioned BrainView', () => {
    const view = createConnectomePilot('t', circuit, undefined, soma).brain();
    expect(view.hasPositions).toBe(true);
    expect(view.soma?.backdrop.count).toBe(40000);
    expect(createConnectomePilot('t2', circuit).brain().hasPositions).toBe(false);
  });
});
