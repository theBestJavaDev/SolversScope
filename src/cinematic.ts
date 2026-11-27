// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Hidden offline render window. Receives scene commands + camera poses from the main process (which gets them from
 * the hub window that holds the log) and replies with raw RGBA pixels. See shared/cinematic/OfflinePipeline.ts.
 *
 * Messages in (from main):  set-assets, set-preferences, set-battery,
 *   cin-init   {width, height, msaa, mode}               -> creates the renderer, replies cin-init-done
 *   cin-prepare {command, camera}                        -> waits for assets/shaders, replies cin-prepared
 *   cin-frame  {id, subframes}                           -> replies cin-frame-done {id, pixels} (pixels transferred)
 *   cin-info                                              -> replies cin-info-done {gpu strings}
 */

import * as THREE from "three";
import { AdvantageScopeAssets } from "./shared/AdvantageScopeAssets";
import NamedMessage from "./shared/NamedMessage";
import Preferences from "./shared/Preferences";
import Selection from "./shared/Selection";
import { OfflinePipeline, PipelineCamera, Subframe } from "./shared/cinematic/OfflinePipeline";
import Field3dRendererImpl from "./shared/renderers/Field3dRendererImpl";
import GamePieceManager from "./shared/renderers/field3d/objectManagers/GamePieceManager";
import { Field3dRendererCommand } from "./shared/renderers/Field3dRenderer";

declare global {
  interface Window {
    assets: AdvantageScopeAssets | null;
    preferences: Preferences | null;
    isBattery: boolean;
    selection: Selection;
    sendMainMessage: (name: string, data?: any) => void;
  }
}

// Frames must be pure functions of (replay, shot, t): no spin state carried between renders
GamePieceManager.stateless = true;

window.isBattery = false;
window.assets = null;
window.preferences = null;

let messagePort: MessagePort | null = null;
let impl: Field3dRendererImpl | null = null;
let pipeline: OfflinePipeline | null = null;

// Count outstanding texture/model loads so frame 0 can wait for them
let pendingLoads = 0;
const manager = THREE.DefaultLoadingManager;
const originalItemStart = manager.itemStart.bind(manager);
const originalItemEnd = manager.itemEnd.bind(manager);
manager.itemStart = (url: string) => {
  pendingLoads++;
  originalItemStart(url);
};
manager.itemEnd = (url: string) => {
  pendingLoads--;
  originalItemEnd(url);
};

window.sendMainMessage = (name: string, data?: any) => {
  messagePort?.postMessage({ name, data } as NamedMessage);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function init(config: { width: number; height: number; msaa?: number; mode?: "cinematic" | "standard" | "low-power" }) {
  pipeline?.dispose();
  const canvas = document.getElementById("cinematic-canvas") as HTMLCanvasElement;
  const container = document.getElementById("cinematic-container") as HTMLElement;
  if (impl === null) {
    // `mode` is a parameter that defaults to the cinematic look (shadows, IBL, ACES tone mapping)
    impl = new Field3dRendererImpl(
      config.mode ?? "cinematic",
      false, // MSAA happens in the render targets; the canvas only receives the final pass
      canvas,
      container,
      document.getElementById("cinematic-alert") as HTMLElement,
      document.getElementById("cinematic-spinner") as HTMLElement
    );
  }
  pipeline = new OfflinePipeline(impl, canvas, { width: config.width, height: config.height, msaa: config.msaa });
}

/** Renders the first frame repeatedly until the field, robot models and textures are all loaded and shaders compiled. */
async function prepare(command: Field3dRendererCommand, camera: PipelineCamera) {
  if (pipeline === null || impl === null) throw new Error("not initialized");
  const deadline = Date.now() + 120_000;
  const sub: Subframe = { command, camera, weight: 1 };
  let stableCount = 0;
  while (Date.now() < deadline) {
    pipeline.renderFrame([sub]);
    if (impl.isIdle() && pendingLoads === 0) {
      stableCount++;
      if (stableCount >= 3) break; // Idle for three consecutive renders: nothing new was requested
    } else {
      stableCount = 0;
    }
    await sleep(30);
  }
  if (stableCount < 3) throw new Error("Timed out waiting for the field and robot models to load");
  const renderer = (impl as any).renderer as THREE.WebGLRenderer;
  renderer.compile((impl as any).scene, (impl as any).camera); // Shader programs for everything that exists now
  pipeline.renderFrame([sub]);
}

function gpuInfo(): { [key: string]: string } {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const info: { [key: string]: string } = { userAgent: navigator.userAgent };
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    info.glVersion = String(gl.getParameter(gl.VERSION));
    info.glVendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
    info.glRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  }
  return info;
}

window.addEventListener("message", (event) => {
  if (event.data !== "port") return;
  messagePort = event.ports[0];
  messagePort.onmessage = async (event) => {
    const message: NamedMessage = event.data;
    try {
      switch (message.name) {
        case "set-assets":
          window.assets = message.data;
          break;
        case "set-preferences":
          window.preferences = message.data;
          break;
        case "set-battery":
          window.isBattery = message.data;
          break;
        case "cin-init":
          init(message.data);
          messagePort!.postMessage({ name: "cin-init-done", data: { requestId: message.data.requestId } });
          break;
        case "cin-prepare":
          await prepare(message.data.command, message.data.camera);
          messagePort!.postMessage({ name: "cin-prepared", data: { requestId: message.data.requestId } });
          break;
        case "cin-frame": {
          if (pipeline === null) throw new Error("not initialized");
          const pixels = pipeline.renderFrame(message.data.subframes).slice(); // Own copy so it can be transferred
          // Copied, not transferred: transferring an ArrayBuffer to the main process over this port was never delivered
          messagePort!.postMessage({
            name: "cin-frame-done",
            data: { id: message.data.id, width: pipeline.width, height: pipeline.height, buffer: pixels.buffer }
          });
          break;
        }
        case "cin-info":
          messagePort!.postMessage({ name: "cin-info-done", data: { requestId: message.data?.requestId, gpu: gpuInfo() } });
          break;
      }
    } catch (error) {
      messagePort!.postMessage({
        name: "cin-error",
        data: { requestId: message.data?.requestId, id: message.data?.id, message: String((error as Error)?.message ?? error) }
      });
    }
  };
});
