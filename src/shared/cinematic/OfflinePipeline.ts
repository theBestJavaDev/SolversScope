// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Offline frame pipeline (runs in the hidden render window). Everything here is independent of window size,
 * display refresh rate and wall clock.
 *
 * Why not just render to the canvas? Motion blur must be averaged in LINEAR HDR, then tone mapped and sRGB-encoded
 * once. Three r168 only applies tone mapping and the output color space when rendering to the default framebuffer,
 * not to a WebGLRenderTarget, so:
 *   1. Each subframe is drawn into a HalfFloat render target (linear, un-tone-mapped, MSAA, alpha = coverage).
 *   2. The arena dome is drawn as its own layer into a second target: in the live view it is a ShaderMaterial that is
 *      never tone mapped, so it must not go through the tone mapper here either.
 *   3. Both are accumulated (weight 1/N) into HalfFloat targets.
 *   4. One output pass reads the accumulators, tone maps the scene (the renderer's ACES + exposure, via three's own
 *      chunks), blends the dome back in underneath using the coverage, sRGB-encodes, and writes to the canvas at
 *      exactly WxH with the image flipped vertically so gl.readPixels (bottom-up) returns rows top-down.
 *   5. The canvas's framebuffer is read back in the same task, before the browser can present it.
 * With one subframe the result matches the live view except for MSAA resolving before tone mapping (edges only).
 */

import * as THREE from "three";
import { AnnotatedPose3d } from "../geometry";
import Field3dRendererImpl from "../renderers/Field3dRendererImpl";
import { Field3dRendererCommand } from "../renderers/Field3dRenderer";

export type PipelineCamera = {
  /** Position in the log's field frame (m). */
  position: [number, number, number];
  /** [w, x, y, z]; camera +X forward, +Y left, +Z up. */
  rotation: [number, number, number, number];
  /** Vertical fov (degrees). */
  fov: number;
};

export type Subframe = { command: Field3dRendererCommand; camera: PipelineCamera; weight: number };

export type PipelineOptions = {
  width: number;
  height: number;
  /** MSAA samples for the scene target (0 or 4/8). Default 4. */
  msaa?: number;
};

const FULLSCREEN_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

export class OfflinePipeline {
  readonly width: number;
  readonly height: number;
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private domeTarget: THREE.WebGLRenderTarget | null = null;
  private accScene: THREE.WebGLRenderTarget | null = null;
  private accDome: THREE.WebGLRenderTarget | null = null;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private accumulateMaterial: THREE.ShaderMaterial;
  private outputMaterial: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private drawn = false;
  private pending = 0;
  private pixels: Uint8Array;

