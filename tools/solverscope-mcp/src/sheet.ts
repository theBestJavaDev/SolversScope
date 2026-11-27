// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Contact-sheet layout and tiling: n frames into one image, long edge capped. Pure functions (no server needed). */

import { PNG } from "pngjs";

export const MAX_EDGE = 1568;

export type SheetLayout = { columns: number; rows: number; tileWidth: number; tileHeight: number; width: number; height: number };

/** Picks columns so the sheet is close to the tile aspect ratio, then sizes tiles so the long edge is <= maxEdge. */
export function layoutSheet(n: number, aspect = 16 / 9, maxEdge = MAX_EDGE): SheetLayout {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  let best: SheetLayout | null = null;
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    // Largest tile width such that the whole sheet fits in maxEdge x maxEdge
    const tileWidth = Math.floor(Math.min(maxEdge / columns, (maxEdge / rows) * aspect));
    const tileHeight = Math.round(tileWidth / aspect);
    const layout = { columns, rows, tileWidth, tileHeight, width: columns * tileWidth, height: rows * tileHeight };
    // Prefer bigger tiles; ties go to fewer rows
    if (best === null || layout.tileWidth > best.tileWidth) best = layout;
  }
  return best!;
}

/** Evenly spaced times across [start, end], including both ends (one frame: the middle). */
export function evenTimes(start: number, end: number, n: number): number[] {
  if (n === 1) return [(start + end) / 2];
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1));
}

/** Tiles PNG buffers (all tileWidth x tileHeight) row-major into one PNG. */
export function tile(tiles: Buffer[], layout: SheetLayout): Buffer {
  const out = new PNG({ width: layout.width, height: layout.height });
  out.data.fill(16); // Dark gutter color for unused cells
  for (let i = 0; i < out.data.length; i += 4) out.data[i + 3] = 255;
  tiles.forEach((buffer, index) => {
    const png = PNG.sync.read(buffer);
    if (png.width !== layout.tileWidth || png.height !== layout.tileHeight) {
      throw new Error(`tile ${index} is ${png.width}x${png.height}, expected ${layout.tileWidth}x${layout.tileHeight}`);
    }
    const x0 = (index % layout.columns) * layout.tileWidth;
    const y0 = Math.floor(index / layout.columns) * layout.tileHeight;
    for (let y = 0; y < png.height; y++) {
      png.data.copy(out.data, ((y0 + y) * layout.width + x0) * 4, y * png.width * 4, (y + 1) * png.width * 4);
    }
  });
  return PNG.sync.write(out);
}
