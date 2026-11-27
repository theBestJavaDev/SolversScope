// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Frame-to-frame association for game pieces that the log lists without IDs.
 *
 * Each sample is a list of positions whose order may change between samples. For every pair of neighboring
 * samples this finds which piece in sample k is which piece in sample k+1:
 *  - Each piece is predicted forward with constant velocity (taken from its own previous interval).
 *  - Candidate pairs must fall inside a gating radius around the prediction.
 *  - Pairs are taken greedily, nearest first.
 *  - A pair is dropped (the piece is step-held for that interval) when another candidate is nearly as close, so
 *    two balls that touch or cross never get swapped.
 * Lists that carry their own IDs (`Field/PollenById`: index = ball id) skip the matching and map slot to slot.
 * Each piece gets a track id that stays the same as long as it is matched.
 */

import { Translation3d } from "../geometry";
import { dist3, isFinite3 } from "./ReplayMath";

export type TrackerOptions = {
  /** Fastest a piece is expected to move (m/s); sets the gating radius. */
  maxSpeed: number;
  /** Smallest/largest gating radius (m). */
  minGate: number;
  maxGate: number;
  /** A pair is ambiguous if another candidate costs less than max(ratio * best, best + margin). */
  ambiguityRatio: number;
  ambiguityMargin: number;
};

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxSpeed: 30,
  minGate: 0.05,
  maxGate: 0.75,
  ambiguityRatio: 1.5,
  ambiguityMargin: 0.02
};

/** For each piece in the earlier sample, the index of the same piece in the later one, or -1 (hold). */
export type Match = Int32Array;

/**
 * Greedy nearest-neighbor matching with constant-velocity prediction.
 * @param predicted where each earlier piece is expected to be at the later time
 * @param next positions at the later time
 */
export function associate(predicted: Translation3d[], next: Translation3d[], gate: number, opts: TrackerOptions): Match {
  const n0 = predicted.length;
  const match = new Int32Array(n0).fill(-1);
  type Candidate = { i: number; j: number; cost: number };
  const candidates: Candidate[] = [];
  const bestForI = new Float64Array(n0).fill(Infinity);
  const secondForI = new Float64Array(n0).fill(Infinity);
  const bestForJ = new Float64Array(next.length).fill(Infinity);
  const secondForJ = new Float64Array(next.length).fill(Infinity);
  for (let i = 0; i < n0; i++) {
    if (!isFinite3(predicted[i])) continue;
    for (let j = 0; j < next.length; j++) {
      if (!isFinite3(next[j])) continue;
      const cost = dist3(predicted[i], next[j]);
      if (cost > gate) continue;
      candidates.push({ i, j, cost });
      if (cost < bestForI[i]) {
        secondForI[i] = bestForI[i];
        bestForI[i] = cost;
      } else if (cost < secondForI[i]) secondForI[i] = cost;
      if (cost < bestForJ[j]) {
        secondForJ[j] = bestForJ[j];
        bestForJ[j] = cost;
      } else if (cost < secondForJ[j]) secondForJ[j] = cost;
    }
  }
  // Stable sort keeps results independent of engine sort quirks for equal costs
  candidates.sort((a, b) => a.cost - b.cost || a.i - b.i || a.j - b.j);
  const takenJ = new Uint8Array(next.length);
  const threshold = (best: number) => Math.max(opts.ambiguityRatio * best, best + opts.ambiguityMargin);
  for (const c of candidates) {
    if (match[c.i] !== -1 || takenJ[c.j]) continue;
    const ambiguous = secondForI[c.i] < threshold(c.cost) || secondForJ[c.j] < threshold(c.cost);
    takenJ[c.j] = 1; // Reserve even if ambiguous so a rival can't claim it by default
    if (!ambiguous) match[c.i] = c.j;
  }
  return match;
}

/** Builds up tracks for one list of pieces over the run, one interval at a time. */
export class PieceTracker {
  private positions: Translation3d[][] = [];
  private times: number[] = [];
  /** matches[k] maps sample k to sample k+1. */
  private matches: Match[] = [];
  /** ids[k][i] = track id of piece i in sample k. */
  private ids: number[][] = [];
  private nextId = 0;
  /** First and last sample index each track was seen. */
  private seen = new Map<number, [number, number]>();

  constructor(
    private stable: boolean,
    private opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS
  ) {}

  get sampleCount(): number {
    return this.positions.length;
  }

  /** Feeds the next sample. Samples must be added in order (k = 0, 1, 2, ...). */
  addSample(time: number, positions: Translation3d[]): void {
    const k = this.positions.length;
    this.positions.push(positions);
    this.times.push(time);
    let ids: number[];
    if (k === 0) {
      ids = positions.map(() => this.nextId++);
    } else if (this.stable) {
      this.matches.push(Int32Array.from(this.positions[k - 1].map((_, i) => (i < positions.length ? i : -1))));
      ids = positions.map((_, j) => j);
      this.nextId = Math.max(this.nextId, positions.length);
    } else {
      const match = this.computeMatch(k - 1);
      this.matches.push(match);
      ids = new Array(positions.length).fill(-1);
      match.forEach((j, i) => {
        if (j >= 0) ids[j] = this.ids[k - 1][i];
      });
      for (let j = 0; j < ids.length; j++) if (ids[j] === -1) ids[j] = this.nextId++;
    }
    this.ids.push(ids);
    ids.forEach((id) => {
      const entry = this.seen.get(id);
      if (entry === undefined) this.seen.set(id, [k, k]);
      else entry[1] = k;
    });
  }

  /** Match from sample k to k+1 (requires both to be added). */
  matchFor(k: number): Match {
    return this.matches[k];
  }

  idsFor(k: number): number[] {
    return this.ids[k];
  }

  /** Sample indices (first, last) in which a track was seen. */
  lifetime(id: number): [number, number] | undefined {
    return this.seen.get(id);
  }

  trackIds(): number[] {
    return [...this.seen.keys()];
  }

  private computeMatch(k: number): Match {
    const p0 = this.positions[k];
    const p1 = this.positions[k + 1];
    const dt = Math.max(1e-6, this.times[k + 1] - this.times[k]);
    const gate = Math.min(this.opts.maxGate, Math.max(this.opts.minGate, this.opts.maxSpeed * dt));
    // Velocity of each piece from its previous interval (if it had one)
    const inverse = new Int32Array(p0.length).fill(-1);
    if (k > 0) this.matches[k - 1].forEach((j, i) => (j >= 0 ? (inverse[j] = i) : 0));
    const dtPrev = k > 0 ? Math.max(1e-6, this.times[k] - this.times[k - 1]) : 1;
    const predicted = p0.map((p, i): Translation3d => {
      const prev = inverse[i] >= 0 ? this.positions[k - 1][inverse[i]] : null;
      if (prev === null || !isFinite3(p) || !isFinite3(prev)) return p;
      let v: Translation3d = [(p[0] - prev[0]) / dtPrev, (p[1] - prev[1]) / dtPrev, (p[2] - prev[2]) / dtPrev];
      const speed = Math.hypot(v[0], v[1], v[2]);
      if (speed > this.opts.maxSpeed) v = [0, 0, 0].map((_, a) => (v[a] * this.opts.maxSpeed) / speed) as Translation3d;
      return [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
    });
    return associate(predicted, p1, gate, this.opts);
  }
}
