// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Cinematic camera shots: keyframes, spline paths, orbit and critically damped follow.
 *
 * FRAME (the same one every pose in the replay uses, see `ReplaySource.frame`):
 *  - Units: meters, seconds, radians for angular speed, degrees for fov.
 *  - Axes: right-handed, +Z up. X/Y are the field axes of the log's coordinate system.
 *  - Quaternions: [w, x, y, z] (w first).
 *  - Camera local axes: +X forward (the view direction), +Y left, +Z up. A rotation of identity looks along field +X.
 *  - fov is the VERTICAL field of view in degrees.
 *  - All times `t` are on the replay clock (seconds, same clock as the log), not relative to the clip.
 *
 * Everything here is a pure function of (shot, replay, t): no wall clock, no frame-rate dependence.
 * The follow camera is a spring and therefore depends on its history; `FollowIntegrator` always integrates from
 * (shot start - preroll) on a fixed substep grid, so preview_frame(t) and a rendered frame at t are identical.
 */

import { Pose3d, Rotation3d, Translation3d } from "../geometry";
import { dist3, lerp, lerp3, normalizeQuat, slerp } from "./ReplayMath";

export type Vec3 = Translation3d;
export type Quat = Rotation3d;

/** A world point, or an entity (robot, ghost or game piece id from get_scene) plus an offset in world axes. */
export type Target = Vec3 | { entity: string; offset?: Vec3 };

export type ShotMode = "static" | "dolly" | "orbit" | "follow" | "crane";

export type Keyframe = {
  /** Replay-clock time (s). */
  t: number;
  /** Camera position (m). Required for static/dolly/crane. */
  position?: Vec3;
  /** Explicit orientation [w,x,y,z]. Use this or lookAt. */
  rotation?: Quat;
  /** Point or entity to aim at. Tracks the entity over time. Use this or rotation. */
  lookAt?: Target;
  /** Vertical field of view (degrees). Defaults to the shot's fov. */
  fov?: number;
};

export type OrbitParams = {
  /** Point or entity to circle. */
  center: Target;
  /** Horizontal distance (m) from the center. */
  radius: number;
  /** Camera height (m) above the center point. */
  height: number;
  /** Angular speed (rad/s). Positive is counter-clockwise seen from above. */
  angularSpeed: number;
  /** Angle (rad) at shot start, measured from field +X toward +Y. Default 0. */
  startAngle?: number;
  /** Look-at offset (m) added to the center, world axes. Default [0,0,0]. */
  lookAtOffset?: Vec3;
};

export type FollowParams = {
  /** Entity id to follow. */
  target: string;
  /** Camera offset (m) from the target. */
  offset: Vec3;
  /** "target-local": offset is rotated by the target's heading (yaw only, so no roll/pitch wobble), +X = target forward.
   *  "world": offset is in field axes. Default "target-local". */
  offsetFrame?: "target-local" | "world";
  /** Offset (m) added to the target position for the aim point, same frame as `offset`. Default [0,0,0]. */
  lookAtOffset?: Vec3;
  /** Spring natural frequency (rad/s) for position. Higher is tighter. Default 3. */
  positionOmega?: number;
  /** Spring natural frequency (rad/s) for the aim point. Default 5. */
  lookAtOmega?: number;
  /** Seconds to integrate before the shot starts so frame 0 is settled. Default 1. */
  preroll?: number;
};

export type Shot = {
  mode: ShotMode;
  /** Replay-clock time (s) the shot begins. Orbit angle and the follow spring start from here. Default: replay start. */
  startTime?: number;
  /** Keyframes (static: 1; dolly/crane: 2 or more, any order). Ignored by orbit and follow. */
  keyframes?: Keyframe[];
  orbit?: OrbitParams;
  follow?: FollowParams;
  /** Default vertical fov (degrees). Default 50. */
  fov?: number;
  /** World "up" used to build orientations from lookAt. Default [0,0,1]. */
  up?: Vec3;
};

export type CameraState = { position: Vec3; rotation: Quat; fov: number };

/** Looks up an entity's pose on the replay clock. Null when absent. */
export type EntityResolver = (id: string, t: number) => Pose3d | null;

export const DEFAULT_FOV = 50;
/** Fixed substep (s) of the follow spring. */
export const FOLLOW_SUBSTEP = 1 / 240;

// ---------- vector helpers ----------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n < 1e-12 ? [1, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
};
export const smoothstep = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** Rotates v by quaternion q ([w,x,y,z]). */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const t = scale(cross([x, y, z], v), 2);
  return add(add(v, scale(t, w)), cross([x, y, z], t));
}

/** Heading (yaw about +Z) of a pose, as a quaternion. */
export function yawQuat(q: Quat): Quat {
  const yaw = Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3]));
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
}

