// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Hub side of the cinematic tools. The hub window holds the log, so it answers the main process's requests:
 *   cin-scene     -> what is in the replay (duration, frame, field, entities and their poses at t)
 *   cin-sample    -> for a shot and a list of frames: the interpolated scene command + camera for every subframe
 *   cin-live-look -> point the visible 3D tab at a shot's camera at time t (for comparing against offline renders)
 * Replies go back as `cin-response` {requestId, ok, result | error:{code, message, details?}}.
 * Nothing here runs unless the main process asks, so the live view is unaffected when the command server is off.
 */

import { BuiltIn3dFields } from "../../shared/AdvantageScopeAssets";
import TabType from "../../shared/TabType";
import { CameraState, Shot, ShotEvaluator, shotEntityRefs, validateShot } from "../../shared/cinematic/CameraShot";
import { PresetName, PresetParams, resolvePreset } from "../../shared/cinematic/CameraPresets";
import { ReplaySource } from "../../shared/cinematic/ReplaySource";
import { SubTime } from "../../shared/cinematic/Timing";
import Field3dRenderer from "../../shared/renderers/Field3dRenderer";
import Field3dController from "../controllers/Field3dController";
import { makeRlogReplaySource } from "./RlogReplaySource";

class CinematicError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

type Session = { controller: Field3dController; replay: ReplaySource; key: string };
let session: Session | null = null;
const evaluators = new Map<string, ShotEvaluator>();

function findController(): Field3dController {
  const controllers = window.tabs.findControllers(TabType.Field3d) as Field3dController[];
  if (controllers.length === 0) {
    throw new CinematicError("no_field_tab", "Open a log and add a 3D Field tab (File > Open, then Tabs > 3D Field) first.");
  }
  return controllers[0];
}

function getSession(): Session {
  const controller = findController();
  const range = window.log.getTimestampRange();
  const key = [controller.UUID, JSON.stringify(controller.getReplayKeys()), range[0], range[1], window.log.getFieldCount()].join("|");
  if (session === null || session.key !== key) {
    if (window.log.getFieldCount() === 0) throw new CinematicError("no_replay", "No log is open.");
    session = { controller, replay: makeRlogReplaySource(controller), key };
    evaluators.clear();
  }
  return session;
}

function checkTime(replay: ReplaySource, t: number, what = "t") {
  if (!Number.isFinite(t) || t < replay.startTime - 1e-9 || t > replay.endTime + 1e-9) {
    throw new CinematicError("t_out_of_range", `${what}=${t} is outside the replay [${replay.startTime}, ${replay.endTime}] seconds`, {
      min: replay.startTime,
      max: replay.endTime
    });
  }
}

function evaluatorFor(replay: ReplaySource, shot: Shot): ShotEvaluator {
  const errors = validateShot(shot);
  if (errors.length > 0) throw new CinematicError("invalid_shot", errors.map((e) => `${e.path}: ${e.message}`).join("; "), errors);
  const known = new Set(replay.entities().map((e) => e.id));
  const missing = shotEntityRefs(shot).filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new CinematicError("unknown_entity", `Unknown entity id(s): ${missing.join(", ")}. Call get_scene for valid ids.`, { missing });
  }
  const key = JSON.stringify(shot);
  let evaluator = evaluators.get(key);
  if (evaluator === undefined) {
    evaluator = new ShotEvaluator(shot, (id, t) => replay.entityPose(id, t), replay.startTime);
    evaluators.set(key, evaluator);
    if (evaluators.size > 8) evaluators.delete(evaluators.keys().next().value as string);
  }
  return evaluator;
}

/** Field size and where its center is in the log's frame (FRC/FTC wall frames put the origin at a corner). */
function fieldInfo(replay: ReplaySource) {
  const fields = [...(window.assets?.field3ds ?? []), ...BuiltIn3dFields];
  const config = fields.find((f) => f.id === replay.frame.field);
  const widthM = (config?.widthInches ?? 144) * 0.0254;
  const heightM = (config?.heightInches ?? 144) * 0.0254;
  const wall = replay.frame.coordinateSystem === "wall-alliance" || replay.frame.coordinateSystem === "wall-blue";
  return {
    id: replay.frame.field,
    isFTC: config?.isFTC ?? true,
    sizeMeters: [widthM, heightM] as [number, number],
    centerInLogFrame: (wall ? [widthM / 2, heightM / 2, 0] : [0, 0, 0]) as [number, number, number]
  };
}

const COORDINATE_DOCS: { [key: string]: string } = {
  "center-red": "Origin at the field center, +X facing away from the red alliance wall, +Y to the left of +X (Systemcore).",
  "center-rotated":
    "Origin at the field center, +X facing to the right from the perspective of the red alliance wall (FTC traditional, 2024-2025 to 2026-2027).",
  "wall-blue": "Origin at the rightmost corner of the blue alliance wall, +X facing the red alliance wall (FRC 2023-2026).",
  "wall-alliance":
    "Origin at the rightmost corner of the robot's current alliance wall, +X facing the opposite alliance wall (FRC 2022)."
};

