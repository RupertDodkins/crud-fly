import type { BrainView } from '../controllers/connectome-pilot';

/** Fixed schematic positions; colour comes only from current model rates. */
export function createNeuralActivity(view: BrainView): { canvas: HTMLCanvasElement; draw(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 350;
  const ctx = canvas.getContext('2d')!;
  function draw(): void {
    const rates = view.rates();
    ctx.fillStyle = '#0f2a24';
    ctx.fillRect(0, 0, 600, 350);
    ctx.font = '20px Menlo, Consolas, monospace';
    ctx.fillStyle = '#f8edc5';
    ctx.fillText('SIMULATED NEURAL ACTIVITY', 22, 32);
    ctx.font = '15px Menlo, Consolas, monospace';
    ctx.fillStyle = '#87c9b1';
    ctx.fillText('Schematic layout · one dot per neuron', 22, 57);
    const peak = Math.max(0.001, ...rates);
    const groups = ['L', 'M', 'R'] as const;
    groups.forEach((side, group) => {
      const neurons = view.neurons.filter(n => n.side === side);
      const columns = 18;
      neurons.forEach((n, i) => {
        const rate = rates[n.index] ?? 0;
        const intensity = Math.sqrt(rate / peak);
        ctx.fillStyle = `rgb(${Math.round(45 + 172 * intensity)},${Math.round(82 + 171 * intensity)},${Math.round(70 + 32 * intensity)})`;
        ctx.beginPath();
        ctx.arc(25 + group * 194 + (i % columns) * 9.3, 88 + Math.floor(i / columns) * 7.1, 2.6, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = '#87c9b1';
      ctx.fillText(side === 'L' ? 'LEFT' : side === 'R' ? 'RIGHT' : 'MIDLINE', 25 + group * 194, 306);
    });
    ctx.fillText('Relative model rates · shot decisions', 22, 333);
  }
  return { canvas, draw };
}
