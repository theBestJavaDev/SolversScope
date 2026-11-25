// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * FLOWER pickup animation.
 *
 * The robot sim moves a POLLEN from a FLOWER into the robot in one tick when the pollinator's wedge takes it
 * (`<id> SCORED->HELD pollinator-wedge`), and the POLLEN above it drop one slot in the same tick, so on screen the ball
 * simply vanishes from the FLOWER and shows up in the robot. This replays those pickups as motion:
 *
 *  - the balls above the one taken glide down one slot (they roll down the FLOWER), and
 *  - the ball taken rolls out of the bottom of the FLOWER along the floor and up into the robot, arriving exactly
 *    where the robot's hold draws it (`Field/HeldPollen`) when the sim says it is held.
 *
 * It reads the log's plain POLLEN list (`Field/Pollen`, which has no ball ids) and finds each ball by where it sits: the
 * FLOWER columns come from the first frame, and the ball taken is the lowest one in the column the wedge is facing.
 * The result is a copy of the list (FLOWER_POLLEN_KEY) the 3D views draw instead of the plain one; the log's own data is
 * untouched.
 */

import { FLOWER_POLLEN_KEY, POLLEN_LIST_KEY, usePollenSource } from "./missMask";
const HELD_KEY = "RealOutputs/Field/HeldPollen";
const ROBOT = "RealOutputs/Field/Robot";

/**
 * Seconds the balls above glide down one slot, and the ball taken spends rolling out into the robot. The sim takes a
 * ball every 0.19 s, so the balls after the first have GLIDE + ROLL = 0.19 s; the first ball of a burst has no ball
 * before it, so it starts rolling earlier, when the wedge touches it (FIRST_ROLL_SECONDS before the sim counts it held).
 */
const GLIDE_SECONDS = 0.08;
const ROLL_SECONDS = 0.11;
const FIRST_ROLL_SECONDS = 0.3;
const BURST_GAP_SECONDS = 0.5;
/** The 2.8 in POLLEN stack in a FLOWER: slot spacing (m), and the lowest slot's height is read from the log. */
const SLOT = 2.8 * 0.0254;
const POLLEN_RADIUS = 1.4 * 0.0254;
/** The robot's intake front (m ahead of its center) and the wedge's tip: the ball rolls to the first, from the FLOWER at the second. */
const INTAKE_FRONT = 10.064 * 0.0254;
const WEDGE_TIP = 13.21 * 0.0254;

type Vec = [number, number, number];

/** A FLOWER's column of balls: its axis and the height of the lowest slot. */
interface Column {
  x: number;
  y: number;
  bottomZ: number;
}

function parseList(bytes: Uint8Array): Vec[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Vec[] = [];
  for (let i = 0; (i + 1) * 24 <= bytes.byteLength; i++) {
    out.push([view.getFloat64(i * 24, true), view.getFloat64(i * 24 + 8, true), view.getFloat64(i * 24 + 16, true)]);
  }
  return out;
}

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec, b: Vec, t: number): Vec => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const near = (a: Vec, b: Vec, tolerance = 2e-4) =>
  Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance && Math.abs(a[2] - b[2]) < tolerance;

/** The FLOWER columns: groups of POLLEN standing one above another at the same spot, read from the first frame. */
export function findColumns(list: Vec[]): Column[] {
  const columns: { x: number; y: number; zs: number[] }[] = [];
  for (const [x, y, z] of list) {
    if (z < POLLEN_RADIUS * 1.2 || z > 0.4) continue; // floor balls sit at one radius; CELLs and flight are higher/lower
    let column = columns.find((c) => Math.hypot(c.x - x, c.y - y) < 0.02);
    if (column === undefined) {
      column = { x, y, zs: [] };
      columns.push(column);
    }
    column.zs.push(z);
  }
  return columns.filter((c) => c.zs.length >= 2).map((c) => ({ x: c.x, y: c.y, bottomZ: Math.min(...c.zs) }));
}

/** When the wedge took a ball out of a FLOWER (from the sim's own bookkeeping), once per ball. */
function wedgePickups(): number[] {
  const times: number[] = [];
  for (const key of window.log.getFieldKeys()) {
    if (!/^RealOutputs\/Sim\/Pollen\/transitions\/\d+$/.test(key)) continue;
    const set = window.log.getString(key, -Infinity, Infinity);
    set?.values.forEach((value, i) => {
      if (/^\S+\s+SCORED->HELD\s+pollinator-wedge/.test(value)) times.push(set.timestamps[i]);
    });
  }
  return times.sort((a, b) => a - b);
}

function robotAt(t: number): { x: number; y: number; heading: number } | null {
  const get = (suffix: string) => {
    const set = window.log.getNumber(ROBOT + suffix, t, t);
    return set !== undefined && set.values.length > 0 ? set.values[0] : null;
  };
  const x = get("/translation/x");
  const y = get("/translation/y");
  const heading = get("/rotation/value");
  return x === null || y === null || heading === null ? null : { x, y, heading };
}

/**
 * Writes FLOWER_POLLEN_KEY (the POLLEN list with the FLOWER pickups animated) and points the 3D views at it.
 * Returns false, leaving the plain list alone, when this log has no wedge pickups or no POLLEN lists.
 */
