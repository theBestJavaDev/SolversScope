// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * ReplaySource: the scene as a pure function of time, with interpolation and an entity table.
 *
 * The 3D field is already f(log, t) through `Field3dController.getCommand()`, but that holds the last logged value
 * (sample-and-hold). A 50 Hz log shown at 60 fps then updates unevenly, which looks like judder, and motion blur
 * subframes between two log samples would all be identical. `InterpolatingReplaySource` wraps any `RawCommandProvider`
 * (the RLOG adapter is `src/hub/cinematic/RlogReplaySource.ts`) and blends the two commands around `t`:
 *  - continuous channels (poses, components, mechanism lines): lerp translation, slerp rotation;
 *  - discrete state (model names, colors, counts that differ, anything that jumped farther than a plausible speed
 *    allows, e.g. a ball parked off the field or a robot reset): step-hold the earlier sample's value;
 *  - game pieces: matched between samples by `PieceTracker`, so reordered lists don't swap balls.
 * No physics runs here. Same (provider, t) always gives the same command.
 */

import { AnnotatedPose3d, Pose3d } from "../geometry";
import { MechanismState } from "../log/LogMechanismState";
import {
  Field3dRendererCommand,
  Field3dRendererCommand_AnyObj,
  Field3dRendererCommand_GamePieceObj
} from "../renderers/Field3dRenderer";
import { PieceTracker, TrackerOptions, DEFAULT_TRACKER_OPTIONS } from "./PieceTracker";
import { dist3, isFinite3, lerp, lerp3, slerp } from "./ReplayMath";

/** Where the data comes from. For RLOGs this wraps the loaded log and a Field3dController. */
export interface RawCommandProvider {
  /** Sorted, unique times (s) at which any pose channel has a sample. */
  times: number[];
  /** The un-interpolated render command at time t (sample-and-hold). */
  commandAt(t: number): Field3dRendererCommand;
}

export type EntityType = "robot" | "ghost" | "gamePiece" | "other";

export type EntityInfo = {
  /** Stable id used by shots (`lookAt`, `follow` targets) and by get_scene. */
  id: string;
  type: EntityType;
  /** Human-readable name (robot model, or piece variant + track number). */
  name: string;
  /** Source group: robot model or piece variant. */
  group: string;
  /** Run times (s) at which this entity was first and last listed. */
  firstTime: number;
  lastTime: number;
};

export type EntityState = EntityInfo & {
  /** Pose in the field frame of the log (see `frame`). Null if the entity isn't present at this time. */
  pose: Pose3d | null;
};

export type Sample = {
  time: number;
  command: Field3dRendererCommand;
  /** Per command object, per pose: entity id (or null). Parallel to `command.objects[i].poses`. */
  entityIds: (string | null)[][];
};

export interface ReplaySource {
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  /** Coordinate system name of every pose (`Field3dRendererCommand.coordinateSystem`) and the field id. */
  readonly frame: { field: string; coordinateSystem: string };
  /** Every entity that appears anywhere in the run. May scan the whole run the first time. */
  entities(): EntityInfo[];
  /** Interpolated scene at time t (clamped to the run). */
  sample(t: number): Sample;
  /** Entities present at t, with poses. */
  entityStates(t: number): EntityState[];
  /** Pose of one entity at t, or null if absent/unknown. */
  entityPose(id: string, t: number): Pose3d | null;
}

export type InterpolationOptions = {
  /** Largest plausible speed (m/s) of a robot/ghost/axes/cone; a bigger jump between samples is a teleport. */
  maxRobotSpeed: number;
  tracker: TrackerOptions;
};

export const DEFAULT_INTERPOLATION: InterpolationOptions = {
  maxRobotSpeed: 25,
  tracker: DEFAULT_TRACKER_OPTIONS
};

/** True for the poses the sim parks off the field (hidden balls) instead of removing them. */
export function isParked(pose: Pose3d): boolean {
  const t = pose.translation;
  return !isFinite3(t) || Math.abs(t[0]) > 1000 || Math.abs(t[1]) > 1000 || t[2] < -100;
}

const ROBOT_LIKE = new Set(["robot", "ghost"]);

export class InterpolatingReplaySource implements ReplaySource {
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly frame: { field: string; coordinateSystem: string };

  private rawCache = new Map<number, Field3dRendererCommand>();
  /** One tracker per object index; created on first need and fed sequentially. */
  private trackers = new Map<number, PieceTracker>();
  private entityTable: EntityInfo[] | null = null;

  constructor(
    private provider: RawCommandProvider,
    private options: InterpolationOptions = DEFAULT_INTERPOLATION
  ) {
    const times = provider.times;
    if (times.length === 0) throw new Error("ReplaySource needs at least one sample time");
    this.startTime = times[0];
    this.endTime = times[times.length - 1];
    this.duration = this.endTime - this.startTime;
    const first = this.raw(0);
    this.frame = { field: first.field, coordinateSystem: first.coordinateSystem };
  }

