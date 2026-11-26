// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Cinematic-only detail for the FTC field: puzzle-tile floor and the BIOBUZZ sign plates.
 *
 * The field loads in a worker as plain merged geometry with no texture coordinates, so this runs on the main thread
 * once the field arrives (the field is in its own frame by then: x/y across the floor, z up).
 *
 *  - Floor ("carpet" meshes): FTC foam tiles are 24 in squares that lock together with dovetail tabs (laid 23.5 in apart). A tile-sized
 *    texture with the real AndyMark tile outline (traced from the CAD, see tileOutline.ts) as a thin dark line, foam
 *    grain and a bump map is repeated once per tile. The texture's edges are the tiles' straight edges (see TILE_PITCH).
 *  - HIVE frame ("sign" meshes): the two sticker plates are trapezoids (0.766 m wide at the bottom, 0.696 m at the top,
 *    about 0.164 m along the slope). Each gets the BIOBUZZ plate (every render mode).
 *  - HIVE goals ("aprilTag_<id>" meshes): the four tag plates under the HIVEs (17 x 5 in) each get the real BIOBUZZ tag
 *    cluster: four 36h11 tags, 3.25 in square, with the IDs and spacing of the FTC SDK's tag library (every render mode).
 */

import * as THREE from "three";
import { TILE_OUTLINE } from "./tileOutline";

/** Tiles are laid 23.5 in apart (their tabs overlap), with straight edges at these field coordinates (from the CAD). */
const TILE_PITCH = 0.5969; // m
const TILE_X0 = -0.6072452; // m, a tile's left straight edge
const TILE_Y0 = 0.0102923; // m, a tile's bottom straight edge (field y)
const STICKER_WIDTH = 0.766; // m, bottom edge
const STICKER_TOP_WIDTH = 0.696; // m
const STICKER_HEIGHT = 0.164; // m, along the slope
/** HIVE goal tag plates: 17 x 5 in, carrying four 36h11 tags (3.25 in black square, so 3.25 * 10 / 8 in with the white border). */
const TAG_PLATE_WIDTH_IN = 17;
const TAG_PLATE_HEIGHT_IN = 5;
const TAG_SIZE_IN = 3.25;
const TAG_CENTERS_IN = [-6.5, -2.75, 2.75, 6.5]; // from the plate's center, IDs counting up left to right (FTC SDK cluster)
const TAG_TEXTURE_URL = "textures/apriltag-36h11/";
/**
 * The official BIOBUZZ plate artwork (FIRST / RTX): the plate on a white square (keyed out when it loads).
 * Relative to the page. It is FIRST's artwork, so it is not committed (see .gitignore); without it the
 * drawn plate below is used.
 */
