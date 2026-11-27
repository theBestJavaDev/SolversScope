// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Small vector/quaternion helpers for the cinematic tools. No dependencies, so they run in Node tests. */

import { Pose3d, Rotation3d, Translation3d } from "../geometry";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerp3(a: Translation3d, b: Translation3d, t: number): Translation3d {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function dist3(a: Translation3d, b: Translation3d): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function isFinite3(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

export function normalizeQuat(q: Rotation3d): Rotation3d {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n < 1e-12 ? [1, 0, 0, 0] : [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Spherical interpolation along the shortest arc. Quaternions are [w, x, y, z]. */
export function slerp(a: Rotation3d, b: Rotation3d, t: number): Rotation3d {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bw = b;
  if (dot < 0) {
    dot = -dot;
    bw = [-b[0], -b[1], -b[2], -b[3]];
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    // Nearly parallel: normalized lerp avoids dividing by ~0
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  return normalizeQuat([
    a[0] * s0 + bw[0] * s1,
    a[1] * s0 + bw[1] * s1,
    a[2] * s0 + bw[2] * s1,
    a[3] * s0 + bw[3] * s1
  ]);
}

export function lerpPose(a: Pose3d, b: Pose3d, t: number): Pose3d {
  return { translation: lerp3(a.translation, b.translation, t), rotation: slerp(a.rotation, b.rotation, t) };
}
