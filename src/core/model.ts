// Canonical game state. Everything else (renderer, HUD, pilots, replay) reads this; only session.ts writes it.
//
// Caller usage the types are derived from:
//
//   const session = createSession({ seed: 7, rules: DEMO_RULES, controllers: [connectomePilot, heuristic] });
//   for (let i = 0; i < 120 * 30; i++) session.step();           // 30 s at 120 Hz
//   render(session.frame());                                      // read-only projection
//   const tape = session.tape();                                  // seed + rules + commands + hashes
//   assert(replay(tape).hashes deep-equals tape.hashes);

export type PlayerId = 0 | 1;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Ball {
  readonly pos: Vec2;
  readonly vel: Vec2;
  /** true once pocketed; the ball is out of play until the rules respawn it. */
  readonly pocketed: boolean;
}

/** Table geometry in metres. Origin at table centre, x along the long axis. Short ends are x = ±length/2. */
export interface Table {
  readonly length: number;
  readonly width: number;
  readonly ballRadius: number;
  readonly pocketRadius: number;
  /** Six pocket centres. */
  readonly pockets: readonly Vec2[];
}

export type FlyPhase = 'idle' | 'approach' | 'aim' | 'strike' | 'recover';

/**
 * The fly's gameplay body. Crud is ball-in-hand: the shooter fetches the cue ball wherever it is,
 * carries it to either short end, and throws. The engine grabs the ball when the fly reaches it on
 * its turn, moves the held ball with the fly, and releases it with the shot velocity when strike lands.
 */
export interface FlyBody {
  readonly pos: Vec2;
  readonly heading: number;
  /** `approach` covers both fetching the cue ball and carrying it to an end; see `carrying`. */
  readonly phase: FlyPhase;
  /** Seconds elapsed in the current phase. */
  readonly phaseT: number;
  /** Set during aim/strike; the engine converts this to the cue-ball release velocity when strike lands. */
  readonly shot: Shot | null;
  /** True while the cue ball is in this fly's grasp. Absent means false. */
  readonly carrying?: boolean;
}

export interface Shot {
  readonly angle: number;
  /** Normalised 0..1; rules clamp and physics scales to an impulse. */
  readonly force: number;
}

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly lives: number;
  readonly fly: FlyBody;
}

/**
 * Turn state machine. Booleans scattered across the state were the alternative; this is the
 * model-the-domain choice. Every rule transition is an edge here.
 */
export type Turn =
  | { readonly kind: 'serve'; readonly shooter: PlayerId; readonly attempt: 1 | 2 | 3 }
  | {
      readonly kind: 'awaiting_shot';
      readonly shooter: PlayerId;
      readonly deadlineTick: number;
      /** Present when the in-flight shot is a serve, so a miss is a serve fault rather than a lost life. */
      readonly serveAttempt?: 1 | 2 | 3;
    }
  | { readonly kind: 'in_play'; readonly lastShooter: PlayerId }
  | { readonly kind: 'resolving'; readonly outcome: RuleEvent }
  | { readonly kind: 'over'; readonly winner: PlayerId };

export type RuleEvent =
  | { readonly kind: 'life_lost'; readonly player: PlayerId; readonly reason: LifeLostReason; readonly tick: number }
  | { readonly kind: 'serve_fault'; readonly player: PlayerId; readonly attempt: number; readonly tick: number }
  /** `pos` is the cue-ball release point. */
  | { readonly kind: 'legal_shot'; readonly player: PlayerId; readonly tick: number; readonly pos?: Vec2 }
  /** `pos` is the impact point between ball centres. */
  | { readonly kind: 'contact'; readonly tick: number; readonly pos?: Vec2 }
  /** `pos` is the pocket centre. */
  | { readonly kind: 'pocket'; readonly ball: 'cue' | 'object'; readonly tick: number; readonly pos?: Vec2 }
  | { readonly kind: 'match_over'; readonly winner: PlayerId; readonly tick: number };

/** Each reason is one line of the HUD rule log and one row of the RULES IN FORCE counter. */
export type LifeLostReason =
  | 'object_ball_stopped'
  | 'object_ball_pocketed'
  /** Object ball travelled under six inches after your hit (a dead ball). */
  | 'object_short_travel'
  | 'shot_from_long_side'
  | 'no_contact'
  | 'three_serve_faults'
  | 'cue_ball_off_table'
  | 'shot_backwards';

export interface MatchState {
  readonly tick: number;
  readonly table: Table;
  readonly cue: Ball;
  readonly object: Ball;
  readonly players: readonly [Player, Player];
  readonly turn: Turn;
  /** Append-only. The HUD renders the tail; tests assert on it. */
  readonly log: readonly RuleEvent[];
  /** xorshift state; the only randomness in the match. */
  readonly rng: number;
}

/** What a controller may say. Nothing here touches a ball directly. */
export type PlayerCommand =
  | { readonly kind: 'wait' }
  | { readonly kind: 'move'; readonly target: Vec2 }
  | { readonly kind: 'shoot'; readonly shot: Shot };

/** Bounded view a controller gets. It cannot see the other player's controller or the rng. */
export interface Observation {
  readonly me: PlayerId;
  readonly tick: number;
  readonly table: Table;
  readonly cue: Ball;
  readonly object: Ball;
  readonly myFly: FlyBody;
  readonly myLives: number;
  readonly theirLives: number;
  readonly turn: Turn;
  /** Both short-end regions. Any shooter may throw from either. */
  readonly legalEnds: readonly [{ readonly xMin: number; readonly xMax: number }, { readonly xMin: number; readonly xMax: number }];
  /** True when this fly holds the cue ball. */
  readonly carrying: boolean;
  /** Seconds until the object ball stops at current deceleration. Infinity if not rolling. */
  readonly objectStopsIn: number;
}

export interface Controller {
  readonly id: string;
  /** Human-readable label the HUD shows; must be honest ("connectome pilot", "heuristic"). */
  readonly label: string;
  decide(obs: Observation): PlayerCommand;
  /** Optional telemetry the HUD may display. Only values the controller actually computed. */
  telemetry?(): Readonly<Record<string, number>>;
}

/** A frozen snapshot for presentation. Same shape as MatchState today; kept separate so renderers never hold the live object. */
export type Frame = MatchState;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}
