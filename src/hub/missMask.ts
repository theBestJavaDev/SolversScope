// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Hides the real ball of a shot that Auto Check's random match misses.
 *
 * The robot-code sim is a perfect robot, so its log shows every ball going into the CELL. A random match flies the
 * same shot again with real error and draws the miss itself (MATCH_MISSES_KEY). Without this, the 3D view would show
 * both: the miss and the log's ball sitting in the CELL, so the robot looks like it launched more balls than it held.
 *
 * The sim logs every POLLEN by its own id (`Field/PollenById`, index = id). This copies that list to
 * MASKED_POLLEN_KEY with each missed shot's ball parked off the field from its launch until the robot next takes it
 * (it is then in the robot's hold, drawn from Field/HeldPollen), and points the 3D views' POLLEN at the copy.
 */

import TabType from "../shared/TabType";

export const POLLEN_BY_ID_KEY = "RealOutputs/Field/PollenById";
export const POLLEN_LIST_KEY = "RealOutputs/Field/Pollen";
export const MASKED_POLLEN_KEY = "/SolversSim/Anim/Pollen";
/** The POLLEN list with the FLOWER pickups animated (flowerAnim.ts). */
export const FLOWER_POLLEN_KEY = "/SolversSim/Anim/FlowerPollen";
const PARKED: [number, number, number] = [1e4, 1e4, -1000];

/**
 * True when this log lists its POLLEN per ball (`Field/PollenById`), which is what lets a missed shot's real ball be hidden.
 * Without it the random match must not draw anything: its missed ball would appear on top of the log's own ball,
 * which still sits in the CELL, so the field would show more balls than the robot ever held.
 */
export function canHideMissedBalls(): boolean {
  const raw = window.log.getRaw(POLLEN_BY_ID_KEY, -Infinity, Infinity);
  return raw !== undefined && raw.timestamps.length > 0;
}

/** Per ball id, when it was taken by the robot (the "->HELD" transitions of the sim's own bookkeeping). */
function heldTimes(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const key of window.log.getFieldKeys()) {
    if (!/^RealOutputs\/Sim\/Pollen\/transitions\/\d+$/.test(key)) continue;
    const set = window.log.getString(key, -Infinity, Infinity);
    set?.values.forEach((value, i) => {
      const m = /^(\S+)\s+\S+->HELD\b/.exec(value);
      if (m) out.set(m[1], [...(out.get(m[1]) ?? []), set.timestamps[i]]);
    });
  }
  return out;
}

/**
 * Writes the masked per-ball list. Returns false when this log has no per-ball list (an older sim log), in which
 * case the 3D view keeps the plain list.
 *
 * @param missed the launches the random match missed: when, and which ball (its id in the sim's bookkeeping)
 */
export function applyMissMask(missed: { time: number; ballId: string | null }[]): boolean {
  const log = window.log;
  const raw = log.getRaw(POLLEN_BY_ID_KEY, -Infinity, Infinity);
  if (raw === undefined || raw.timestamps.length === 0) return false;

  const taken = heldTimes();
  const hidden = new Map<number, [number, number][]>();
  for (const shot of missed) {
    if (shot.ballId === null) continue;
    const id = Number(shot.ballId);
    if (!Number.isFinite(id)) continue;
    const end = (taken.get(shot.ballId) ?? []).find((t) => t > shot.time + 1e-6) ?? Infinity;
    hidden.set(id, [...(hidden.get(id) ?? []), [shot.time - 0.021, end]]);
  }

  log.deleteFieldsWithPrefix(MASKED_POLLEN_KEY);
  raw.timestamps.forEach((t, i) => {
    const bytes = raw.values[i];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const list: [number, number, number][] = [];
    for (let id = 0; (id + 1) * 24 <= bytes.byteLength; id++) {
      const spans = hidden.get(id);
      if (spans !== undefined && spans.some(([from, to]) => t >= from && t < to)) {
        list.push(PARKED);
      } else {
        list.push([view.getFloat64(id * 24, true), view.getFloat64(id * 24 + 8, true), view.getFloat64(id * 24 + 16, true)]);
      }
    }
    log.putTranslation3dArray(MASKED_POLLEN_KEY, t, list);
  });
  usePollenSource(MASKED_POLLEN_KEY);
  return true;
}

/** Points every 3D tab's POLLEN source (plain list or masked list) at `key`. */
export function usePollenSource(key: string) {
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string }[] } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    for (const source of controller.sources) {
      const isPollenList =
        source.logKey === POLLEN_LIST_KEY || source.logKey === MASKED_POLLEN_KEY || source.logKey === FLOWER_POLLEN_KEY;
      if (isPollenList && source.logKey !== key) {
        source.logKey = key;
        changed = true;
      }
    }
  }
  if (changed) window.tabs.restoreState(state);
}

/** The list the 3D views draw when no missed ball is hidden: the FLOWER-animated copy if this log has one, else the plain list. */
export function defaultPollenKey(): string {
  return window.log.getFieldKeys().includes(FLOWER_POLLEN_KEY) ? FLOWER_POLLEN_KEY : POLLEN_LIST_KEY;
}
