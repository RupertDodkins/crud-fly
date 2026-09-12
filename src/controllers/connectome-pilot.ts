import type { Controller, Observation } from '../core/model';

/**
 * Real recorded connectivity, artificial game sensors, simplified neuron dynamics, hand-designed
 * action decoder. Pattern and constants from flyway-surfer `dist/pilot.js` (MIT). Data from
 * `src/brain/flight-v1.json` (MaleCNS v1.0 subset, CC BY 4.0, see provenance.json).
 *
 * Not a complete brain. Not recorded neural activity. Not evidence of learning.
 */

/** Shape of flight-v1.json (columnar). Parsed once at the boundary; internals trust it. */
export interface CircuitData {
  readonly version: number;
  readonly source: string;
  readonly license: string;
  readonly types: readonly { readonly name: string; readonly superclass: string; readonly count: number; readonly nt: string; readonly tau: number }[];
  readonly units: {
    readonly count: number;
    readonly bodyId: readonly number[];
    /** Index into `types`. */
    readonly type: readonly number[];
    readonly side: readonly ('L' | 'R' | 'M')[];
    readonly role: readonly string[];
    /** Transmitter-derived: +1 excitatory, -1 inhibitory. */
    readonly sign: readonly (1 | -1)[];
    readonly nt: readonly string[];
  };
  readonly edges: {
    readonly count: number;
    readonly pre: readonly number[];
    readonly post: readonly number[];
    /** Unsigned synapse count. */
    readonly weight: readonly number[];
  };
}

export function parseCircuit(json: unknown): CircuitData {
  throw new Error('not implemented');
}

export interface PilotTelemetry {
  /** Mean rate of left descending neurons. Dimensionless model activity. */
  readonly dnLeft: number;
  readonly dnRight: number;
  readonly neuronCount: number;
  readonly edgeCount: number;
  /** Sum of |rate change| this step. */
  readonly activity: number;
  /** Last decoded shot, for the HUD. */
  readonly angleOffset: number;
  readonly force: number;
}

export interface PilotParams {
  /** Rate leak, from source: 0.3. */
  readonly tau: number;
  /** Weight scale, from source: 1.2. */
  readonly gain: number;
  /** Rate clamp, from source: [0, 3]. */
  readonly maxRate: number;
  /** Network steps per decision. */
  readonly stepsPerDecision: number;
  /** Ours: how far DN asymmetry can bend the aim, radians. */
  readonly steerGain: number;
  /** Ours: base force and how much summed DN drive adds. */
  readonly forceBase: number;
  readonly forceGain: number;
}

export const DEFAULT_PILOT: PilotParams = {
  tau: 0.3,
  gain: 1.2,
  maxRate: 3,
  stepsPerDecision: 3,
  steerGain: 0.25,
  forceBase: 0.5,
  forceGain: 0.15,
};

/**
 * Encode: object-ball bearing and closing speed relative to the fly become looming stimulus on
 * LC4/LPLC2 by side. Nothing else enters the graph.
 * Decode: mean DN rates by side. angle = aimToward(object) + steerGain*(L-R); force = base + gain*(L+R).
 * Stance, legality, timing come from the shared heuristic layer, not the graph.
 */
export function createConnectomePilot(id: string, circuit: CircuitData, params?: Partial<PilotParams>): Controller & { telemetry(): PilotTelemetry };

export function createConnectomePilot(): never {
  throw new Error('not implemented');
}

/** Exposed for the perturbation test: same observation, stimulus nudged, angle must move. */
export function encodeStimulus(obs: Observation): { left: number; right: number } {
  throw new Error('not implemented');
}