function scene(data: { t?: number }) {
  const { replay } = getSession();
  const t = data.t ?? replay.startTime;
  checkTime(replay, t);
  return {
    startTime: replay.startTime,
    endTime: replay.endTime,
    duration: replay.duration,
    samples: (() => {
      const times = replay.sampleTimes;
      const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      return { count: times.length, medianInterval: gaps[Math.floor(gaps.length / 2)] ?? 0, maxInterval: gaps[gaps.length - 1] ?? 0 };
    })(),
    frame: {
      coordinateSystem: replay.frame.coordinateSystem,
      description: COORDINATE_DOCS[replay.frame.coordinateSystem] ?? replay.frame.coordinateSystem,
      units: { length: "meters", time: "seconds", angle: "radians", fov: "degrees (vertical)" },
      axes: "Right-handed, +Z up. Pose translation is [x, y, z] in the log's field frame.",
      quaternion: "[w, x, y, z] (w first)",
      cameraAxes: "Camera local +X forward, +Y left, +Z up (identity rotation looks along field +X)"
    },
    field: fieldInfo(replay),
    entities: replay.entityStates(t).map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      group: e.group,
      pose: e.pose === null ? null : { translation: e.pose.translation, rotation: e.pose.rotation },
      firstTime: e.firstTime,
      lastTime: e.lastTime
    })),
    t
  };
}

function sample(data: { shot: Shot; items: { t: number; subs: SubTime[] }[] }) {
  const { replay } = getSession();
  const evaluator = evaluatorFor(replay, data.shot);
  return data.items.map((item) => ({
    t: item.t,
    subframes: item.subs.map((sub) => {
      checkTime(replay, sub.t, "subframe t");
      let camera: CameraState;
      try {
        camera = evaluator.stateAt(sub.t);
      } catch (error) {
        throw new CinematicError("shot_failed", String((error as Error).message));
      }
      return { command: replay.sample(sub.t).command, camera, weight: sub.weight };
    })
  }));
}

function preset(data: { preset: PresetName; params: PresetParams }) {
  const { replay } = getSession();
  const field = fieldInfo(replay);
  const params = { ...data.params, start: data.params.start ?? replay.startTime };
  checkTime(replay, params.start, "start");
  if (params.target !== undefined && !replay.entities().some((e) => e.id === params.target)) {
    throw new CinematicError("unknown_entity", `Unknown entity id: ${params.target}. Call get_scene for valid ids.`);
  }
  try {
    return resolvePreset(data.preset, params, {
      fieldCenter: field.centerInLogFrame,
      fieldSize: field.sizeMeters,
      entityPose: (id, t) => replay.entityPose(id, t)
    });
  } catch (error) {
    throw new CinematicError("invalid_preset", String((error as Error).message));
  }
}

function liveLook(data: { shot: Shot; t: number }) {
  const { replay, controller } = getSession();
  checkTime(replay, data.t);
  const camera = evaluatorFor(replay, data.shot).stateAt(data.t);
  const renderer = window.tabs.findRenderer(controller) as Field3dRenderer | null;
  if (renderer === null) throw new CinematicError("no_field_tab", "No renderer for the 3D Field tab");
  const index = window.tabs.getSelectedTab();
  window.selection.pause(); // The sim layout auto-plays the run; hold the live view still at t
  window.selection.setSelectedTime(data.t);
  const applied = renderer.lookThroughCinematicPose(camera.position, camera.rotation, camera.fov);
  const robotOf = (c: { objects: { type: string; poses: { pose: unknown }[] }[] }) => c.objects.find((o) => o.type === "robot")?.poses[0]?.pose;
  const diagnostics = {
    selectedTabType: window.tabs.getSelectedTabType(),
    field3dControllers: window.tabs.findControllers(TabType.Field3d).length,
    canvases: Array.from(document.querySelectorAll("canvas.field-3d-canvas")).map((c) => Math.round(c.getBoundingClientRect().width)),
    renderTime: window.selection.getRenderTime(),
    liveRobot: robotOf(controller.getCommand() as any),
    offlineRobot: robotOf(replay.sample(data.t).command as any),
    liveDrawnRobot: renderer.debugPrimaryRobot()
  };
  const canvas = document.querySelector("canvas.field-3d-canvas") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, selectedTab: index, camera, applied, diagnostics };
}

export function handleCinematicMessage(name: string, data: any) {
  const reply = (body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }) =>
    window.sendMainMessage("cin-response", { requestId: data.requestId, ...body });
  try {
    switch (name) {
      case "cin-scene":
        return reply({ ok: true, result: scene(data) });
      case "cin-sample":
        return reply({ ok: true, result: sample(data) });
      case "cin-preset":
        return reply({ ok: true, result: preset(data) });
      case "cin-live-look":
        return reply({ ok: true, result: liveLook(data) });
      default:
        return reply({ ok: false, error: { code: "unknown_message", message: name } });
    }
  } catch (error) {
    if (error instanceof CinematicError) {
      reply({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
    } else {
      reply({ ok: false, error: { code: "internal_error", message: String((error as Error)?.stack ?? error) } });
    }
  }
}
