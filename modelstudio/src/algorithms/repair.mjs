// Mesh reduction and repair algorithms.
//
// Decimation uses meshoptimizer's WASM simplifier (quadric edge collapse with
// attribute preservation). Attribute-aware decimation is implemented by welding
// on position, simplifying with UV+jitter attributes, then re-welding seams.
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  compactVertices,
  computeNormals,
  inspectGeometry,
  removeDegenerateTriangles,
  removeDuplicateTriangles,
  triangleCount,
  vertexCount,
  weldVertices,
} from '../core/geometry.mjs';
import { fail } from '../core/util.mjs';
import { injectSmooth } from './remesh.mjs';

let ready = null;
async function simplifier() {
  if (!ready) {
    await MeshoptSimplifier.ready;
    if (!MeshoptSimplifier.supported) fail('simplifier_unavailable', 'meshoptimizer WASM is not supported in this runtime', { status: 503 });
    ready = Promise.resolve(true);
  }
  await ready;
  return MeshoptSimplifier;
}

/**
 * Simplify a mesh to (approximately) `targetTriangles`.
 * Returns geometry with all vertex attributes carried over.
 */
export async function decimate(geo, { targetTriangles, targetError = 0.01 } = {}) {
  const inTris = triangleCount(geo);
  if (!targetTriangles || targetTriangles <= 0) fail('invalid_argument', 'targetTriangles must be positive');
  if (targetTriangles >= inTris) {
    return { ...geo, stats: { trianglesBefore: inTris, trianglesAfter: inTris, error: 0, skipped: true } };
  }
  const module = await simplifier();
  const vc = vertexCount(geo);
  const hasUV = geo.uvs.length === vc * 2;
  const hasSkin = geo.weights.length === vc * 4;

  // 1. Weld on position only so the simplifier can collapse across UV seams.
  const welded = weldVertices({ ...geo, uvs: new Float32Array(0) }, 1e-6);
  const wvc = vertexCount(welded);

  // 2. Re-derive per-vertex attributes from the first welded occurrence.
  const posKey = (positions, i) =>
    `${positions[i * 3].toFixed(5)}|${positions[i * 3 + 1].toFixed(5)}|${positions[i * 3 + 2].toFixed(5)}`;
  const sourceByKey = new Map();
  for (let i = 0; i < vc; i += 1) {
    const k = posKey(geo.positions, i);
    if (!sourceByKey.has(k)) sourceByKey.set(k, i);
  }
  const attrSource = new Uint32Array(wvc);
  for (let i = 0; i < wvc; i += 1) {
    attrSource[i] = sourceByKey.get(posKey(welded.positions, i)) ?? 0;
  }

  // Attributes fed to the simplifier: UV (scaled down so geometry dominates).
  const attributeStride = 3;
  const attributes = new Float32Array(wvc * attributeStride);
  for (let i = 0; i < wvc; i += 1) {
    const src = attrSource[i];
    attributes[i * attributeStride] = hasUV ? geo.uvs[src * 2] * 4 : 0;
    attributes[i * attributeStride + 1] = hasUV ? geo.uvs[src * 2 + 1] * 4 : 0;
    attributes[i * attributeStride + 2] = 0;
  }

  const targetIndexCount = Math.max(3, Math.floor(targetTriangles) * 3);
  const indices = new Uint32Array(welded.indices);
  const positions = new Float32Array(welded.positions);
  let simplifiedIndices;
  let error = 0;
  try {
    const result = module.simplifyWithAttributes(
      indices,
      positions,
      3,
      attributes,
      attributeStride,
      [0.02, 0.02, 0.02],
      [],
      targetIndexCount,
      Math.min(10, Math.max(1e-4, targetError)),
    );
    simplifiedIndices = result[0];
    error = result[1];
  } catch {
    const result = module.simplify(indices, positions, 3, targetIndexCount, targetError, []);
    simplifiedIndices = result[0];
    error = result[1];
  }

  // 3. Rebuild vertex arrays from the surviving welded vertices.
  const out = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(simplifiedIndices),
    normals: new Float32Array(0),
    uvs: hasUV ? new Float32Array(wvc * 2) : new Float32Array(0),
    joints: hasSkin ? new Uint16Array(wvc * 4) : new Uint16Array(0),
    weights: hasSkin ? new Float32Array(wvc * 4) : new Float32Array(0),
  };
  for (let i = 0; i < wvc; i += 1) {
    const src = attrSource[i];
    if (hasUV) {
      out.uvs[i * 2] = geo.uvs[src * 2];
      out.uvs[i * 2 + 1] = geo.uvs[src * 2 + 1];
    }
    if (hasSkin) {
      for (let k = 0; k < 4; k += 1) {
        out.joints[i * 4 + k] = geo.joints[src * 4 + k];
        out.weights[i * 4 + k] = geo.weights[src * 4 + k];
      }
    }
  }
  out.normals = computeNormals(out.positions, out.indices);
  const compacted = compactVertices(out);
  compacted.normals = computeNormals(compacted.positions, compacted.indices);
  const finalTris = triangleCount(compacted);
  return {
    ...compacted,
    stats: {
      trianglesBefore: inTris,
      trianglesAfter: finalTris,
      verticesBefore: vc,
      verticesAfter: vertexCount(compacted),
      error,
      reduction: Number((1 - finalTris / Math.max(1, inTris)).toFixed(4)),
    },
  };
}

