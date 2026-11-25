// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getSpiralIndex } from "../../util";
import { disposeObject } from "../Field3dRendererImpl";

export const XR_MAX_RADIUS = 0.08;
export const LOW_POWER_MAX_RADIUS = 0.08;
export const STANDARD_MAX_RADIUS = 0.04;
export const CINEMATIC_MAX_RADIUS = 0.02;
export const FTC_MULTIPLIER = 0.25; // FTC components are smaller, adjust appropriately to avoid cutting too agressively

/**
 * The original (CAD) name of a mesh. GLTFLoader renames nodes ("am-5883: Panel Sticker" becomes "am-5883_Panel_Sticker",
 * spaces and colons are changed) and keeps the original in userData.name, so match on that.
 */
export function getMeshLabel(mesh: THREE.Object3D): string {
  const original = mesh.userData?.name;
  return typeof original === "string" ? original : mesh.name;
}

/**
 * First AprilTag ID of the four-tag cluster on each BIOBUZZ HIVE goal's tag plate (from the FTC SDK's
 * AprilTagGameDatabase.getBioBuzzTagLibrary(): RED SCORING 30-33, RED AUDIENCE 34-37, BLUE AUDIENCE 38-41,
 * BLUE SCORING 42-45). Null when the mesh is not one of the plates ("... Goal April Tag (Audience|Scoring)").
 */
export function getAprilTagPlateFirstId(label: string): number | null {
  const text = label.toLowerCase();
  if (!text.includes("goal april tag")) return null;
  const blue = text.includes("blue");
  const red = text.includes("red");
  const audience = text.includes("audience");
  const scoring = text.includes("scoring");
  if (red && scoring) return 30;
  if (red && audience) return 34;
  if (blue && audience) return 38;
  if (blue && scoring) return 42;
  return null;
}

/**
 * Cinematic mode draws everything with physically based materials (lit by the environment map and
 * soft shadows in Field3dRendererImpl); the other modes keep the cheap Phong look.
 */
function makeMaterial(
  kind: "normal" | "transparent" | "carpet",
  mode: "low-power" | "standard" | "cinematic",
  materialSpecular: THREE.Color,
  materialShininess: number
): THREE.Material {
  if (mode === "cinematic") {
    if (kind === "carpet") {
      // Foam tiles / carpet: rough, no sheen
      return new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.93,
        metalness: 0,
        sheen: 0.35,
        sheenRoughness: 0.8,
        sheenColor: new THREE.Color(0x888888)
      });
    } else if (kind === "transparent") {
      // Polycarbonate / acrylic
      return new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.06,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        transparent: true,
        opacity: 0.22,
        depthWrite: false
      });
    }
    // Anodized aluminum / molded plastic: satin base with a glossy clear coat
    return new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.48,
      metalness: 0.2,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1
    });
  }
  const options: THREE.MeshPhongMaterialParameters = {
    vertexColors: true,
    side: THREE.DoubleSide,
    specular: materialSpecular,
    shininess: kind === "carpet" ? 0 : materialShininess
  };
  if (kind === "transparent") {
    options.transparent = true;
    options.opacity = 0.2;
    options.depthWrite = false;
  }
  return new THREE.MeshPhongMaterial(options);
}

export default function optimizeGeometries(
  object: THREE.Object3D,
  mode: "low-power" | "standard" | "cinematic",
  materialSpecular: THREE.Color,
  materialShininess: number,
  enableSimplification = true,
  isFTC: boolean = false,
  slicingSize?: number
): {
  normal: THREE.Mesh[];
  transparent: THREE.Mesh[];
  carpet: THREE.Mesh[];
  /** The HIVE frame's two sticker plates, kept apart so they can carry the BIOBUZZ sign (every render mode). */
  sign: THREE.Mesh[];
  /** The four HIVE goal tag plates, kept apart so they can carry real AprilTags. Named "aprilTag_<first id>". */
  aprilTags: THREE.Mesh[];
} {
  let geometries = getGeometries(object, mode, enableSimplification, isFTC, slicingSize);

  let normalMeshes: THREE.Mesh[] = [];
  let transparentMeshes: THREE.Mesh[] = [];
  let carpetMeshes: THREE.Mesh[] = [];
  geometries.normal.forEach((group) => {
    if (group.length > 0) {
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(geometry, makeMaterial("normal", mode, materialSpecular, materialShininess));
        normalMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = true;
          mesh.receiveShadow = true; // self-shadowing (normalBias on the lights prevents acne)
        }
        mesh.name = "normal";
      }
    }
  });
  geometries.transparent.forEach((group) => {
    if (group.length > 0) {
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(geometry, makeMaterial("transparent", mode, materialSpecular, materialShininess));
        transparentMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
        }
        mesh.name = "transparent";
      }
    }
  });
  geometries.carpet.forEach((group) => {
    if (group.length > 0) {
      let geometry = BufferGeometryUtils.mergeGeometries(group, false);
      if (geometry !== null) {
        let mesh = new THREE.Mesh(geometry, makeMaterial("carpet", mode, materialSpecular, materialShininess));
        carpetMeshes.push(mesh);
        if (mode === "cinematic") {
          mesh.castShadow = false;
          mesh.receiveShadow = true;
        }
        mesh.name = "carpet";
      }
    }
  });
  let signMeshes: THREE.Mesh[] = [];
  geometries.sign.forEach((geometry) => {
    let mesh = new THREE.Mesh(geometry, makeMaterial("normal", mode, materialSpecular, materialShininess));
    mesh.name = "sign";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    signMeshes.push(mesh);
  });
  let aprilTagMeshes: THREE.Mesh[] = [];
  geometries.aprilTags.forEach((plate) => {
    let mesh = new THREE.Mesh(plate.geometry, makeMaterial("normal", mode, materialSpecular, materialShininess));
    mesh.name = "aprilTag_" + plate.firstId.toString();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    aprilTagMeshes.push(mesh);
  });
  disposeObject(object);
  return {
    normal: normalMeshes,
    transparent: transparentMeshes,
    carpet: carpetMeshes,
    sign: signMeshes,
    aprilTags: aprilTagMeshes
  };
}

