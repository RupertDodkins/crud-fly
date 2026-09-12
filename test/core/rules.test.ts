import { describe, expect, it } from 'vitest';
import { vec } from '../../src/core/model';
import type { Ball, MatchState, PlayerId, RuleEvent, Turn } from '../../src/core/model';
import {
  CARRY_OFFSET,
  DEMO_RULES,
  GRAB_REACH,
  RESOLVE_TICKS,
  adjudicate,
  canGrab,
  carryPoint,
  clampCommand,
  footSpot,
  grabCue,
  isTurnOf,
  legalZone,
  rulesInForce,
  validateShot,
  zoneContaining,
  type ContactMark,
} from '../../src/core/rules';
import { DEMO_PHYSICS } from '../../src/core/physics';
import { initialState } from '../../src/core/session';

function base(): MatchState {
  return initialState(3, DEMO_RULES, ['A', 'B']);
}

function withFly(state: MatchState, player: PlayerId, patch: Partial<MatchState['players'][0]['fly']>): MatchState {
  const players = state.players.map((p) => (p.id === player ? { ...p, fly: { ...p.fly, ...patch } } : p)) as unknown as MatchState['players'];
  return { ...state, players };
}

function withFlyAt(state: MatchState, player: PlayerId, x: number, y: number): MatchState {
  return withFly(state, player, { pos: vec(x, y) });
}

/** Nobody holding the ball, cue somewhere on the table at rest. */
function free(state: MatchState, cue: Ball = { pos: vec(0.2, 0.1), vel: vec(0, 0), pocketed: false }): MatchState {
  return { ...withFly(withFly(state, 0, { carrying: false }), 1, { carrying: false }), cue };
}

const rolling = (x: number, y: number, vx = 0.4, vy = 0): Ball => ({ pos: vec(x, y), vel: vec(vx, vy), pocketed: false });
const crawling = (x: number, y: number): Ball => ({ pos: vec(x, y), vel: vec(0.005, 0), pocketed: false });
const lifeLost = (events: readonly RuleEvent[]) => events.filter((e) => e.kind === 'life_lost');
const kinds = (events: readonly RuleEvent[]) => events.map((e) => e.kind);

describe('ends and legality', () => {
  it('both short-end zones are legal for either player; the long side is not', () => {
    const s = free(base());
    const z0 = legalZone(s.table, DEMO_RULES, 0);
    const z1 = legalZone(s.table, DEMO_RULES, 1);
    expect(z0.xMin).toBe(-s.table.length / 2);
    expect(z1.xMax).toBe(s.table.length / 2);
    expect(zoneContaining(s.table, DEMO_RULES, 0)).toBeNull();
    expect(zoneContaining(s.table, DEMO_RULES, -1.2)).toBe(0);
    expect(zoneContaining(s.table, DEMO_RULES, 1.2)).toBe(1);

    // Player 0 on the x>0 end, throwing toward -x: legal. Legality depends only on standing in either zone.
    const onFarEnd = withFlyAt(s, 0, 1.1, 0.2);
    expect(validateShot(onFarEnd, DEMO_RULES, 0, { angle: Math.PI, force: 0.5 })).toBeNull();
    // Player 1 on the x<0 end, throwing toward +x: also legal.
    const p1Near = withFlyAt(s, 1, -1.1, 0);
    expect(validateShot(p1Near, DEMO_RULES, 1, { angle: 0, force: 0.5 })).toBeNull();
    // Mid-table is the long side for everyone.
    expect(validateShot(withFlyAt(s, 0, 0, 0), DEMO_RULES, 0, { angle: 0, force: 0.5 })).toBe('shot_from_long_side');
    expect(validateShot(withFlyAt(s, 1, 0.3, 0.5), DEMO_RULES, 1, { angle: Math.PI, force: 0.5 })).toBe('shot_from_long_side');
    // Throwing into the cushion behind you is backwards from whichever end you stand at.
    expect(validateShot(onFarEnd, DEMO_RULES, 0, { angle: 0, force: 0.5 })).toBe('shot_backwards');
    expect(validateShot(p1Near, DEMO_RULES, 1, { angle: Math.PI, force: 0.5 })).toBe('shot_backwards');
    // Exactly along the cushion (a folded clamp) is not backwards.
    expect(validateShot(onFarEnd, DEMO_RULES, 0, { angle: Math.PI / 2, force: 0.5 })).toBeNull();
  });

  it('an illegal throw assesses the life via the physics event path and does not touch the log', () => {
    const s = withFlyAt(base(), 0, 0, 0);
    const out = adjudicate(s, DEMO_RULES, [{ kind: 'life_lost', player: 0, reason: 'shot_from_long_side', tick: s.tick }]);
    expect(out.state.players[0].lives).toBe(2);
    expect(out.state.log.length).toBe(0);
    expect(lifeLost(out.events)[0]).toMatchObject({ reason: 'shot_from_long_side' });
    expect(out.state.turn.kind).toBe('resolving');
  });

  it('clampCommand caps force and folds a backward angle to the cushion line from whichever end the fly stands at', () => {
    const s = free(base());
    const atNeg = clampCommand(withFlyAt(s, 0, -1.1, 0), DEMO_RULES, 0, { kind: 'shoot', shot: { angle: Math.PI - 0.1, force: 2 } });
    expect(atNeg.kind).toBe('shoot');
    if (atNeg.kind === 'shoot') {
      expect(atNeg.shot.force).toBe(1);
      expect(Math.cos(atNeg.shot.angle)).toBeGreaterThanOrEqual(-1e-12);
    }
    const atPos = clampCommand(withFlyAt(s, 0, 1.1, 0), DEMO_RULES, 0, { kind: 'shoot', shot: { angle: 0.1, force: 0.5 } });
    if (atPos.kind === 'shoot') expect(Math.cos(atPos.shot.angle)).toBeLessThanOrEqual(1e-12);
    expect(rulesInForce(DEMO_RULES)).toBeGreaterThan(0);
    expect(rulesInForce({ ...DEMO_RULES, forbidLongSideShots: false })).toBe(rulesInForce(DEMO_RULES) - 1);
  });
});

