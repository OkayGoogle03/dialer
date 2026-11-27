export interface Point { x: number; y: number }

const EDGE = 8;

/** Keeps the whole popup on the screen (its top left corner wins if the screen is smaller than the popup). */
export function clampPosition(p: Point, size: { width: number; height: number }, view: { width: number; height: number }): Point {
  const fit = (v: number, length: number, room: number) => Math.max(EDGE, Math.min(v, room - length - EDGE));
  return { x: fit(p.x, size.width, view.width), y: fit(p.y, size.height, view.height) };
}
