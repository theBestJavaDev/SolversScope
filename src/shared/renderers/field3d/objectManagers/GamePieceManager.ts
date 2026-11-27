// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";
import { Pose3d, Rotation3d } from "../../../geometry";
import { Field3dRendererCommand_GamePieceObj } from "../../Field3dRenderer";
import ObjectManager from "../ObjectManager";
import ResizableInstancedMesh from "../ResizableInstancedMesh";

/** Per-piece motion state used to animate balls whose log has no orientation. */
interface BallMotion {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
  /** Unit axis (field frame) the ball last turned about. */
  axis: THREE.Vector3;
  /** Radians turned per meter travelled; sign flips for backspin. */
  rate: number;
  hasRolled: boolean;
  lastTime: number | null;
  /** Velocity (m/s) over the previous frame pair, to tell free flight from rolling. */
  velocity: THREE.Vector3 | null;
}

/** Jumps larger than this (m) between frames are scrubs/teleports, not motion. */
const MAX_FRAME_STEP = 1.5;
/** Spin per meter of a ball in flight that has never touched the floor, as a fraction of rolling (backspin). */
const LAUNCH_SPIN_FRACTION = -1.2;
const UP = new THREE.Vector3(0, 0, 1);
const GRAVITY = new THREE.Vector3(0, 0, -9.81);
/** Moving faster than this with no history is assumed to be a shot, not a ball rolling out of a cell (m/s). */
const LAUNCH_SPEED = 3;
/** Acceleration this close to gravity alone means free flight (m/s^2). */
const FREE_FLIGHT_TOLERANCE = 4;