describe('turn ownership and ball-in-hand', () => {
  it('isTurnOf: shooter during serve/awaiting_shot, the opponent of the last hitter during in_play', () => {
    expect(isTurnOf({ kind: 'serve', shooter: 1, attempt: 1 }, 1)).toBe(true);
    expect(isTurnOf({ kind: 'serve', shooter: 1, attempt: 1 }, 0)).toBe(false);
    expect(isTurnOf({ kind: 'awaiting_shot', shooter: 0, deadlineTick: 5 }, 0)).toBe(true);
    expect(isTurnOf({ kind: 'in_play', lastShooter: 0 }, 1)).toBe(true);
    expect(isTurnOf({ kind: 'in_play', lastShooter: 0 }, 0)).toBe(false);
    expect(isTurnOf({ kind: 'over', winner: 0 }, 0)).toBe(false);
  });

  it('a fly within GRAB_REACH on its clock picks the ball up; in_play becomes awaiting_shot for the grabber', () => {
    const cue: Ball = { pos: vec(0.2, 0.1), vel: vec(0, 0), pocketed: false };
    const s: MatchState = { ...free(base(), cue), object: rolling(-0.3, 0), turn: { kind: 'in_play', lastShooter: 0 } };
    const near = withFly(s, 1, { pos: vec(0.2 + GRAB_REACH - 0.01, 0.1), heading: Math.PI });
    expect(canGrab(near, 1)).toBe(true);
    expect(canGrab(near, 0)).toBe(false); // player 0 just hit; not their clock
    expect(canGrab(withFly(s, 1, { pos: vec(0.2 + GRAB_REACH + 0.01, 0.1) }), 1)).toBe(false);
    expect(canGrab(withFly(near, 1, { phase: 'recover' }), 1)).toBe(false);

    const g = grabCue(near, DEMO_RULES, DEMO_PHYSICS, 1);
    expect(g.players[1].fly.carrying).toBe(true);
    expect(g.players[0].fly.carrying).toBe(false);
    expect(g.turn).toMatchObject({ kind: 'awaiting_shot', shooter: 1 });
    expect(g.cue.pos).toEqual(carryPoint(g.players[1].fly));
    expect(Math.hypot(g.cue.pos.x - g.players[1].fly.pos.x, g.cue.pos.y - g.players[1].fly.pos.y)).toBeCloseTo(CARRY_OFFSET, 12);
    expect(canGrab(g, 0)).toBe(false); // held: nobody else may take it
  });

  it('a serve throw in flight may not be picked up again until it has come to rest', () => {
    const cue: Ball = { pos: vec(0.2, 0.1), vel: vec(0, 0), pocketed: false };
    const s: MatchState = { ...free(base(), cue), turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 10, serveAttempt: 1 } };
    expect(canGrab(withFly(s, 0, { pos: vec(0.2, 0.15) }), 0)).toBe(false);
  });
});

