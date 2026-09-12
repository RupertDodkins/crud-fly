import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/core/session';
import { DEMO_RULES } from '../../src/core/rules';
import { DEMO_PHYSICS, DT } from '../../src/core/physics';
import { createHeuristic } from '../../src/controllers/heuristic';
import { parseTape, replayTape } from '../../src/replay/codec';

function run(seed: number, seconds: number) {
  const session = createSession({
    seed,
    rules: DEMO_RULES,
    physics: DEMO_PHYSICS,
    controllers: [createHeuristic('a', seed), createHeuristic('b', seed + 1)],
    hashEvery: 30,
  });
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) session.step();
  return session;
}

describe('session', () => {
  it('same seed twice produces an identical hash sequence', () => {
    const a = run(7, 10).tape();
    const b = run(7, 10).tape();
    expect(a.hashes.length).toBeGreaterThan(10);
    expect(b.hashes).toEqual(a.hashes);
    expect(run(8, 10).tape().hashes).not.toEqual(a.hashes);
  });

  it('a 20 s tape replays with matching hashes, including through JSON', () => {
    const tape = run(11, 20).tape();
    expect(replayTape(tape).ok).toBe(true);
    const roundTrip = parseTape(JSON.parse(JSON.stringify(tape)));
    expect(replayTape(roundTrip).ok).toBe(true);
    expect(() => parseTape({ ...tape, commands: 'nope' })).toThrow();
    expect(() => parseTape({ ...tape, version: 99 })).toThrow();
  });

  it('a 30 s heuristic match produces contacts and at least one lost life', () => {
    const frame = run(7, 30).frame();
    const count = (kind: string) => frame.log.filter((e) => e.kind === kind).length;
    expect(count('contact')).toBeGreaterThanOrEqual(3);
    expect(count('life_lost')).toBeGreaterThanOrEqual(1);
    expect(count('legal_shot')).toBeGreaterThanOrEqual(3);
    // No fly ever struck from outside its zone: the heuristic honours the stance rule.
    expect(frame.log.some((e) => e.kind === 'life_lost' && e.reason === 'shot_from_long_side')).toBe(false);
  });

  it('a tampered tape fails replay', () => {
    const tape = run(3, 5).tape();
    const shoot = tape.commands.findIndex((c) => c.cmd.kind === 'shoot');
    expect(shoot).toBeGreaterThanOrEqual(0);
    const commands = tape.commands.map((c, i) => (i === shoot && c.cmd.kind === 'shoot' ? { ...c, cmd: { kind: 'shoot' as const, shot: { ...c.cmd.shot, angle: c.cmd.shot.angle + 0.5 } } } : c));
    expect(replayTape({ ...tape, commands }).ok).toBe(false);
  });
});
