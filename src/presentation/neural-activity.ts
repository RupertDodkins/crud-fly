import type { BrainView } from '../controllers/connectome-pilot';

/** Fixed schematic positions; colour comes only from current model rates. */
export function createNeuralActivity(view: BrainView): { canvas: HTMLCanvasElement; ready(): boolean; draw(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 350;
  const ctx = canvas.getContext('2d')!;
  const anatomy = view.soma;
  let ready = !anatomy;
  const backdrop = document.createElement('canvas');
  backdrop.width = 600; backdrop.height = 350;
  const background = backdrop.getContext('2d')!;
  function project(x: number, z: number): [number, number] {
    if (!anatomy) return [0, 0];
    const extentX = anatomy.bbox.max[0] - anatomy.bbox.min[0];
    const extentZ = anatomy.bbox.max[2] - anatomy.bbox.min[2];
    const scale = Math.min(550 / extentZ, 230 / extentX);
    return [25 + (z - anatomy.bbox.min[2]) * scale, 78 + (x - anatomy.bbox.min[0]) * scale];
  }
  if (anatomy) {
    void fetch(anatomy.backdrop.url).then(response => {
      if (!response.ok) throw new Error(`Soma backdrop: ${response.status}`);
      return response.arrayBuffer();
    }).then(buffer => {
      const xyz = new Float32Array(buffer);
      ready = true;
      background.fillStyle = '#42665e';
      for (let i = 0; i + 2 < xyz.length; i += 3) {
        const [x, y] = project(xyz[i]!, xyz[i + 2]!);
        background.fillRect(x, y, 0.7, 0.7);
      }
    }).catch(error => console.error('Soma backdrop unavailable', error));
  }

  function draw(): void {
    const rates = view.rates();
    ctx.fillStyle = '#0f2a24';
    ctx.fillRect(0, 0, 600, 350);
    ctx.font = '20px Menlo, Consolas, monospace';
    ctx.fillStyle = '#f8edc5';
    ctx.fillText('SIMULATED NEURAL ACTIVITY', 22, 32);
    ctx.font = '15px Menlo, Consolas, monospace';
    ctx.fillStyle = '#87c9b1';
    ctx.fillText(anatomy ? 'Real soma positions · MaleCNS v1.0' : 'Schematic layout · one dot per neuron', 22, 57);
    const peak = Math.max(0.001, ...rates);
    if (anatomy) {
      ctx.drawImage(backdrop, 0, 0);
      view.neurons.forEach(n => {
        const x = anatomy.um[n.index * 3]!, z = anatomy.um[n.index * 3 + 2]!;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        const rate = rates[n.index] ?? 0;
        if (rate <= 0) return;
        const intensity = Math.sqrt(rate / peak);
        const [px, py] = project(x, z);
        ctx.fillStyle = `rgba(217,253,102,${0.2 + 0.8 * intensity})`;
        ctx.beginPath(); ctx.arc(px, py, 0.8 + 1.2 * intensity, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = '#87c9b1';
      ctx.fillText(`Grey: static CNS · ${anatomy.missing} units unlocated`, 22, 316);
      ctx.fillText('Lime: relative simulated activity', 22, 337);
      return;
    }
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
  return { canvas, draw, ready: () => ready };
}