function getGeometries(
  object: THREE.Object3D,
  mode: "low-power" | "standard" | "cinematic",
  enableSimplification: boolean,
  isFTC: boolean,
  slicingSize?: number
): {
  normal: THREE.BufferGeometry[][];
  transparent: THREE.BufferGeometry[][];
  carpet: THREE.BufferGeometry[][];
  sign: THREE.BufferGeometry[];
  aprilTags: { geometry: THREE.BufferGeometry; firstId: number }[];
} {
  let sign: THREE.BufferGeometry[] = [];
  let aprilTags: { geometry: THREE.BufferGeometry; firstId: number }[] = [];
  let normal: THREE.BufferGeometry[][] = [];
  let transparent: THREE.BufferGeometry[][] = [];
  let carpet: THREE.BufferGeometry[][] = [];

  let totalCount = 0;
  object.traverse((object) => {
    totalCount++;

    if (object.type === "Mesh") {
      let mesh = object as THREE.Mesh;
      let geometry = mesh.geometry.clone();
      mesh.updateWorldMatrix(true, false);
      geometry.applyMatrix4(mesh.matrixWorld);

      // Remove unused attributes (interferes with merge)
      let attributeNames = Object.keys(geometry.attributes);
      if (!attributeNames.includes("normal") || !attributeNames.includes("position")) {
        // Doesn't include required attributes, remove
        return;
      }
      attributeNames.forEach((name) => {
        if (name !== "normal" && name !== "position") {
          geometry.deleteAttribute(name);
        }
      });

      // Apply color from material as attribute
      let isTransparent = false;
      if (!Array.isArray(mesh.material)) {
        isTransparent = mesh.material.transparent && mesh.material.opacity < 0.75;
        if ("color" in mesh.material) {
          let rgb = (mesh.material.color as THREE.Color).toArray().map((v) => v * 255);

          const numVerts = geometry.getAttribute("position").count;
          const itemSize = 3; // r, g, b
          const colors = new Uint8Array(itemSize * numVerts);

          colors.forEach((_, ndx) => {
            colors[ndx] = rgb[ndx % 3];
          });

          const normalized = true;
          const colorAttrib = new THREE.BufferAttribute(colors, itemSize, normalized);
          geometry.setAttribute("color", colorAttrib);
        }
      }

      // Apply simplification
      let include = true;
      let vertices: THREE.Vector3[] = [];
      let center = new THREE.Vector3();
      for (let i = 0; i < geometry.attributes.position.count; i++) {
        let vertex = new THREE.Vector3(
          geometry.attributes.position.getX(i),
          geometry.attributes.position.getY(i),
          geometry.attributes.position.getZ(i)
        );
        vertices.push(vertex);
        center.add(vertex);
      }
      center.divideScalar(vertices.length);
      let maxRadius = vertices.reduce((prev, vertex) => {
        let dist = vertex.distanceTo(center);
        return dist > prev ? dist : prev;
      }, 0);
      if (enableSimplification && !mesh.name.includes("NOSIMPLIFY")) {
        switch (mode) {
          case "low-power":
            if (maxRadius < LOW_POWER_MAX_RADIUS * (isFTC ? FTC_MULTIPLIER : 1)) include = false;
            break;
          case "standard":
            if (maxRadius < STANDARD_MAX_RADIUS * (isFTC ? FTC_MULTIPLIER : 1)) include = false;
            break;
          case "cinematic":
            if (maxRadius < CINEMATIC_MAX_RADIUS * (isFTC ? FTC_MULTIPLIER : 1)) include = false;
            break;
        }
      }

      // The HIVE sticker plates and tag plates stay separate meshes in every mode (FtcFieldDetail gives them the
      // BIOBUZZ sign and the real AprilTags)
      const label = getMeshLabel(mesh);
      if (isFTC && label.includes("Panel Sticker")) {
        sign.push(geometry);
        return;
      }
      const plateFirstId = isFTC ? getAprilTagPlateFirstId(label) : null;
      if (plateFirstId !== null) {
        aprilTags.push({ geometry: geometry, firstId: plateFirstId });
        return;
      }

      // Save final geometry
      if (include) {
        let outputIndex = 0;
        if (slicingSize !== undefined && maxRadius * 2 < slicingSize) {
          outputIndex = 1 + getSpiralIndex(Math.floor(center.x / slicingSize), Math.floor(center.y / slicingSize));
        }
        if (mesh.name.toLowerCase().includes("carpet")) {
          while (carpet.length < outputIndex + 1) {
            carpet.push([]);
          }
          carpet[outputIndex].push(geometry);
        } else if (isTransparent) {
          while (transparent.length < outputIndex + 1) {
            transparent.push([]);
          }
          transparent[outputIndex].push(geometry);
        } else {
          while (normal.length < outputIndex + 1) {
            normal.push([]);
          }
          normal[outputIndex].push(geometry);
        }
      }
    }
  });

  return {
    normal: normal,
    transparent: transparent,
    carpet: carpet,
    sign: sign,
    aprilTags: aprilTags
  };
}
