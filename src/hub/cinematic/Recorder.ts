// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * The recorded window of the timeline. Live data (including "Live 3D view") already lands in the log/timeline, so
 * "recording" is marking a start and end on it; the cinematic tools then render that window. The Telemetry tab's
 * Record button and the command server's record_start/record_stop share this one state.
 */

export type RecordState = { start: number | null; end: number | null; recording: boolean };

let state: RecordState = { start: null, end: null, recording: false };

/** The newest time with data: the live time when connected, else the timeline's time or the log end. */
export function recordNow(): number {
  return window.selection.getCurrentLiveTime() ?? window.selection.getRenderTime() ?? window.log.getTimestampRange()[1];
}

export const recorder = {
  get(): RecordState {
    return { ...state };
  },
  start(): RecordState {
    state = { start: recordNow(), end: null, recording: true };
    return this.get();
  },
  stop(): RecordState {
    if (state.recording) state = { ...state, end: recordNow(), recording: false };
    return this.get();
  }
};
