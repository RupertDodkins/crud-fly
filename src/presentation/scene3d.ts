import type { Frame } from '../core/model';

/**
 * Phase 3. Three.js diorama: table plus flies ported from flyway-surfer `dist/scene.js` (MIT):
 * makeFly() geometry, wing/leg animation, palette, lighting, shadow and camera setup.
 * Reads Frame only. Never holds the live MatchState.
 */
export interface Scene3D {
  update(frame: Frame, dt: number): void;
  resize(w: number, h: number): void;
  readonly canvas: HTMLCanvasElement;
}

export function createScene3D(container: HTMLElement): Scene3D {
  throw new Error('not implemented');
}