  // ---- raw access ----

  private raw(k: number): Field3dRendererCommand {
    let command = this.rawCache.get(k);
    if (command !== undefined) {
      this.rawCache.delete(k);
      this.rawCache.set(k, command);
      return command;
    }
    command = this.provider.commandAt(this.provider.times[k]);
    this.rawCache.set(k, command);
    if (this.rawCache.size > 16) this.rawCache.delete(this.rawCache.keys().next().value as number);
    return command;
  }

  /** Index of the last sample at or before t. */
  private indexAt(t: number): number {
    const times = this.provider.times;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private piecePositions(command: Field3dRendererCommand, objIndex: number) {
    const obj = command.objects[objIndex];
    return obj !== undefined && obj.type === "gamePiece" ? obj.poses.map((p) => p.pose.translation) : [];
  }

  /** Makes sure the tracker for this object has consumed samples 0..k+1 (so interval k has a match). */
  private trackerFor(objIndex: number, k: number): PieceTracker {
    let tracker = this.trackers.get(objIndex);
    if (tracker === undefined) {
      const obj = this.raw(0).objects[objIndex] as Field3dRendererCommand_GamePieceObj;
      tracker = new PieceTracker(obj.stableIds === true, this.options.tracker);
      this.trackers.set(objIndex, tracker);
    }
    const last = Math.min(k + 1, this.provider.times.length - 1);
    while (tracker.sampleCount <= last) {
      const i = tracker.sampleCount;
      tracker.addSample(this.provider.times[i], this.piecePositions(this.raw(i), objIndex));
    }
    return tracker;
  }

  // ---- entity naming ----

  private entityId(command: Field3dRendererCommand, objIndex: number, poseIndex: number, trackId: number): string {
    const obj = command.objects[objIndex];
    const ordinal = command.objects.slice(0, objIndex).filter((o) => o.type === obj.type).length;
    switch (obj.type) {
      case "robot":
      case "ghost":
        return obj.poses.length > 1 ? `${obj.type}.${ordinal}.${poseIndex}` : `${obj.type}.${ordinal}`;
      case "gamePiece":
        return `piece.${ordinal}.${trackId}`;
      default:
        return `${obj.type}.${ordinal}.${poseIndex}`;
    }
  }

  // ---- sampling ----

  sample(t: number): Sample {
    t = Math.min(this.endTime, Math.max(this.startTime, t));
    const k = this.indexAt(t);
    const times = this.provider.times;
    const c0 = this.raw(k);
    const hasNext = k + 1 < times.length;
    const alpha = hasNext && t > times[k] ? (t - times[k]) / (times[k + 1] - times[k]) : 0;
    const dt = hasNext ? times[k + 1] - times[k] : 1;
    const c1 = alpha > 0 ? this.raw(k + 1) : c0;

    const entityIds: (string | null)[][] = [];
    const objects: Field3dRendererCommand_AnyObj[] = c0.objects.map((obj0, objIndex) => {
      const obj1 = c1.objects[objIndex];
      const sameKind = obj1 !== undefined && obj1.type === obj0.type;
      if (obj0.type === "gamePiece") {
        const tracker = this.trackerFor(objIndex, k);
        const trackIds = tracker.idsFor(k);
        entityIds.push(obj0.poses.map((_, i) => this.entityId(c0, objIndex, i, trackIds[i])));
        if (alpha === 0 || !sameKind) return { ...obj0, time: t };
        const match = tracker.matchFor(k);
        const next = (obj1 as Field3dRendererCommand_GamePieceObj).poses;
        return {
          ...obj0,
          time: t,
          poses: obj0.poses.map((p, i) => {
            const j = match[i];
            if (j < 0 || j >= next.length) return p;
            return this.blendPose(p, next[j], alpha, dt, this.options.tracker.maxSpeed);
          })
        };
      }
      entityIds.push(obj0.poses.map((_, i) => this.entityId(c0, objIndex, i, i)));
      if (alpha === 0 || !sameKind) return obj0;
      return this.blendObject(obj0, obj1, alpha, dt);
    });

    const cameraOverride =
      alpha > 0 && c0.cameraOverride !== null && c1.cameraOverride !== null
        ? this.blendPose(c0.cameraOverride, c1.cameraOverride, alpha, dt, this.options.maxRobotSpeed)
        : c0.cameraOverride;
    return { time: t, command: { ...c0, objects, cameraOverride }, entityIds };
  }

  private blendPose(a: AnnotatedPose3d, b: AnnotatedPose3d, alpha: number, dt: number, maxSpeed: number) {
    const ta = a.pose.translation;
    const tb = b.pose.translation;
    // Hold across teleports (reset, ball parked off the field, ball appearing) and bad data
    if (!isFinite3(ta) || !isFinite3(tb) || isParked(a.pose) || isParked(b.pose)) return a;
    if (dist3(ta, tb) > Math.max(0.05, maxSpeed * dt)) return a;
    return {
      pose: { translation: lerp3(ta, tb, alpha), rotation: slerp(a.pose.rotation, b.pose.rotation, alpha) },
      annotation: a.annotation
    };
  }

  private blendList(a: AnnotatedPose3d[], b: AnnotatedPose3d[], alpha: number, dt: number, maxSpeed: number) {
    if (a.length !== b.length) return a;
    return a.map((p, i) => this.blendPose(p, b[i], alpha, dt, maxSpeed));
  }

  private blendMechanism(a: MechanismState | null, b: MechanismState | null, alpha: number): MechanismState | null {
    if (a === null || b === null || a.lines.length !== b.lines.length) return a;
    const lines = a.lines.map((la, i) => {
      const lb = b.lines[i];
      if (la.color !== lb.color) return la;
      return {
        ...la,
        start: [lerp(la.start[0], lb.start[0], alpha), lerp(la.start[1], lb.start[1], alpha)] as [number, number],
        end: [lerp(la.end[0], lb.end[0], alpha), lerp(la.end[1], lb.end[1], alpha)] as [number, number],
        weight: lerp(la.weight, lb.weight, alpha)
      };
    });
    return { ...a, lines };
  }

  private blendObject(a: Field3dRendererCommand_AnyObj, b: Field3dRendererCommand_AnyObj, alpha: number, dt: number) {
    const speed = this.options.maxRobotSpeed;
    if (ROBOT_LIKE.has(a.type) && "mechanisms" in a && "mechanisms" in b) {
      return {
        ...a,
        poses: this.blendList(a.poses, b.poses, alpha, dt, speed),
        components: this.blendList(a.components, b.components, alpha, dt, speed),
        // Vision targets are detections, not continuous motion: hold
        mechanisms: {
          xz: this.blendMechanism(a.mechanisms.xz, b.mechanisms.xz, alpha),
          yz: this.blendMechanism(a.mechanisms.yz, b.mechanisms.yz, alpha)
        }
      };
    }
    if (a.type === "axes" || a.type === "cone") {
      return { ...a, poses: this.blendList(a.poses, b.poses, alpha, dt, speed) };
    }
    // Trajectories, heatmaps, AprilTags: static or not meaningfully continuous
    return a;
  }

  // ---- entity table ----

  entities(): EntityInfo[] {
    if (this.entityTable !== null) return this.entityTable;
    const times = this.provider.times;
    const table = new Map<string, EntityInfo>();
    const last = times.length - 1;
    const first = this.raw(0);
    // Robots and other non-piece objects: scan the first and last samples (their lists don't change over a run)
    const addObject = (command: Field3dRendererCommand, objIndex: number, k: number) => {
      const obj = command.objects[objIndex];
      if (obj.type !== "robot" && obj.type !== "ghost") return;
      obj.poses.forEach((_, i) => {
        const id = this.entityId(command, objIndex, i, i);
        const group = obj.model;
        const existing = table.get(id);
        if (existing === undefined) {
          table.set(id, {
            id,
            type: obj.type,
            name: group,
            group,
            firstTime: times[k],
            lastTime: times[k]
          });
        } else existing.lastTime = times[k];
      });
    };
    [0, last].forEach((k) => {
      const command = this.raw(k);
      command.objects.forEach((_, objIndex) => addObject(command, objIndex, k));
    });
    // Game pieces: the full run, since tracks come and go
    first.objects.forEach((obj, objIndex) => {
      if (obj.type !== "gamePiece") return;
      const tracker = this.trackerFor(objIndex, last);
      tracker.trackIds().forEach((trackId) => {
        const [k0, k1] = tracker.lifetime(trackId)!;
        const id = this.entityId(first, objIndex, 0, trackId);
        table.set(id, {
          id,
          type: "gamePiece",
          name: `${obj.variant} #${trackId}`,
          group: obj.variant,
          firstTime: times[k0],
          lastTime: times[k1]
        });
      });
    });
    this.entityTable = [...table.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return this.entityTable;
  }

  entityStates(t: number): EntityState[] {
    const sample = this.sample(t);
    const info = new Map(this.entities().map((e) => [e.id, e]));
    const out: EntityState[] = [];
    sample.command.objects.forEach((obj, objIndex) => {
      if (obj.type === "aprilTagBuiltIn" || obj.type === "trajectory" || obj.type === "heatmap") return;
      obj.poses.forEach((p, i) => {
        const id = sample.entityIds[objIndex][i];
        const entity = id === null ? undefined : info.get(id);
        if (entity === undefined) return;
        out.push({ ...entity, pose: obj.type === "gamePiece" && isParked(p.pose) ? null : p.pose });
      });
    });
    return out;
  }

  entityPose(id: string, t: number): Pose3d | null {
    return this.entityStates(t).find((e) => e.id === id)?.pose ?? null;
  }
}
