import type { Controller, Observation, PlayerCommand, Shot, Vec2 } from '../core/model';
import { createHeuristic } from './heuristic';

/**
 * Real recorded connectivity, artificial game sensors, simplified neuron dynamics, hand-designed
 * action decoder. Pattern and constants from flyway-surfer `dist/pilot.js` (MIT, commit d00e185).
 * Data from `src/brain/flight-v1.json` (MaleCNS v1.0 subset, CC BY 4.0, see provenance.json).
 *
 * Rates below are dimensionless model values, not measured spike rates.
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
    /** Transmitter-derived: +1 excitatory, -1 inhibitory, 0 unknown (present in the vendored data). */
    readonly sign: readonly (1 | -1 | 0)[];
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

const INPUT_TYPE = /^(LC4|LPLC2)$/;
const OUTPUT_TYPE = /^DNp0[1-6]$/;

class CircuitParseError extends Error {
  constructor(path: string, detail: string) {
    super(`flight-v1 circuit: ${path} ${detail}`);
    this.name = 'CircuitParseError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireRecord(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new CircuitParseError(path, 'must be an object');
  return v;
}

function requireNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CircuitParseError(path, 'must be a finite number');
  return v;
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new CircuitParseError(path, 'must be a string');
  return v;
}

function requireArray(v: unknown, path: string, length: number): readonly unknown[] {
  if (!Array.isArray(v)) throw new CircuitParseError(path, 'must be an array');
  if (v.length !== length) throw new CircuitParseError(path, `must have length ${length}, got ${v.length}`);
  return v;
}

function requireNumbers(v: unknown, path: string, length: number, check: (n: number, i: number) => boolean, detail: string): readonly number[] {
  const arr = requireArray(v, path, length);
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (typeof n !== 'number' || !Number.isFinite(n) || !check(n, i)) throw new CircuitParseError(`${path}[${i}]`, detail);
  }
  return arr as readonly number[];
}

function requireStrings(v: unknown, path: string, length: number): readonly string[] {
  const arr = requireArray(v, path, length);
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') throw new CircuitParseError(`${path}[${i}]`, 'must be a string');
  }
  return arr as readonly string[];
}

export function parseCircuit(json: unknown): CircuitData {
  const root = requireRecord(json, 'root');
  const version = requireNumber(root['version'], 'version');
  const source = requireString(root['source'], 'source');
  const license = requireString(root['license'], 'license');

  const rawTypes = root['types'];
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) throw new CircuitParseError('types', 'must be a non-empty array');
  const types = rawTypes.map((t, i) => {
    const r = requireRecord(t, `types[${i}]`);
    return {
      name: requireString(r['name'], `types[${i}].name`),
      superclass: requireString(r['superclass'], `types[${i}].superclass`),
      count: requireNumber(r['count'], `types[${i}].count`),
      nt: requireString(r['nt'], `types[${i}].nt`),
      tau: requireNumber(r['tau'], `types[${i}].tau`),
    };
  });

  const u = requireRecord(root['units'], 'units');
  const unitCount = requireNumber(u['count'], 'units.count');
  if (!Number.isInteger(unitCount) || unitCount <= 0 || unitCount > 0xffff) {
    throw new CircuitParseError('units.count', 'must be a positive integer that fits Uint16 indices');
  }
  const isIndex = (max: number) => (n: number) => Number.isInteger(n) && n >= 0 && n < max;
  const units = {
    count: unitCount,
    bodyId: requireNumbers(u['bodyId'], 'units.bodyId', unitCount, () => true, 'must be a number'),
    type: requireNumbers(u['type'], 'units.type', unitCount, isIndex(types.length), `must be an integer index into types (0..${types.length - 1})`),
    side: requireStrings(u['side'], 'units.side', unitCount).map((s, i) => {
      if (s !== 'L' && s !== 'R' && s !== 'M') throw new CircuitParseError(`units.side[${i}]`, "must be 'L', 'R' or 'M'");
      return s;
    }),
    role: requireStrings(u['role'], 'units.role', unitCount),
    sign: requireNumbers(u['sign'], 'units.sign', unitCount, (n) => n === 1 || n === -1 || n === 0, 'must be 1, -1 or 0').map((n) => n as 1 | -1 | 0),
    nt: requireStrings(u['nt'], 'units.nt', unitCount),
  };

  const e = requireRecord(root['edges'], 'edges');
  const edgeCount = requireNumber(e['count'], 'edges.count');
  if (!Number.isInteger(edgeCount) || edgeCount < 0) throw new CircuitParseError('edges.count', 'must be a non-negative integer');
  const edges = {
    count: edgeCount,
    pre: requireNumbers(e['pre'], 'edges.pre', edgeCount, isIndex(unitCount), `must be an integer unit index (0..${unitCount - 1})`),
    post: requireNumbers(e['post'], 'edges.post', edgeCount, isIndex(unitCount), `must be an integer unit index (0..${unitCount - 1})`),
    weight: requireNumbers(e['weight'], 'edges.weight', edgeCount, (n) => n >= 0, 'must be a non-negative number'),
  };

  return { version, source, license, types, units, edges };
}