/** Quaternion for a camera at `position` aiming at `target` (camera +X forward, +Y left, +Z up). */
export function lookAtQuat(position: Vec3, target: Vec3, up: Vec3 = [0, 0, 1]): Quat {
  const f = unit(sub(target, position));
  let left = cross(up, f);
  if (norm(left) < 1e-6) {
    // Looking straight along `up`: pick any perpendicular so the result is still defined and continuous-ish
    left = cross(Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], f);
  }
  left = unit(left);
  const u = cross(f, left);
  // Rotation matrix with columns f (x), left (y), u (z)
  const m00 = f[0], m10 = f[1], m20 = f[2];
  const m01 = left[0], m11 = left[1], m21 = left[2];
  const m02 = u[0], m12 = u[1], m22 = u[2];
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return normalizeQuat(q);
}

// ---------- centripetal Catmull-Rom ----------

/**
 * Evaluates the centripetal (alpha = 0.5) Catmull-Rom segment between p1 and p2 at u in [0,1]
 * (Barry-Goldman pyramid). Centripetal parameterization never loops or overshoots on tight corners.
 */
export function catmullRomCentripetal(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const knot = (a: Vec3, b: Vec3) => Math.max(Math.sqrt(dist3(a, b)), 1e-4);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = lerp(t1, t2, u);
  const mix = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => lerp3(a, b, (t - ta) / (tb - ta));
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** Position on the spline through `points` at times `times` (ascending). Clamps outside. */
export function splinePosition(times: number[], points: Vec3[], t: number): Vec3 {
  const n = points.length;
  if (n === 1 || t <= times[0]) return points[0];
  if (t >= times[n - 1]) return points[n - 1];
  let i = 0;
  while (i < n - 2 && times[i + 1] <= t) i++;
  // Phantom end points by reflection keep the end tangents sensible
  const p0 = i === 0 ? sub(scale(points[0], 2), points[1]) : points[i - 1];
  const p3 = i + 2 >= n ? sub(scale(points[n - 1], 2), points[n - 2]) : points[i + 2];
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  return catmullRomCentripetal(p0, points[i], points[i + 1], p3, u);
}

// ---------- critically damped spring ----------

export type SpringState = { x: Vec3; v: Vec3 };

/** Exact step of a critically damped spring toward a fixed goal over dt. */
export function springStep(s: SpringState, goal: Vec3, omega: number, dt: number): SpringState {
  const e = Math.exp(-omega * dt);
  const x: number[] = [0, 0, 0];
  const v: number[] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const delta = s.x[a] - goal[a];
    const temp = (s.v[a] + omega * delta) * dt;
    x[a] = goal[a] + (delta + temp) * e;
    v[a] = (s.v[a] - omega * temp) * e;
  }
  return { x: x as Vec3, v: v as Vec3 };
}

/**
 * Follow-camera spring state as a function of time only.
 * Integrates on the fixed grid (start - preroll) + k * FOLLOW_SUBSTEP, then one partial step to t. Because the grid
 * and arithmetic don't depend on who asks or in what order, a preview at t equals the rendered frame at t. A cache
 * of the last whole-step state only saves work for sequential queries; it never changes the result.
 */
export class FollowIntegrator {
  private cacheK = -1;
  private cachePos: SpringState | null = null;
  private cacheLook: SpringState | null = null;

  constructor(
    private params: FollowParams,
    private resolve: EntityResolver,
    private shotStart: number
  ) {}

  private goals(t: number): { position: Vec3; look: Vec3 } | null {
    const pose = this.resolve(this.params.target, t);
    if (pose === null) return null;
    const local = (this.params.offsetFrame ?? "target-local") === "target-local";
    const frame = local ? yawQuat(pose.rotation) : ([1, 0, 0, 0] as Quat);
    const place = (o: Vec3) => add(pose.translation, rotateVec(frame, o));
    return { position: place(this.params.offset), look: place(this.params.lookAtOffset ?? [0, 0, 0]) };
  }