/** Deterministic pseudo-random orientation so balls don't all sit with the same logo/seam facing. */
function seededOrientation(index: number): THREE.Quaternion {
  const rand = (n: number) => {
    const x = Math.sin((index + 1) * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const u1 = rand(1);
  const u2 = rand(2);
  const u3 = rand(3);
  return new THREE.Quaternion(
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3)
  );
}

export default class GamePieceManager extends ObjectManager<Field3dRendererCommand_GamePieceObj> {
  /**
   * Offline (cinematic) rendering sets this: rolling/spin is integrated over successive renders, so it depends on which
   * frames were drawn before, and a preview at t could never match a render frame at t. With it set, balls keep a fixed
   * seeded orientation (no roll or spin), which makes every frame a pure function of (replay, shot, t).
   */
  static stateless = false;
  private gamePieces: { [key: string]: THREE.Mesh };
  private instances: ResizableInstancedMesh | null = null;
  private lastVariant = "";
  private motion: BallMotion[] = [];
  private centers: { [variant: string]: THREE.Vector3 } = {};

  constructor(
    root: THREE.Object3D,
    materialSpecular: THREE.Color,
    materialShininess: number,
    mode: "low-power" | "standard" | "cinematic",
    isXR: boolean,
    requestRender: () => void,
    gamePieces: { [key: string]: THREE.Mesh }
  ) {
    super(root, materialSpecular, materialShininess, mode, isXR, requestRender);
    this.gamePieces = gamePieces;
  }

  dispose(): void {
    // Don't dispose game piece geometries/materials
    // (owned by main renderer and disposed there)
    this.instances?.dispose(false, false);
  }

  setObjectData(object: Field3dRendererCommand_GamePieceObj): void {
    // Create new instances
    if (object.variant !== this.lastVariant || this.instances === null) {
      this.lastVariant = object.variant;
      this.motion = [];
      this.instances?.dispose(false, false);
      if (object.variant in this.gamePieces) {
        this.instances = new ResizableInstancedMesh(this.root, [this.gamePieces[object.variant]]);
      }
    }

    // Update poses (balls get a rolling / spinning orientation derived from their motion)
    const radius = this.ballRadius(object.variant);
    this.instances?.setPoses(object.poses.map((x, index) => this.animate(x.pose, index, radius, object.time ?? null)));
  }

  /** Radius of a (roughly) spherical piece, or null for pieces that shouldn't be rolled. */
  private ballRadius(variant: string): number | null {
    const mesh = this.gamePieces[variant];
    if (mesh === undefined) return null;
    const geometry = mesh.geometry;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const shortest = Math.min(size.x, size.y, size.z);
    if (longest <= 0 || shortest / longest < 0.85) return null;
    this.centers[variant] = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const radius = longest / 2;
    return radius > 0.005 && radius < 0.5 ? radius : null;
  }

  /**
   * Gives a ball an orientation from how it moved since the last frame: it rolls on the floor
   * (no slipping), and in flight it keeps turning about the horizontal axis (backspin when it was
   * launched, or the roll it had when it left the floor). Pure function of displacement, so
   * scrubbing backwards un-rolls the ball. Poses that already carry a rotation are left alone.
   */
  private animate(pose: Pose3d, index: number, radius: number | null, time: number | null): Pose3d {
    const hasRotation = Math.abs(pose.rotation[0]) < 0.9999;
    if (radius === null || hasRotation) return pose;

    const position = new THREE.Vector3(...pose.translation);
    let state = this.motion[index];
    if (state === undefined) {
      state = {
        position: position.clone(),
        orientation: seededOrientation(index),
        axis: new THREE.Vector3(0, 1, 0),
        rate: 0,
        hasRolled: false,
        lastTime: time,
        velocity: null
      };
      this.motion[index] = state;
    }

    const step = position.clone().sub(state.position);
    const distance = step.length();
    const dt = time !== null && state.lastTime !== null ? time - state.lastTime : null;
    if (GamePieceManager.stateless) {
      state.orientation = seededOrientation(index);
    } else if (distance > MAX_FRAME_STEP || (dt !== null && Math.abs(dt) > 0.5)) {
      // Timeline jump or a piece reappearing elsewhere: restart from a fresh orientation
      state.orientation = seededOrientation(index);
      state.hasRolled = false;
      state.rate = 0;
      state.velocity = null;
    } else if (distance > 1e-6) {
      const horizontal = new THREE.Vector3(step.x, step.y, 0);
      const rolling = 1 / radius;
      if (horizontal.lengthSq() > 1e-12) {
        // Axis perpendicular to the direction of travel: up x direction (right-hand rule rolls it forward)
        state.axis.copy(UP).cross(horizontal).normalize();
      }

      // Free flight (a shot or a fall) vs. rolling on something (floor, or the tipping CELL's bar).
      // Free flight accelerates at gravity alone; anything else that is moving is being carried.
      let velocity: THREE.Vector3 | null = null;
      if (dt !== null && Math.abs(dt) > 1e-4) velocity = step.clone().divideScalar(dt);
      let freeFlight: boolean;
      if (velocity === null) {
        freeFlight = false;
      } else if (state.velocity === null) {
        freeFlight = velocity.length() > LAUNCH_SPEED; // no history yet: fast = just launched
      } else {
        const acceleration = velocity.clone().sub(state.velocity).divideScalar(dt!);
        freeFlight = acceleration.distanceTo(GRAVITY) < FREE_FLIGHT_TOLERANCE && velocity.length() > 0.5;
      }
      state.velocity = velocity;

      if (!freeFlight) {
        // Rolling forward along its path, whichever way that points (down a tipped bar, out of the CELL...)
        state.rate = rolling;
        state.hasRolled = true;
      } else if (!state.hasRolled) {
        state.rate = rolling * LAUNCH_SPIN_FRACTION; // launched: backspin
      }
      const angle = distance * state.rate;
      const turn = new THREE.Quaternion().setFromAxisAngle(state.axis, angle);
      state.orientation.premultiply(turn).normalize();
    }
    state.lastTime = time;
    state.position.copy(position);

    const q = state.orientation;
    const rotation: Rotation3d = [q.w, q.x, q.y, q.z];
    // The model may not be centered on its origin: turn it about its own center
    const c = this.centers[this.lastVariant];
    let translation = pose.translation;
    if (c !== undefined && c.lengthSq() > 1e-8) {
      const shift = c.clone().sub(c.clone().applyQuaternion(q));
      translation = [translation[0] + shift.x, translation[1] + shift.y, translation[2] + shift.z];
    }
    return { translation: translation, rotation: rotation };
  }
}
