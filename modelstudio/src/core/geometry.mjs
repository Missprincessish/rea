// Geometry value object: typed-array mesh data plus the operations that only
// touch vertex/index buffers. Nothing here knows about projects or files.
import { ModelStudioError, decodeArray, encodeArray, fail } from './util.mjs';

export const EMPTY_GEOMETRY = () => ({
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  joints: new Uint16Array(0),
  weights: new Float32Array(0),
});

export function cloneGeometry(geo) {
  return {
    positions: new Float32Array(geo.positions),
    indices: new Uint32Array(geo.indices),
    normals: new Float32Array(geo.normals),
    uvs: new Float32Array(geo.uvs),
    joints: new Uint16Array(geo.joints),
    weights: new Float32Array(geo.weights),
  };
}

export const vertexCount = (geo) => Math.floor(geo.positions.length / 3);
export const triangleCount = (geo) => Math.floor(geo.indices.length / 3);

export function serializeGeometry(geo) {
  return {
    vertexCount: vertexCount(geo),
    triangleCount: triangleCount(geo),
    positions: encodeArray(geo.positions),
    indices: encodeArray(geo.indices),
    normals: encodeArray(geo.normals),
    uvs: encodeArray(geo.uvs),
    joints: encodeArray(geo.joints),
    weights: encodeArray(geo.weights),
  };
}

export function deserializeGeometry(payload) {
  if (!payload) return EMPTY_GEOMETRY();
  return {
    positions: decodeArray(payload.positions, 'f32'),
    indices: decodeArray(payload.indices, 'u32'),
    normals: decodeArray(payload.normals, 'f32'),
    uvs: decodeArray(payload.uvs, 'f32'),
    joints: decodeArray(payload.joints, 'u16'),
    weights: decodeArray(payload.weights, 'f32'),
  };
}

/** Validate and normalise a geometry record coming from an operation. */
export function normalizeGeometry(geo) {
  const out = {
    positions: geo.positions instanceof Float32Array ? geo.positions : new Float32Array(geo.positions ?? 0),
    indices: geo.indices instanceof Uint32Array ? geo.indices : new Uint32Array(geo.indices ?? 0),
    normals: geo.normals instanceof Float32Array ? geo.normals : new Float32Array(geo.normals ?? 0),
    uvs: geo.uvs instanceof Float32Array ? geo.uvs : new Float32Array(geo.uvs ?? 0),
    joints: geo.joints instanceof Uint16Array ? geo.joints : new Uint16Array(geo.joints ?? 0),
    weights: geo.weights instanceof Float32Array ? geo.weights : new Float32Array(geo.weights ?? 0),
  };
  const vc = vertexCount(out);
  if (out.normals.length !== vc * 3) out.normals = computeNormals(out.positions, out.indices);
  if (out.uvs.length !== vc * 2) out.uvs = new Float32Array(vc * 2);
  if (out.joints.length !== vc * 4) out.joints = new Uint16Array(vc * 4);
  if (out.weights.length !== vc * 4) out.weights = new Float32Array(vc * 4);
  for (let i = 0; i < out.indices.length; i += 1) {
    if (out.indices[i] >= vc) {
      fail('corrupt_geometry', `Index ${out.indices[i]} is out of range for ${vc} vertices`, {
        details: { indexOffset: i },
      });
    }
  }
  return out;
}

/** Build geometry from indexed triangle soup. */
export function makeGeometry(positions, indices, { uvs = null, normals = null } = {}) {
  const geo = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: normals ? new Float32Array(normals) : new Float32Array(0),
    uvs: uvs ? new Float32Array(uvs) : new Float32Array(0),
    joints: new Uint16Array(0),
    weights: new Float32Array(0),
  };
  const vc = vertexCount(geo);
  if (geo.normals.length !== vc * 3) geo.normals = computeNormals(geo.positions, geo.indices);
  if (geo.uvs.length !== vc * 2) geo.uvs = new Float32Array(vc * 2);
  geo.joints = new Uint16Array(vc * 4);
  geo.weights = new Float32Array(vc * 4);
  return geo;
}

export function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

