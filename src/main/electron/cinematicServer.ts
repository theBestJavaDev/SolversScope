// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Cinematic command server: JSON over a WebSocket on 127.0.0.1 only. Off unless started (`--cinematic-server[=port]`
 * or SOLVERS_CINEMATIC_SERVER=1 / SOLVERS_CINEMATIC_PORT); with it off, none of this runs.
 *
 * Protocol:  request  {"id": <number|string>, "cmd": "<name>", "params": {...}}
 *            response {"id": <same>, "ok": true,  "result": {...}}
 *                     {"id": <same>, "ok": false, "error": {"code": "...", "message": "...", "details"?: ...}}
 *
 * Security (any web page can open a WebSocket to 127.0.0.1, and render_clip writes files):
 *  - Connections carrying an Origin header with a web origin (http/https/...) are refused. Native clients send none.
 *  - A per-launch random token is written to <userData>/cinematic-token (mode 0600) and must be sent in the
 *    `x-solverscope-token` header (browsers cannot set it). A pointer file ~/.solverscope/cinematic.json tells local
 *    tools the port and where the token file is; it never holds the token.
 *  - Output paths are never taken from callers: renders go to the renders directory under a validated name.
 *    Replays are opened by path, but only with a log-file extension.
 */

import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { CinematicError, CinematicMain } from "./cinematicMain";
import { listRuns } from "./runsFolder";

export const DEFAULT_PORT = 8765;
const REPLAY_EXTENSIONS = [".rlog", ".wpilog", ".wpilogxz", ".hoot", ".revlog", ".csv"];

export namespace CinematicServer {
  let wss: WebSocketServer | null = null;
  let httpServer: http.Server | null = null;
  let token = "";
  let currentShot: unknown = null;
  let lastRecording: { start: number; end: number } | null = null;
  let currentReplay: string | null = null;

