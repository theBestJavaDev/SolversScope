#!/usr/bin/env node
// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * stdio MCP server: one tool per SolversScope command-server command, plus preview_contact_sheet.
 * Register: claude mcp add --scope project --transport stdio solverscope -- node tools/solverscope-mcp/dist/index.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, callServer } from "./client.js";
import { evenTimes, layoutSheet, tile } from "./sheet.js";

const FRAME = [
  "COORDINATES: every position/pose uses the replay's field frame (get_scene.frame says which coordinate system the log uses).",
  "Right-handed, +Z up; units are meters, seconds, degrees for fov (vertical), radians for angular speed.",
  "Quaternions are [w, x, y, z] (w FIRST). A camera looks along its local +X with +Y left and +Z up, so the identity rotation looks along field +X.",
  "All times are on the REPLAY clock (the log's own seconds, shown by get_scene.startTime/endTime), not seconds from the clip start."
].join(" ");

const vec3 = z.array(z.number()).length(3).describe("[x, y, z] in meters");
const target = z
  .union([vec3, z.object({ entity: z.string().describe("entity id from get_scene, e.g. robot.0 or piece.0.3"), offset: vec3.optional().describe("meters added to the entity position, in field axes") })])
  .describe("A world point [x,y,z], or {entity, offset?} to track a robot / game piece as it moves");

const shotSchema = z
  .object({
    mode: z.enum(["static", "dolly", "orbit", "follow", "crane"]).describe(
      "static: one fixed keyframe. dolly: camera glides through 2+ keyframes on a centripetal Catmull-Rom spline (position), slerp (explicit rotations) or lookAt blending, with eased fov. crane: like dolly but the whole path is eased in/out so it starts and ends at rest (rising reveals). orbit: circle `orbit.center` at radius/height/angularSpeed, always aimed at it. follow: a critically damped spring chases `follow.target` through direction changes."
    ),
    startTime: z.number().optional().describe("Replay time (s) the shot begins; orbit angle and the follow spring start here. Default: replay start."),
    keyframes: z
      .array(
        z.object({
          t: z.number().describe("replay time (s)"),
          position: vec3.optional(),
          rotation: z.array(z.number()).length(4).optional().describe("[w,x,y,z]; use this OR lookAt"),
          lookAt: target.optional(),
          fov: z.number().optional().describe("vertical fov degrees (1-150); eased between keyframes")
        })
      )
      .optional()
      .describe("static needs 1; dolly and crane need 2+ (distinct times, each with position and rotation or lookAt)"),
    orbit: z
      .object({
        center: target,
        radius: z.number().describe("horizontal distance from center, meters (> 0)"),
        height: z.number().describe("camera height above the center point, meters"),
        angularSpeed: z.number().describe("rad/s; positive = counter-clockwise seen from above"),
        startAngle: z.number().optional().describe("radians from field +X toward +Y at startTime. Default 0"),
        lookAtOffset: vec3.optional()
      })
      .optional(),
    follow: z
      .object({
        target: z.string().describe("entity id to follow"),
        offset: vec3.describe("camera offset from the target, meters"),
        offsetFrame: z.enum(["target-local", "world"]).optional().describe("target-local (default): +X = the target's heading (yaw only). world: field axes"),
        lookAtOffset: vec3.optional().describe("aim point offset from the target, same frame as offset"),
        positionOmega: z.number().optional().describe("position spring frequency rad/s (default 3; higher = tighter)"),
        lookAtOmega: z.number().optional().describe("aim spring frequency rad/s (default 5)"),
        preroll: z.number().optional().describe("seconds of spring warm-up before startTime (default 1) so frame 0 is settled")
      })
      .optional(),
    fov: z.number().optional().describe("default vertical fov in degrees (default 50)"),
    up: vec3.optional().describe("world up used for lookAt (default [0,0,1])")
  })
  .describe("A camera shot. " + FRAME);

const presetEnum = z.enum(["establishing_wide", "follow_chase", "low_angle_hero", "top_down", "orbit_robot", "crane_reveal"]);
const presetParams = z
  .object({
    target: z.string().optional().describe("entity id (required by follow_chase, low_angle_hero, orbit_robot; optional for crane_reveal)"),
    start: z.number().optional().describe("replay time (s) the shot starts (default: replay start)"),
    duration: z.number().optional().describe("shot length in seconds for dolly/crane presets (default 6)")
  })
  .describe("Preset parameters");

