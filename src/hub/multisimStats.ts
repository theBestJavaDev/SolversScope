// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Multisim telemetry: per-run numbers for the compare panel under the Multisim fields (scoring,
 * timing, driving) plus live values at the playhead. Each run is a BioBuzz SimLoop log loaded under
 * its own merge prefix (/Log0, /Log1, ... or "" for a single log). Times are seconds since that
 * run's auto START, so runs line up even if their logs don't start together.
 */

import LoggableType from "../shared/log/LoggableType";
import { applyKeyPrefix } from "../shared/log/LogKeyUtils";

const AUTO_SECONDS = 30;
const SAMPLE_DT = 0.05;
/** Slower than this counts as stopped (idle time). */
const IDLE_SPEED = 0.05;

const K = {
  leg: "RealOutputs/Auto/leg",
  launches: "RealOutputs/Sim/Launch/count",
  transitions: "RealOutputs/Sim/Pollen/transitions/",
  robotX: "RealOutputs/Field/Robot/translation/x",
  robotY: "RealOutputs/Field/Robot/translation/y",
  redTips: "RealOutputs/Sim/Hive/redTips",
  blueTips: "RealOutputs/Sim/Hive/blueTips"
};

export type MultisimSummary = {
  /** False when the log isn't a robot-code sim run (nothing to compare). */
  isSim: boolean;
  start: number;
  shots: number;
  scored: number;
  missed: number;
  hiveTips: number;
  firstShot: number | null;
  lastShot: number | null;
  lastLegChange: number | null;
  idle: number;
  pathLength: number;
  topSpeed: number;
  avgSpeed: number;
  /** Launch and score times (absolute log time) for the live "so far" counts. */
  launchTimes: number[];
  scoreTimes: number[];
};

export type MultisimLive = {
  leg: string;
  speed: number | null;
  shotsSoFar: number;
  scoredSoFar: number;
  position: [number, number] | null;
};

function num(key: string, t: number): number | null {
  const set = window.log.getNumber(key, t, t);
  return set !== undefined && set.values.length > 0 && set.timestamps[0] <= t + 1e-9 ? set.values[0] : null;
}

function str(key: string, t: number): string | null {
  const set = window.log.getString(key, t, t);
  return set !== undefined && set.values.length > 0 && set.timestamps[0] <= t + 1e-9 ? set.values[0] : null;
}

function position(prefix: string, t: number): [number, number] | null {
  const x = num(applyKeyPrefix(prefix, K.robotX), t);
  const y = num(applyKeyPrefix(prefix, K.robotY), t);
  return x === null || y === null ? null : [x, y];
}

/** The run's auto START (else the first logged time of its robot pose). */
function runStart(prefix: string): number {
  const leg = applyKeyPrefix(prefix, K.leg);
  if (window.log.getType(leg) === LoggableType.String) {
    const legs = window.log.getString(leg, -Infinity, Infinity);
    const index = legs?.values.findIndex((value) => value === "START") ?? -1;
    if (legs !== undefined && index >= 0) return legs.timestamps[index];
  }
  const xs = window.log.getNumber(applyKeyPrefix(prefix, K.robotX), -Infinity, Infinity);
  return xs !== undefined && xs.timestamps.length > 0 ? xs.timestamps[0] : 0;
}

const cache = new Map<string, { keyCount: number; summary: MultisimSummary }>();

/** Whole-run numbers for one run (cached until more of the log loads). */
export function getMultisimSummary(prefix: string): MultisimSummary {
  const keys = window.log.getFieldKeys();
  const cached = cache.get(prefix);
  if (cached !== undefined && cached.keyCount === keys.length) return cached.summary;
  const summary = computeSummary(prefix, keys);
  cache.set(prefix, { keyCount: keys.length, summary });
  return summary;
}

