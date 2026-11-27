// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * ReplaySource over the loaded log (RLOG, or the live timeline that "Live 3D view" records into).
 *
 * The scene comes from a 3D Field tab's own `getCommand(t)`, so a replay shows exactly what that tab shows.
 * Nothing here writes to the log or the UI; `getCommand(t)` with an explicit time reads the log only.
 */

import { InterpolatingReplaySource, RawCommandProvider, ReplaySource } from "../../shared/cinematic/ReplaySource";
import Field3dController from "../controllers/Field3dController";

/** Sorted unique sample times of every log field under the given keys (children included). */
export function sampleTimesForKeys(keys: string[]): number[] {
  const wanted = new Set(keys);
  const fieldKeys = window.log
    .getFieldKeys()
    .filter((fieldKey) => wanted.has(fieldKey) || keys.some((key) => fieldKey.startsWith(key + "/")));
  return window.log.getTimestamps(fieldKeys);
}

export function makeRlogReplaySource(controller: Field3dController): ReplaySource {
  let times = sampleTimesForKeys(controller.getReplayKeys());
  if (times.length === 0) {
    // Nothing plotted yet: fall back to the log's overall range so the run still has a duration
    times = [...window.log.getTimestampRange()];
  }
  const provider: RawCommandProvider = {
    times,
    commandAt: (t) => controller.getCommand(t)
  };
  return new InterpolatingReplaySource(provider);
}
