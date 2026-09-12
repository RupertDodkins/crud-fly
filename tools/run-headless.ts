// Heuristic vs heuristic for N seconds; writes public/replays/hero.json and verifies it replays.
// Usage: npx tsx tools/run-headless.ts [seconds=30] [seed=7]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../src/core/session';
import { DEMO_RULES } from '../src/core/rules';
import { DEMO_PHYSICS, DT } from '../src/core/physics';
import { createHeuristic } from '../src/controllers/heuristic';
import { replayTape } from '../src/replay/codec';
import type { RuleEvent } from '../src/core/model';

const seconds = Number(process.argv[2] ?? 30);
const seed = Number(process.argv[3] ?? 7);
const ticks = Math.round(seconds / DT);

const session = createSession({
  seed,
  rules: DEMO_RULES,
  physics: DEMO_PHYSICS,
  controllers: [createHeuristic('heuristic-a', seed), createHeuristic('heuristic-b', seed + 1)],
  names: ['Fly A', 'Fly B'],
});
for (let i = 0; i < ticks; i++) session.step();

const frame = session.frame();
const counts = new Map<string, number>();
for (const e of frame.log) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);

const describe = (e: RuleEvent): string => {
  const t = (e.tick * DT).toFixed(2).padStart(6);
  switch (e.kind) {
    case 'life_lost':
      return `${t}s  LIFE LOST  P${e.player}  ${e.reason}`;
    case 'serve_fault':
      return `${t}s  serve fault  P${e.player}  attempt ${e.attempt}`;
    case 'legal_shot':
      return `${t}s  shot  P${e.player}`;
    case 'contact':
      return `${t}s  contact`;
    case 'pocket':
      return `${t}s  pocket  ${e.ball}`;
    case 'match_over':
      return `${t}s  MATCH OVER  winner P${e.winner}`;
  }
};

console.log(`seed=${seed} seconds=${seconds} ticks=${ticks}`);
for (const e of frame.log) console.log(describe(e));
console.log('--- counts by kind');
for (const [k, v] of [...counts.entries()].sort()) console.log(`${k.padEnd(12)} ${v}`);
console.log(`lives: P0=${frame.players[0].lives} P1=${frame.players[1].lives}  turn=${frame.turn.kind}`);

const tape = session.tape();
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/replays/hero.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(tape));
console.log(`wrote ${out} (${tape.commands.length} commands, ${tape.hashes.length} hashes)`);

const check = replayTape(tape);
console.log(`replay ok=${check.ok}`);
if (!check.ok) process.exit(1);
