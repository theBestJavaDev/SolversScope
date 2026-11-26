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
 *  - the ball taken rolls out of the bottom of the FLOWER along the floor and up into the robot, starting the moment the
 *    wedge touches it (the sim's pickup time) and arriving where the robot's hold draws it (`Field/HeldPollen`), which
 *    waits for it (FLOWER_HELD_KEY hides that spot until the ball is there).
 *
 * It reads the log's plain POLLEN list (`Field/Pollen`, which has no ball ids) and finds each ball by where it sits: the
 * FLOWER columns come from the first frame, and the ball taken is the lowest one in the column the wedge is facing.
 * The result is a copy of the list (FLOWER_POLLEN_KEY) the 3D views draw instead of the plain one; the log's own data is
 * untouched.
 */

import TabType from "../shared/TabType";
import { FLOWER_POLLEN_KEY, POLLEN_LIST_KEY, usePollenSource } from "./missMask";
const HELD_KEY = "RealOutputs/Field/HeldPollen";
/** The robot's hold with the ball still rolling in left out, so it is not drawn twice. */
export const FLOWER_HELD_KEY = "/SolversSim/Anim/FlowerHeld";
const ROBOT = "RealOutputs/Field/Robot";

/**
 * Seconds the balls above take to roll down one slot, and the ball taken to roll out into the robot, both starting when
 * the wedge touches the ball. A downhill roll keeps speeding up, so the roll is given about the time a ball really takes
 * (it may overlap the next pickup's, which is 0.19 s later); it is cut short only if the robot launches that ball sooner.
 */
const GLIDE_SECONDS = 0.12;
const ROLL_SECONDS = 0.4;
const MIN_ROLL_SECONDS = 0.1;
/** While a roll or glide is in progress the lists are sampled this often (s), not at the log's 50 Hz, so the motion is smooth. */
const SUB_STEP = 0.005;
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
/** A ball rolling downhill: starts from rest and speeds up the whole way, with a little give at the end. */
const rollEase = (u: number) => 0.8 * Math.min(1, Math.max(0, u)) ** 2 + 0.2 * smooth(u);
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
  const ok = buildFlowerAnimation();
  if (!ok) {
    // A saved layout may still point at the animated copies from an earlier log: back to the log's own lists
    usePollenSource(POLLEN_LIST_KEY);
    useHeldSource(HELD_KEY);
  }
  return ok;
}

