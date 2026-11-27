// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Named camera presets that resolve to ordinary Shots. All numbers are meters/seconds in the replay frame
 * (see CameraShot.ts). A preset is only a starting point: the agent can edit the returned Shot.
 */

import { Pose3d } from "../geometry";
import { Shot, Vec3 } from "./CameraShot";

export type PresetName =
  | "establishing_wide"
  | "follow_chase"
  | "low_angle_hero"
  | "top_down"
  | "orbit_robot"
  | "crane_reveal";

export const PRESET_NAMES: PresetName[] = [
  "establishing_wide",
  "follow_chase",
  "low_angle_hero",
  "top_down",
  "orbit_robot",
  "crane_reveal"
];

export const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  establishing_wide:
    "Slow push-in from a high corner of the field toward the field center. Params: start, duration. No target needed.",
  follow_chase:
    "Spring-damped chase camera behind and above `target` (a robot id). Params: target, start, duration (duration only sets the clip length hint).",
  low_angle_hero:
    "Low camera near the floor, in front-left of `target` at its start pose, slowly drifting to look up at it. Params: target, start, duration.",
  top_down: "Fixed overhead view of the whole field, looking straight down. Params: start. No target needed.",
  orbit_robot: "Circles `target` at 1.6 m radius, 0.9 m up, one lap in about 12.5 s. Params: target, start.",
  crane_reveal:
    "Starts low at one end of the field aimed at `target` (or the field center if none), then rises and pulls back to a high wide view with eased start and stop. Params: target?, start, duration."
};

export type PresetContext = {
  /** Field center in the replay frame (m). */
  fieldCenter: Vec3;
  /** Field size along X and Y (m). */
  fieldSize: [number, number];
  /** Where an entity is at time t, for presets that start from a robot's pose. */
  entityPose: (id: string, t: number) => Pose3d | null;
};

export type PresetParams = {
  target?: string;
  /** Replay-clock time (s) the shot starts. */
  start: number;
  /** Length of the shot (s). */
  duration?: number;
};

function needTarget(name: string, p: PresetParams): string {
  if (!p.target) throw new Error(`preset ${name} needs a target entity id`);
  return p.target;
}

export function resolvePreset(name: PresetName, p: PresetParams, ctx: PresetContext): Shot {
  const [cx, cy, cz] = ctx.fieldCenter;
  const [w, h] = ctx.fieldSize;
  const size = Math.max(w, h);
  const duration = p.duration ?? 6;
  const t0 = p.start;
  const t1 = t0 + duration;

  switch (name) {
    case "establishing_wide": {
      const far: Vec3 = [cx - size * 0.62, cy - size * 0.62, cz + size * 0.5];
      const near: Vec3 = [cx - size * 0.5, cy - size * 0.5, cz + size * 0.4];
      return {
        mode: "dolly",
        startTime: t0,
        fov: 55,
        keyframes: [
          { t: t0, position: far, lookAt: [cx, cy, cz] },
          { t: t1, position: near, lookAt: [cx, cy, cz] }
        ]
      };
    }
    case "follow_chase": {
      const target = needTarget(name, p);
      return {
        mode: "follow",
        startTime: t0,
        fov: 60,
        follow: {
          target,
          offset: [-0.9, 0, 0.55],
          offsetFrame: "target-local",
          lookAtOffset: [0.25, 0, 0.15],
          positionOmega: 3,
          lookAtOmega: 5,
          preroll: 1
        }
      };
    }
    case "low_angle_hero": {
      const target = needTarget(name, p);
      const pose = ctx.entityPose(target, t0);
      if (pose === null) throw new Error(`entity "${target}" is not present at t=${t0}`);
      const [x, y] = pose.translation;
      return {
        mode: "dolly",
        startTime: t0,
        fov: 35,
        keyframes: [
          { t: t0, position: [x + 1.0, y - 0.9, cz + 0.12], lookAt: { entity: target, offset: [0, 0, 0.2] } },
          { t: t1, position: [x + 1.2, y - 0.5, cz + 0.1], lookAt: { entity: target, offset: [0, 0, 0.22] } }
        ]
      };
    }
    case "top_down": {
      const fov = 50;
      const height = (size / 2 / Math.tan((fov / 2) * (Math.PI / 180))) * 1.08;
      return {
        mode: "static",
        startTime: t0,
        fov,
        // +X on screen points up, matching the usual field diagram orientation for the field's long axis
        up: [1, 0, 0],
        keyframes: [{ t: t0, position: [cx, cy, cz + height], lookAt: [cx, cy, cz] }]
      };
    }
    case "orbit_robot": {
      const target = needTarget(name, p);
      return {
        mode: "orbit",
        startTime: t0,
        fov: 50,
        orbit: {
          center: { entity: target },
          radius: 1.6,
          height: 0.9,
          angularSpeed: 0.5,
          startAngle: -Math.PI / 2,
          lookAtOffset: [0, 0, 0.15]
        }
      };
    }
    case "crane_reveal": {
      const aim = p.target ? { entity: p.target, offset: [0, 0, 0.15] as Vec3 } : ctx.fieldCenter;
      return {
        mode: "crane",
        startTime: t0,
        fov: 50,
        keyframes: [
          { t: t0, position: [cx - size * 0.55, cy, cz + 0.25], lookAt: aim, fov: 40 },
          { t: (t0 + t1) / 2, position: [cx - size * 0.7, cy - size * 0.25, cz + size * 0.3], lookAt: aim },
          { t: t1, position: [cx - size * 0.55, cy - size * 0.55, cz + size * 0.65], lookAt: ctx.fieldCenter, fov: 55 }
        ]
      };
    }
  }
}
