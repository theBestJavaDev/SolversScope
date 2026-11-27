// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";

/**
 * SolversScope's 3D backdrop: instead of a flat color around the field, an arena in the team colors.
 *
 *  - Dome: vertical gradient from the paper color overhead to a warm gold haze at the horizon.
 *  - Floor: a large dark floor under the field, lit like a venue (a pool of light under the field
 *    that fades out), with a faint gold 1 m grid.
 *  - Fog in the same color, so the floor melts into the horizon.
 *
 * Built in WPILib coordinates (Z up, field center at the origin); add `group` to the Z-up group.
 */
export default class SolversArena {
  readonly group = new THREE.Group();
  /** The backdrop dome (own material, not tone mapped). */
  readonly dome: THREE.Mesh;
  private domeMaterial: THREE.ShaderMaterial;
  private floorMaterial: THREE.MeshBasicMaterial;
  private floorTexture: THREE.CanvasTexture;
  private gridMaterial: THREE.LineBasicMaterial;
  private fog = new THREE.Fog(0x000000, 14, 60);
  private lastKey = "";

  constructor() {
    // Dome (drawn behind everything, ignores fog/lighting)
    this.domeMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color() },
        horizon: { value: new THREE.Color() },
        glow: { value: new THREE.Color() },
        bottom: { value: new THREE.Color() }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 glow;
        uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float h = vDir.z; // Z up
          vec3 sky = mix(horizon, top, smoothstep(0.0, 0.55, h));
          vec3 ground = mix(horizon, bottom, smoothstep(0.0, 0.25, -h));
          vec3 color = h >= 0.0 ? sky : ground;
          color += glow * exp(-abs(h) * 22.0); // thin gold haze on the horizon
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }`
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), this.domeMaterial);
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    this.dome = dome;
    this.group.add(dome);

    // Floor: radial "pool of light" texture
    this.floorTexture = new THREE.CanvasTexture(document.createElement("canvas"));
    this.floorTexture.colorSpace = THREE.SRGBColorSpace;
    // Unlit, so the venue lighting baked into the texture shows as designed (the field lights would
    // wash it out to gray)
    this.floorMaterial = new THREE.MeshBasicMaterial({ map: this.floorTexture });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 96), this.floorMaterial);
    floor.position.z = -0.02; // just under the field's own floor
    this.group.add(floor);

    // Faint gold grid (1 m), fading with the fog
    const lines: number[] = [];
    const extent = 30;
    for (let i = -extent; i <= extent; i++) {
      lines.push(-extent, i, 0, extent, i, 0, i, -extent, 0, i, extent, 0);
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    this.gridMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.1, depthWrite: false });
    const grid = new THREE.LineSegments(gridGeometry, this.gridMaterial);
    grid.position.z = -0.015;
    this.group.add(grid);
  }

  /** The fog to put on the scene (colors kept in sync by `update`). */
  getFog(): THREE.Fog {
    return this.fog;
  }

  /** Re-colors for the current theme (cheap to call every frame; only rebuilds on a change). */
  update(background: string, accent: string, isDark: boolean) {
    const key = background + accent + isDark;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Mix in screen (sRGB) space: a few % toward white in linear space is ~30% gray on screen
    const toSrgb = (c: THREE.Color) => {
      const t = { r: 0, g: 0, b: 0 };
      c.getRGB(t, THREE.SRGBColorSpace);
      return t;
    };
    const mix = (from: THREE.Color, to: THREE.Color, t: number) => {
      const x = toSrgb(from);
      const y = toSrgb(to);
      return new THREE.Color().setRGB(
        x.r + (y.r - x.r) * t,
        x.g + (y.g - x.g) * t,
        x.b + (y.b - x.b) * t,
        THREE.SRGBColorSpace
      );
    };
    const bg = new THREE.Color(background);
    const gold = new THREE.Color(accent);
    const black = new THREE.Color(0x000000);
    const white = new THREE.Color(0xffffff);
    const u = this.domeMaterial.uniforms;
    u.top.value.copy(isDark ? mix(bg, black, 0.45) : mix(bg, white, 0.5));
    u.horizon.value.copy(mix(bg, gold, isDark ? 0.07 : 0.14));
    u.glow.value.copy(gold).multiplyScalar(isDark ? 0.02 : 0.04); // added in linear space
    u.bottom.value.copy(isDark ? mix(bg, black, 0.45) : mix(bg, black, 0.08));
    this.fog.color.copy(mix(bg, gold, isDark ? 0.04 : 0.1));
    this.fog.near = 14;
    this.fog.far = 60;

    // Floor: lit pool under the field fading to the fog color
    const canvas = this.floorTexture.image as HTMLCanvasElement;
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    const center = isDark ? mix(mix(bg, white, 0.05), gold, 0.03) : mix(bg, black, 0.06);
    const edge = this.fog.color;
    const gradient = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
    gradient.addColorStop(0, "#" + center.getHexString());
    gradient.addColorStop(0.08, "#" + mix(center, edge, 0.4).getHexString());
    gradient.addColorStop(0.3, "#" + edge.getHexString());
    gradient.addColorStop(1, "#" + edge.getHexString());
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    this.floorTexture.needsUpdate = true;

    this.gridMaterial.color.copy(gold);
    this.gridMaterial.opacity = isDark ? 0.045 : 0.12;
  }
}