function buildFlowerAnimation(): boolean {
  const log = window.log;
  const pollen = log.getRaw(POLLEN_LIST_KEY, -Infinity, Infinity);
  const held = log.getRaw(HELD_KEY, -Infinity, Infinity);
  if (pollen === undefined || pollen.timestamps.length < 3 || held === undefined || held.timestamps.length === 0) return false;
  const pickups = wedgePickups();
  if (pickups.length === 0) return false;

  const times = pollen.timestamps;
  const original = pollen.values.map(parseList);
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

  // What to animate, as functions of time: the log only has a sample every 0.02 s, so these are sampled finer below
  const rolls: { start: number; end: number; from: Vec; mouth: Vec; to: Vec }[] = [];
  const glides: { start: number; end: number; from: Vec; to: Vec }[] = [];
  const hides: { holdFrame: number; arrive: number }[] = [];

  for (const t0 of pickups) {
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

    // Where the robot's hold draws it once it is held: the newest ball in the hold, in the frame the sim first counts it
    const heldIndex = Math.min(heldFrames.length - 1, Math.max(0, frameAtOrAfterHeld(held.timestamps, times[leave] - 1e-6)));
    let holdFrame = heldIndex;
    for (let h = Math.max(1, heldIndex - 2); h <= Math.min(heldFrames.length - 1, heldIndex + 3); h++) {
      if (heldFrames[h].length > heldFrames[h - 1].length) {
        holdFrame = h;
        break;
      }
    }
    const target: Vec | undefined = heldFrames[holdFrame][heldFrames[holdFrame].length - 1];
    const robotNow = robotAt(times[leave]) ?? robot;
    const mouth: Vec = [
      robotNow.x + Math.cos(robotNow.heading) * INTAKE_FRONT,
      robotNow.y + Math.sin(robotNow.heading) * INTAKE_FRONT,
      POLLEN_RADIUS
    ];

    // 1. The ball taken starts rolling when the wedge touches it (the frame the sim takes it): out the bottom, along
    //    the floor into the intake, then up into the robot. It is an extra ball in the list until it arrives, and the
    //    hold's newest spot waits for it.
    if (target !== undefined && heldFrames[holdFrame].length > heldFrames[Math.max(0, holdFrame - 1)].length) {
      // Cut short only if the robot launches (the hold shrinks) before it would arrive
      let launchAt = Infinity;
      for (let h = holdFrame + 1; h < heldFrames.length; h++) {
        if (heldFrames[h].length < heldFrames[h - 1].length) {
          launchAt = held.timestamps[h];
          break;
        }
      }
      const start = times[leave];
      const arrive = Math.max(start + MIN_ROLL_SECONDS, Math.min(start + ROLL_SECONDS, launchAt - 0.03));
      rolls.push({ start, end: arrive, from: taken, mouth, to: target });
      hides.push({ holdFrame, arrive });
    }

    // 2. The balls above it roll down one slot each (the log drops them in one frame)
    for (const now of original[leave].filter((p) => inColumn(p, column!))) {
      const old: Vec = [now[0], now[1], now[2] + SLOT];
      // Only balls that really dropped a slot: the one that was there the frame before
      if (before.some((p) => near(p, old, 3e-3))) glides.push({ start: times[leave], end: times[leave] + GLIDE_SECONDS, from: old, to: now });
    }
  }
  if (rolls.length === 0 && glides.length === 0) return false;

  // The list at time t: the log's frame at or before it, with the glides and rolls in progress applied. Frames with an
  // animation in progress are sampled every SUB_STEP seconds instead of every frame, so the motion is smooth.
  const outTimes: number[] = [];
  const outLists: Vec[][] = [];
  for (let f = 0; f < times.length; f++) {
    const next = f + 1 < times.length ? times[f + 1] : times[f] + (times[f] - times[Math.max(0, f - 1)] || 0.02);
    const busy =
      rolls.some((r) => r.start < next - 1e-9 && r.end > times[f] + 1e-9) ||
      glides.some((g) => g.start < next - 1e-9 && g.end > times[f] + 1e-9);
    const steps = busy ? Math.min(20, Math.max(1, Math.round((next - times[f]) / SUB_STEP))) : 1;
    for (let j = 0; j < steps; j++) {
      const t = times[f] + (j * (next - times[f])) / steps;
      const list: Vec[] = original[f].map((p) => [...p] as Vec);
      for (const g of glides) {
        if (t < g.start - 1e-9 || t >= g.end) continue;
        const index = original[f].findIndex((p) => near(p, g.to));
        if (index >= 0) list[index] = lerpVec(g.from, g.to, rollEase((t - g.start) / (g.end - g.start)));
      }
      for (const r of rolls) {
        if (t >= r.start - 1e-9 && t < r.end) list.push(rollPosition(r.from, r.mouth, r.to, (t - r.start) / (r.end - r.start)));
      }
      outTimes.push(t);
      outLists.push(list);
    }
  }

  // The hold, with each arriving ball's spot left out until it gets there (balls still rolling in are the newest ones)
  const holdTimes = held.timestamps;
  const arrivals = hides.map((h) => h.arrive).filter((t) => !holdTimes.some((x) => Math.abs(x - t) < 1e-6));
  const sampleTimes = [...holdTimes, ...arrivals].sort((a, b) => a - b);
  const hiddenAt = (t: number) => hides.filter((h) => holdTimes[h.holdFrame] <= t + 1e-9 && t < h.arrive - 1e-9).length;
  const holdAt = (t: number) => {
    let lo = 0;
    let hi = holdTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (holdTimes[mid] <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return heldFrames[lo];
  };

  log.deleteFieldsWithPrefix(FLOWER_POLLEN_KEY);
  outTimes.forEach((t, i) => log.putTranslation3dArray(FLOWER_POLLEN_KEY, t, outLists[i]));
  log.deleteFieldsWithPrefix(FLOWER_HELD_KEY);
  sampleTimes.forEach((t) => {
    const list = holdAt(t);
    log.putTranslation3dArray(FLOWER_HELD_KEY, t, list.slice(0, Math.max(0, list.length - hiddenAt(t))));
  });
  usePollenSource(FLOWER_POLLEN_KEY);
  useHeldSource(FLOWER_HELD_KEY);
  return true;
}

/**
 * Where the rolling ball is at u (0 to 1): one smooth curve from where it sat, past the intake's mouth at floor level,
 * to its spot in the robot's hold, starting from rest and speeding up the whole way like a ball rolling downhill.
 */
function rollPosition(from: Vec, mouth: Vec, to: Vec, u: number): Vec {
  const s = rollEase(u);
  const a = (1 - s) * (1 - s);
  const b = 2 * (1 - s) * s;
  const c = s * s;
  return [a * from[0] + b * mouth[0] + c * to[0], a * from[1] + b * mouth[1] + c * to[1], a * from[2] + b * mouth[2] + c * to[2]];
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

/** Points every 3D tab's hold source (the plain list or the FLOWER copy) at `key`. */
function useHeldSource(key: string) {
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string }[] } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    for (const source of controller.sources) {
      if ((source.logKey === HELD_KEY || source.logKey === FLOWER_HELD_KEY) && source.logKey !== key) {
        source.logKey = key;
        changed = true;
      }
    }
  }
  if (changed) window.tabs.restoreState(state);
}
