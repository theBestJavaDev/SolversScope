// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Cinematic camera checks. Part of `npm run test:cinematic`. */

import {
  catmullRomCentripetal,
  FOLLOW_SUBSTEP,
  lookAtQuat,
  rotateVec,
  Shot,
  ShotEvaluator,
  springStep,
  splinePosition,
  validateShot,
  Vec3
} from "../../src/shared/cinematic/CameraShot";
import { PRESET_NAMES, resolvePreset } from "../../src/shared/cinematic/CameraPresets";
import { Pose3d } from "../../src/shared/geometry";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearV = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => Array.from(a).every((x, i) => near(x, b[i], eps));
const yawPose = (x: number, y: number, yaw: number): Pose3d => ({
  translation: [x, y, 0],
  rotation: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]
});

// lookAt: +X forward, +Y left, +Z up
{
  const q = lookAtQuat([0, 0, 0], [5, 0, 0]);
  check("looking along +X is the identity rotation", nearV(q, [1, 0, 0, 0]));
  const f = rotateVec(lookAtQuat([1, 1, 1], [1, 1, 11]), [1, 0, 0]);
  check("lookAt straight up still points forward at the target", nearV(f, [0, 0, 1]));
  const qd = lookAtQuat([0, 0, 5], [0, 0, 0], [1, 0, 0]);
  check("top-down camera: forward is -Z", nearV(rotateVec(qd, [1, 0, 0]), [0, 0, -1]));
  check("top-down camera with up=+X: camera up is +X", nearV(rotateVec(qd, [0, 0, 1]), [1, 0, 0]));
  const q3 = lookAtQuat([0, 0, 0], [3, 4, 0]);
  check("camera up stays +Z for a horizontal look", nearV(rotateVec(q3, [0, 0, 1]), [0, 0, 1]));
}

// Catmull-Rom: passes through keyframes, no loops on a sharp corner
{
  const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const times = [0, 1, 2, 3];
  check("spline passes through every keyframe", pts.every((p, i) => nearV(splinePosition(times, pts, times[i]), p, 1e-9)));
  // Sharp corner with unequal spacing: centripetal must not overshoot the bounding box by much and stay finite
  const corner: Vec3[] = [[0, 0, 0], [10, 0, 0], [10.01, 0.01, 0], [10.02, 10, 0]];
  let maxOver = 0;
  for (let t = 0; t <= 3; t += 0.01) {
    const p = splinePosition([0, 1, 2, 3], corner, t);
    maxOver = Math.max(maxOver, p[0] - 10.02, -p[0], -p[1], p[1] - 10);
  }
  check("centripetal spline has no big overshoot on a sharp corner", maxOver < 0.5, `overshoot=${maxOver}`);
  const mid = catmullRomCentripetal([-1, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0], 0.5);
  check("straight-line control points give the midpoint", nearV(mid, [0.5, 0, 0], 1e-9));
}

// Spring: critically damped = no overshoot on a step, converges, exact vs. fine stepping
{
  let s = { x: [0, 0, 0] as Vec3, v: [0, 0, 0] as Vec3 };
  let maxX = 0;
  for (let i = 0; i < 2400; i++) {
    s = springStep(s, [1, 0, 0], 3, FOLLOW_SUBSTEP);
    maxX = Math.max(maxX, s.x[0]);
  }
  check("critically damped spring never overshoots", maxX <= 1 + 1e-12, `max=${maxX}`);
  check("spring converges to the goal", near(s.x[0], 1, 1e-6));
  const big = springStep({ x: [0, 0, 0], v: [0, 0, 0] }, [1, 0, 0], 3, 1);
  let fine = { x: [0, 0, 0] as Vec3, v: [0, 0, 0] as Vec3 };
  for (let i = 0; i < 240; i++) fine = springStep(fine, [1, 0, 0], 3, FOLLOW_SUBSTEP);
  check("spring step is exact (1 big step = 240 small steps for a fixed goal)", near(big.x[0], fine.x[0], 1e-9));
}