const SIGN_ARTWORK_URL = "textures/biobuzz-sign.webp";

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** One foam tile: grain, then the tile's real dovetail outline as a thin dark line. */
export function makeTileCanvas(size = 1024): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d")!;

  // Foam: a light base with fine grain and some soft blotches
  ctx.fillStyle = "#c9ccd1";
  ctx.fillRect(0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size);
  let seed = 1234567;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    const grain = (random() - 0.5) * 46 + (random() - 0.5) * 18;
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + grain));
    image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + grain));
    image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + grain * 1.02));
  }
  ctx.putImageData(image, 0, 0);
  for (let i = 0; i < 90; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 30 + random() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = random() < 0.5;
    g.addColorStop(0, dark ? "rgba(60,64,72,0.10)" : "rgba(255,255,255,0.10)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // The tile's real outline (its tabs and blanks, chamfers and corners), drawn once per tile in a 3 by 3 block so the
  // parts that reach past the canvas wrap around to the other side. Neighboring tiles' outlines lie on the same seam,
  // so each seam is one thin, dark, bold line.
  ctx.lineWidth = size * 0.005; // about 3 mm on the tile: thin, but solid black so it still reads from a distance
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#07080a";
  for (const ox of [-1, 0, 1]) {
    for (const oy of [-1, 0, 1]) {
      ctx.beginPath();
      for (let i = 0; i < TILE_OUTLINE.length; i += 2) {
        const x = (TILE_OUTLINE[i] + ox) * size;
        const y = (1 - TILE_OUTLINE[i + 1] + oy) * size; // v runs up the field, canvas y runs down
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  return canvas;
}

/** The BIOBUZZ sticker: a yellow trapezoid plate with a black border, honeycomb, a bee and the name. */
export function makeSignCanvas(pixelsPerMeter = 2000): HTMLCanvasElement {
  const width = Math.round(STICKER_WIDTH * pixelsPerMeter);
  const height = Math.round(STICKER_HEIGHT * pixelsPerMeter);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const inset = ((STICKER_WIDTH - STICKER_TOP_WIDTH) / 2) * pixelsPerMeter;

  const trapezoid = (grow: number) => {
    ctx.beginPath();
    ctx.moveTo(inset + grow * 0.6, grow);
    ctx.lineTo(width - inset - grow * 0.6, grow);
    ctx.lineTo(width - grow, height - grow);
    ctx.lineTo(grow, height - grow);
    ctx.closePath();
  };

  // Plate
  ctx.fillStyle = "#101010";
  ctx.fillRect(0, 0, width, height);
  trapezoid(0);
  ctx.fillStyle = "#101010";
  ctx.fill();
  trapezoid(height * 0.05);
  ctx.fillStyle = "#ffd200";
  ctx.fill();

  // Honeycomb, clipped to the plate
  ctx.save();
  trapezoid(height * 0.05);
  ctx.clip();
  const hex = height * 0.2;
  ctx.strokeStyle = "rgba(160,110,0,0.35)";
  ctx.lineWidth = Math.max(2, height * 0.012);
  for (let row = -1; row * hex * 1.5 < height + hex; row++) {
    for (let col = -1; col * hex * 1.732 < width + hex; col++) {
      const cx = col * hex * 1.732 + (row % 2 === 0 ? 0 : hex * 0.866);
      const cy = row * hex * 1.5;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const px = cx + hex * Math.cos(a);
        const py = cy + hex * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();

  // Bee: striped body and two wings, on the left
  const beeX = width * 0.14;
  const beeY = height * 0.55;
  const beeW = height * 0.5;
  ctx.save();
  ctx.translate(beeX, beeY);
  ctx.rotate(-0.25);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "#101010";
  ctx.lineWidth = height * 0.015;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(beeW * 0.05, dir * beeW * 0.42, beeW * 0.38, beeW * 0.22, dir * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = "#101010";
  ctx.beginPath();
  ctx.ellipse(0, 0, beeW * 0.55, beeW * 0.33, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd200";
  for (const x of [-0.25, 0.02, 0.28]) {
    ctx.fillRect(beeW * x - beeW * 0.06, -beeW * 0.3, beeW * 0.12, beeW * 0.6);
  }
  ctx.fillStyle = "#101010";
  ctx.beginPath();
  ctx.arc(beeW * 0.56, 0, beeW * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Name
  ctx.fillStyle = "#101010";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const family = "'Orbitron', 'Inter Variable', 'Arial Black', sans-serif";
  ctx.font = "900 " + Math.round(height * 0.5) + "px " + family;
  ctx.fillText("BIOBUZZ", width * 0.56, height * 0.52, width * 0.62);
  return canvas;
}

/**
 * Loads the plate artwork and crops it to the plate (the image is the plate in the middle of a transparent square).
 * Null when the file can't be loaded.
 */
export function loadSignArtwork(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const full = makeCanvas(image.naturalWidth, image.naturalHeight);
        const ctx = full.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, full.width, full.height);
        // The artwork is the plate on an opaque white square: flood the white in from the border to transparent. The
        // plate's own black outline stops it (so the plate's inside, mounting holes included, is kept).
        const w = full.width;
        const h = full.height;
        const isWhite = (index: number) =>
          data.data[index * 4] > 236 && data.data[index * 4 + 1] > 236 && data.data[index * 4 + 2] > 236;
        const seen = new Uint8Array(w * h);
        const stack: number[] = [];
        const push = (x: number, y: number) => {
          const index = y * w + x;
          if (!seen[index] && isWhite(index)) {
            seen[index] = 1;
            stack.push(index);
          }
        };
        for (let x = 0; x < w; x++) {
          push(x, 0);
          push(x, h - 1);
        }
        for (let y = 0; y < h; y++) {
          push(0, y);
          push(w - 1, y);
        }
        while (stack.length > 0) {
          const index = stack.pop()!;
          const x = index % w;
          const y = (index - x) / w;
          if (x > 0) push(x - 1, y);
          if (x < w - 1) push(x + 1, y);
          if (y > 0) push(x, y - 1);
          if (y < h - 1) push(x, y + 1);
        }
        // Plate extent: the rows and columns that really have artwork in them (a stray speck in the margin doesn't count)
        const rowCount = new Uint32Array(h);
        const colCount = new Uint32Array(w);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const index = y * w + x;
            if (seen[index]) {
              data.data[index * 4 + 3] = 0;
            } else {
              rowCount[y]++;
              colCount[x]++;
            }
          }
        }
        const enough = Math.max(8, Math.round(Math.min(w, h) * 0.02));
        const first = (counts: Uint32Array) => counts.findIndex((c) => c >= enough);
        const last = (counts: Uint32Array) => {
          for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= enough) return i;
          return -1;
        };
        const minX = first(colCount);
        const maxX = last(colCount);
        const minY = first(rowCount);
        const maxY = last(rowCount);
        ctx.putImageData(data, 0, 0);
        if (maxX < minX || maxY < minY) {
          resolve(null);
          return;
        }
        const cropped = makeCanvas(maxX - minX + 1, maxY - minY + 1);
        cropped.getContext("2d")!.drawImage(full, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
        resolve(cropped);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Loads one 10 x 10 pixel 36h11 tag image (the black square plus its white border). Null when it can't be loaded. */
function loadTagImage(id: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = TAG_TEXTURE_URL + id.toString().padStart(3, "0") + ".png";
  });
}

/**
 * A tag plate's texture: a white plate with the four tags of a cluster (IDs firstId..firstId + 3, left to right as seen
 * from outside) drawn without smoothing so the squares stay crisp. Null when none of the tag images could be loaded.
 */
export async function makeAprilTagPlateCanvas(firstId: number, pixelsPerInch = 80): Promise<HTMLCanvasElement | null> {
  const images = await Promise.all(TAG_CENTERS_IN.map((_, i) => loadTagImage(firstId + i)));
  if (images.every((image) => image === null)) return null;
  const canvas = makeCanvas(TAG_PLATE_WIDTH_IN * pixelsPerInch, TAG_PLATE_HEIGHT_IN * pixelsPerInch);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  const sizePx = Math.round(TAG_SIZE_IN * (10 / 8) * pixelsPerInch);
  images.forEach((image, i) => {
    if (image === null) return;
    const x = Math.round(canvas.width / 2 + TAG_CENTERS_IN[i] * pixelsPerInch - sizePx / 2);
    const y = Math.round((canvas.height - sizePx) / 2);
    ctx.drawImage(image, x, y, sizePx, sizePx);
  });
  return canvas;
}

/** Largest-eigenvalue eigenvector of a symmetric 3x3 matrix (power iteration), as a unit vector. */
function principalAxis(matrix: number[][], start: THREE.Vector3): THREE.Vector3 {
  const v = start.clone().normalize();
  for (let i = 0; i < 64; i++) {
    const next = new THREE.Vector3(
      matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z,
      matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z,
      matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z
    );
    if (next.lengthSq() < 1e-30) break;
    v.copy(next.normalize());
  }
  return v;
}

/**
 * Fills in a tag plate's texture coordinates from its own geometry, whatever way the plate is turned (the field's
 * plates are tilted on the HIVE goals, the HIVE models' plates lie flat under the level bar). The plate is a thin flat
 * 17 x 5 in sheet. Its front face is the one that points down (the tags face the field from under the HIVE), and seen
 * from there the texture is upright when "up" is the short edge's direction that leads toward the middle of the
 * HIVE / field (horizontally), so u runs left to right and v runs up that edge.
 */
export function mapAprilTagPlate(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute("position");
  const count = position.count;
  const p = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (let i = 0; i < count; i++) centroid.add(p.fromBufferAttribute(position, i));
  centroid.divideScalar(Math.max(1, count));

  // Principal axes of the vertices: the plate's long edge, then its short edge (the third is its thickness)
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(position, i).sub(centroid);
    const c = [p.x, p.y, p.z];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) covariance[r][k] += c[r] * c[k];
  }
  const long = principalAxis(covariance, new THREE.Vector3(1, 0.3, 0.1));
  const deflated = covariance.map((row, r) =>
    row.map((value, k) => value - (long.getComponent(r) * long.getComponent(k)) * long.dot(principalAxisTimes(covariance, long)))
  );
  let short = principalAxis(deflated, new THREE.Vector3(0.1, 1, 0.3));
  short = short.sub(long.clone().multiplyScalar(short.dot(long))).normalize();

  // "Up" is the short edge's direction that points toward the middle, horizontally (z is up)
  const up = short.clone();
  const towardMiddle = up.x * centroid.x + up.y * centroid.y;
  if (towardMiddle > 1e-4 || (Math.abs(towardMiddle) <= 1e-4 && up.z < 0)) up.negate();
  const normal = long.clone().cross(up);
  if (normal.z > 0) normal.negate(); // front face down
  const right = new THREE.Vector3().crossVectors(normal.clone().negate(), up); // right x up = normal (toward the viewer)

  let minR = Infinity;
  let maxR = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(position, i);
    const r = p.dot(right);
    const u = p.dot(up);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
  }
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(position, i);
    uv[i * 2] = (p.dot(right) - minR) / Math.max(1e-6, maxR - minR);
    uv[i * 2 + 1] = (p.dot(up) - minU) / Math.max(1e-6, maxU - minU);
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  groupFacesByFront(mesh.geometry, normal);
}

/**
 * Splits a plate's triangles into two draw groups: group 0 is the face toward `front` (the tiles, which gets the tags)
 * and group 1 is everything else (the upper face and the rim, plain white). The plate is a thin sheet with a face on each
 * side, so without this the upper face would show the tags mirrored.
 */
function groupFacesByFront(geometry: THREE.BufferGeometry, front: THREE.Vector3) {
  const index = geometry.getIndex();
  const normals = geometry.getAttribute("normal");
  if (index === null || normals === undefined) return;
  const towardTiles: number[] = [];
  const others: number[] = [];
  const face = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  for (let i = 0; i + 2 < index.count; i += 3) {
    face.set(0, 0, 0);
    for (let k = 0; k < 3; k++) face.add(vertex.fromBufferAttribute(normals, index.getX(i + k)));
    face.normalize();
    const target = face.dot(front) > 0.5 ? towardTiles : others;
    target.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  geometry.setIndex([...towardTiles, ...others]);
  geometry.clearGroups();
  geometry.addGroup(0, towardTiles.length, 0);
  geometry.addGroup(towardTiles.length, others.length, 1);
}

/** covariance * v (helper for deflating the principal axis out of a covariance matrix). */
function principalAxisTimes(matrix: number[][], v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z,
    matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z,
    matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z
  );
}

/** Fills in the texture coordinates of the floor meshes: one 0..1 span per tile. */
function mapFloor(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = (position.getX(i) - TILE_X0) / TILE_PITCH;
    uv[i * 2 + 1] = (position.getY(i) - TILE_Y0) / TILE_PITCH;
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Fills in a sticker plate's texture coordinates from its own geometry: across by x, up the slope from its lowest
 * edge. Read from outside the HIVE, the plate on the +y side runs right-to-left in x and the other left-to-right.
 */
function mapSign(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute("position");
  let low = new THREE.Vector3();
  let high = new THREE.Vector3();
  let meanY = 0;
  let lowZ = Infinity;
  let highZ = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    meanY += p.y;
    if (p.z < lowZ) {
      lowZ = p.z;
      low.copy(p);
    }
    if (p.z > highZ) {
      highZ = p.z;
      high.copy(p);
    }
  }
  meanY /= Math.max(1, position.count);
  const slope = new THREE.Vector2(high.y - low.y, high.z - low.z).normalize();
  const uv = new Float32Array(position.count * 2);
  const flip = meanY > 0 ? -1 : 1;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    const along = (p.y - low.y) * slope.x + (p.z - low.z) * slope.y;
    uv[i * 2] = 0.5 + (flip * p.x) / STICKER_WIDTH;
    uv[i * 2 + 1] = along / STICKER_HEIGHT;
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

type DetailMode = "cinematic" | "standard" | "low-power";

/** Physically based in cinematic mode, the cheap Phong look otherwise (like the rest of the field). */
function makeDetailMaterial(map: THREE.Texture | null, mode: DetailMode, side: THREE.Side = THREE.DoubleSide): THREE.Material {
  return mode === "cinematic"
    ? new THREE.MeshPhysicalMaterial({
        map: map,
        side: side,
        roughness: 0.38,
        metalness: 0,
        clearcoat: 0.7,
        clearcoatRoughness: 0.2
      })
    : new THREE.MeshPhongMaterial({ map: map, side: side, specular: 0x333333, shininess: 40 });
}

/** True for the separate tag plate meshes made by OptimizeGeometries ("aprilTag_<first id>"). */
export function isAprilTagPlate(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh && object.name.startsWith("aprilTag_");
}

/**
 * Turns a tag plate mesh (field or robot model, e.g. the sim's HIVE models) into a real tag plate: a white plate right
 * away, with the four tags of its cluster once their images have loaded. The material is shared by every instance of
 * the mesh, so the tags appear on all of them.
 */
export function applyAprilTagPlate(mesh: THREE.Mesh, mode: DetailMode = "cinematic", maxAnisotropy = 8) {
  mapAprilTagPlate(mesh);
  // The face toward the tiles carries the tags; the upper face and the rim are plain white (one-sided, so nothing is drawn twice)
  const tags = makeDetailMaterial(null, mode, THREE.FrontSide);
  const white = makeDetailMaterial(null, mode, THREE.FrontSide);
  mesh.material = [tags, white];
  void makeAprilTagPlateCanvas(Number(mesh.name.slice("aprilTag_".length))).then((canvas) => {
    if (canvas === null) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    (tags as THREE.MeshPhongMaterial).map = texture;
    tags.needsUpdate = true;
  });
}

/**
 * Applies the BIOBUZZ sign and the HIVE goal AprilTags to a freshly loaded FTC field in every render mode, and the
 * tile floor in cinematic mode only.
 */
export function applyFtcFieldDetail(field: THREE.Object3D, maxAnisotropy = 8, mode: DetailMode = "cinematic") {
  const cinematic = mode === "cinematic";
  let tileTexture: THREE.CanvasTexture | null = null;
  let signTexture: THREE.CanvasTexture | null = null;
  const signMaterials: THREE.Material[] = [];
  field.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (cinematic && object.name === "carpet" && object.geometry.getAttribute("position") !== undefined) {
      if (tileTexture === null) {
        tileTexture = new THREE.CanvasTexture(makeTileCanvas());
        tileTexture.wrapS = tileTexture.wrapT = THREE.RepeatWrapping;
        tileTexture.colorSpace = THREE.SRGBColorSpace;
        tileTexture.anisotropy = maxAnisotropy;
      }
      mapFloor(object);
      const material = object.material as THREE.MeshPhysicalMaterial;
      material.map = tileTexture;
      material.bumpMap = tileTexture;
      material.bumpScale = 1.4;
      material.vertexColors = true;
      material.needsUpdate = true;
    } else if (object.name === "sign") {
      // The drawn plate shows until the real artwork has loaded (or stays if the file is not on this computer)
      if (signTexture === null) {
        signTexture = new THREE.CanvasTexture(makeSignCanvas());
        signTexture.colorSpace = THREE.SRGBColorSpace;
        signTexture.anisotropy = maxAnisotropy;
      }
      mapSign(object);
      const material = makeDetailMaterial(signTexture, mode);
      object.material = material;
      signMaterials.push(material);
    } else if (isAprilTagPlate(object)) {
      applyAprilTagPlate(object, mode, maxAnisotropy);
    }
  });
  if (signMaterials.length > 0) {
    void loadSignArtwork(SIGN_ARTWORK_URL).then((artwork) => {
      if (artwork === null) return;
      const real = new THREE.CanvasTexture(artwork);
      real.colorSpace = THREE.SRGBColorSpace;
      real.anisotropy = maxAnisotropy;
      signMaterials.forEach((material) => {
        (material as THREE.MeshPhongMaterial).map = real;
        // The artwork's own outline and mounting holes are transparent: cut them out
        material.alphaTest = 0.5;
        material.needsUpdate = true;
      });
    });
  }
}