  constructor(
    private impl: Field3dRendererImpl,
    private canvas: HTMLCanvasElement,
    private options: PipelineOptions
  ) {
    this.width = options.width;
    this.height = options.height;
    this.pixels = new Uint8Array(this.width * this.height * 4);

    this.accumulateMaterial = new THREE.ShaderMaterial({
      uniforms: { tSource: { value: null }, weight: { value: 1 } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: `
        uniform sampler2D tSource;
        uniform float weight;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tSource, vUv) * weight; }`,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    this.outputMaterial = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tDome: { value: null } },
      // Flipped vertically: readPixels returns the bottom row first, so the bottom of the framebuffer holds the image top
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = vec2(uv.x, 1.0 - uv.y);
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tDome;
        varying vec2 vUv;
        void main() {
          vec4 s = texture2D(tScene, vUv);
          vec3 dome = texture2D(tDome, vUv).rgb;
          float a = clamp(s.a, 0.0, 1.0);
          vec3 c = a > 1e-4 ? s.rgb / a : vec3(0.0);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * a + dome * (1.0 - a), 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: true
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.accumulateMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private makeTarget(samples: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: samples > 0 || true,
      samples
    });
    target.texture.generateMipmaps = false;
    return target;
  }

  private ensureTargets() {
    if (this.sceneTarget !== null) return;
    this.sceneTarget = this.makeTarget(this.options.msaa ?? 4);
    this.domeTarget = this.makeTarget(0);
    this.accScene = this.makeTarget(0);
    this.accDome = this.makeTarget(0);
    // The dome gets its own layer so it can be drawn (and kept out of the tone mapper) separately
    this.impl.getArenaDome().layers.set(1);
  }

  /** Releases GPU targets and gives the dome back to the normal layer. */
  dispose() {
    [this.sceneTarget, this.domeTarget, this.accScene, this.accDome].forEach((t) => t?.dispose());
    this.sceneTarget = this.domeTarget = this.accScene = this.accDome = null;
    this.impl.getArenaDome().layers.set(0);
    this.impl.cinematic = null;
  }

  private accumulate(renderer: THREE.WebGLRenderer, source: THREE.Texture, into: THREE.WebGLRenderTarget, weight: number) {
    this.quad.material = this.accumulateMaterial;
    this.accumulateMaterial.uniforms.tSource.value = source;
    this.accumulateMaterial.uniforms.weight.value = weight;
    renderer.setRenderTarget(into);
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
  }

  /** Draw hook installed on the live renderer implementation for the duration of a subframe. */
  private drawSubframe(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    weight: number
  ) {
    this.drawn = true;
    const savedTarget = renderer.getRenderTarget();
    const savedAutoClear = renderer.autoClear;
    const savedClearColor = renderer.getClearColor(new THREE.Color());
    const savedClearAlpha = renderer.getClearAlpha();
    const savedBackground = scene.background;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;

    // Scene layer (everything but the dome), linear HDR with coverage in alpha
    camera.layers.set(0);
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);
    // Dome layer
    camera.layers.set(1);
    renderer.setRenderTarget(this.domeTarget);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.set(0);

    this.accumulate(renderer, this.sceneTarget!.texture, this.accScene!, weight);
    this.accumulate(renderer, this.domeTarget!.texture, this.accDome!, weight);

    scene.background = savedBackground;
    renderer.setClearColor(savedClearColor, savedClearAlpha);
    renderer.autoClear = savedAutoClear;
    renderer.setRenderTarget(savedTarget);
  }

  private clearAccumulators(renderer: THREE.WebGLRenderer) {
    const savedClearAlpha = renderer.getClearAlpha();
    const savedClearColor = renderer.getClearColor(new THREE.Color());
    renderer.setClearColor(0x000000, 0);
    for (const target of [this.accScene!, this.accDome!]) {
      renderer.setRenderTarget(target);
      renderer.clear();
    }
    renderer.setClearColor(savedClearColor, savedClearAlpha);
    renderer.setRenderTarget(null);
  }

  /** Number of subframes whose assets were still loading when drawn (so the caller can retry). */
  get notIdle(): boolean {
    return !this.impl.isIdle();
  }

  /**
   * Renders one output frame from its subframes (weights should sum to 1) and returns top-down RGBA8 pixels.
   * The returned array is reused by the next call; copy it if you need to keep it.
   */
  renderFrame(subframes: Subframe[]): Uint8Array {
    this.ensureTargets();
    const renderer = (this.impl as any).renderer as THREE.WebGLRenderer;
    this.clearAccumulators(renderer);
    for (const sub of subframes) {
      this.drawn = false;
      const cameraPose: AnnotatedPose3d = {
        pose: { translation: sub.camera.position, rotation: sub.camera.rotation },
        annotation: { is2DSource: false }
      };
      this.impl.cinematic = {
        width: this.width,
        height: this.height,
        fov: sub.camera.fov,
        draw: (r, s, c) => this.drawSubframe(r, s, c, sub.weight)
      };
      this.impl.render({ ...sub.command, cameraOverride: cameraPose });
      if (!this.drawn) {
        throw new Error(
          `Nothing was drawn: field "${sub.command.field}" is not available in this window's assets (check the field id)`
        );
      }
    }
    this.impl.cinematic = null;

    // Output pass to the default framebuffer, then read it back before the browser presents it
    const gl = renderer.getContext();
    this.quad.material = this.outputMaterial;
    this.outputMaterial.uniforms.tScene.value = this.accScene!.texture;
    this.outputMaterial.uniforms.tDome.value = this.accDome!.texture;
    renderer.setRenderTarget(null);
    renderer.setSize(this.width, this.height, false);
    renderer.setPixelRatio(1);
    renderer.autoClear = true;
    renderer.render(this.quadScene, this.quadCamera);
    gl.finish();
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    return this.pixels;
  }

  /** The canvas this pipeline draws to (for sizing checks). */
  get surface(): HTMLCanvasElement {
    return this.canvas;
  }
}