export function applyFlowerAnimation(): boolean {
  const log = window.log;
  const pollen = log.getRaw(POLLEN_LIST_KEY, -Infinity, Infinity);
  const held = log.getRaw(HELD_KEY, -Infinity, Infinity);
  if (pollen === undefined || pollen.timestamps.length < 3 || held === undefined || held.timestamps.length === 0) return false;
  const pickups = wedgePickups();
  if (pickups.length === 0) return false;

  const times = pollen.timestamps;
  const original = pollen.values.map(parseList);
  const out: Vec[][] = original.map((list) => list.map((p) => [...p] as Vec));
  const columns = findColumns(original[0]);
  if (columns.length === 0) return false;
  const heldFrames = held.values.map(parseList);

  const frameAtOrAfter = (t: number) => {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inColumn = (p: Vec, column: Column) => Math.hypot(p[0] - column.x, p[1] - column.y) < 0.02 && p[2] > POLLEN_RADIUS * 1.2;

  let animated = 0;
  for (let n = 0; n < pickups.length; n++) {
    const t0 = pickups[n];
    const rollSeconds = n === 0 || t0 - pickups[n - 1] > BURST_GAP_SECONDS ? FIRST_ROLL_SECONDS : ROLL_SECONDS;
    const robot = robotAt(Math.max(times[0], t0 - 0.02));
    if (robot === null) continue;
    const tip = [robot.x + Math.cos(robot.heading) * WEDGE_TIP, robot.y + Math.sin(robot.heading) * WEDGE_TIP];
    let column: Column | undefined;
    let best = 0.45;
    for (const c of columns) {
      const d = Math.hypot(c.x - tip[0], c.y - tip[1]);
      if (d < best) {
        best = d;
        column = c;
      }
    }
    if (column === undefined) continue;

    // The frame the ball leaves the column: the first one near the event where the column has one fewer ball
    const around = frameAtOrAfter(t0);
    const count = (f: number) => original[f].filter((p) => inColumn(p, column!)).length;
    let leave = around;
    for (let f = Math.max(1, around - 3); f <= Math.min(times.length - 1, around + 3); f++) {
      if (count(f) < count(f - 1)) {
        leave = f;
        break;
      }
    }
    if (leave < 1 || leave >= times.length - 1) continue;

    // The ball taken: the lowest one in the column the frame before
    const before = original[leave - 1].filter((p) => inColumn(p, column!)).sort((a, b) => a[2] - b[2]);
    if (before.length === 0) continue;
    const taken = before[0];

    // Where the robot's hold draws it once it is held: the newest ball in the hold
    const heldFrame = heldFrames[Math.min(heldFrames.length - 1, Math.max(0, frameAtOrAfterHeld(held.timestamps, times[leave] + 0.02)))];
    const target: Vec | undefined = heldFrame[heldFrame.length - 1];
    const robotNow = robotAt(times[leave]) ?? robot;
    const mouth: Vec = [
      robotNow.x + Math.cos(robotNow.heading) * INTAKE_FRONT,
      robotNow.y + Math.sin(robotNow.heading) * INTAKE_FRONT,
      POLLEN_RADIUS
    ];

    // 1. The ball taken rolls out the bottom, along the floor into the intake, up into the robot (ends at the leave frame)
    if (target !== undefined) {
      const startFrame = frameAtOrAfter(times[leave] - rollSeconds);
      for (let f = startFrame; f < leave; f++) {
        const index = original[f].findIndex((p) => near(p, taken));
        if (index < 0) continue;
        const u = (times[f] - times[startFrame]) / Math.max(1e-6, times[leave] - times[startFrame]);
        out[f][index] =
          u < 0.55
            ? lerpVec(taken, mouth, smooth(u / 0.55) * 0.9 + (u / 0.55) * 0.1) // rolls down and out, speeding up
            : lerpVec(mouth, target, smooth((u - 0.55) / 0.45)); // then up into the robot
      }
    }

    // 2. The balls above it roll down one slot each (the log drops them in one frame)
    const above = original[leave].filter((p) => inColumn(p, column!));
    const endFrame = frameAtOrAfter(times[leave] + GLIDE_SECONDS);
    for (const now of above) {
      const old: Vec = [now[0], now[1], now[2] + SLOT];
      // Only balls that really dropped a slot: the one that was there the frame before
      if (!before.some((p) => near(p, old, 3e-3))) continue;
      for (let f = leave; f < Math.min(endFrame, times.length); f++) {
        const index = original[f].findIndex((p) => near(p, now));
        if (index < 0) continue;
        const u = (times[f] - times[leave]) / Math.max(1e-6, times[Math.min(endFrame, times.length - 1)] - times[leave]);
        out[f][index] = lerpVec(old, now, smooth(u));
      }
    }
    animated++;
  }
  if (animated === 0) return false;

  log.deleteFieldsWithPrefix(FLOWER_POLLEN_KEY);
  times.forEach((t, f) => log.putTranslation3dArray(FLOWER_POLLEN_KEY, t, out[f]));
  usePollenSource(FLOWER_POLLEN_KEY);
  return true;
}

function frameAtOrAfterHeld(timestamps: number[], t: number): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] < t - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
