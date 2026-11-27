// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Virtual clock checks. Part of `npm run test:cinematic`. */

import { frameCount, frameTime, subframeTimes } from "../../src/shared/cinematic/Timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
}

check("frame time is exactly start + k/fps (no accumulated drift at frame 100000)", frameTime(2, 100000, 60) === 2 + 100000 / 60);
check("frame count covers [start, end) at fps", frameCount(0, 1.5, 30) === 45 && frameCount(8, 8.8, 30) === 24);
check("a range shorter than one frame still renders one frame", frameCount(0, 0.001, 30) === 1);
check("one subframe is exactly t (preview == unblurred render)", subframeTimes(3.25, 60, 1)[0].t === 3.25);
{
  const subs = subframeTimes(10, 30, 4, 180);
  const span = subs[3].t - subs[0].t;
  check("weights sum to 1", Math.abs(subs.reduce((a, s) => a + s.weight, 0) - 1) < 1e-12);
  check("subframes are centered on the frame time", Math.abs((subs[0].t + subs[3].t) / 2 - 10) < 1e-12);
  check("180 degree shutter spans half a frame (with sample centers inside it)", Math.abs(span - (3 / 4) * 0.5 / 30) < 1e-12, String(span));
  check("360 degree shutter spans a full frame interval", Math.abs(subframeTimes(10, 30, 2, 360)[1].t - subframeTimes(10, 30, 2, 360)[0].t - 0.5 / 30) < 1e-12);
}
console.log(failures === 0 ? "\nAll timing checks passed" : `\n${failures} timing check(s) failed`);
if (failures !== 0) process.exit(1);
