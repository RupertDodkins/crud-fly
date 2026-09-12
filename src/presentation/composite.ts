import type { Frame } from '../core/model';
import type { PilotTelemetry } from '../controllers/connectome-pilot';

/**
 * Record-mode compositor: the 3D canvas plus a canvas-drawn HUD in one 1280x720 surface so
 * MediaRecorder captures both. Mirrors the DOM HUD in main.ts; same labels, same numbers.
 */
export interface HudData {
  readonly title: string;
  readonly telemetry: PilotTelemetry | null;
  readonly rulesInForce: number;
  readonly totalRules: number;
  readonly startingLives: number;
  readonly logTail: readonly string[];
  readonly finePrint: string;
}

const W = 1280;
const H = 720;
const HUD_W = 320;

const mint = '#87c9b1';
const cream = '#f8edc5';
const lime = '#d9fd66';
const pink = '#f34684';
const panel = '#0f2a24';

export function createComposite(): { canvas: HTMLCanvasElement; draw(scene: HTMLCanvasElement, frame: Frame, hud: HudData): void } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const mono = 'Menlo, Consolas, monospace';
  const trace: { tick: number; left: number; right: number }[] = [];

  function wrap(text: string, x: number, y: number, maxWidth: number, lineHeight: number): number {
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        y += lineHeight;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
    return y + lineHeight;
  }

  function draw(scene: HTMLCanvasElement, frame: Frame, hud: HudData): void {
    const sceneW = W - HUD_W;
    const scale = Math.min(sceneW / scene.width, H / scene.height);
    const dw = scene.width * scale;
    const dh = scene.height * scale;
    ctx.fillStyle = '#a9dccb';
    ctx.fillRect(0, 0, sceneW, H);
    ctx.drawImage(scene, (sceneW - dw) / 2, (H - dh) / 2, dw, dh);

    ctx.fillStyle = panel;
    ctx.fillRect(sceneW, 0, HUD_W, H);
    const x = sceneW + 20;
    let y = 34;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = lime;
    ctx.font = `600 12px ${mono}`;
    ctx.fillText(hud.title.toUpperCase(), x, y);
    y += 30;
    const t = hud.telemetry;
    if (t) {
      ctx.fillStyle = lime;
      ctx.font = `600 44px ${mono}`;
      ctx.fillText(t.dnLeft.toFixed(2), x, y + 8);
      ctx.fillStyle = mint;
      ctx.font = `11px ${mono}`;
      ctx.fillText('DN LEFT', x + 145, y + 8);
      y += 46;
      ctx.fillStyle = lime;
      ctx.font = `600 44px ${mono}`;
      ctx.fillText(t.dnRight.toFixed(2), x, y + 8);
      ctx.fillStyle = mint;
      ctx.font = `11px ${mono}`;
      ctx.fillText('DN RIGHT', x + 145, y + 8);
      y += 36;
      ctx.fillStyle = cream;
      ctx.font = `13px ${mono}`;
      ctx.fillText(`steer ${(t.angleOffset * (180 / Math.PI)).toFixed(1)}°  force ${t.force.toFixed(2)}`, x, y);
      y += 20;
      ctx.fillText(`${t.neuronCount} neurons · ${t.edgeCount} edges`, x, y);
      y += 20;
      ctx.fillText(`activity ${t.activity.toFixed(1)}`, x, y);
      y += 34;
      if (trace.length && frame.tick < trace[trace.length - 1]!.tick) trace.length = 0;
      if (trace[trace.length - 1]?.tick !== frame.tick) trace.push({ tick: frame.tick, left: t.dnLeft, right: t.dnRight });
      while (trace.length > 120) trace.shift();
      ctx.fillStyle = '#193e35'; ctx.fillRect(x, y, HUD_W - 40, 52);
      const peak = Math.max(1, ...trace.flatMap(p => [Math.abs(p.left), Math.abs(p.right)]));
      for (const side of ['left', 'right'] as const) {
        ctx.strokeStyle = side === 'left' ? lime : mint; ctx.lineWidth = 1.5; ctx.beginPath();
        trace.forEach((p, i) => { const px = x + i / 119 * (HUD_W - 40), py = y + 46 - p[side] / peak * 40; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.stroke();
      }
      y += 80;
    }
    const [a, b] = frame.players;
    const lives = (n: number) => '●'.repeat(n) + '○'.repeat(Math.max(0, hud.startingLives - n));
    ctx.fillStyle = cream;
    ctx.font = `600 15px ${mono}`;
    ctx.fillText(`${a.name} ${lives(a.lives)}   ${lives(b.lives)} ${b.name}`, x, y);
    y += 28;
    ctx.font = `13px ${mono}`;
    ctx.fillText(`RULES IN FORCE: ${hud.rulesInForce} / ${hud.totalRules}`, x, y);
    y += 26;
    ctx.fillStyle = pink;
    ctx.font = `12px ${mono}`;
    for (const line of hud.logTail) {
      y = wrap(line, x, y, HUD_W - 40, 16);
    }
    ctx.fillStyle = mint;
    ctx.font = `11px ${mono}`;
    wrap(hud.finePrint, x, H - 96, HUD_W - 40, 15);
  }

  return { canvas, draw };
}
