// Re-run a tape and dump 30 fps frames to tools/out/frames.json for a browser page to play back.
// Usage: npx tsx tools/record.ts [tape=public/replays/hero.json] [fps=30]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, replayController } from '../src/core/session';
import { parseTape } from '../src/replay/codec';
import { DT } from '../src/core/physics';
import type { PlayerCommand } from '../src/core/model';

const here = dirname(fileURLToPath(import.meta.url));
const tapePath = resolve(here, '..', process.argv[2] ?? 'public/replays/hero.json');
const fps = Number(process.argv[3] ?? 30);
const tape = parseTape(JSON.parse(readFileSync(tapePath, 'utf8')));

const byPlayer: [Map<number, PlayerCommand>, Map<number, PlayerCommand>] = [new Map(), new Map()];
for (const c of tape.commands) byPlayer[c.player].set(c.tick, c.cmd);
const session = createSession({
  seed: tape.seed,
  rules: tape.rules,
  physics: tape.physics,
  controllers: [replayController(tape.controllerIds[0], byPlayer[0]), replayController(tape.controllerIds[1], byPlayer[1])],
  names: tape.names,
});

const every = Math.max(1, Math.round(1 / (fps * DT)));
const frames: unknown[] = [];
for (let i = 0; i <= tape.finalTick; i++) {
  if (i % every === 0) {
    const f = session.frame();
    frames.push({
      tick: f.tick,
      cue: f.cue,
      object: f.object,
      flies: f.players.map((p) => ({ pos: p.fly.pos, heading: p.fly.heading, phase: p.fly.phase })),
      lives: f.players.map((p) => p.lives),
      turn: f.turn.kind,
      logLen: f.log.length,
    });
  }
  if (i < tape.finalTick) session.step();
}

const out = resolve(here, 'out/frames.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ fps, table: session.frame().table, log: session.frame().log, frames }));
console.log(`wrote ${frames.length} frames at ${fps} fps to ${out}`);
console.log('Once a browser page renders tools/out/frames.json to PNGs in tools/out/png/, encode with:');
console.log(`  ffmpeg -framerate ${fps} -i tools/out/png/%05d.png -c:v libvpx-vp9 -pix_fmt yuv420p tools/out/hero.webm`);