/** Type alias rather than interface so it stays assignable to Controller's Record<string, number>. */
export type PilotTelemetry = {
  /** Mean rate of left descending neurons. Dimensionless model activity. */
  readonly dnLeft: number;
  readonly dnRight: number;
  readonly neuronCount: number;
  readonly edgeCount: number;
  /** Sum of |rate change| over the last simulate call. */
  readonly activity: number;
  /** Last decoded shot, for the HUD. */
  readonly angleOffset: number;
  readonly force: number;
};

/** Narrows Controller.telemetry so callers see the concrete fields instead of an index signature. */
export interface ConnectomePilot extends Controller {
  telemetry(): PilotTelemetry;
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
  /** Ours: max radians the DN asymmetry index (bias-centred, in [-1, 1]) can bend the intercept aim. */
  readonly steerGain: number;
  /** Ours: how much the bias-centred summed DN drive (in [-1, 1]) adds to the intercept force. */
  readonly forceGain: number;
}

export const DEFAULT_PILOT: PilotParams = {
  tau: 0.3,
  gain: 1.2,
  maxRate: 3,
  stepsPerDecision: 3,
  steerGain: 0.15,
  forceGain: 0.1,
};

/** Maximum stimulus per input side, matching the source's rate clamp. */
const STIMULUS_MAX = 3;
/** Closing speed (m/s) at which the looming term saturates. */
const CLOSING_REF_MPS = 1.0;
/** Weight of proximity alone (ball present but not closing) inside the looming term. */
const PRESENCE_WEIGHT = 0.25;

export interface CircuitSides {
  readonly inputs: readonly [readonly number[], readonly number[]];
  readonly outputs: readonly [readonly number[], readonly number[]];
}

/** Index units by role and side (0 = L, 1 = R). Midline units enter neither set. */
export function circuitSides(circuit: CircuitData): CircuitSides {
  const inputs: [number[], number[]] = [[], []];
  const outputs: [number[], number[]] = [[], []];
  for (let i = 0; i < circuit.units.count; i++) {
    const typeIndex = circuit.units.type[i] as number;
    const type = (circuit.types[typeIndex] as CircuitData['types'][number]).name;
    const s = circuit.units.side[i];
    if (s !== 'L' && s !== 'R') continue;
    const side = s === 'L' ? 0 : 1;
    if (INPUT_TYPE.test(type)) inputs[side].push(i);
    if (OUTPUT_TYPE.test(type)) outputs[side].push(i);
  }
  return { inputs, outputs };
}