  /** Spring positions at time t: camera position and aim point. Throws if the entity never exists. */
  at(t: number): { position: Vec3; look: Vec3 } {
    const preroll = this.params.preroll ?? 1;
    const t0 = this.shotStart - preroll;
    const wp = this.params.positionOmega ?? 3;
    const wl = this.params.lookAtOmega ?? 5;
    const steps = Math.max(0, Math.floor((t - t0) / FOLLOW_SUBSTEP + 1e-9));

    let k = 0;
    let pos: SpringState;
    let look: SpringState;
    if (this.cacheK >= 0 && this.cacheK <= steps && this.cachePos && this.cacheLook) {
      k = this.cacheK;
      pos = this.cachePos;
      look = this.cacheLook;
    } else {
      const g = this.goals(t0);
      if (g === null) throw new Error(`follow target "${this.params.target}" is not present at t=${t0.toFixed(3)}`);
      pos = { x: g.position, v: [0, 0, 0] };
      look = { x: g.look, v: [0, 0, 0] };
    }
    for (; k < steps; k++) {
      const g = this.goals(t0 + k * FOLLOW_SUBSTEP);
      if (g !== null) {
        pos = springStep(pos, g.position, wp, FOLLOW_SUBSTEP);
        look = springStep(look, g.look, wl, FOLLOW_SUBSTEP);
      } // Target absent: coast in place
    }
    this.cacheK = steps;
    this.cachePos = pos;
    this.cacheLook = look;
    const rest = t - (t0 + steps * FOLLOW_SUBSTEP);
    if (rest > 1e-12) {
      const g = this.goals(t0 + steps * FOLLOW_SUBSTEP);
      if (g !== null) {
        return {
          position: springStep(pos, g.position, wp, rest).x,
          look: springStep(look, g.look, wl, rest).x
        };
      }
    }
    return { position: pos.x, look: look.x };
  }
}

// ---------- shot evaluation ----------

export type ShotError = { path: string; message: string };

/** Structural validation with agent-readable messages. Empty array means valid. */
export function validateShot(shot: Shot): ShotError[] {
  const errors: ShotError[] = [];
  const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  const isTarget = (v: unknown) =>
    isVec(v) || (typeof v === "object" && v !== null && typeof (v as any).entity === "string");
  const modes: ShotMode[] = ["static", "dolly", "orbit", "follow", "crane"];
  if (!modes.includes(shot.mode)) {
    errors.push({ path: "mode", message: `mode must be one of ${modes.join(", ")}` });
    return errors;
  }
  if (shot.fov !== undefined && !(shot.fov > 1 && shot.fov < 150))
    errors.push({ path: "fov", message: "fov must be between 1 and 150 degrees (vertical)" });
  if (shot.mode === "orbit") {
    const o = shot.orbit;
    if (!o) errors.push({ path: "orbit", message: "orbit mode needs an `orbit` object" });
    else {
      if (!isTarget(o.center)) errors.push({ path: "orbit.center", message: "center must be [x,y,z] or {entity, offset?}" });
      if (!(o.radius > 0)) errors.push({ path: "orbit.radius", message: "radius must be > 0 (meters)" });
      if (!Number.isFinite(o.height)) errors.push({ path: "orbit.height", message: "height must be a number (meters)" });
      if (!Number.isFinite(o.angularSpeed))
        errors.push({ path: "orbit.angularSpeed", message: "angularSpeed must be a number (rad/s)" });
    }
  } else if (shot.mode === "follow") {
    const f = shot.follow;
    if (!f) errors.push({ path: "follow", message: "follow mode needs a `follow` object" });
    else {
      if (typeof f.target !== "string") errors.push({ path: "follow.target", message: "target must be an entity id" });
      if (!isVec(f.offset)) errors.push({ path: "follow.offset", message: "offset must be [x,y,z] (meters)" });
      if (f.positionOmega !== undefined && !(f.positionOmega > 0))
        errors.push({ path: "follow.positionOmega", message: "must be > 0 (rad/s)" });
      if (f.lookAtOmega !== undefined && !(f.lookAtOmega > 0))
        errors.push({ path: "follow.lookAtOmega", message: "must be > 0 (rad/s)" });
      if (f.preroll !== undefined && !(f.preroll >= 0)) errors.push({ path: "follow.preroll", message: "must be >= 0 (s)" });
    }
  } else {
    const k = shot.keyframes;
    const min = shot.mode === "static" ? 1 : 2;
    if (!k || k.length < min) {
      errors.push({ path: "keyframes", message: `${shot.mode} needs at least ${min} keyframe(s)` });
    } else {
      k.forEach((kf, i) => {
        if (!Number.isFinite(kf.t)) errors.push({ path: `keyframes[${i}].t`, message: "t must be a number (replay seconds)" });
        if (!isVec(kf.position)) errors.push({ path: `keyframes[${i}].position`, message: "position must be [x,y,z] (meters)" });
        if (kf.rotation === undefined && kf.lookAt === undefined)
          errors.push({ path: `keyframes[${i}]`, message: "give either `rotation` [w,x,y,z] or `lookAt`" });
        if (kf.lookAt !== undefined && !isTarget(kf.lookAt))
          errors.push({ path: `keyframes[${i}].lookAt`, message: "lookAt must be [x,y,z] or {entity, offset?}" });
        if (kf.rotation !== undefined && !(Array.isArray(kf.rotation) && kf.rotation.length === 4 && kf.rotation.every(Number.isFinite)))
          errors.push({ path: `keyframes[${i}].rotation`, message: "rotation must be [w,x,y,z]" });
        if (kf.fov !== undefined && !(kf.fov > 1 && kf.fov < 150))
          errors.push({ path: `keyframes[${i}].fov`, message: "fov must be between 1 and 150" });
      });
      if (k && new Set(k.map((x) => x.t)).size !== k.length)
        errors.push({ path: "keyframes", message: "keyframe times must be distinct" });
    }
  }
  return errors;
}