// Follow shot through a direction change, order independence, preroll
{
  // Target drives +X for 2 s then turns to +Y. Heading follows velocity.
  const resolve = (id: string, t: number): Pose3d | null => {
    if (id !== "robot.0") return null;
    const tt = Math.min(Math.max(t, 0), 6);
    if (tt <= 2) return yawPose(2 * tt, 0, 0);
    return yawPose(4, 2 * (tt - 2), Math.PI / 2);
  };
  const shot: Shot = {
    mode: "follow",
    startTime: 0,
    follow: { target: "robot.0", offset: [-1, 0, 0.5], lookAtOffset: [0.2, 0, 0.1] }
  };
  const fresh = () => new ShotEvaluator(shot, resolve, 0);
  const seq = fresh();
  const seqStates = [0, 1, 2, 3, 4, 5].map((t) => seq.stateAt(t));
  const rnd = fresh();
  const rndStates = [5, 2, 0, 4, 1, 3].map((t) => ({ t, s: rnd.stateAt(t) })).sort((a, b) => a.t - b.t).map((x) => x.s);
  check("follow camera state does not depend on query order", JSON.stringify(seqStates) === JSON.stringify(rndStates));
  check("follow at frame 0 starts settled on the offset (preroll)", nearV(seqStates[0].position, [-1, 0, 0.5], 1e-3), String(seqStates[0].position));
  // Smoothness: position speed has no jump at the turn (max frame-to-frame accel bounded)
  const ev = fresh();
  let maxJerk = 0;
  // The goal here jumps ~1.4 m in one frame (heading flips instantly), the harshest case: peak spring accel is
  // omega^2 * jump = 9 * 1.41 = 12.7 m/s^2, so anything near that bound is the spring doing its job, not a snap.
  let p0 = ev.stateAt(1.5).position;
  let p1 = ev.stateAt(1.5 + 1 / 60).position;
  let prevVel: Vec3 = [(p1[0] - p0[0]) * 60, (p1[1] - p0[1]) * 60, (p1[2] - p0[2]) * 60];
  for (let t = 1.5 + 2 / 60; t < 3.5; t += 1 / 60) {
    const p2 = ev.stateAt(t).position;
    const vel: Vec3 = [(p2[0] - p1[0]) * 60, (p2[1] - p1[1]) * 60, (p2[2] - p1[2]) * 60];
    maxJerk = Math.max(maxJerk, Math.hypot(vel[0] - prevVel[0], vel[1] - prevVel[1], vel[2] - prevVel[2]) * 60);
    p1 = p2;
    prevVel = vel;
  }
  check("follow camera accel stays under the spring bound through a 90 degree turn", maxJerk < 14, `max accel ${maxJerk}`);
  const behind = ev.stateAt(12).position;
  check("follow settles behind the target after it stops", nearV(behind, [4, 7, 0.5], 1e-3), String(behind));
}

// Orbit
{
  const resolve = (id: string): Pose3d | null => (id === "robot.0" ? yawPose(1, 2, 0) : null);
  const shot: Shot = { mode: "orbit", startTime: 10, orbit: { center: { entity: "robot.0" }, radius: 2, height: 1, angularSpeed: Math.PI / 2 } };
  const ev = new ShotEvaluator(shot, resolve, 0);
  check("orbit starts at +X of the center", nearV(ev.stateAt(10).position, [3, 2, 1], 1e-9));
  check("orbit quarter turn at t+1 s lands at +Y", nearV(ev.stateAt(11).position, [1, 4, 1], 1e-9));
  const q = ev.stateAt(10.37);
  const f = rotateVec(q.rotation, [1, 0, 0]);
  const toCenter = [1 - q.position[0], 2 - q.position[1], 0 - q.position[2]];
  const n = Math.hypot(...toCenter);
  check("orbit camera aims at the center", nearV(f, toCenter.map((v) => v / n), 1e-9));
}