describe('the clock: object ball stops', () => {
  const mark = (x: number, y: number, by: PlayerId, serveAttempt?: 1 | 2 | 3): ContactMark =>
    serveAttempt === undefined ? { objectPos: vec(x, y), by, tick: 400 } : { objectPos: vec(x, y), by, tick: 400, serveAttempt };

  it('six-inch rule: the object stops 0.05 m after the hit -> the hitter loses object_short_travel', () => {
    const s: MatchState = { ...free(base()), tick: 500, object: crawling(0.35, 0), turn: { kind: 'in_play', lastShooter: 0 } };
    const out = adjudicate(s, DEMO_RULES, [], mark(0.3, 0, 0));
    expect(lifeLost(out.events)).toEqual([{ kind: 'life_lost', player: 0, reason: 'object_short_travel', tick: 500 }]);
    expect(out.state.players[0].lives).toBe(2);
    expect(out.state.turn.kind).toBe('resolving');
  });

  it('the object travels 0.5 m after the hit and stops before the opponent hits it -> the opponent loses object_ball_stopped', () => {
    const s: MatchState = { ...free(base()), tick: 500, object: crawling(0.8, 0), turn: { kind: 'in_play', lastShooter: 0 } };
    const out = adjudicate(s, DEMO_RULES, [], mark(0.3, 0, 0));
    expect(lifeLost(out.events)).toEqual([{ kind: 'life_lost', player: 1, reason: 'object_ball_stopped', tick: 500 }]);
    expect(out.state.players[1].lives).toBe(2);
  });

  it('the same two outcomes apply once the opponent holds or has thrown the ball (awaiting_shot with a prior contact)', () => {
    const held = withFly({ ...free(base()), tick: 500, turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 600 } }, 1, { carrying: true });
    const short = adjudicate({ ...held, object: crawling(0.35, 0) }, DEMO_RULES, [], mark(0.3, 0, 0));
    expect(lifeLost(short.events)[0]).toMatchObject({ player: 0, reason: 'object_short_travel' });
    const slow = adjudicate({ ...held, object: crawling(0.8, 0) }, DEMO_RULES, [], mark(0.3, 0, 0));
    expect(lifeLost(slow.events)[0]).toMatchObject({ player: 1, reason: 'object_ball_stopped' });
  });

  it('contact hands the clock to the opponent immediately and records where the object ball was', () => {
    const s: MatchState = { ...free(base(), rolling(0.1, 0, 2, 0)), tick: 300, object: rolling(0.2, 0, 1.5, 0.1), turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 900 } };
    const out = adjudicate(s, DEMO_RULES, [{ kind: 'contact', tick: 300 }]);
    expect(out.state.turn).toEqual({ kind: 'in_play', lastShooter: 1 });
    expect(out.contact).toEqual({ objectPos: vec(0.2, 0), by: 1, tick: 300 });
    expect(isTurnOf(out.state.turn, 0)).toBe(true);
    expect(kinds(out.events)).toEqual(['contact']);
  });

  it('losing the last life ends the match', () => {
    const s0 = free(base());
    const players = s0.players.map((p) => (p.id === 1 ? { ...p, lives: 1 } : p)) as unknown as MatchState['players'];
    const s: MatchState = { ...s0, players, tick: 50, object: crawling(0.8, 0), turn: { kind: 'in_play', lastShooter: 0 } };
    const out = adjudicate(s, DEMO_RULES, [], mark(0.1, 0, 0));
    expect(kinds(out.events)).toEqual(['life_lost', 'match_over']);
    expect(out.state.turn).toEqual({ kind: 'over', winner: 0 });
  });
});

