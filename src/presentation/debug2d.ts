import type { Frame, PlayerId, RuleEvent, Vec2 } from '../core/model';
import { DEMO_RULES, legalZone } from '../core/rules';

const RAIL = 0.09;
const CLOTH = '#2e7d4f';
const RAIL_COLOUR = '#5a3a1e';
const FLY_COLOURS: readonly [string, string] = ['#1b1b1b', '#2a1f3d'];
const ZONE_COLOURS: readonly [string, string] = ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.10)'];

function describe(e: RuleEvent): string {
  switch (e.kind) {
    case 'life_lost':
      return `LIFE LOST P${e.player}: ${e.reason.replace(/_/g, ' ')}`;
    case 'serve_fault':
      return `SERVE FAULT P${e.player} (${e.attempt})`;
    case 'legal_shot':
      return `SHOT P${e.player}`;
    case 'contact':
      return 'CONTACT';
    case 'pocket':
      return `POCKET: ${e.ball} ball`;
    case 'match_over':
      return `MATCH OVER: P${e.winner} wins`;
  }
}

/**
 * Phase 1 top-down renderer on a 2D canvas. Development preview and GIF insurance. Draws table,
 * pockets, balls, flies as triangles, legal zones, the rule-log tail and lives. Reads Frame only.
 */
export function drawDebug(ctx: CanvasRenderingContext2D, frame: Frame, hud?: Readonly<Record<string, number>>): void {
  const { table } = frame;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const scale = Math.min(W / (table.length + 2 * RAIL + 0.2), H / (table.width + 2 * RAIL + 0.6));
  const cx = W / 2;
  const cy = H / 2;
  const toX = (x: number): number => cx + x * scale;
  const toY = (y: number): number => cy + y * scale;
  const px = (m: number): number => m * scale;

  ctx.fillStyle = '#12161a';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = RAIL_COLOUR;
  ctx.fillRect(toX(-table.length / 2 - RAIL), toY(-table.width / 2 - RAIL), px(table.length + 2 * RAIL), px(table.width + 2 * RAIL));
  ctx.fillStyle = CLOTH;
  ctx.fillRect(toX(-table.length / 2), toY(-table.width / 2), px(table.length), px(table.width));

  for (const p of [0, 1] as const) {
    const zone = legalZone(table, DEMO_RULES, p);
    ctx.fillStyle = ZONE_COLOURS[p];
    ctx.fillRect(toX(zone.xMin), toY(-table.width / 2), px(zone.xMax - zone.xMin), px(table.width));
  }

  ctx.fillStyle = '#050505';
  for (const pocket of table.pockets) {
    ctx.beginPath();
    ctx.arc(toX(pocket.x), toY(pocket.y), px(table.pocketRadius), 0, Math.PI * 2);
    ctx.fill();
  }

  const drawBall = (pos: Vec2, pocketed: boolean, colour: string): void => {
    if (pocketed) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(toX(pos.x), toY(pos.y), px(table.ballRadius), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  drawBall(frame.object.pos, frame.object.pocketed, '#d3372b');
  drawBall(frame.cue.pos, frame.cue.pocketed, '#f4f1e8');

  for (const player of frame.players) {
    const { fly } = player;
    const size = px(0.05);
    ctx.save();
    ctx.translate(toX(fly.pos.x), toY(fly.pos.y));
    ctx.rotate(fly.heading);
    ctx.fillStyle = FLY_COLOURS[player.id];
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.6);
    ctx.lineTo(-size * 0.7, -size * 0.6);
    ctx.closePath();
    ctx.fill();
    if (fly.phase === 'aim' || fly.phase === 'strike') {
      ctx.strokeStyle = fly.phase === 'strike' ? '#ffd166' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(size * 3, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.font = '13px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';
  const drawLives = (id: PlayerId, x: number, align: CanvasTextAlign): void => {
    const player = frame.players[id];
    ctx.textAlign = align;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(player.name.toUpperCase(), x, 10);
    for (let i = 0; i < player.lives; i++) {
      const dx = align === 'left' ? x + 6 + i * 16 : x - 6 - i * 16;
      ctx.beginPath();
      ctx.arc(dx, 34, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  drawLives(0, 12, 'left');
  drawLives(1, W - 12, 'right');

  ctx.textAlign = 'left';
  ctx.fillStyle = '#c9c9c9';
  const tail = frame.log.slice(-5);
  tail.forEach((e, i) => {
    ctx.fillText(describe(e), 12, H - 12 - (tail.length - i) * 16);
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#9fb3c8';
  const turn = frame.turn;
  const turnText =
    turn.kind === 'over'
      ? `OVER: P${turn.winner} WINS`
      : turn.kind === 'in_play'
        ? `IN PLAY (P${turn.lastShooter} hit)`
        : turn.kind === 'resolving'
          ? 'RESOLVING'
          : `${turn.kind.toUpperCase().replace('_', ' ')}: P${turn.shooter}`;
  ctx.fillText(turnText, cx, 10);

  if (hud) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9fb3c8';
    let row = 0;
    for (const key of Object.keys(hud)) {
      const v = hud[key];
      if (v === undefined) continue;
      ctx.fillText(`${key.toUpperCase()}  ${Number.isInteger(v) ? v : v.toFixed(3)}`, W - 12, 52 + row * 16);
      row += 1;
    }
  }
}