/** Entity ids referenced by a shot (for validating against the replay's entity table). */
export function shotEntityRefs(shot: Shot): string[] {
  const ids: string[] = [];
  const add = (t?: Target) => {
    if (t && !Array.isArray(t)) ids.push(t.entity);
  };
  shot.keyframes?.forEach((k) => add(k.lookAt));
  if (shot.orbit) add(shot.orbit.center);
  if (shot.follow) ids.push(shot.follow.target);
  return ids;
}

export class ShotEvaluator {
  private follow: FollowIntegrator | null = null;
  private keyframes: Keyframe[];
  private start: number;
  private fovDefault: number;
  private up: Vec3;

  constructor(
    private shot: Shot,
    private resolve: EntityResolver,
    replayStart: number
  ) {
    const errors = validateShot(shot);
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.keyframes = [...(shot.keyframes ?? [])].sort((a, b) => a.t - b.t);
    this.start = shot.startTime ?? replayStart;
    this.fovDefault = shot.fov ?? DEFAULT_FOV;
    this.up = shot.up ?? [0, 0, 1];
    if (shot.mode === "follow") this.follow = new FollowIntegrator(shot.follow!, resolve, this.start);
  }

  private targetPoint(target: Target, t: number): Vec3 {
    if (Array.isArray(target)) return target;
    const pose = this.resolve(target.entity, t);
    if (pose === null) throw new Error(`entity "${target.entity}" is not present at t=${t.toFixed(3)}`);
    return add(pose.translation, target.offset ?? [0, 0, 0]);
  }

  stateAt(t: number): CameraState {
    switch (this.shot.mode) {
      case "static":
        return this.keyframed(t, true);
      case "dolly":
        return this.keyframed(t, false);
      case "crane": {
        // Eased path parameter: starts and ends at rest
        const t0 = this.keyframes[0].t;
        const t1 = this.keyframes[this.keyframes.length - 1].t;
        const eased = t1 > t0 ? t0 + smoothstep((t - t0) / (t1 - t0)) * (t1 - t0) : t0;
        return this.keyframed(eased, false, t);
      }
      case "orbit":
        return this.orbit(t);
      case "follow":
        return this.followState(t);
    }
  }

  /** `t` drives the path, `aimT` (default t) drives entity tracking. */
  private keyframed(t: number, hold: boolean, aimT: number = t): CameraState {
    const k = this.keyframes;
    const first = k[0];
    const position = hold || k.length === 1 ? first.position! : splinePosition(k.map((x) => x.t), k.map((x) => x.position!), t);

    // Bracketing keyframes
    let i = 0;
    if (!hold) while (i < k.length - 2 && k[i + 1].t <= t) i++;
    const a = k[hold ? 0 : i];
    const b = k[hold ? 0 : Math.min(i + 1, k.length - 1)];
    const u = hold || b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));

    // Eased fov
    const fovA = a.fov ?? this.fovDefault;
    const fovB = b.fov ?? this.fovDefault;
    const fov = lerp(fovA, fovB, smoothstep(u));

    // Orientation
    let rotation: Quat;
    if (a.lookAt !== undefined && b.lookAt !== undefined) {
      const pa = this.targetPoint(a.lookAt, aimT);
      const pb = this.targetPoint(b.lookAt, aimT);
      rotation = lookAtQuat(position, lerp3(pa, pb, u), this.up);
    } else {
      const qa = this.keyRotation(a, aimT);
      const qb = this.keyRotation(b, aimT);
      rotation = slerp(qa, qb, u);
    }
    return { position, rotation, fov };
  }

  private keyRotation(kf: Keyframe, t: number): Quat {
    if (kf.rotation) return normalizeQuat(kf.rotation);
    return lookAtQuat(kf.position!, this.targetPoint(kf.lookAt!, t), this.up);
  }

  private orbit(t: number): CameraState {
    const o = this.shot.orbit!;
    const center = this.targetPoint(o.center, t);
    const angle = (o.startAngle ?? 0) + o.angularSpeed * (t - this.start);
    const position: Vec3 = [
      center[0] + o.radius * Math.cos(angle),
      center[1] + o.radius * Math.sin(angle),
      center[2] + o.height
    ];
    const aim = add(center, o.lookAtOffset ?? [0, 0, 0]);
    return { position, rotation: lookAtQuat(position, aim, this.up), fov: this.fovDefault };
  }

  private followState(t: number): CameraState {
    const { position, look } = this.follow!.at(t);
    return { position, rotation: lookAtQuat(position, look, this.up), fov: this.fovDefault };
  }
}
