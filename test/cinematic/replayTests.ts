// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Cinematic replay checks. Run with `npm run test:cinematic`. Exits non-zero if any check fails. */

import { InterpolatingReplaySource, RawCommandProvider } from "../../src/shared/cinematic/ReplaySource";
import { associate, DEFAULT_TRACKER_OPTIONS } from "../../src/shared/cinematic/PieceTracker";
import { slerp } from "../../src/shared/cinematic/ReplayMath";
import { AnnotatedPose3d, Translation3d } from "../../src/shared/geometry";
import { Field3dRendererCommand } from "../../src/shared/renderers/Field3dRenderer";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const ap = (x: number, y: number, z = 0, yaw = 0): AnnotatedPose3d => ({
  pose: { translation: [x, y, z], rotation: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)] },
  annotation: { is2DSource: false }
});

type Frame = { robots: AnnotatedPose3d[]; balls: AnnotatedPose3d[] };
function provider(times: number[], at: (t: number) => Frame, stableIds = false): RawCommandProvider {
  return {
    times,
    commandAt: (t) => {
      const f = at(t);
      return {
        field: "FTC:Test",
        isRedAlliance: false,
        coordinateSystem: "center-red",
        autoDriverStation: -1,
        allRobotModels: ["Bot"],
        cameraOverride: null,
        objects: [
          {
            type: "robot",
            model: "Bot",
            poses: f.robots,
            components: [],
            mechanisms: { xz: null, yz: null },
            visionTargets: [],
            swerveModuleVelocities: []
          },
          { type: "gamePiece", variant: "ball", poses: f.balls, time: t, stableIds }
        ]
      } as Field3dRendererCommand;
    }
  };
}
const times50 = Array.from({ length: 101 }, (_, i) => i * 0.02);

// 1. Continuous channels interpolate at 60 fps cadence
{
  const src = new InterpolatingReplaySource(provider(times50, (t) => ({ robots: [ap(t * 2, 0, 0, t)], balls: [] })));
  let maxErr = 0;
  for (let f = 0; f < 120; f++) {
    const t = f / 60;
    const p = src.sample(t).command.objects[0].poses[0].pose.translation[0];
    maxErr = Math.max(maxErr, Math.abs(p - t * 2));
  }
  check("robot position is linear in time between 50 Hz samples (60 fps)", maxErr < 1e-9, `maxErr=${maxErr}`);
  const q = src.sample(0.5 + 0.01).command.objects[0].poses[0].pose.rotation;
  check("rotation is slerped (yaw 0.51 rad)", near(2 * Math.atan2(q[3], q[0]), 0.51, 1e-6));
}

// 2. slerp takes the short way and stays unit length
{
  const a: [number, number, number, number] = [1, 0, 0, 0];
  const b: [number, number, number, number] = [-Math.cos(0.1), 0, 0, -Math.sin(0.1)]; // same rotation as yaw 0.2, negated
  const m = slerp(a, b, 0.5);
  check("slerp uses the shortest arc", near(2 * Math.atan2(Math.abs(m[3]), Math.abs(m[0])), 0.1, 1e-9), String(m));
  check("slerp output is unit length", near(Math.hypot(...m), 1, 1e-12));
}

// 3. Teleports hold, not fly
{
  const jump = (t: number) => ({ robots: [t < 1 ? ap(0, 0) : ap(10, 0)], balls: [] });
  const src = new InterpolatingReplaySource(provider(times50, jump));
  const x = src.sample(0.99).command.objects[0].poses[0].pose.translation[0];
  check("a 10 m jump in one sample is step-held", x === 0, `x=${x}`);
}

// 4. Parked balls (sim hides balls at x=1e4) do not fly across the field
{
  const at = (t: number) => ({ robots: [ap(0, 0)], balls: [t < 1 ? ap(1, 1, 0.05) : ap(1e4, 1e4, -1000)] });
  const src = new InterpolatingReplaySource(provider(times50, at, true));
  const p = src.sample(0.99).command.objects[1].poses[0].pose.translation;
  check("ball parked off field is held until the parking sample", p[0] === 1 && p[1] === 1);
  check("parked ball has no entity pose", src.entityPose("piece.0.0", 1.5) === null);
}