  /** Parses `--cinematic-server[=port]` / env into a port, or null when the server is not requested. */
  export function requestedPort(argv: string[], env: NodeJS.ProcessEnv): number | null {
    const flag = argv.find((a) => a === "--cinematic-server" || a.startsWith("--cinematic-server="));
    let port: number | null = null;
    if (flag !== undefined) port = flag.includes("=") ? Number(flag.split("=")[1]) : DEFAULT_PORT;
    else if (env.SOLVERS_CINEMATIC_PORT) port = Number(env.SOLVERS_CINEMATIC_PORT);
    else if (env.SOLVERS_CINEMATIC_SERVER === "1") port = DEFAULT_PORT;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      console.error(`[cinematic] invalid port for the command server: ${port}`);
      return null;
    }
    return port;
  }

  export function tokenFilePath(): string {
    return path.join(app.getPath("userData"), "cinematic-token");
  }

  export function start(port: number) {
    if (wss !== null) return;
    token = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(tokenFilePath(), token, { mode: 0o600 });
    fs.chmodSync(tokenFilePath(), 0o600);

    httpServer = http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("SolversScope cinematic server: connect with a WebSocket client.");
    });
    wss = new WebSocketServer({
      server: httpServer,
      maxPayload: 1024 * 1024,
      verifyClient: (info, done) => {
        const origin = info.origin;
        if (origin !== undefined && origin !== "") return done(false, 403, "Browser origins are not allowed");
        const sent = info.req.headers["x-solverscope-token"];
        const given = Buffer.from(typeof sent === "string" ? sent : "");
        const want = Buffer.from(token);
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return done(false, 401, "Bad token");
        done(true);
      }
    });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => void handleMessage(socket, raw.toString()));
    });
    httpServer.on("error", (error) => console.error("[cinematic] command server error:", error.message));
    httpServer.listen(port, "127.0.0.1", () => {
      console.log(`[cinematic] command server listening on ws://127.0.0.1:${port} (token file: ${tokenFilePath()})`);
      try {
        const dir = path.join(os.homedir(), ".solverscope");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "cinematic.json"),
          JSON.stringify({ host: "127.0.0.1", port, tokenFile: tokenFilePath(), pid: process.pid, rendersDir: CinematicMain.getRendersDir() }, null, 2),
          { mode: 0o600 }
        );
      } catch (error) {
        console.warn("[cinematic] could not write the discovery file:", error);
      }
    });
  }

  export function stop() {
    wss?.close();
    httpServer?.close();
    wss = null;
    httpServer = null;
  }

  /** Default replay folder: $SOLVERS_REPLAY_DIR, else the newest `<project>/TeamCode/build/sim` up to two levels under home. */
  function findSimFolder(): string | null {
    if (process.env.SOLVERS_REPLAY_DIR) return process.env.SOLVERS_REPLAY_DIR;
    const found: { folder: string; modified: number }[] = [];
    const dirs = (dir: string) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(dir, e.name));
      } catch {
        return [];
      }
    };
    const home = os.homedir();
    for (const level1 of dirs(home)) {
      for (const project of [level1, ...dirs(level1)]) {
        const folder = path.join(project, "TeamCode", "build", "sim");
        try {
          if (fs.statSync(folder).isDirectory()) found.push({ folder, modified: fs.statSync(folder).mtimeMs });
        } catch {
          // not a robot project
        }
      }
    }
    found.sort((a, b) => b.modified - a.modified);
    return found[0]?.folder ?? null;
  }

  // ---------- dispatch ----------

  async function handleMessage(socket: WebSocket, raw: string) {
    let id: unknown = null;
    const send = (body: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id, ...body }));
    try {
      let request: any;
      try {
        request = JSON.parse(raw);
      } catch {
        throw new CinematicError("bad_request", "Request must be JSON: {id, cmd, params}");
      }
      id = request?.id ?? null;
      if (typeof request !== "object" || request === null || typeof request.cmd !== "string") {
        throw new CinematicError("bad_request", "Request must be an object with a string `cmd`");
      }
      if (request.params !== undefined && (typeof request.params !== "object" || request.params === null || Array.isArray(request.params))) {
        throw new CinematicError("bad_request", "`params` must be an object");
      }
      const handler = handlers[request.cmd];
      if (handler === undefined) {
        throw new CinematicError("unknown_command", `Unknown command "${request.cmd}". Commands: ${Object.keys(handlers).join(", ")}`);
      }
      send({ ok: true, result: await handler(request.params ?? {}) });
    } catch (error) {
      const e = error instanceof CinematicError ? error.toJSON() : { code: "internal_error", message: String((error as Error)?.message ?? error) };
      send({ ok: false, error: e });
    }
  }

  /** Shot to use: the call's own `shot` or `preset` (+ `preset_params`), else the one stored by set_shot. */
  async function resolveShot(params: any): Promise<unknown> {
    if (params.shot !== undefined) return params.shot;
    if (params.preset !== undefined) {
      return CinematicMain.hubCall("cin-preset", { preset: params.preset, params: params.preset_params ?? {} });
    }
    if (currentShot === null) {
      throw new CinematicError("no_shot", "No shot given and none set. Pass `shot` or `preset`, or call set_shot first.");
    }
    return currentShot;
  }

  async function ensureReplay(params: any) {
    if (typeof params.replay === "string" && params.replay !== currentReplay) await loadReplay(params.replay);
  }

  async function loadReplay(file: string) {
    if (!path.isAbsolute(file)) throw new CinematicError("invalid_params", "replay must be an absolute path (see list_replays)");
    if (!REPLAY_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
      throw new CinematicError("invalid_params", `replay must be a log file (${REPLAY_EXTENSIONS.join(", ")})`);
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new CinematicError("replay_not_found", `No such file: ${file}`);
    const scene = await CinematicMain.openReplay(file);
    currentReplay = file;
    return scene;
  }

  const handlers: { [cmd: string]: (params: any) => Promise<unknown> } = {
    async get_scene(params) {
      return CinematicMain.hubCall("cin-scene", { t: params.t });
    },

    async list_replays(params) {
      if (params.folder !== undefined && typeof params.folder !== "string") {
        throw new CinematicError("invalid_params", "folder must be a string path");
      }
      let list = listRuns(params.folder);
      if (params.folder === undefined && list.runs.length === 0) list = listRuns(findSimFolder());
      return { folder: list.folder, current: currentReplay, replays: list.runs.map((r) => ({ path: r.path, name: r.name, modifiedMs: r.modified, sizeKb: r.sizeKb })) };
    },

    async load_replay(params) {
      if (typeof params.replay !== "string") throw new CinematicError("invalid_params", "replay (absolute path) is required");
      return loadReplay(params.replay);
    },

    async record_start() {
      return CinematicMain.hubCall("cin-record", { action: "start" });
    },

    async record_stop() {
      const result = await CinematicMain.hubCall("cin-record", { action: "stop" });
      if (result.start !== null && result.end !== null && result.end > result.start) {
        lastRecording = { start: result.start, end: result.end };
      }
      return result;
    },

    async set_shot(params) {
      const shot = await resolveShot({ shot: params.shot, preset: params.preset, preset_params: params.preset_params, });
      // Validate against the replay now (entity ids, structure) so mistakes surface here, not at render time
      const scene = await CinematicMain.hubCall("cin-scene", {});
      await CinematicMain.hubCall("cin-sample", { shot, items: [{ t: scene.startTime, subs: [{ t: scene.startTime, weight: 1 }] }] });
      currentShot = shot;
      return { shot };
    },

    async preview_frame(params) {
      await ensureReplay(params);
      const shot = await resolveShot(params);
      const result = await CinematicMain.previewFrame({
        shot,
        t: params.t,
        width: params.width,
        height: params.height,
        format: params.format,
        quality: params.quality
      });
      return { image: result.data.toString("base64"), mimeType: result.mimeType, width: result.width, height: result.height, t: result.t, pixelHash: result.pixelHash };
    },

    async render_clip(params) {
      await ensureReplay(params);
      const shot = await resolveShot(params);
      const job = await CinematicMain.renderClip({
        shot,
        name: params.name,
        fps: params.fps,
        width: params.width,
        height: params.height,
        start: params.start ?? lastRecording?.start,
        end: params.end ?? lastRecording?.end,
        motionBlurSamples: params.motion_blur_samples,
        shutterDegrees: params.shutter_degrees,
        crf: params.crf
      });
      return { jobId: job.jobId, frames: job.frames, outputPath: job.outputPath };
    },

    async render_status(params) {
      if (typeof params.jobId !== "string") throw new CinematicError("invalid_params", "jobId is required");
      if (params.cancel === true) CinematicMain.cancelJob(params.jobId);
      const job = CinematicMain.getJob(params.jobId);
      if (job === null) throw new CinematicError("unknown_job", `No render job ${params.jobId}`);
      return { ...job, progress: job.frames > 0 ? job.framesDone / job.frames : 0 };
    }
  };
}
