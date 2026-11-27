// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Drives the built MCP server over stdio the way an agent would (also the README's example session):
 *   node dist/exampleSession.js [outDir]
 * Needs SolversScope running with --cinematic-server and a log open.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const outDir = process.argv[2] ?? ".";
fs.mkdirSync(outDir, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "example-session", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")] }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const images = r.content.filter((c: any) => c.type === "image");
  console.log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? "   [ERROR]" : ""}\n${text.length > 600 ? text.slice(0, 600) + " ..." : text}${images.length ? `\n(+ ${images.length} image, ${images[0].mimeType}, ${Math.round(images[0].data.length * 0.75 / 1024)} KB)` : ""}`);
  images.forEach((img: any, i: number) => fs.writeFileSync(path.join(outDir, `${name}_${i}.${img.mimeType === "image/png" ? "png" : "jpg"}`), Buffer.from(img.data, "base64")));
  return { isError: !!r.isError, text, images };
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const scene = await call("get_scene");
if (scene.isError) {
  await client.close();
  process.exit(2);
}
const s = JSON.parse(scene.text);
await call("set_shot", { preset: "follow_chase", preset_params: { target: "robot.0", start: 8 } });
await call("preview_frame", { t: 10 });
await call("preview_contact_sheet", { n: 6, start: 8, end: 12 });
const job = JSON.parse((await call("render_clip", { name: "example", fps: 30, width: 1280, height: 720, start: 8, end: 10, motion_blur_samples: 4 })).text);
for (;;) {
  const status = JSON.parse((await call("render_status", { jobId: job.jobId })).text);
  if (["done", "failed", "cancelled"].includes(status.state)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call("preview_frame", { t: s.endTime + 100 });
await client.close();
