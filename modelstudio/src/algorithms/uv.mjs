// UV projection. Cylindrical/spherical/planar/box projections with seam repair,
// then a quantised weld so shared corners stay welded.
import { computeFaceNormals, computeNormals, vertexCount } from '../core/geometry.mjs';
import { fail } from '../core/util.mjs';

export const PROJECTIONS = ['auto', 'cylindrical', 'spherical', 'planar', 'box', 'top'];

function pickProjection(geo) {
  const p = geo.positions;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const upright = size[1] > Math.max(size[0], size[2]) * 1.25;
  if (upright) return 'cylindrical';
  if (Math.abs(size[1] - Math.min(...size)) < 1e-3) return 'top';
  return 'cylindrical';
}

/**
 * Generate UV coordinates. Always returns a mesh whose vertex attributes match
 * the new vertex count, so it can be fed straight back into the project.
 */
export function projectUV(geo, { projection = 'auto', scale = 1, rotation = 0, margin = 0.02 } = {}) {
  const mode = projection === 'auto' ? pickProjection(geo) : projection;
  if (!PROJECTIONS.includes(mode)) {
    fail('invalid_argument', `Unknown projection "${projection}"`, { details: { available: PROJECTIONS } });
  }
  const p = geo.positions;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const height = Math.max(size[1], 1e-6);
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);

  // 1. Expand to per-corner vertices so seams can be split independently.
  const triCount = Math.floor(geo.indices.length / 3);
  const cornerCount = triCount * 3;
  const srcVerts = vertexCount(geo);
  const hasSkin = geo.weights.length === srcVerts * 4;
  const positions = new Float32Array(cornerCount * 3);
  const uvs = new Float32Array(cornerCount * 2);
  const joints = hasSkin ? new Uint16Array(cornerCount * 4) : new Uint16Array(0);
  const weights = hasSkin ? new Float32Array(cornerCount * 4) : new Float32Array(0);

  for (let c = 0; c < cornerCount; c += 1) {
    const v = geo.indices[c];
    for (let k = 0; k < 3; k += 1) positions[c * 3 + k] = p[v * 3 + k];
    if (hasSkin) {
      for (let k = 0; k < 4; k += 1) {
        joints[c * 4 + k] = geo.joints[v * 4 + k];
        weights[c * 4 + k] = geo.weights[v * 4 + k];
      }
    }
  }

  const faceNormals = computeFaceNormals(positions, identityIndices(cornerCount));

  for (let c = 0; c < cornerCount; c += 1) {
    const x0 = positions[c * 3] - center[0];
    const y0 = positions[c * 3 + 1] - min[1];
    const z0 = positions[c * 3 + 2] - center[2];
    const x = x0 * cosR - z0 * sinR;
    const z = x0 * sinR + z0 * cosR;
    let u = 0;
    let v = 0;
    if (mode === 'cylindrical') {
      u = 0.5 + Math.atan2(x, z) / (Math.PI * 2);
      v = y0 / height;
    } else if (mode === 'spherical') {
      const r = Math.hypot(x0, positions[c * 3 + 1] - center[1], z0) || 1;
      u = 0.5 + Math.atan2(x, z) / (Math.PI * 2);
      v = 0.5 + Math.asin(Math.max(-1, Math.min(1, (positions[c * 3 + 1] - center[1]) / r))) / Math.PI;
    } else if (mode === 'top') {
      u = (positions[c * 3] - min[0]) / Math.max(size[0], 1e-6);
      v = (positions[c * 3 + 2] - min[2]) / Math.max(size[2], 1e-6);
    } else if (mode === 'planar') {
      u = (positions[c * 3] - min[0]) / Math.max(size[0], 1e-6);
      v = (positions[c * 3 + 1] - min[1]) / height;
    } else if (mode === 'box') {
      const nx = Math.abs(faceNormals[c * 3]);
      const ny = Math.abs(faceNormals[c * 3 + 1]);
      const nz = Math.abs(faceNormals[c * 3 + 2]);
      if (ny >= nx && ny >= nz) {
        u = (positions[c * 3] - min[0]) / Math.max(size[0], 1e-6);
        v = (positions[c * 3 + 2] - min[2]) / Math.max(size[2], 1e-6);
      } else if (nx >= nz) {
        u = (positions[c * 3 + 2] - min[2]) / Math.max(size[2], 1e-6);
        v = y0 / height;
      } else {
        u = (positions[c * 3] - min[0]) / Math.max(size[0], 1e-6);
        v = y0 / height;
      }
    }
    uvs[c * 2] = applyScale(u, scale, margin);
    uvs[c * 2 + 1] = applyScale(v, scale, margin);
  }

  // 2. Repair cylindrical wrap on a per-triangle basis.
  if (mode === 'cylindrical' || mode === 'spherical') {
    for (let t = 0; t < triCount; t += 1) {
      let maxU = -Infinity;
      let minU = Infinity;
      for (let k = 0; k < 3; k += 1) {
        const u = uvs[(t * 3 + k) * 2];
        if (u > maxU) maxU = u;
        if (u < minU) minU = u;
      }
      if (maxU - minU > 0.5) {
        for (let k = 0; k < 3; k += 1) {
          if (uvs[(t * 3 + k) * 2] < 0.5) uvs[(t * 3 + k) * 2] += 1;
        }
      }
    }
  }

  const indices = new Uint32Array(cornerCount);
  for (let i = 0; i < cornerCount; i += 1) indices[i] = i;
  const expanded = {
    positions,
    indices,
    normals: new Float32Array(0),
    uvs,
    joints,
    weights,
  };

  // 3. Weld identical (position, uv, weights) corners.
  const welded = weldByUv(expanded);
  welded.normals = computeNormals(welded.positions, welded.indices);
  const coverage = uvCoverage(welded);
  return {
    ...welded,
    stats: {
      projection: mode,
      corners: cornerCount,
      vertices: vertexCount(welded),
      triangles: welded.indices.length / 3,
      uvCoverage: coverage,
    },
  };
}

