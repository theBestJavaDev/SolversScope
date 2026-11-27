// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Talks to the SolversScope command server (one short-lived WebSocket per call, so restarts never leave a stale socket). */

import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const START_HINT =
  "Start SolversScope with the command server enabled, with a log open that has a 3D Field tab: " +
  "`npx electron bundles/main.js --cinematic-server <log.rlog>` from the SolversScope repo " +
  "(or set SOLVERS_CINEMATIC_SERVER=1). If it is running on another port, set SOLVERSCOPE_PORT.";

type Connection = { url: string; token: string };

/** Port/token come from env overrides, else from ~/.solverscope/cinematic.json (written by the app at start-up). */
export function findConnection(env: NodeJS.ProcessEnv = process.env): Connection {
  const pointerPath = env.SOLVERSCOPE_DISCOVERY ?? path.join(os.homedir(), ".solverscope", "cinematic.json");
  let pointer: { host?: string; port?: number; tokenFile?: string } = {};
  try {
    pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8"));
  } catch {
    if (!env.SOLVERSCOPE_PORT) throw new BridgeError("server_not_running", "SolversScope's command server is not running. " + START_HINT);
  }
  const port = Number(env.SOLVERSCOPE_PORT ?? pointer.port ?? 8765);
  const tokenFile = env.SOLVERSCOPE_TOKEN_FILE ?? pointer.tokenFile;
  let token = env.SOLVERSCOPE_TOKEN ?? "";
  if (!token && tokenFile) {
    try {
      token = fs.readFileSync(tokenFile, "utf-8").trim();
    } catch {
      throw new BridgeError("server_not_running", `Could not read the token file ${tokenFile}. ` + START_HINT);
    }
  }
  if (!token) throw new BridgeError("server_not_running", "No token found for the command server. " + START_HINT);
  return { url: `ws://${pointer.host ?? "127.0.0.1"}:${port}`, token };
}

let nextId = 1;

/** Sends one command and resolves with its result, or throws a BridgeError carrying the server's structured error. */
export function callServer(cmd: string, params: object = {}, timeoutMs = 10 * 60 * 1000): Promise<any> {
  const connection = findConnection();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(connection.url, { headers: { "x-solverscope-token": connection.token }, handshakeTimeout: 5000 });
    const id = nextId++;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new BridgeError("timeout", `${cmd} did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const fail = (error: BridgeError) => {
      clearTimeout(timer);
      reject(error);
    };
    ws.on("open", () => ws.send(JSON.stringify({ id, cmd, params })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.ok) resolve(msg.result);
      else reject(new BridgeError(msg.error.code, msg.error.message, msg.error.details));
    });
    ws.on("unexpected-response", (_req, res) => {
      const why = res.statusCode === 401 ? "the token was rejected (is this a different SolversScope launch? restart the bridge)" : `HTTP ${res.statusCode}`;
      fail(new BridgeError("connection_refused", `SolversScope refused the connection: ${why}. ` + START_HINT));
    });
    ws.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        fail(new BridgeError("server_not_running", "Could not connect to SolversScope's command server. " + START_HINT));
      } else fail(new BridgeError("connection_error", error.message));
    });
    ws.on("close", () => {
      clearTimeout(timer);
    });
  });
}
