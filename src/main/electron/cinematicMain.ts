// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Main-process side of the cinematic tools: owns the hidden render window, runs preview and clip jobs, pipes raw frames
 * to ffmpeg, hashes every frame and writes a reproducibility sidecar next to each render.
 *
 * Data flow for one frame:  hub window (has the log; interpolates the scene and evaluates the shot)
 *                           -> here -> hidden render window (HDR pipeline, readPixels) -> here -> ffmpeg stdin.
 * Jobs run one at a time (previews and renders share the one GPU window). The virtual clock is the frame index, so
 * nothing depends on window size, display refresh or wall time.
 */

import { BrowserWindow, MessageChannelMain, MessagePortMain, app, nativeImage } from "electron";
import { ChildProcess, execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import { frameCount, frameTime, subframeTimes } from "../../shared/cinematic/Timing";
import NamedMessage from "../../shared/NamedMessage";

export type Deps = {
  getHubWindow: () => BrowserWindow | null;
  sendToHub: (window: BrowserWindow, name: string, data: unknown) => void;
  getAssets: () => unknown;
  getPreferences: () => unknown;
  getBattery: () => boolean;
  windowIcon?: Electron.NativeImage | string;
};

export class CinematicError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export type PreviewSpec = {
  shot: unknown;
  t: number;
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
  quality?: number;
  msaa?: number;
  mode?: "cinematic" | "standard" | "low-power";
};

export type ClipSpec = {
  shot: unknown;
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
  start?: number;
  end?: number;
  motionBlurSamples?: number;
  shutterDegrees?: number;
  crf?: number;
  msaa?: number;
  mode?: "cinematic" | "standard" | "low-power";
  /** Test hook: render and hash every frame but don't encode. */
  dryRun?: boolean;
};

export type JobStatus = {
  jobId: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  framesDone: number;
  frames: number;
  /** Absolute path of the mp4 (set when done). */
  outputPath: string | null;
  sidecarPath: string | null;
  error: { code: string; message: string; details?: unknown } | null;
  startedAt: number;
  finishedAt: number | null;
  /** sha256 over the per-frame hashes of the raw pixels (set when done). */
  framesDigest: string | null;
  frameHashes?: string[];
};

const MAX_DIMENSION = 7680;
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const debug = (...args: unknown[]) => {
  if (process.env.SOLVERS_CINEMATIC_DEBUG) console.log("[cinematic]", ...args);
};

export namespace CinematicMain {
  let deps: Deps;
  let renderWindow: BrowserWindow | null = null;
  let renderPort: MessagePortMain | null = null;
  let renderReady: Promise<void> | null = null;
  let surfaceKey = "";
  let nextRequestId = 1;
  const pendingHub = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const pendingRender = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const jobs = new Map<string, JobStatus & { cancel?: boolean }>();
  let queue: Promise<unknown> = Promise.resolve();
  let rendersDirOverride: string | null = process.env.SOLVERS_RENDERS_DIR ?? null;
  let ffmpegCache: { path: string; version: string; encoders: boolean } | null = null;

  export function configure(dependencies: Deps) {
    deps = dependencies;
  }

  /** Directory renders are written to (configurable; default <userData>/renders). Always absolute. */
  export function getRendersDir(): string {
    const dir = path.resolve(rendersDirOverride ?? path.join(app.getPath("userData"), "renders"));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  export function setRendersDir(dir: string | null) {
    rendersDirOverride = dir;
  }

  // ---------- hub window ----------

  export function onHubResponse(data: any) {
    const pending = pendingHub.get(data.requestId);
    if (pending === undefined) return;
    pendingHub.delete(data.requestId);
    clearTimeout(pending.timer);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new CinematicError(data.error.code, data.error.message, data.error.details));
  }

  export function hubCall<T = any>(name: string, data: object, timeoutMs = 120_000): Promise<T> {
    const hub = deps.getHubWindow();
    if (hub === null || hub.isDestroyed()) {
      return Promise.reject(new CinematicError("no_hub", "No SolversScope window is open."));
    }
    const requestId = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingHub.delete(requestId);
        reject(new CinematicError("hub_timeout", `The SolversScope window did not answer ${name} in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pendingHub.set(requestId, { resolve, reject, timer });
      deps.sendToHub(hub, name, { ...data, requestId });
    });
  }

  /** Opens a log in the hub window and waits until its 3D field tab can be sampled. Returns the scene summary. */
  export async function openReplay(file: string) {
    const hub = deps.getHubWindow();
    if (hub === null) throw new CinematicError("no_hub", "No SolversScope window is open.");
    deps.sendToHub(hub, "open-files", { files: [file], merge: false });
    await new Promise((r) => setTimeout(r, 1000));
    let last = "";
    let stable = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const scene = await hubCall("cin-scene", {}, 5000);
        const signature = `${scene.startTime}:${scene.endTime}:${scene.entities.length}`;
        stable = signature === last ? stable + 1 : 0;
        last = signature;
        if (stable >= 2) return scene;
      } catch {
        stable = 0;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new CinematicError("load_timeout", `Timed out waiting for ${path.basename(file)} to load with a 3D Field tab`);
  }

  // ---------- render window ----------

  /** Forwards a message (assets, preferences, battery) to the render window if it exists. */
  export function broadcast(name: string, data: unknown) {
    renderPort?.postMessage({ name, data } as NamedMessage);
  }

  function renderCall<T = any>(name: string, data: object, transfer: MessagePortMain[] = []): Promise<T> {
    if (renderPort === null) return Promise.reject(new CinematicError("no_render_window", "Render window is not running"));
    const requestId = String(nextRequestId++);
    return new Promise<T>((resolve, reject) => {
      pendingRender.set(requestId, { resolve, reject });
      renderPort!.postMessage({ name, data: { ...data, requestId } } as NamedMessage, transfer);
    });
  }

  function onRenderMessage(message: NamedMessage) {
    const data = message.data;
    debug("from render window:", message.name);
    switch (message.name) {
      case "cin-error": {
        const key = data.id !== undefined ? "f" + data.id : String(data.requestId);
        const pending = pendingRender.get(key);
        pendingRender.delete(key);
        pending?.reject(new CinematicError("render_failed", data.message));
        break;
      }
      case "cin-frame-done": {
        const pending = pendingRender.get("f" + data.id);
        pendingRender.delete("f" + data.id);
        pending?.resolve({ ...data, pixels: new Uint8Array(data.buffer) });
        break;
      }
      default: {
        const pending = pendingRender.get(String(data?.requestId));
        pendingRender.delete(String(data?.requestId));
        pending?.resolve(data);
      }
    }
  }

  async function ensureRenderWindow(): Promise<void> {
    if (renderWindow !== null && !renderWindow.isDestroyed() && renderReady !== null) return renderReady;
    // A normal window that is never shown: not `offscreen` rendering, which would change the GPU path.
    renderWindow = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      icon: deps.windowIcon,
      webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false }
    });
    renderWindow.setMenu(null);
    renderWindow.webContents.on("console-message", (event) => {
      const e = event as any; // Electron 45 passes details on the event object
      console.log(`[cinematic-render] ${e.message ?? ""}`);
    });
    surfaceKey = "";
    const win = renderWindow;
    win.on("closed", () => {
      renderWindow = null;
      renderPort = null;
      renderReady = null;
      pendingRender.forEach((p) => p.reject(new CinematicError("render_window_closed", "Render window closed")));
      pendingRender.clear();
    });
    debug("creating render window");
    renderReady = new Promise<void>((resolve, reject) => {
      win.webContents.once("did-fail-load", (_e, _c, description) => reject(new Error("render window failed to load: " + description)));
      win.webContents.once("dom-ready", async () => {
        const { port1, port2 } = new MessageChannelMain();
        win.webContents.postMessage("port", null, [port1]);
        renderPort = port2;
        port2.on("message", (event) => onRenderMessage(event.data));
        port2.start();
        broadcast("set-assets", deps.getAssets());
        broadcast("set-preferences", deps.getPreferences());
        broadcast("set-battery", deps.getBattery());
        debug("render window ports ready");
        try {
          await renderCall("cin-info", {});
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    win.loadFile(path.join(__dirname, "../www/cinematic.html"));
    return renderReady;
  }

  async function ensureSurface(width: number, height: number, msaa: number, mode: string) {
    await ensureRenderWindow();
    const key = `${width}x${height}@${msaa}/${mode}`;
    if (key !== surfaceKey) {
      await renderCall("cin-init", { width, height, msaa, mode });
      surfaceKey = key;
    }
  }

  async function gpuInfo(): Promise<{ [key: string]: unknown }> {
    await ensureRenderWindow();
    const info = await renderCall("cin-info", {});
    return {
      ...info.gpu,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      appVersion: app.getVersion()
    };
  }

  /** Serializes jobs: previews and renders share one GPU window. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  // ---------- ffmpeg ----------

  function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? ((error as any).code ?? 1) : 0, out: stdout + stderr });
      });
    });
  }

  /** ffmpeg on PATH first, then the copy SolversScope caches in userData. Logs which one and verifies libx264. */
  export async function findFfmpeg() {
    if (ffmpegCache !== null) return ffmpegCache;
    const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const candidates = [process.env.SOLVERS_FFMPEG, "ffmpeg", path.join(app.getPath("userData"), exe)].filter(
      (x): x is string => !!x
    );
    const tried: string[] = [];
    for (const candidate of candidates) {
      const version = await run(candidate, ["-version"]);
      if (version.code !== 0) {
        tried.push(candidate);
        continue;
      }
      const encoders = await run(candidate, ["-hide_banner", "-encoders"]);
      const hasX264 = /\blibx264\b/.test(encoders.out);
      const first = version.out.split("\n")[0];
      console.log(`[cinematic] ffmpeg: ${candidate} (${first}); libx264 ${hasX264 ? "available" : "MISSING"}`);
      if (!hasX264) {
        tried.push(`${candidate} (no libx264 encoder)`);
        continue;
      }
      ffmpegCache = { path: candidate, version: first, encoders: true };
      return ffmpegCache;
    }
    throw new CinematicError(
      "ffmpeg_missing",
      `ffmpeg with the libx264 encoder was not found (tried: ${tried.join(", ") || "none"}). ` +
        `Install ffmpeg and make sure it is on PATH (macOS: brew install ffmpeg; Windows: winget install ffmpeg; ` +
        `Linux: apt install ffmpeg), or set SOLVERS_FFMPEG to its full path.`
    );
  }

  // ---------- validation ----------

  function int(value: unknown, name: string, min: number, max: number, fallback?: number): number {
    const v = value === undefined ? fallback : value;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new CinematicError("invalid_params", `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)})`);
    }
    return v;
  }
  function num(value: unknown, name: string, min: number, max: number, fallback?: number): number {
    const v = value === undefined ? fallback : value;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new CinematicError("invalid_params", `${name} must be a number between ${min} and ${max} (got ${JSON.stringify(value)})`);
    }
    return v;
  }

  // ---------- previews ----------

  export type PreviewResult = {
    data: Buffer;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    t: number;
    /** sha256 of the raw RGBA pixels (not the encoded file). */
    pixelHash: string;
  };

  export function encodeImage(pixels: Uint8Array, width: number, height: number, format: "png" | "jpeg", quality: number) {
    if (format === "png") {
      const png = new PNG({ width, height });
      png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      return { data: PNG.sync.write(png), mimeType: "image/png" as const };
    }
    // Electron bitmaps are BGRA
    const bgra = Buffer.alloc(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      bgra[i] = pixels[i + 2];
      bgra[i + 1] = pixels[i + 1];
      bgra[i + 2] = pixels[i];
      bgra[i + 3] = 255;
    }
    return { data: nativeImage.createFromBitmap(bgra, { width, height }).toJPEG(quality), mimeType: "image/jpeg" as const };
  }

  export function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }

  // The render window answers cin-frame by id, not requestId; register the pending entry under "f<id>"
  function renderFrameCall(id: number, subframes: unknown[]) {
    if (renderPort === null) return Promise.reject(new CinematicError("no_render_window", "Render window is not running"));
    return new Promise<{ pixels: Uint8Array; width: number; height: number }>((resolve, reject) => {
      pendingRender.set("f" + id, { resolve, reject });
      renderPort!.postMessage({ name: "cin-frame", data: { id, subframes } } as NamedMessage);
    });
  }

  export function previewFrame(spec: PreviewSpec): Promise<PreviewResult> {
    const width = int(spec.width, "width", 16, 4096, 960);
    const height = int(spec.height, "height", 16, 4096, 540);
    const format = spec.format ?? "png";
    if (format !== "png" && format !== "jpeg") throw new CinematicError("invalid_params", "format must be png or jpeg");
    const quality = int(spec.quality, "quality", 1, 100, 85);
    const msaa = int(spec.msaa, "msaa", 0, 8, 4);
    const t = num(spec.t, "t", -Infinity, Infinity);
    return enqueue(async () => {
      debug("preview: sampling");
      const [item] = await hubCall("cin-sample", { shot: spec.shot, items: [{ t, subs: [{ t, weight: 1 }] }] });
      debug("preview: surface");
      await ensureSurface(width, height, msaa, spec.mode ?? "cinematic");
      debug("preview: prepare");
      await renderCall("cin-prepare", { command: item.subframes[0].command, camera: item.subframes[0].camera });
      debug("preview: frame");
      const frame = await renderFrameCall(nextRequestId++, item.subframes);
      debug("preview: done");
      const encoded = encodeImage(frame.pixels, width, height, format, quality);
      return { ...encoded, width, height, t, pixelHash: sha256(frame.pixels) };
    });
  }

  // ---------- clips ----------

  function timestamp(): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  export function getJob(jobId: string): JobStatus | null {
    const job = jobs.get(jobId);
    if (job === undefined) return null;
    const { cancel, ...status } = job;
    return { ...status, frameHashes: undefined };
  }

  export function getJobHashes(jobId: string): string[] | null {
    return jobs.get(jobId)?.frameHashes ?? null;
  }

  export function cancelJob(jobId: string): boolean {
    const job = jobs.get(jobId);
    if (job === undefined || job.state === "done" || job.state === "failed") return false;
    job.cancel = true;
    return true;
  }

  /** Validates the spec, checks ffmpeg, queues the job and returns its id immediately. */
  export async function renderClip(spec: ClipSpec): Promise<{ jobId: string; frames: number; outputPath: string }> {
    const fps = num(spec.fps, "fps", 1, 240, 30);
    const width = int(spec.width, "width", 16, MAX_DIMENSION, 1920);
    const height = int(spec.height, "height", 16, MAX_DIMENSION, 1080);
    if (!spec.dryRun && (width % 2 !== 0 || height % 2 !== 0)) {
      throw new CinematicError("invalid_params", `width and height must be even for yuv420p H.264 (got ${width}x${height})`);
    }
    const samples = int(spec.motionBlurSamples, "motionBlurSamples", 1, 64, 1);
    const shutter = num(spec.shutterDegrees, "shutterDegrees", 1, 360, 180);
    const crf = int(spec.crf, "crf", 0, 51, 18);
    const msaa = int(spec.msaa, "msaa", 0, 8, 4);
    const name = spec.name ?? "clip";
    if (!NAME_PATTERN.test(name)) {
      throw new CinematicError("invalid_params", "name must be 1-64 characters of letters, digits, _ or - (no paths)");
    }
    const mode = spec.mode ?? "cinematic";

    // Replay range, so defaults and range errors are explained before anything is queued
    const scene = await hubCall("cin-scene", {});
    const start = num(spec.start, "start", -Infinity, Infinity, scene.startTime);
    const end = num(spec.end, "end", -Infinity, Infinity, scene.endTime);
    if (start < scene.startTime - 1e-9 || end > scene.endTime + 1e-9 || !(end > start)) {
      throw new CinematicError(
        "t_out_of_range",
        `start/end must satisfy ${scene.startTime} <= start < end <= ${scene.endTime} (got start=${start}, end=${end})`,
        { min: scene.startTime, max: scene.endTime }
      );
    }
    const ffmpeg = spec.dryRun ? null : await findFfmpeg();
    const frames = frameCount(start, end, fps);
    const stamp = timestamp();
    const base = path.join(getRendersDir(), `${name}_${stamp}`);
    const outputPath = `${base}.mp4`;
    const jobId = crypto.randomUUID();
    const job: JobStatus & { cancel?: boolean } = {
      jobId,
      state: "queued",
      framesDone: 0,
      frames,
      outputPath: null,
      sidecarPath: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      framesDigest: null
    };
    jobs.set(jobId, job);

    enqueue(async () => {
      job.state = "running";
      let encoder: ChildProcess | null = null;
      let encoderExit: Promise<{ code: number | null; stderr: string }> | null = null;
      const hashes: string[] = [];
      try {
        if (job.cancel) throw new CinematicError("cancelled", "Cancelled");
        const gpu = await gpuInfo();
        await ensureSurface(width, height, msaa, mode);

        const subsFor = (index: number) => {
          const t = frameTime(start, index, fps);
          return { t, subs: subframeTimes(t, fps, samples, shutter) };
        };
        const first = await hubCall("cin-sample", { shot: spec.shot, items: [subsFor(0)] });
        await renderCall("cin-prepare", { command: first[0].subframes[0].command, camera: first[0].subframes[0].camera });

        if (ffmpeg !== null) {
          const args = [
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
            // RGB -> BT.709 limited-range YUV (swscale defaults to BT.601 otherwise) and tag the stream to match
            "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-movflags", "+faststart",
            outputPath
          ];
          const proc = spawn(ffmpeg.path, args, { stdio: ["pipe", "ignore", "pipe"] });
          encoder = proc;
          let stderr = "";
          proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
          proc.stdin.on("error", () => undefined); // surfaced through the exit code below
          encoderExit = new Promise((resolve) => {
            proc.on("close", (code) => resolve({ code, stderr }));
            proc.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
          });
        }

        // Pipeline: ask the hub for the next frame's scene while the GPU renders the current one
        let upcoming: Promise<any> | null = null;
        for (let i = 0; i < frames; i++) {
          if (job.cancel) throw new CinematicError("cancelled", "Cancelled");
          const items = i === 0 ? first : await upcoming!;
          if (i + 1 < frames) upcoming = hubCall("cin-sample", { shot: spec.shot, items: [subsFor(i + 1)] });
          const frame = await renderFrameCall(i, items[0].subframes);
          hashes.push(sha256(frame.pixels));
          if (encoder !== null) {
            const proc = encoder as ChildProcess;
            const buffer = Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
            if (!proc.stdin!.write(buffer)) {
              await new Promise<void>((resolve) => {
                proc.stdin!.once("drain", resolve);
                proc.once("close", resolve);
              });
            }
          }
          job.framesDone = i + 1; // Every frame is rendered and delivered: none are dropped
        }

        if (encoder !== null && encoderExit !== null) {
          (encoder as ChildProcess).stdin!.end();
          const exit = await encoderExit;
          if (exit.code !== 0) throw new CinematicError("encode_failed", `ffmpeg exited with code ${exit.code}: ${exit.stderr}`);
        }
        const digest = crypto.createHash("sha256").update(hashes.join("")).digest("hex");
        const sidecarPath = `${base}.json`;
        fs.writeFileSync(
          sidecarPath,
          JSON.stringify(
            {
              output: ffmpeg === null ? null : outputPath,
              createdAt: new Date().toISOString(),
              params: { name, fps, width, height, start, end, frames, motionBlurSamples: samples, shutterDegrees: shutter, crf, msaa, mode },
              shot: spec.shot,
              replay: { startTime: scene.startTime, endTime: scene.endTime, frame: scene.frame, field: scene.field },
              environment: gpu,
              ffmpeg: ffmpeg === null ? null : { path: ffmpeg.path, version: ffmpeg.version },
              framesDigest: digest,
              frameHashes: hashes,
              hashNote: "sha256 of each frame's raw top-down RGBA8 readPixels buffer (not of the mp4)"
            },
            null,
            2
          )
        );
        job.outputPath = ffmpeg === null ? null : outputPath;
        job.sidecarPath = sidecarPath;
        job.framesDigest = digest;
        job.frameHashes = hashes;
        job.state = "done";
      } catch (error) {
        (encoder as ChildProcess | null)?.kill();
        fs.rmSync(outputPath, { force: true }); // No partial files
        job.error = error instanceof CinematicError ? error.toJSON() : { code: "render_failed", message: String((error as Error)?.message ?? error) };
        job.state = job.error.code === "cancelled" ? "cancelled" : "failed";
      }
      job.finishedAt = Date.now();
    });
    return { jobId, frames, outputPath };
  }

  // ---------- self test (SOLVERS_CINEMATIC_SELFTEST=<script.json>) ----------

  /**
   * Developer harness: runs a JSON list of steps against the open log, logging results. Used to verify the pipeline
   * without the command server. Steps: preview, compare (live view vs. offline), hashes, clip.
   */
  export async function runSelfTest(scriptPath: string) {
    const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
    const log = (...args: unknown[]) => console.log("[cinematic-selftest]", ...args);
    // Wait for a log with a 3D field tab
    for (let attempt = 0; ; attempt++) {
      try {
        const scene = await hubCall("cin-scene", {}, 5000);
        log("scene", JSON.stringify({ start: scene.startTime, end: scene.endTime, frame: scene.frame.coordinateSystem, samples: scene.samples, field: scene.field, entities: scene.entities.length }));
        break;
      } catch (error) {
        if (attempt > 180) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const resolveShot = async (step: any) =>
      step.preset ? hubCall("cin-preset", { preset: step.preset, params: step.params ?? {} }) : step.shot;
    for (const step of script.steps) {
      try {
        switch (step.op) {
          case "scene": {
            const scene = await hubCall("cin-scene", { t: step.t });
            fs.writeFileSync(step.out, JSON.stringify(scene, null, 2));
            log("scene written", step.out);
            break;
          }
          case "preview": {
            const shot = await resolveShot(step);
            const r = await previewFrame({ ...step, shot });
            fs.writeFileSync(step.out, r.data);
            log("preview", step.out, `${r.width}x${r.height}`, "hash", r.pixelHash);
            break;
          }
          case "compare": {
            const shot = await resolveShot(step);
            const look = await hubCall("cin-live-look", { shot, t: step.t });
            log("live camera", JSON.stringify(look.applied), "fov", look.camera.fov);
            await new Promise((r) => setTimeout(r, step.settleMs ?? 1500));
            const after = await hubCall("cin-live-look", { shot, t: step.t });
            log("live camera after settle", JSON.stringify(after.applied));
            log("diagnostics", JSON.stringify(after.diagnostics));
            const hub = deps.getHubWindow()!;
            const live = await hub.webContents.capturePage({
              x: Math.round(look.rect.x), y: Math.round(look.rect.y), width: Math.round(look.rect.width), height: Math.round(look.rect.height)
            });
            const scale = step.scale ?? 1; // 2 = same pixel size as a retina capture
            const w = Math.round(look.rect.width * scale);
            const h = Math.round(look.rect.height * scale);
            fs.writeFileSync(step.outLive, live.toPNG());
            const r = await previewFrame({ ...step, shot, width: w, height: h, format: "png" });
            fs.writeFileSync(step.outPreview, r.data);
            // Mean absolute difference after scaling the (retina) live capture to the preview size
            const liveScaled = live.resize({ width: w, height: h, quality: "best" }).toBitmap(); // BGRA
            const png = PNG.sync.read(r.data);
            let sum = 0;
            let maxChannel = 0;
            for (let i = 0; i < png.data.length; i += 4) {
              const d = [Math.abs(png.data[i] - liveScaled[i + 2]), Math.abs(png.data[i + 1] - liveScaled[i + 1]), Math.abs(png.data[i + 2] - liveScaled[i])];
              sum += d[0] + d[1] + d[2];
              maxChannel = Math.max(maxChannel, ...d);
            }
            log("compare", `live ${live.getSize().width}x${live.getSize().height} (scaled to ${w}x${h}) vs preview`, "mean abs diff per channel (0-255):", (sum / (png.data.length / 4) / 3).toFixed(2), "max", maxChannel);
            break;
          }
          case "hashes": {
            const shot = await resolveShot(step);
            const run1 = await renderClip({ ...step, shot, dryRun: true, name: step.name ?? "hashes" });
            await waitJob(run1.jobId);
            const run2 = await renderClip({ ...step, shot, dryRun: true, name: step.name ?? "hashes" });
            await waitJob(run2.jobId);
            const a = getJob(run1.jobId)!;
            const b = getJob(run2.jobId)!;
            const ha = getJobHashes(run1.jobId) ?? [];
            const hb = getJobHashes(run2.jobId) ?? [];
            const same = a.state === "done" && b.state === "done" && ha.length === hb.length && ha.every((x, i) => x === hb[i]);
            log("determinism", same ? "PASS" : "FAIL", `${ha.length} frames`, a.framesDigest, b.framesDigest, a.error ?? b.error ?? "");
            break;
          }
          case "preview-vs-render": {
            // preview at frame k must equal frame k of a render (follow-cam path dependence)
            const shot = await resolveShot(step);
            const k = step.frame as number;
            const fps = step.fps ?? 30;
            const t = frameTime(step.start, k, fps);
            const prev = await previewFrame({ shot, t, width: step.width, height: step.height, msaa: step.msaa });
            const job = await renderClip({ ...step, shot, dryRun: true, name: "pvr" });
            await waitJob(job.jobId);
            const hashes = getJobHashes(job.jobId) ?? [];
            log("preview-vs-render", prev.pixelHash === hashes[k] ? "PASS" : "FAIL", `frame ${k} t=${t}`, prev.pixelHash.slice(0, 12), (hashes[k] ?? "-").slice(0, 12));
            break;
          }
          case "clip": {
            const shot = await resolveShot(step);
            const job = await renderClip({ ...step, shot });
            const status = await waitJob(job.jobId);
            log("clip", status.state, status.outputPath, status.error ?? "");
            break;
          }
          default:
            log("unknown step", step.op);
        }
      } catch (error) {
        log("step failed", step.op, error instanceof CinematicError ? JSON.stringify(error.toJSON()) : String((error as Error)?.stack ?? error));
      }
    }
    log("done");
  }

  async function waitJob(jobId: string): Promise<JobStatus> {
    for (;;) {
      const status = getJob(jobId)!;
      if (status.state === "done" || status.state === "failed" || status.state === "cancelled") return status;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