class RateCircuit {
  readonly n: number;
  readonly pre: Uint16Array;
  readonly post: Uint16Array;
  readonly weights: Float32Array;
  readonly sides: CircuitSides;
  rates: Float32Array;
  private drive: Float32Array;
  private next: Float32Array;
  left = 0;
  right = 0;
  activity = 0;

  constructor(circuit: CircuitData, private readonly params: PilotParams) {
    const n = circuit.units.count;
    this.n = n;
    this.rates = new Float32Array(n);
    this.drive = new Float32Array(n);
    this.next = new Float32Array(n);
    this.pre = Uint16Array.from(circuit.edges.pre);
    this.post = Uint16Array.from(circuit.edges.post);
    this.weights = new Float32Array(circuit.edges.count);
    const incoming = new Float32Array(n);
    for (let e = 0; e < this.pre.length; e++) {
      const post = this.post[e] as number;
      incoming[post] = (incoming[post] as number) + (circuit.edges.weight[e] as number);
    }
    for (let e = 0; e < this.pre.length; e++) {
      const pre = this.pre[e] as number;
      const post = this.post[e] as number;
      this.weights[e] =
        (params.gain * (circuit.units.sign[pre] as number) * (circuit.edges.weight[e] as number)) /
        Math.max(1, incoming[post] as number);
    }
    this.sides = circuitSides(circuit);
  }

  simulate(left: number, right: number): void {
    const { tau, maxRate, stepsPerDecision } = this.params;
    const { inputs, outputs } = this.sides;
    let activity = 0;
    for (let s = 0; s < stepsPerDecision; s++) {
      this.drive.fill(0);
      for (const i of inputs[0]) this.drive[i] = left;
      for (const i of inputs[1]) this.drive[i] = right;
      for (let e = 0; e < this.pre.length; e++) {
        const post = this.post[e] as number;
        this.drive[post] = (this.drive[post] as number) + (this.weights[e] as number) * (this.rates[this.pre[e] as number] as number);
      }
      for (let i = 0; i < this.n; i++) {
        const r = this.rates[i] as number;
      const nx = clamp(r + tau * ((this.drive[i] as number) - r), 0, maxRate);
      this.next[i] = nx;
        activity += Math.abs(nx - r);
      }
      [this.rates, this.next] = [this.next, this.rates];
    }
    this.activity = activity;
    this.left = this.meanRate(outputs[0]);
    this.right = this.meanRate(outputs[1]);
  }

