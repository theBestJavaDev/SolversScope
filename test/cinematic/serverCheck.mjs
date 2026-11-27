// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// End-to-end check of the cinematic command server. Start the app first:
//   SOLVERS_FFMPEG=<ffmpeg> npx electron bundles/main.js --cinematic-server <log.rlog>
// then: node test/cinematic/serverCheck.mjs
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".solverscope", "cinematic.json"), "utf-8"));
const token = fs.readFileSync(info.tokenFile, "utf-8");
const url = `ws://${info.host}:${info.port}`;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
};

const attempt = (headers) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => (ws.close(), resolve("open")));
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    ws.on("error", () => resolve("error"));
  });
check("no token is rejected (401)", (await attempt({})) === 401);
check("wrong token is rejected (401)", (await attempt({ "x-solverscope-token": "nope" })) === 401);
check("web Origin is rejected (403) even with the right token", (await attempt({ "x-solverscope-token": token, Origin: "http://evil.example" })) === 403);

const ws = new WebSocket(url, { headers: { "x-solverscope-token": token } });
await new Promise((r) => ws.on("open", r));
let nextId = 1;
const pending = new Map();
ws.on("message", (m) => {
  const msg = JSON.parse(m.toString());
  pending.get(msg.id)?.(msg);
});
const call = (cmd, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, cmd, params }));
  });
const raw = (text) =>
  new Promise((resolve) => {
    pending.set(null, resolve);
    ws.send(text);
  });

let r = await raw("{not json");
check("bad JSON -> bad_request", r.ok === false && r.error.code === "bad_request");
r = await call("nope");
check("unknown command -> unknown_command (id echoed)", r.ok === false && r.error.code === "unknown_command" && r.id === nextId - 1);

r = await call("list_replays");
check("list_replays returns absolute paths", r.ok && r.result.replays.length > 0 && r.result.replays.every((x) => path.isAbsolute(x.path)), JSON.stringify(r).slice(0, 200));
r = await call("load_replay", { replay: "relative.rlog" });
check("load_replay rejects relative paths", r.ok === false && r.error.code === "invalid_params");
r = await call("load_replay", { replay: "/etc/passwd" });
check("load_replay rejects non-log files", r.ok === false && r.error.code === "invalid_params");
r = await call("load_replay", { replay: "/nonexistent/x.rlog" });
check("load_replay missing file -> replay_not_found", r.ok === false && r.error.code === "replay_not_found");

r = await call("get_scene");
check("get_scene has duration, frame, field and entities", r.ok && r.result.duration > 1 && r.result.frame.quaternion.includes("w first") && r.result.field.sizeMeters.length === 2 && r.result.entities.some((e) => e.id === "robot.0"), JSON.stringify(r).slice(0, 200));
const scene = r.result;
r = await call("get_scene", { t: 1e9 });
check("get_scene out-of-range t -> t_out_of_range with bounds", r.ok === false && r.error.code === "t_out_of_range" && r.error.details.max === scene.endTime);

r = await call("set_shot", { preset: "follow_chase", preset_params: { target: "robot.9" } });
check("set_shot with unknown entity -> unknown_entity", r.ok === false && r.error.code === "unknown_entity", JSON.stringify(r));
r = await call("set_shot", { shot: { mode: "orbit" } });
check("set_shot with invalid shot -> invalid_shot", r.ok === false && r.error.code === "invalid_shot", JSON.stringify(r));
r = await call("preview_frame", { t: 10 });
check("preview_frame with no shot set -> no_shot", r.ok === false && r.error.code === "no_shot");
r = await call("set_shot", { preset: "follow_chase", preset_params: { target: "robot.0", start: 8 } });
check("set_shot with a preset stores the resolved shot", r.ok && r.result.shot.mode === "follow");

r = await call("preview_frame", { t: 10, width: 640, height: 360 });
const png = r.ok ? Buffer.from(r.result.image, "base64") : Buffer.alloc(0);
check("preview_frame returns a base64 PNG of the right size", r.ok && png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 640 && png.readUInt32BE(20) === 360, JSON.stringify(r).slice(0, 200));
r = await call("preview_frame", { t: 10, width: 640, height: 360, format: "jpeg" });
check("preview_frame jpeg option", r.ok && r.result.mimeType === "image/jpeg" && Buffer.from(r.result.image, "base64")[0] === 0xff);
r = await call("preview_frame", { t: -5 });
check("preview_frame out-of-range t -> t_out_of_range", r.ok === false && r.error.code === "t_out_of_range");
r = await call("preview_frame", { t: 10, width: 5 });
check("preview_frame bad width -> invalid_params", r.ok === false && r.error.code === "invalid_params");

r = await call("record_stop");
check("record_stop before start -> not_recording", r.ok === false && r.error.code === "not_recording");
r = await call("record_start");
check("record_start", r.ok && r.result.recording === true);
r = await call("record_start");
check("record_start twice -> already_recording", r.ok === false && r.error.code === "already_recording");
r = await call("record_stop");
check("record_stop returns the window", r.ok && r.result.recording === false && r.result.start !== null && r.result.end !== null, JSON.stringify(r).slice(0, 200));

r = await call("render_clip", { name: "../x", fps: 30, width: 640, height: 360, start: 8, end: 9 });
check("render_clip rejects path-like names", r.ok === false && r.error.code === "invalid_params");
r = await call("render_clip", { name: "srvtest", fps: 30, width: 640, height: 360, start: 8, end: 9, motion_blur_samples: 2 });
check("render_clip returns a job id immediately", r.ok && typeof r.result.jobId === "string" && r.result.frames === 30 && path.isAbsolute(r.result.outputPath), JSON.stringify(r).slice(0, 300));
const jobId = r.result?.jobId;
let status;
let sawRunning = false;
for (let i = 0; i < 600; i++) {
  status = (await call("render_status", { jobId })).result;
  if (status.state === "running" && status.framesDone > 0 && status.framesDone < status.frames) sawRunning = true;
  if (["done", "failed", "cancelled"].includes(status.state)) break;
  await new Promise((r) => setTimeout(r, 200));
}
check("render_status reports done with an absolute output path that exists", status.state === "done" && path.isAbsolute(status.outputPath) && fs.existsSync(status.outputPath) && status.framesDone === 30, JSON.stringify(status).slice(0, 400));
check("render_status showed progress while running", sawRunning || status.frames <= 30, "never saw a partial state (fast job)");
check("output stays inside the renders dir", status.outputPath?.startsWith(info.rendersDir) ?? false, `${status.outputPath} vs ${info.rendersDir}`);
r = await call("render_status", { jobId: "nope" });
check("render_status unknown job -> unknown_job", r.ok === false && r.error.code === "unknown_job");

ws.close();
console.log(failures === 0 ? "\nAll server checks passed" : `\n${failures} server check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