/** Uniform Laplacian smoothing, preserving boundary vertices. */
export function smooth(geo, { iterations = 1, factor = 0.5, preserveBoundary = true } = {}) {
  let positions = new Float32Array(geo.positions);
  const vc = vertexCount(geo);
  const neighbors = adjacency(geo);
  const boundary = preserveBoundary ? boundaryVertices(geo) : new Uint8Array(vc);
  const lambda = Math.min(1, Math.max(0, factor));
  for (let it = 0; it < Math.max(1, iterations); it += 1) {
    const next = new Float32Array(positions);
    for (let i = 0; i < vc; i += 1) {
      if (boundary[i]) continue;
      const list = neighbors[i];
      if (!list || list.length === 0) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const j of list) {
        sx += positions[j * 3];
        sy += positions[j * 3 + 1];
        sz += positions[j * 3 + 2];
      }
      const inv = 1 / list.length;
      next[i * 3] += (sx * inv - positions[i * 3]) * lambda;
      next[i * 3 + 1] += (sy * inv - positions[i * 3 + 1]) * lambda;
      next[i * 3 + 2] += (sz * inv - positions[i * 3 + 2]) * lambda;
    }
    positions = next;
  }
  return { ...geo, positions, normals: computeNormals(positions, geo.indices) };
}

export function adjacency(geo) {
  const vc = vertexCount(geo);
  const sets = new Array(vc);
  const push = (a, b) => {
    if (!sets[a]) sets[a] = new Set();
    sets[a].add(b);
  };
  for (let i = 0; i < geo.indices.length; i += 3) {
    const a = geo.indices[i];
    const b = geo.indices[i + 1];
    const c = geo.indices[i + 2];
    push(a, b);
    push(a, c);
    push(b, a);
    push(b, c);
    push(c, a);
    push(c, b);
  }
  return sets.map((s) => (s ? Array.from(s) : []));
}

export function boundaryVertices(geo) {
  const counts = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let i = 0; i < geo.indices.length; i += 3) {
    const tri = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
    for (let k = 0; k < 3; k += 1) {
      const k2 = key(tri[k], tri[(k + 1) % 3]);
      counts.set(k2, (counts.get(k2) ?? 0) + 1);
    }
  }
  const out = new Uint8Array(vertexCount(geo));
  for (const [k, v] of counts) {
    if (v === 1) {
      const [a, b] = k.split(',').map(Number);
      out[a] = 1;
      out[b] = 1;
    }
  }
  return out;
}

