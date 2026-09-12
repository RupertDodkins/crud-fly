import { describe, expect, it } from 'vitest';
import { vec } from '../../src/core/model';
import type { MatchState, PlayerId, RuleEvent } from '../../src/core/model';
import { DEMO_RULES, adjudicate, clampCommand, rulesInForce, validateShot } from '../../src/core/rules';
import { initialState } from '../../src/core/session';

function base(): MatchState {
  return initialState(3, DEMO_RULES, ['A', 'B']);
}

function withFlyAt(state: MatchState, player: PlayerId, x: number, y: number): MatchState {
  const players = state.players.map((p) => (p.id === player ? { ...p, fly: { ...p.fly, pos: vec(x, y) } } : p)) as unknown as MatchState['players'];
  return { ...state, players };
}

const lifeLost = (events: readonly RuleEvent[]) => events.filter((e) => e.kind === 'life_lost');

describe('rules', () => {
  it('object ball stopping during awaiting_shot costs the shooter a life', () => {
    const s: MatchState = { ...base(), tick: 500, object: { pos: vec(0.3, 0.1), vel: vec(0.005, 0), pocketed: false }, turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 600 } };
    const out = adjudicate(s, DEMO_RULES, []);
    expect(lifeLost(out.events)).toEqual([{ kind: 'life_lost', player: 1, reason: 'object_ball_stopped', tick: 500 }]);
    expect(out.state.players[1].lives).toBe(2);
    expect(out.state.turn.kind).toBe('resolving');
  });

  it('a stopped object ball during a serve is a serve fault, not a lost life, until attempts run out', () => {
    const rolling = { pos: vec(0.3, 0.1), vel: vec(0.001, 0), pocketed: false };
    const first = adjudicate({ ...base(), tick: 10, object: rolling, turn: { kind: 'serve', shooter: 0, attempt: 1 } }, DEMO_RULES, []);
    expect(first.events.map((e) => e.kind)).toEqual(['serve_fault']);
    expect(first.state.turn).toEqual({ kind: 'serve', shooter: 0, attempt: 2 });
    const third = adjudicate({ ...base(), tick: 10, object: rolling, turn: { kind: 'awaiting_shot', shooter: 0, deadlineTick: 20, serveAttempt: 3 } }, DEMO_RULES, []);
    expect(third.events.map((e) => e.kind)).toEqual(['serve_fault', 'life_lost']);
    expect(lifeLost(third.events)[0]).toMatchObject({ player: 0, reason: 'three_serve_faults' });
  });

  it('shooting from outside the short-end zone is shot_from_long_side', () => {
    const s = withFlyAt(base(), 0, 0, 0);
    expect(validateShot(s, DEMO_RULES, 0, { angle: 0, force: 0.5 })).toBe('shot_from_long_side');
    const legal = withFlyAt(base(), 0, -1.1, 0);
    expect(validateShot(legal, DEMO_RULES, 0, { angle: 0, force: 0.5 })).toBeNull();
    expect(validateShot(legal, DEMO_RULES, 0, { angle: Math.PI, force: 0.5 })).toBe('shot_backwards');
    const out = adjudicate(s, DEMO_RULES, [{ kind: 'life_lost', player: 0, reason: 'shot_from_long_side', tick: s.tick }]);
    expect(out.state.players[0].lives).toBe(2);
    expect(out.state.log.length).toBe(0);
    expect(lifeLost(out.events)[0]).toMatchObject({ reason: 'shot_from_long_side' });
  });

  it('a pocketed object ball costs a life per pocketPenalty', () => {
    const s: MatchState = { ...base(), tick: 900, object: { pos: vec(1.27, 0.635), vel: vec(0, 0), pocketed: true }, turn: { kind: 'in_play', lastShooter: 0 } };
    const pocket: RuleEvent = { kind: 'pocket', ball: 'object', tick: 900 };
    const last = adjudicate(s, DEMO_RULES, [pocket]);
    expect(lifeLost(last.events)[0]).toMatchObject({ player: 0, reason: 'object_ball_pocketed' });
    const next = adjudicate(s, { ...DEMO_RULES, pocketPenalty: 'next_shooter' }, [pocket]);
    expect(lifeLost(next.events)[0]).toMatchObject({ player: 1, reason: 'object_ball_pocketed' });
  });

  it('losing the last life ends the match', () => {
    const s0 = base();
    const players = s0.players.map((p) => (p.id === 1 ? { ...p, lives: 1 } : p)) as unknown as MatchState['players'];
    const s: MatchState = { ...s0, players, tick: 50, object: { pos: vec(0, 0), vel: vec(0, 0), pocketed: false }, turn: { kind: 'awaiting_shot', shooter: 1, deadlineTick: 60 } };
    const out = adjudicate(s, DEMO_RULES, []);
    expect(out.events.map((e) => e.kind)).toEqual(['life_lost', 'match_over']);
    expect(out.state.turn).toEqual({ kind: 'over', winner: 0 });
  });

  it('clampCommand caps force and folds backward angles into the table half-plane', () => {
    const s = base();
    const c = clampCommand(s, DEMO_RULES, 0, { kind: 'shoot', shot: { angle: Math.PI - 0.1, force: 2 } });
    expect(c.kind).toBe('shoot');
    if (c.kind === 'shoot') {
      expect(c.shot.force).toBe(1);
      expect(Math.cos(c.shot.angle)).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(rulesInForce(DEMO_RULES)).toBeGreaterThan(0);
    expect(rulesInForce({ ...DEMO_RULES, forbidLongSideShots: false })).toBe(rulesInForce(DEMO_RULES) - 1);
  });
});