describe('pockets', () => {
  const pocket: RuleEvent = { kind: 'pocket', ball: 'object', tick: 900 };
  const sunk: Ball = { pos: vec(1.27, 0.635), vel: vec(0, 0), pocketed: true };

  it('in_play: the defender (other than the pocketer) loses under last_shooter; the pocketer under next_shooter', () => {
    const s: MatchState = { ...free(base()), tick: 900, object: sunk, turn: { kind: 'in_play', lastShooter: 0 } };
    const last = adjudicate(s, DEMO_RULES, [pocket]);
    expect(lifeLost(last.events)[0]).toMatchObject({ player: 1, reason: 'object_ball_pocketed' });
    const next = adjudicate(s, { ...DEMO_RULES, pocketPenalty: 'next_shooter' }, [pocket]);
    expect(lifeLost(next.events)[0]).toMatchObject({ player: 0, reason: 'object_ball_pocketed' });
  });

  it('awaiting_shot: the pocketer is whoever made the last contact, not the player holding the ball', () => {
    const s: MatchState = { ...free(base()), tick: 900, object: sunk, turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 950 } };
    const out = adjudicate(s, DEMO_RULES, [pocket], { objectPos: vec(0, 0), by: 0, tick: 800 });
    expect(lifeLost(out.events)[0]).toMatchObject({ player: 1, reason: 'object_ball_pocketed' });
  });

  it('a serve that pockets on contact is a successful serve: the receiver loses', () => {
    const s: MatchState = { ...free(base()), tick: 900, object: sunk, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 950, serveAttempt: 2 } };
    const out = adjudicate(s, DEMO_RULES, [{ kind: 'contact', tick: 900 }, pocket]);
    expect(lifeLost(out.events)[0]).toMatchObject({ player: 1, reason: 'object_ball_pocketed' });
    expect(kinds(out.events)).not.toContain('serve_fault');
  });

  it('a pocketed cue ball is never penalised: it respawns at the nearer end centre for the fetcher', () => {
    const cuePocket: RuleEvent = { kind: 'pocket', ball: 'cue', tick: 700 };
    const sunkCue: Ball = { pos: vec(1.27, -0.635), vel: vec(0, 0), pocketed: true };
    const s: MatchState = { ...free(base(), sunkCue), tick: 700, object: rolling(0, 0), turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 950 } };
    const out = adjudicate(withFlyAt(s, 1, 0.9, 0.2), DEMO_RULES, [cuePocket]);
    expect(lifeLost(out.events)).toEqual([]);
    expect(out.state.cue.pocketed).toBe(false);
    expect(out.state.cue.pos.x).toBeGreaterThan(0);
    expect(out.state.cue.vel).toEqual(vec(0, 0));
    expect(out.state.turn).toEqual(s.turn);
  });
});