/** Recompute smooth vertex normals with optional angle threshold (degrees). */
export function recomputeNormals(geo, { smoothAngle = 80 } = {}) {
  const normals = computeNormals(geo.positions, geo.indices);
  if (smoothAngle >= 180) return { ...geo, normals };
  // Angle-weighted fallback: keep face normals for creases by blending smooth/face.
  const face = computeFaceNormals(geo.positions, geo.indices);
  const cosLimit = Math.cos((smoothAngle * Math.PI) / 180);
  const out = new Float32Array(normals.length);
  const accum = new Float32Array(normals.length);
  for (let t = 0; t < geo.indices.length / 3; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = geo.indices[t * 3 + k] * 3;
      const fn = t * 3;
      const dot =
        normals[v] * face[fn] + normals[v + 1] * face[fn + 1] + normals[v + 2] * face[fn + 2];
      if (dot >= cosLimit) {
        accum[v] += normals[v];
        accum[v + 1] += normals[v + 1];
        accum[v + 2] += normals[v + 2];
      } else {
        accum[v] += face[fn];
        accum[v + 1] += face[fn + 1];
        accum[v + 2] += face[fn + 2];
      }
    }
  }
  for (let i = 0; i < accum.length; i += 3) {
    const len = Math.hypot(accum[i], accum[i + 1], accum[i + 2]) || 1;
    out[i] = accum[i] / len;
    out[i + 1] = accum[i + 1] / len;
    out[i + 2] = accum[i + 2] / len;
  }
  return { ...geo, normals: out };
}

export function computeFaceNormals(positions, indices) {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let k = 0; k < 3; k += 1) {
      out[i + k] = k === 0 ? nx : k === 1 ? ny : nz;
    }
  }
  return out;
}

export function boundingBox(geo) {
  const p = geo.positions;
  if (p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min,
    max,
    size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/**
 * Weld vertices that share position (and optionally UV/normal) within a tolerance.
 * Rebuilds all vertex attributes.
 */
export function weldVertices(geo, tolerance = 1e-5) {
  const vc = vertexCount(geo);
  const key = (x, y, z, u, v) =>
    `${Math.round(x / tolerance)}|${Math.round(y / tolerance)}|${Math.round(z / tolerance)}|${Math.round(u / tolerance)}|${Math.round(v / tolerance)}`;
  const map = new Map();
  const remap = new Uint32Array(vc);
  const P = [];
  const UV = [];
  const J = [];
  const W = [];
  const hasUv = geo.uvs.length === vc * 2 && geo.uvs.some((v) => v !== 0);
  const hasSkin = geo.weights.length === vc * 4;
  for (let i = 0; i < vc; i += 1) {
    const x = geo.positions[i * 3];
    const y = geo.positions[i * 3 + 1];
    const z = geo.positions[i * 3 + 2];
    const u = hasUv ? geo.uvs[i * 2] : 0;
    const v = hasUv ? geo.uvs[i * 2 + 1] : 0;
    const k = key(x, y, z, u, v);
    let target = map.get(k);
    if (target === undefined) {
      target = P.length / 3;
      map.set(k, target);
      P.push(x, y, z);
      UV.push(u, v);
      if (hasSkin) {
        J.push(geo.joints[i * 4], geo.joints[i * 4 + 1], geo.joints[i * 4 + 2], geo.joints[i * 4 + 3]);
        W.push(geo.weights[i * 4], geo.weights[i * 4 + 1], geo.weights[i * 4 + 2], geo.weights[i * 4 + 3]);
      }
    }
    remap[i] = target;
  }
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i += 1) indices[i] = remap[geo.indices[i]];
  return {
    positions: new Float32Array(P),
    indices,
    normals: new Float32Array(0),
    uvs: hasUv ? new Float32Array(UV) : new Float32Array(0),
    joints: hasSkin ? new Uint16Array(J) : new Uint16Array(0),
    weights: hasSkin ? new Float32Array(W) : new Float32Array(0),
    weldedVertices: vc - P.length / 3,
    remainingVertices: P.length / 3,
  };
}

export function removeDegenerateTriangles(geo, epsilon = 1e-9) {
  const out = [];
  let removed = 0;
  const p = geo.positions;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const ia = geo.indices[i];
    const ib = geo.indices[i + 1];
    const ic = geo.indices[i + 2];
    if (ia === ib || ib === ic || ia === ic) {
      removed += 1;
      continue;
    }
    const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
    const bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2];
    const cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) / 2 <= epsilon) {
      removed += 1;
      continue;
    }
    out.push(ia, ib, ic);
  }
  return { ...geo, indices: new Uint32Array(out), removedTriangles: removed };
}