const shotChoice = {
  shot: shotSchema.optional().describe("Explicit shot. If omitted, `preset` is used, else the shot stored by set_shot."),
  preset: presetEnum.optional().describe("Named preset instead of a full shot: establishing_wide, follow_chase, low_angle_hero, top_down, orbit_robot, crane_reveal"),
  preset_params: presetParams.optional()
};

const server = new McpServer({ name: "solverscope", version: "1.0.0" });

function fail(error: unknown) {
  const e = error instanceof BridgeError ? error : new BridgeError("internal_error", String((error as Error)?.message ?? error));
  const details = e.details === undefined ? "" : "\nDetails: " + JSON.stringify(e.details);
  return { isError: true, content: [{ type: "text" as const, text: `[${e.code}] ${e.message}${details}` }] };
}
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const wrap = <A,>(fn: (args: A) => Promise<any>) => async (args: A) => {
  try {
    return await fn(args);
  } catch (error) {
    return fail(error);
  }
};

server.registerTool(
  "get_scene",
  {
    description:
      "Describe the loaded replay: start/end/duration (seconds, replay clock), the coordinate frame (units, axes, quaternion order, camera axes), the field (id, size in meters, center in the log frame) and every entity with its id, type (robot|ghost|gamePiece), name and pose at time t. Entity ids are what shots reference (lookAt, follow.target, orbit.center): robots are robot.0, robot.1...; game pieces are piece.<group>.<n>. Call this first.",
    inputSchema: { t: z.number().optional().describe("replay time (s) to read poses at; default = replay start. Must be within [startTime, endTime].") }
  },
  wrap(async (args: { t?: number }) => json(await callServer("get_scene", args)))
);

server.registerTool(
  "list_replays",
  {
    description: "List log files (replays) available to load: absolute path, name, modified time, size. Defaults to the robot project's TeamCode/build/sim folder.",
    inputSchema: { folder: z.string().optional().describe("absolute folder to list instead of the default") }
  },
  wrap(async (args: { folder?: string }) => json(await callServer("list_replays", args)))
);

server.registerTool(
  "load_replay",
  {
    description: "Open a log in SolversScope and wait until it can be rendered (needs the log to produce a 3D Field tab, which BioBuzz sim logs do automatically). Returns the same summary as get_scene.",
    inputSchema: { replay: z.string().describe("absolute path of a .rlog/.wpilog/etc. file, from list_replays") }
  },
  wrap(async (args: { replay: string }) => json(await callServer("load_replay", args)))
);

server.registerTool(
  "record_start",
  {
    description: "Mark the start of a recording window on the live timeline (the same as the Telemetry tab's Record button; live data, including Live 3D view, already lands in the timeline). record_stop then gives you the replay-time window to render.",
    inputSchema: {}
  },
  wrap(async () => json(await callServer("record_start")))
);

server.registerTool(
  "record_stop",
  {
    description: "End the recording window. Returns {start, end, duration} on the replay clock. A later render_clip without start/end renders exactly this window.",
    inputSchema: {}
  },
  wrap(async () => json(await callServer("record_stop")))
);

server.registerTool(
  "set_shot",
  {
    description:
      "Validate a camera shot against the loaded replay (structure, entity ids) and store it as the current shot, which preview_frame, preview_contact_sheet and render_clip use when they are not given one. Give either a full `shot` or a `preset`. Presets resolve to editable shots: " +
      "establishing_wide (slow push-in from a high corner, no target), follow_chase (spring chase cam behind a robot), low_angle_hero (low camera drifting up at a robot), top_down (fixed overhead), orbit_robot (circle a robot, ~12.5 s per lap), crane_reveal (low start rising to a high wide view). Returns the resolved shot so you can tweak it. " + FRAME,
    inputSchema: shotChoice
  },
  wrap(async (args: any) => json(await callServer("set_shot", args)))
);

server.registerTool(
  "preview_frame",
  {
    description:
      "Render ONE frame at replay time t and return it as an image (not a file). Fast; use it to check framing before committing to a render. Uses the same pipeline as render_clip, so the pixels match the final clip frame at that time. Defaults to 960x540 PNG (larger images are downscaled on the model side and only cost tokens); `format: \"jpeg\"` is smaller. " + FRAME,
    inputSchema: {
      t: z.number().describe("replay time in seconds, within [startTime, endTime] from get_scene"),
      width: z.number().int().min(16).max(4096).optional().describe("pixels, default 960"),
      height: z.number().int().min(16).max(4096).optional().describe("pixels, default 540"),
      format: z.enum(["png", "jpeg"]).optional().describe("default png"),
      quality: z.number().int().min(1).max(100).optional().describe("jpeg quality, default 85"),
      ...shotChoice
    }
  },
  wrap(async (args: any) => {
    const r = await callServer("preview_frame", args);
    return {
      content: [
        { type: "image" as const, data: r.image, mimeType: r.mimeType },
        { type: "text" as const, text: `t=${r.t}s, ${r.width}x${r.height}, pixelHash ${r.pixelHash.slice(0, 12)}` }
      ]
    };
  })
);