describe('serve', () => {
  it('the initial state is a serve with the object stationary on the foot spot and the cue ball in the server\'s hand', () => {
    const s = base();
    expect(s.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 1 });
    expect(s.players[0].fly.carrying).toBe(true);
    expect(s.players[1].fly.carrying).toBe(false);
    expect(s.cue.pos).toEqual(carryPoint(s.players[0].fly));
    expect(s.object.vel).toEqual(vec(0, 0));
    expect(s.object.pos).toEqual(footSpot(s.table, DEMO_RULES, 1));
    expect(s.object.pos.x).toBeCloseTo(s.table.length / 2 - DEMO_RULES.footSpotInset, 12);
    expect(s.players[0].fly.pos.x).toBeLessThan(0);
    expect(s.players[1].fly.pos.x).toBeGreaterThan(0);
  });

  it('a stationary object ball during a serve costs nothing, while carrying or while the throw is in flight', () => {
    const carrying = adjudicate({ ...base(), tick: 40 }, DEMO_RULES, []);
    expect(carrying.events).toEqual([]);
    expect(carrying.state.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 1 });
    const inFlight: MatchState = { ...free(base(), rolling(-0.5, 0, 3, 0)), tick: 60, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 60, serveAttempt: 1 } };
    const out = adjudicate(inFlight, DEMO_RULES, []);
    expect(out.events).toEqual([]);
    expect(out.state.turn).toEqual(inFlight.turn);
  });

  it('the thrown cue ball stopping without contact is a serve fault; the third is three_serve_faults', () => {
    const stopped: Ball = { pos: vec(0.9, 0.3), vel: vec(0.001, 0), pocketed: false };
    const first: MatchState = { ...free(base(), stopped), tick: 700, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 60, serveAttempt: 1 } };
    const out1 = adjudicate(first, DEMO_RULES, []);
    expect(kinds(out1.events)).toEqual(['serve_fault']);
    expect(out1.state.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 2 });
    expect(out1.state.players[0].lives).toBe(3);
    // The object goes back to the foot spot, stationary; the cue lies where it stopped for the server to fetch.
    expect(out1.state.object.pos).toEqual(footSpot(first.table, DEMO_RULES, 1));
    expect(out1.state.object.vel).toEqual(vec(0, 0));
    expect(out1.state.cue).toEqual(stopped);
    expect(out1.state.players[0].fly.carrying).toBe(false);
    expect(out1.contact).toBeNull();

    const third = adjudicate({ ...first, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 60, serveAttempt: 3 } }, DEMO_RULES, []);
    expect(kinds(third.events)).toEqual(['serve_fault', 'life_lost']);
    expect(lifeLost(third.events)[0]).toMatchObject({ player: 0, reason: 'three_serve_faults' });
    expect(third.state.turn.kind).toBe('resolving');
  });

  it('a serve that contacts but moves the object under six inches is a serve fault, not a lost life', () => {
    const s: MatchState = { ...free(base()), tick: 800, object: crawling(1.05, 0), turn: { kind: 'in_play', lastShooter: 0 } };
    const out = adjudicate(s, DEMO_RULES, [], { objectPos: vec(1.1, 0), by: 0, tick: 700, serveAttempt: 1 });
    expect(kinds(out.events)).toEqual(['serve_fault']);
    expect(out.state.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 2 });
  });

  it('a pocketed serve throw without contact is a serve fault and the cue ball respawns', () => {
    const sunkCue: Ball = { pos: vec(1.27, 0.635), vel: vec(0, 0), pocketed: true };
    const s: MatchState = { ...free(base(), sunkCue), tick: 800, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 60, serveAttempt: 1 } };
    const out = adjudicate(s, DEMO_RULES, [{ kind: 'pocket', ball: 'cue', tick: 800 }]);
    expect(kinds(out.events)).toEqual(['pocket', 'serve_fault']);
    expect(out.state.cue.pocketed).toBe(false);
    expect(out.state.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 2 });
  });
});

describe('resolving', () => {
  it('after RESOLVE_TICKS the loser serves with the ball in hand; the object waits at the receiver\'s end', () => {
    const lost: RuleEvent = { kind: 'life_lost', player: 1, reason: 'object_ball_stopped', tick: 1000 };
    const turn: Turn = { kind: 'resolving', outcome: lost };
    // Player 1 (the loser) is standing at the x<0 end after chasing; player 0 (receiver) is mid-table on the x>0 side.
    let s: MatchState = { ...free(base()), tick: 1000 + RESOLVE_TICKS - 1, turn };
    s = withFlyAt(withFlyAt(s, 1, -1.0, 0.2), 0, 0.4, -0.3);
    const early = adjudicate(s, DEMO_RULES, [], { objectPos: vec(0, 0), by: 0, tick: 900 });
    expect(early.state.turn).toEqual(turn);

    const out = adjudicate({ ...s, tick: 1000 + RESOLVE_TICKS }, DEMO_RULES, [], { objectPos: vec(0, 0), by: 0, tick: 900 });
    expect(out.state.turn).toEqual({ kind: 'serve', shooter: 1, attempt: 1 });
    expect(out.state.players[1].fly.carrying).toBe(true);
    expect(out.state.players[0].fly.carrying).toBe(false);
    expect(out.state.cue.pos).toEqual(carryPoint(out.state.players[1].fly));
    expect(out.state.object.pos).toEqual(footSpot(s.table, DEMO_RULES, 1));
    expect(out.state.object.vel).toEqual(vec(0, 0));
    expect(out.contact).toBeNull();
  });
});