function computeSummary(prefix: string, keys: string[]): MultisimSummary {
  const P = (key: string) => applyKeyPrefix(prefix, key);
  const isSim = window.log.getType(P(K.launches)) === LoggableType.Number && keys.includes(P(K.robotX));
  const start = runStart(prefix);
  const empty: MultisimSummary = {
    isSim,
    start,
    shots: 0,
    scored: 0,
    missed: 0,
    hiveTips: 0,
    firstShot: null,
    lastShot: null,
    lastLegChange: null,
    idle: 0,
    pathLength: 0,
    topSpeed: 0,
    avgSpeed: 0,
    launchTimes: [],
    scoreTimes: []
  };
  if (!isSim) return empty;

  // Launches: each step of the launch counter is one shot
  const launchTimes: number[] = [];
  const counts = window.log.getNumber(P(K.launches), -Infinity, Infinity);
  if (counts !== undefined) {
    for (let i = 1; i < counts.values.length; i++) {
      for (let k = counts.values[i - 1]; k < counts.values[i]; k++) launchTimes.push(counts.timestamps[i]);
    }
  }

  // Scored / missed: what happened to each ball after it was in flight
  const transitionPrefix = P(K.transitions);
  const scoreTimes: number[] = [];
  let missed = 0;
  for (const key of keys) {
    if (!key.startsWith(transitionPrefix) || !/^\d+$/.test(key.slice(transitionPrefix.length))) continue;
    const set = window.log.getString(key, -Infinity, Infinity);
    set?.values.forEach((value, i) => {
      const m = /^\S+\s+IN_FLIGHT->(\S+)/.exec(value);
      if (m === null) return;
      if (m[1] === "SCORED") scoreTimes.push(set.timestamps[i]);
      else missed++;
    });
  }
  scoreTimes.sort((a, b) => a - b);

  // HIVE tips: final values of both counters
  const lastValue = (key: string) => {
    const set = window.log.getNumber(P(key), -Infinity, Infinity);
    return set !== undefined && set.values.length > 0 ? set.values[set.values.length - 1] : 0;
  };
  const hiveTips = lastValue(K.redTips) + lastValue(K.blueTips);

  // Last leg change within the auto period
  let lastLegChange: number | null = null;
  const legs = window.log.getString(P(K.leg), -Infinity, Infinity);
  legs?.timestamps.forEach((t, i) => {
    if (t >= start && t <= start + AUTO_SECONDS + 1e-6 && (i === 0 || legs.values[i] !== legs.values[i - 1])) {
      lastLegChange = t - start;
    }
  });

  // Driving over the auto period, sampled on a fixed grid
  let pathLength = 0;
  let topSpeed = 0;
  let idle = 0;
  let movingTime = 0;
  let previous = position(prefix, start);
  for (let t = start + SAMPLE_DT; t <= start + AUTO_SECONDS + 1e-9; t += SAMPLE_DT) {
    const now = position(prefix, t);
    if (previous !== null && now !== null) {
      const step = Math.hypot(now[0] - previous[0], now[1] - previous[1]);
      const speed = step / SAMPLE_DT;
      pathLength += step;
      topSpeed = Math.max(topSpeed, speed);
      if (speed < IDLE_SPEED) idle += SAMPLE_DT;
      else movingTime += SAMPLE_DT;
    }
    previous = now;
  }

  const autoLaunches = launchTimes.filter((t) => t >= start - 1e-6);
  return {
    isSim,
    start,
    shots: launchTimes.length,
    scored: scoreTimes.length,
    missed,
    hiveTips,
    firstShot: autoLaunches.length > 0 ? autoLaunches[0] - start : null,
    lastShot: autoLaunches.length > 0 ? autoLaunches[autoLaunches.length - 1] - start : null,
    lastLegChange,
    idle,
    pathLength,
    topSpeed,
    avgSpeed: movingTime > 0 ? pathLength / movingTime : 0,
    launchTimes,
    scoreTimes
  };
}

/** Values at the playhead. */
export function getMultisimLive(prefix: string, summary: MultisimSummary, time: number): MultisimLive {
  const now = position(prefix, time);
  const before = position(prefix, time - 0.1);
  return {
    leg: str(applyKeyPrefix(prefix, K.leg), time) ?? "—",
    speed: now !== null && before !== null ? Math.hypot(now[0] - before[0], now[1] - before[1]) / 0.1 : null,
    shotsSoFar: summary.launchTimes.filter((t) => t <= time).length,
    scoredSoFar: summary.scoreTimes.filter((t) => t <= time).length,
    position: now
  };
}
