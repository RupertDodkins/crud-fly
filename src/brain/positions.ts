/**
 * Real MaleCNS v1.0 soma positions for the flight-v1 units, plus metadata for the whole-CNS backdrop.
 * Source and licence: src/brain/positions-provenance.json. Values are micrometres.
 */
import type { SomaPositions } from '../controllers/connectome-pilot';
import somaJson from './soma-positions.json';
import backdropMeta from '../../public/brain/cns-somata.json';

interface SomaJson {
  readonly units: number;
  readonly somaUm: ReadonlyArray<readonly [number, number, number] | null>;
  readonly missing: number;
}

function triple(v: readonly number[], what: string): [number, number, number] {
  const [x, y, z] = v;
  if (v.length !== 3 || x === undefined || y === undefined || z === undefined) throw new Error(`${what}: expected xyz`);
  return [x, y, z];
}

/** Builds the SomaPositions block for the vendored flight-v1 circuit. Pure; no fetch. */
export function loadSomaPositions(): SomaPositions {
  const data = somaJson as SomaJson;
  const um = new Float32Array(data.units * 3).fill(Number.NaN);
  data.somaUm.forEach((p, i) => {
    if (p) um.set(p, i * 3);
  });
  return {
    um,
    missing: data.missing,
    bbox: { min: triple(backdropMeta.bbox.min, 'bbox.min'), max: triple(backdropMeta.bbox.max, 'bbox.max') },
    backdrop: { url: `/brain/${backdropMeta.file}`, count: backdropMeta.count, sampledFrom: backdropMeta.sampledFrom },
  };
}