export function removeDuplicateTriangles(geo) {
  const seen = new Set();
  const out = [];
  let removed = 0;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const tri = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]].sort((a, b) => a - b);
    const k = tri.join(',');
    if (seen.has(k)) {
      removed += 1;
      continue;
    }
    seen.add(k);
    out.push(geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]);
  }
  return { ...geo, indices: new Uint32Array(out), removedTriangles: removed };
}

export function compactVertices(geo) {
  const vc = vertexCount(geo);
  const used = new Uint8Array(vc);
  for (let i = 0; i < geo.indices.length; i += 1) used[geo.indices[i]] = 1;
  let kept = 0;
  const remap = new Uint32Array(vc).fill(0xffffffff);
  for (let i = 0; i < vc; i += 1) if (used[i]) remap[i] = kept++;
  const P = new Float32Array(kept * 3);
  const UV = geo.uvs.length === vc * 2 ? new Float32Array(kept * 2) : new Float32Array(0);
  const N = geo.normals.length === vc * 3 ? new Float32Array(kept * 3) : new Float32Array(0);
  const J = geo.joints.length === vc * 4 ? new Uint16Array(kept * 4) : new Uint16Array(0);
  const W = geo.weights.length === vc * 4 ? new Float32Array(kept * 4) : new Float32Array(0);
  for (let i = 0; i < vc; i += 1) {
    const t = remap[i];
    if (t === 0xffffffff) continue;
    P[t * 3] = geo.positions[i * 3];
    P[t * 3 + 1] = geo.positions[i * 3 + 1];
    P[t * 3 + 2] = geo.positions[i * 3 + 2];
    if (UV.length) {
      UV[t * 2] = geo.uvs[i * 2];
      UV[t * 2 + 1] = geo.uvs[i * 2 + 1];
    }
    if (N.length) {
      N[t * 3] = geo.normals[i * 3];
      N[t * 3 + 1] = geo.normals[i * 3 + 1];
      N[t * 3 + 2] = geo.normals[i * 3 + 2];
    }
    if (J.length) {
      for (let k = 0; k < 4; k += 1) {
        J[t * 4 + k] = geo.joints[i * 4 + k];
        W[t * 4 + k] = geo.weights[i * 4 + k];
      }
    }
  }
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i += 1) indices[i] = remap[geo.indices[i]];
  return {
    positions: P,
    indices,
    normals: N,
    uvs: UV,
    joints: J,
    weights: W,
    removedVertices: vc - kept,
  };
}

/** Report mesh health so callers can decide what repair to run. */
export function inspectGeometry(geo) {
  const vc = vertexCount(geo);
  const tc = triangleCount(geo);
  const edgeUse = new Map();
  let degenerate = 0;
  let duplicate = 0;
  const seen = new Set();
  for (let i = 0; i < geo.indices.length; i += 3) {
    const tri = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) degenerate += 1;
    const sorted = [...tri].sort((a, b) => a - b).join(',');
    if (seen.has(sorted)) duplicate += 1;
    seen.add(sorted);
    for (let k = 0; k < 3; k += 1) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeUse.values()) {
    if (count === 1) boundaryEdges += 1;
    else if (count > 2) nonManifoldEdges += 1;
  }
  const usedVerts = new Set();
  for (let i = 0; i < geo.indices.length; i += 1) usedVerts.add(geo.indices[i]);
  const bbox = boundingBox(geo);
  const isClosed = boundaryEdges === 0;
  return {
    vertices: vc,
    triangles: tc,
    faces: tc,
    looseVertices: vc - usedVerts.size,
    degenerateTriangles: degenerate,
    duplicateTriangles: duplicate,
    boundaryEdges,
    nonManifoldEdges,
    closed: isClosed,
    watertight: isClosed && nonManifoldEdges === 0,
    hasUVs: geo.uvs.length === vc * 2 && geo.uvs.some((v) => v !== 0),
    hasSkinWeights: geo.weights.length === vc * 4 && geo.weights.some((v) => v !== 0),
    boundingBox: bbox,
    surfaceArea: surfaceArea(geo),
  };
}

export function surfaceArea(geo) {
  let area = 0;
  const p = geo.positions;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const a = geo.indices[i] * 3;
    const b = geo.indices[i + 1] * 3;
    const c = geo.indices[i + 2] * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    area += Math.hypot(nx, ny, nz) / 2;
  }
  return area;
}

export function ensureGeometry(geo) {
  if (!geo || !geo.positions || geo.positions.length === 0) {
    throw new ModelStudioError('empty_geometry', 'Object has no geometry to operate on');
  }
  return geo;
}