server.registerTool(
  "preview_contact_sheet",
  {
    description:
      "Render n evenly spaced frames across [start, end] and tile them into ONE image (row-major, earliest first), so a whole shot can be judged in a single call. The sheet's long edge is capped at 1568 px. The text result lists each tile's replay time. Defaults to the whole replay and the shot stored by set_shot.",
    inputSchema: {
      n: z.number().int().min(1).max(36).describe("number of frames, 1-36 (6-12 is usually enough)"),
      start: z.number().optional().describe("replay time (s) of the first tile; default replay start"),
      end: z.number().optional().describe("replay time (s) of the last tile; default replay end"),
      ...shotChoice
    }
  },
  wrap(async (args: any) => {
    const scene = await callServer("get_scene", {});
    const start = args.start ?? scene.startTime;
    const end = args.end ?? scene.endTime;
    if (!(end >= start)) throw new BridgeError("invalid_params", "end must be >= start");
    const layout = layoutSheet(args.n);
    const times = evenTimes(start, end, args.n);
    const shot = { shot: args.shot, preset: args.preset, preset_params: args.preset_params };
    const tiles: Buffer[] = [];
    for (const t of times) {
      const r = await callServer("preview_frame", { ...shot, t, width: layout.tileWidth, height: layout.tileHeight, format: "png" });
      tiles.push(Buffer.from(r.image, "base64"));
    }
    const sheet = tile(tiles, layout);
    const text = times.map((t, i) => `tile ${i + 1} (row ${Math.floor(i / layout.columns) + 1}, col ${(i % layout.columns) + 1}): t=${t.toFixed(3)}s`).join("\n");
    return {
      content: [
        { type: "image" as const, data: sheet.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: `${layout.width}x${layout.height}, ${layout.columns} columns x ${layout.rows} rows\n${text}` }
      ]
    };
  })
);

server.registerTool(
  "render_clip",
  {
    description:
      "Start rendering the final video (H.264, yuv420p, CRF 18, BT.709, MP4). ASYNC: returns a jobId immediately; poll render_status for progress and the output path. Deterministic: frame k is rendered at exactly start + k/fps, independent of window size or frame rate, and no frames are dropped. Output goes to the renders directory (the path is returned; you cannot choose a path). Width and height must be even. Without start/end it renders the last record_stop window, else the whole replay. " + FRAME,
    inputSchema: {
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("file name stem (letters, digits, _ -); a timestamp is appended. Default 'clip'"),
      fps: z.number().min(1).max(240).optional().describe("frames per second, default 30"),
      width: z.number().int().min(16).max(7680).optional().describe("pixels, even, default 1920"),
      height: z.number().int().min(16).max(7680).optional().describe("pixels, even, default 1080"),
      start: z.number().optional().describe("replay time (s) of the first frame"),
      end: z.number().optional().describe("replay time (s) the clip ends at (exclusive)"),
      motion_blur_samples: z.number().int().min(1).max(64).optional().describe("subframes averaged per frame in linear HDR; 1 = no blur (default). 4-8 is a good blur."),
      shutter_degrees: z.number().min(1).max(360).optional().describe("shutter angle for motion blur, default 180 (subframes span half a frame)"),
      crf: z.number().int().min(0).max(51).optional().describe("x264 quality, lower = better, default 18"),
      replay: z.string().optional().describe("absolute path of a replay to load first (default: the one already loaded)"),
      ...shotChoice
    }
  },
  wrap(async (args: any) => json(await callServer("render_clip", args)))
);

server.registerTool(
  "render_status",
  {
    description: "Progress of a render_clip job: state (queued|running|done|failed|cancelled), framesDone/frames, progress 0-1, and when done the absolute outputPath of the mp4 and a sidecar .json (shot, params, GPU/ffmpeg versions, per-frame pixel hashes) that reproduces the render. A failed job has an error object {code, message}.",
    inputSchema: {
      jobId: z.string().describe("from render_clip"),
      cancel: z.boolean().optional().describe("true to cancel the job")
    }
  },
  wrap(async (args: { jobId: string; cancel?: boolean }) => json(await callServer("render_status", args)))
);

await server.connect(new StdioServerTransport());
