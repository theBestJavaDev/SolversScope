// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Virtual clock for offline rendering: frame times and motion-blur subframes. Pure math, no wall clock. */

export type SubTime = { t: number; weight: number };

/** Time of output frame `index` (exactly index / fps after `start`, no accumulated error). */
export function frameTime(start: number, index: number, fps: number): number {
  return start + index / fps;
}

/** Number of frames in [start, end) at fps (the last frame is the last one strictly before `end`). */
export function frameCount(start: number, end: number, fps: number): number {
  return Math.max(1, Math.ceil((end - start) * fps - 1e-9));
}

/**
 * Motion-blur subframes for the frame at time `t`: `samples` instants evenly spread over the shutter interval
 * (`shutterDegrees`/360 of a frame, default 180 = half a frame), centered on `t`, each weighted 1/samples.
 * One sample returns exactly `t`, so preview_frame(t) matches an unblurred render frame.
 */
export function subframeTimes(t: number, fps: number, samples: number, shutterDegrees = 180): SubTime[] {
  const n = Math.max(1, Math.floor(samples));
  if (n === 1) return [{ t, weight: 1 }];
  const span = (shutterDegrees / 360) / fps;
  return Array.from({ length: n }, (_, i) => ({ t: t + ((i + 0.5) / n - 0.5) * span, weight: 1 / n }));
}