function applyScale(value, scale, margin) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const pad = Math.max(0, Math.min(0.25, margin));
  return 0.5 + (value - 0.5) * s * (1 - pad * 2);
}

function identityIndices(count) {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = i;
  return out;
}

function weldByUv(geo) {
  const vc = vertexCount(geo);
  const map = new Map();
  const remap = new Uint32Array(vc);
  const P = [];
  const UV = [];
  const J = [];
  const W = [];
  const hasSkin = geo.joints.length === vc * 4;
  const q = (n) => Math.round(n * 1e5) / 1e5;
  for (let i = 0; i < vc; i += 1) {
    const key = `${q(geo.positions[i * 3])}|${q(geo.positions[i * 3 + 1])}|${q(geo.positions[i * 3 + 2])}|${q(geo.uvs[i * 2])}|${q(geo.uvs[i * 2 + 1])}`;
    let t = map.get(key);
    if (t === undefined) {
      t = P.length / 3;
      map.set(key, t);
      P.push(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
      UV.push(geo.uvs[i * 2], geo.uvs[i * 2 + 1]);
      if (hasSkin) for (let k = 0; k < 4; k += 1) {
        J.push(geo.joints[i * 4 + k]);
        W.push(geo.weights[i * 4 + k]);
      }
    }
    remap[i] = t;
  }
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i += 1) indices[i] = remap[geo.indices[i]];
  return {
    positions: new Float32Array(P),
    indices,
    normals: new Float32Array(0),
    uvs: new Float32Array(UV),
    joints: hasSkin ? new Uint16Array(J) : new Uint16Array(0),
    weights: hasSkin ? new Float32Array(W) : new Float32Array(0),
  };
}

/** Fraction of the 0..1 UV square covered by the mesh, and texture waste factor. */
export function uvCoverage(geo) {
  const vc = vertexCount(geo);
  if (geo.uvs.length !== vc * 2) return 0;
  let area = 0;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const a = geo.indices[i] * 2;
    const b = geo.indices[i + 1] * 2;
    const c = geo.indices[i + 2] * 2;
    const ax = geo.uvs[a], ay = geo.uvs[a + 1];
    const bx = geo.uvs[b], by = geo.uvs[b + 1];
    const cx = geo.uvs[c], cy = geo.uvs[c + 1];
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return Number(area.toFixed(4));
}

export function hasUVs(geo) {
  const vc = vertexCount(geo);
  return geo.uvs.length === vc * 2 && geo.uvs.some((v) => v !== 0);
}
