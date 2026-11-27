// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Offline checks for the bridge (no SolversScope needed): contact-sheet layout, tiling, and the "server not running" error. */

import { PNG } from "pngjs";
import { BridgeError, callServer } from "./client.js";
import { MAX_EDGE, evenTimes, layoutSheet, tile } from "./sheet.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
};

for (const n of [1, 2, 6, 9, 12, 36]) {
  const l = layoutSheet(n);
  check(`layout n=${n}: long edge <= ${MAX_EDGE} and all tiles fit`, Math.max(l.width, l.height) <= MAX_EDGE && l.columns * l.rows >= n, JSON.stringify(l));
}
check("times include both ends, evenly spaced", JSON.stringify(evenTimes(0, 10, 5)) === "[0,2.5,5,7.5,10]");
check("single frame is the middle", evenTimes(2, 4, 1)[0] === 3);

{
  const l = layoutSheet(4);
  const solid = (r: number, g: number, b: number) => {
    const png = new PNG({ width: l.tileWidth, height: l.tileHeight });
    for (let i = 0; i < png.data.length; i += 4) [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] = [r, g, b, 255];
    return PNG.sync.write(png);
  };
  const out = PNG.sync.read(tile([solid(255, 0, 0), solid(0, 255, 0), solid(0, 0, 255), solid(255, 255, 0)], l));
  const px = (col: number, row: number) => Array.from(out.data.subarray(((row * l.tileHeight + 1) * out.width + col * l.tileWidth + 1) * 4, ((row * l.tileHeight + 1) * out.width + col * l.tileWidth + 1) * 4 + 3));
  check("tiles land row-major (tile 1 top-left, 2 top-right, 3 below 1)", JSON.stringify([px(0, 0), px(1, 0), px(0, 1), px(1, 1)]) === JSON.stringify([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]), JSON.stringify([px(0, 0), px(1, 0)]));
}

{
  process.env.SOLVERSCOPE_DISCOVERY = "/nonexistent/none.json";
  delete process.env.SOLVERSCOPE_PORT;
  let message = "";
  try {
    await callServer("get_scene");
  } catch (e) {
    message = e instanceof BridgeError ? `${e.code}: ${e.message}` : String(e);
  }
  check("no discovery file -> clear 'start SolverScope with the command server enabled' error", message.startsWith("server_not_running") && message.includes("command server enabled"), message);
  process.env.SOLVERSCOPE_PORT = "1"; // Nothing listens there
  process.env.SOLVERSCOPE_TOKEN = "x";
  message = "";
  try {
    await callServer("get_scene");
  } catch (e) {
    message = e instanceof BridgeError ? `${e.code}: ${e.message}` : String(e);
  }
  check("connection refused -> the same clear error", message.startsWith("server_not_running") && message.includes("command server enabled"), message);
}

console.log(failures === 0 ? "\nAll bridge checks passed" : `\n${failures} bridge check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
