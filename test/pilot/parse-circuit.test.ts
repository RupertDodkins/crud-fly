import { describe, expect, it } from 'vitest';
import raw from '../../src/brain/flight-v1.json';
import { circuitSides, parseCircuit } from '../../src/controllers/connectome-pilot';

describe('parseCircuit', () => {
  it('parses flight-v1.json with 1072 units and 26544 edges and finds inputs/outputs on both sides', () => {
    const circuit = parseCircuit(raw as unknown);
    expect(circuit.units.count).toBe(1072);
    expect(circuit.edges.count).toBe(26544);
    expect(circuit.units.type).toHaveLength(1072);
    expect(circuit.edges.pre).toHaveLength(26544);

    const sides = circuitSides(circuit);
    console.log(
      `flight-v1: LC4/LPLC2 inputs L=${sides.inputs[0].length} R=${sides.inputs[1].length}; ` +
        `DNp01-06 outputs L=${sides.outputs[0].length} R=${sides.outputs[1].length}`,
    );
    expect(sides.inputs[0].length).toBeGreaterThan(0);
    expect(sides.inputs[1].length).toBeGreaterThan(0);
    expect(sides.outputs[0].length).toBeGreaterThan(0);
    expect(sides.outputs[1].length).toBeGreaterThan(0);
  });

  it('rejects non-objects and missing sections', () => {
    expect(() => parseCircuit(null)).toThrow(/root must be an object/);
    expect(() => parseCircuit({ version: 1, source: 's', license: 'l' })).toThrow(/types must be a non-empty array/);
    expect(() => parseCircuit({ version: 1, source: 's', license: 'l', types: [] })).toThrow(/types/);
  });

  it('rejects a truncated units array with a clear message', () => {
    const truncated = structuredClone(raw) as { units: { side: string[] } };
    truncated.units.side = truncated.units.side.slice(0, 10);
    expect(() => parseCircuit(truncated)).toThrow(/units\.side must have length 1072, got 10/);
  });

  it('rejects edges pointing outside the unit range', () => {
    const bad = structuredClone(raw) as { edges: { post: number[] } };
    bad.edges.post[5] = 999999;
    expect(() => parseCircuit(bad)).toThrow(/edges\.post\[5\] must be an integer unit index/);
  });

  it('rejects an invalid side or sign value', () => {
    const badSide = structuredClone(raw) as { units: { side: string[] } };
    badSide.units.side[3] = 'X';
    expect(() => parseCircuit(badSide)).toThrow(/units\.side\[3\] must be 'L', 'R' or 'M'/);

    const badSign = structuredClone(raw) as { units: { sign: number[] } };
    badSign.units.sign[7] = 2;
    expect(() => parseCircuit(badSign)).toThrow(/units\.sign\[7\] must be 1, -1 or 0/);
  });
});