// 5. Two balls crossing, listed in swapped order halfway through: ids must follow the balls
{
  // Ball A moves +x along y=0 at 3 m/s from x=-1.5; ball B moves +y along x=0 from y=-1.1 at 2 m/s. They cross near the origin,
  // but at different times, so they never coincide. The list order flips at t=0.5.
  const pos = (t: number): { a: Translation3d; b: Translation3d } => ({
    a: [-1.5 + 3 * t, 0, 0.05],
    b: [0, -1.1 + 2 * t, 0.05]
  });
  const at = (t: number) => {
    const { a, b } = pos(t);
    const pa = ap(...a);
    const pb = ap(...b);
    return { robots: [ap(0, 0)], balls: t < 0.5 ? [pa, pb] : [pb, pa] };
  };
  const src = new InterpolatingReplaySource(provider(times50, at));
  const idAt = (t: number, which: "a" | "b") => {
    const s = src.sample(t);
    const target = pos(t)[which];
    const poses = s.command.objects[1].poses;
    const i = poses.findIndex((p) => Math.hypot(p.pose.translation[0] - target[0], p.pose.translation[1] - target[1]) < 1e-6);
    return i < 0 ? "missing" : s.entityIds[1][i];
  };
  const ids = { a: new Set<string | null>(), b: new Set<string | null>() };
  for (let k = 0; k < 100; k++) {
    // Sample exactly on log times so positions match the truth exactly
    ids.a.add(idAt(times50[k], "a"));
    ids.b.add(idAt(times50[k], "b"));
  }
  check("ball A keeps one id through the crossing and a list reorder", ids.a.size === 1 && !ids.a.has("missing"), [...ids.a].join());
  check("ball B keeps one id through the crossing and a list reorder", ids.b.size === 1 && !ids.b.has("missing"), [...ids.b].join());
  check("A and B have different ids", [...ids.a][0] !== [...ids.b][0]);
  // Between samples the blended ball lies on the true path
  const s = src.sample(0.23);
  const target = pos(0.23).a;
  const onPath = s.command.objects[1].poses.some(
    (p) => Math.hypot(p.pose.translation[0] - target[0], p.pose.translation[1] - target[1]) < 1e-6
  );
  check("interpolated ball sits on its true path between samples", onPath);
  const table = src.entities().filter((e) => e.type === "gamePiece");
  check("entity table lists exactly 2 pieces for 2 balls", table.length === 2, String(table.length));
}

// 6. Ambiguity: two balls on top of each other are held, not swapped
{
  const m = associate(
    [
      [0, 0, 0],
      [0.01, 0, 0]
    ],
    [
      [0.005, 0, 0],
      [0.015, 0, 0]
    ],
    0.5,
    DEFAULT_TRACKER_OPTIONS
  );
  check("touching balls with an ambiguous match are held (-1)", m[0] === -1 && m[1] === -1, String(m));
}

// 7. Pieces present in the first sample but gone later: still in the table with a lifetime
{
  const at = (t: number) => ({ robots: [ap(0, 0)], balls: t < 1 ? [ap(1, 1)] : [] });
  const src = new InterpolatingReplaySource(provider(times50, at));
  const e = src.entities().find((x) => x.type === "gamePiece")!;
  check("piece lifetime recorded", e !== undefined && near(e.firstTime, 0) && near(e.lastTime, 0.98, 0.021), JSON.stringify(e));
  check("robot entity id and name", src.entities().some((x) => x.id === "robot.0" && x.name === "Bot"));
}

// 8. Determinism: same t, same output
{
  const src = new InterpolatingReplaySource(provider(times50, (t) => ({ robots: [ap(t, 0, 0, t)], balls: [ap(t, 1)] })));
  const a = JSON.stringify(src.sample(0.777));
  src.sample(1.5);
  const b = JSON.stringify(src.sample(0.777));
  check("sample(t) is a pure function of t", a === b);
}

console.log(failures === 0 ? "\nAll replay checks passed" : `\n${failures} replay check(s) failed`);
if (failures !== 0) process.exit(1);