// Keyframed shots: fov easing, lookAt entity tracking, slerp
{
  const resolve = (id: string, t: number): Pose3d | null => (id === "ball.1" ? yawPose(t, 0, 0) : null);
  const shot: Shot = {
    mode: "dolly",
    keyframes: [
      { t: 0, position: [0, -5, 2], lookAt: { entity: "ball.1" }, fov: 40 },
      { t: 4, position: [4, -5, 2], lookAt: { entity: "ball.1" }, fov: 60 }
    ]
  };
  const ev = new ShotEvaluator(shot, resolve, 0);
  check("fov is eased (smoothstep): midpoint is the average", near(ev.stateAt(2).fov, 50, 1e-9));
  check("fov is eased: quarter way is below linear", ev.stateAt(1).fov < 45, String(ev.stateAt(1).fov));
  const s = ev.stateAt(3);
  const want = [3 - s.position[0], 0 - s.position[1], 0 - s.position[2]];
  const n = Math.hypot(...want);
  check("lookAt entity is tracked at the query time", nearV(rotateVec(s.rotation, [1, 0, 0]), want.map((v) => v / n), 1e-9));
  const rotShot: Shot = {
    mode: "dolly",
    keyframes: [
      { t: 0, position: [0, 0, 1], rotation: [1, 0, 0, 0] },
      { t: 2, position: [1, 0, 1], rotation: [Math.cos(Math.PI / 4), 0, 0, Math.sin(Math.PI / 4)] }
    ]
  };
  const q = new ShotEvaluator(rotShot, resolve, 0).stateAt(1).rotation;
  check("explicit rotations are slerped (halfway = 45 degrees yaw)", near(2 * Math.atan2(q[3], q[0]), Math.PI / 4, 1e-9));
  const crane = new ShotEvaluator({ ...shot, mode: "crane" }, resolve, 0);
  check("crane eases the path: at 25% time it has moved less than 25%", crane.stateAt(1).position[0] < 1, String(crane.stateAt(1).position));
  check("crane ends exactly at the last keyframe", nearV(crane.stateAt(4).position, [4, -5, 2], 1e-9));
}

// Validation
{
  check("valid static shot has no errors", validateShot({ mode: "static", keyframes: [{ t: 0, position: [0, 0, 1], lookAt: [1, 0, 1] }] }).length === 0);
  check("orbit without params is rejected", validateShot({ mode: "orbit" }).length === 1);
  check("keyframe needs rotation or lookAt", validateShot({ mode: "static", keyframes: [{ t: 0, position: [0, 0, 1] }] }).length === 1);
  check("bad mode is rejected", validateShot({ mode: "zoom" as any }).length === 1);
  let threw = false;
  try {
    new ShotEvaluator({ mode: "follow", follow: { target: "nope", offset: [0, 0, 1] } }, () => null, 0).stateAt(1);
  } catch {
    threw = true;
  }
  check("following a missing entity throws a readable error", threw);
}

// Presets all resolve to valid, evaluable shots
{
  const ctx = {
    fieldCenter: [0, 0, 0] as Vec3,
    fieldSize: [3.6576, 3.6576] as [number, number],
    entityPose: (id: string, _t: number) => (id === "robot.0" ? yawPose(0.5, -0.5, 0.3) : null)
  };
  for (const name of PRESET_NAMES) {
    let ok = true;
    let detail = "";
    try {
      const shot = resolvePreset(name, { target: "robot.0", start: 0, duration: 6 }, ctx);
      const errs = validateShot(shot);
      if (errs.length) throw new Error(JSON.stringify(errs));
      const ev = new ShotEvaluator(shot, (id, t) => ctx.entityPose(id, t), 0);
      for (const t of [0, 3, 6]) {
        const s = ev.stateAt(t);
        if (![...s.position, ...s.rotation, s.fov].every(Number.isFinite)) throw new Error("non-finite state at " + t);
      }
    } catch (e) {
      ok = false;
      detail = String(e);
    }
    check(`preset ${name} resolves to a valid shot`, ok, detail);
  }
  const top = new ShotEvaluator(resolvePreset("top_down", { start: 0 }, ctx), ctx.entityPose, 0).stateAt(0);
  check("top_down looks straight down", nearV(rotateVec(top.rotation, [1, 0, 0]), [0, 0, -1], 1e-9));
  check("top_down camera sees the whole field (height >= half field / tan(fov/2))", top.position[2] > 1.8288 / Math.tan((25 * Math.PI) / 180));
}

console.log(failures === 0 ? "\nAll camera checks passed" : `\n${failures} camera check(s) failed`);
if (failures !== 0) process.exit(1);