  private meanRate(indices: readonly number[]): number {
    if (indices.length === 0) return 0;
    let sum = 0;
    for (const i of indices) sum += this.rates[i] as number;
    return sum / indices.length;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Sensory encoding (ours). Pure and deterministic.
 *
 *   d        = object.pos - myFly.pos,  r = |d|,  dHat = d / r
 *   bearing  = wrap(atan2(d.y, d.x) - myFly.heading)        signed; negative = ball on the fly's left
 *   lateral  = clamp(-bearing / (pi/2), -1, 1)              +1 fully left, -1 fully right, 0 dead ahead
 *   closing  = max(0, -(object.vel . dHat))                 m/s toward the fly; receding -> 0
 *   near     = clamp(1 - r / table.length, 0, 1)            far ball -> 0
 *   loom     = near * (PRESENCE_WEIGHT + (1 - PRESENCE_WEIGHT) * clamp(closing / CLOSING_REF_MPS, 0, 1))
 *   left     = STIMULUS_MAX * loom * (1 + lateral) / 2
 *   right    = STIMULUS_MAX * loom * (1 - lateral) / 2
 *
 * A ball on the left drives the left LC4/LPLC2 inputs more; closing speed scales both sides;
 * a far, receding ball gives near-zero stimulus on both sides. Both outputs lie in [0, STIMULUS_MAX].
 */
export function encodeStimulus(obs: Observation): { left: number; right: number } {
  const fly = obs.myFly;
  const dx = obs.object.pos.x - fly.pos.x;
  const dy = obs.object.pos.y - fly.pos.y;
  const r = Math.hypot(dx, dy);
  if (r === 0 || obs.object.pocketed) return { left: 0, right: 0 };
  const bearing = wrapAngle(Math.atan2(dy, dx) - fly.heading);
  const lateral = clamp(-bearing / (Math.PI / 2), -1, 1);
  const closing = Math.max(0, -(obs.object.vel.x * (dx / r) + obs.object.vel.y * (dy / r)));
  const near = clamp(1 - r / obs.table.length, 0, 1);
  const loom = near * (PRESENCE_WEIGHT + (1 - PRESENCE_WEIGHT) * clamp(closing / CLOSING_REF_MPS, 0, 1));
  return {
    left: clamp((STIMULUS_MAX * loom * (1 + lateral)) / 2, 0, STIMULUS_MAX),
    right: clamp((STIMULUS_MAX * loom * (1 - lateral)) / 2, 0, STIMULUS_MAX),
  };
}

/**
 * Encode: object-ball bearing and closing speed relative to the fly become looming stimulus on
 * LC4/LPLC2 by side. Nothing else enters the graph.
 * Decode: asymmetry index a = (L - R) / (L + R) and drive index d = (L + R) / (2 * maxRate), each
 * centred on the graph's resting response to a symmetric stimulus so its innate left bias does not
 * become a constant aim error. angle = intercept + steerGain * a'; force = intercept + forceGain * d'.
 * Stance, legality, timing and the intercept itself come from a noise-free heuristic; the graph only
 * perturbs the shot. That division is the hand-designed decoder the disclosure refers to.
 */
export function createConnectomePilot(
  id: string,
  circuit: CircuitData,
  params?: Partial<PilotParams>,
): ConnectomePilot {
  const p: PilotParams = { ...DEFAULT_PILOT, ...params };
  const net = new RateCircuit(circuit, p);
  const rest = restingIndices(new RateCircuit(circuit, p), p);
  const base = createHeuristic(`${id}:intercept`, 0, { aimNoise: 0 });
  let telemetry: PilotTelemetry = {
    dnLeft: 0,
    dnRight: 0,
    neuronCount: circuit.units.count,
    edgeCount: circuit.edges.count,
    activity: 0,
    angleOffset: 0,
    force: 0,
  };

  function perturb(obs: Observation, intercept: Shot): Shot {
    const { left, right } = encodeStimulus(obs);
    net.simulate(left, right);
    const { asym, drive } = indices(net.left, net.right, p.maxRate);
    const angleOffset = p.steerGain * clamp(asym - rest.asym, -1, 1);
    const force = clamp(intercept.force + p.forceGain * clamp(drive - rest.drive, -1, 1), 0.15, 1);
    telemetry = {
      dnLeft: net.left,
      dnRight: net.right,
      neuronCount: circuit.units.count,
      edgeCount: circuit.edges.count,
      activity: net.activity,
      angleOffset,
      force,
    };
    return { angle: intercept.angle + angleOffset, force };
  }

  return {
    id,
    label: 'connectome pilot',
    decide(obs: Observation): PlayerCommand {
      const cmd = base.decide(obs);
      if (cmd.kind !== 'shoot') return cmd;
      return { kind: 'shoot', shot: perturb(obs, cmd.shot) };
    },
    telemetry(): PilotTelemetry {
      return telemetry;
    },
  };
}

function indices(left: number, right: number, maxRate: number): { asym: number; drive: number } {
  const sum = left + right;
  return { asym: sum > 1e-9 ? (left - right) / sum : 0, drive: sum / (2 * maxRate) };
}

/** Graph response to an equal stimulus on both sides, held until settled. Measured once per pilot on a scratch circuit. */
function restingIndices(scratch: RateCircuit, p: PilotParams): { asym: number; drive: number } {
  const half = STIMULUS_MAX / 2;
  for (let i = 0; i < 20; i++) scratch.simulate(half, half);
  return indices(scratch.left, scratch.right, p.maxRate);
}