/** Fill small holes by fanning the boundary loop to its centroid. */
export function fillHoles(geo, { maxHoleVertices = 64 } = {}) {
  const loops = boundaryLoops(geo);
  const positions = Array.from(geo.positions);
  const indices = Array.from(geo.indices);
  let filled = 0;
  for (const loop of loops) {
    if (loop.length > maxHoleVertices || loop.length < 3) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of loop) {
      cx += positions[v * 3];
      cy += positions[v * 3 + 1];
      cz += positions[v * 3 + 2];
    }
    cx /= loop.length;
    cy /= loop.length;
    cz /= loop.length;
    const centerIndex = positions.length / 3;
    positions.push(cx, cy, cz);
    for (let i = 0; i < loop.length; i += 1) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      indices.push(a, centerIndex, b);
    }
    filled += 1;
  }
  const out = {
    ...geo,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
  };
  out.uvs = new Float32Array(vertexCount(out) * 2);
  out.normals = computeNormals(out.positions, out.indices);
  return { ...out, stats: { filledHoles: filled } };
}

export function boundaryLoops(geo) {
  const edges = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const counts = new Map();
  for (let i = 0; i < geo.indices.length; i += 3) {
    const tri = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
    for (let k = 0; k < 3; k += 1) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      const k2 = key(a, b);
      counts.set(k2, (counts.get(k2) ?? 0) + 1);
      if (!edges.has(a)) edges.set(a, []);
      if (!edges.has(b)) edges.set(b, []);
      edges.get(a).push(b);
      edges.get(b).push(a);
    }
  }
  const boundary = new Map();
  for (const [k, count] of counts) {
    if (count !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    if (!boundary.has(a)) boundary.set(a, []);
    if (!boundary.has(b)) boundary.set(b, []);
    boundary.get(a).push(b);
    boundary.get(b).push(a);
  }
  const visited = new Set();
  const loops = [];
  for (const start of boundary.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    let current = start;
    let previous = -1;
    for (let guard = 0; guard < boundary.size * 2 + 4; guard += 1) {
      if (visited.has(current)) break;
      visited.add(current);
      loop.push(current);
      const next = (boundary.get(current) ?? []).find((n) => n !== previous && !visited.has(n));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function flipNormals(geo) {
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i += 3) {
    indices[i] = geo.indices[i];
    indices[i + 1] = geo.indices[i + 2];
    indices[i + 2] = geo.indices[i + 1];
  }
  return { ...geo, indices, normals: computeNormals(geo.positions, indices) };
}

/** Full repair pass. Deterministic and idempotent where possible. */
export function repair(geo, { tolerance = 1e-5, removeDuplicates = true, fillHoles: shouldFill = true } = {}) {
  const before = inspectGeometry(geo);
  let working = { ...geo };
  const actions = [];

  const welded = weldVertices(working, tolerance);
  if (welded.weldedVertices > 0) actions.push(`welded ${welded.weldedVertices} duplicate vertices`);
  working = { ...welded, normals: new Float32Array(0), uvs: welded.uvs.length ? welded.uvs : new Float32Array(0) };
  if (working.uvs.length !== vertexCount(working) * 2) working.uvs = new Float32Array(vertexCount(working) * 2);

  const deg = removeDegenerateTriangles(working);
  if (deg.removedTriangles > 0) actions.push(`removed ${deg.removedTriangles} degenerate triangles`);
  working = deg;

  if (removeDuplicates) {
    const dup = removeDuplicateTriangles(working);
    if (dup.removedTriangles > 0) actions.push(`removed ${dup.removedTriangles} duplicate triangles`);
    working = dup;
  }

  if (shouldFill && before.boundaryEdges > 0) {
    const filled = fillHoles(working);
    if (filled.stats.filledHoles > 0) actions.push(`filled ${filled.stats.filledHoles} hole(s)`);
    working = filled;
  }

  const compacted = compactVertices(working);
  if (compacted.removedVertices > 0) actions.push(`removed ${compacted.removedVertices} loose vertices`);
  working = compacted;
  working.normals = computeNormals(working.positions, working.indices);
  if (working.uvs.length !== vertexCount(working) * 2) working.uvs = new Float32Array(vertexCount(working) * 2);

  const after = inspectGeometry(working);
  return {
    ...working,
    stats: { before, after, actions, changed: actions.length > 0 },
  };
}

// remesh.mjs cannot import this module (circular), so it receives the smoother here.
injectSmooth(smooth);
