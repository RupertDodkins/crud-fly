import type { Frame } from '../core/model';

/**
 * Phase 1 top-down renderer on a 2D canvas. Development preview and GIF insurance. Draws table,
 * pockets, balls, flies as triangles, legal zones, the rule-log tail and lives. Reads Frame only.
 */
export function drawDebug(ctx: CanvasRenderingContext2D, frame: Frame, hud?: Readonly<Record<string, number>>): void {
  throw new Error('not implemented');
}
