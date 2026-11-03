// Skeleton generation, skin-binding, weight correction and posing.
//
// Weights use inverse-distance-to-bone-segment falloff with a top-N influence
// cap, then Laplacian smoothing over the mesh graph. Everything is plain maths
// on typed arrays so results are deterministic and inspectable.
import { boundingBox, computeNormals, triangleCount, vertexCount } from './geometry.mjs';
import { fail } from './util.mjs';
import { adjacency } from '../algorithms/repair.mjs';

const MAX_INFLUENCES = 4;

// --- skeleton templates -----------------------------------------------------

/**
 * Build a humanoid skeleton sized to the mesh bounding box.
 * Node transform is a local translation relative to the parent joint.
 */
export function humanoidSkeleton(geo, { name = 'Rig', mode = 'auto' } = {}) {
  const bbox = boundingBox(geo);
  const h = bbox.size[1] || 1;
  const width = Math.max(bbox.size[0], bbox.size[2]);
  const groundY = bbox.min[1];
  const centerX = bbox.center[0];
  const centerZ = bbox.center[2];
  const isWide = width > h * 0.9 && mode === 'auto';
  const isUpright = mode === 'humanoid' || (!isWide && h > width * 0.9);

  if (!isUpright) return quadrupedSkeleton(geo, { name, bbox });

  const y = (fraction) => groundY + h * fraction;
  const armSpan = Math.max(width * 0.5, h * 0.16);
  const nodes = {};
  const add = (id, boneName, parent, translation) => {
    nodes[id] = { id, name: boneName, parent, translation, rotation: [0, 0, 0, 1] };
    return id;
  };

  add('hips', 'hips', null, [centerX, y(0.53), centerZ]);
  add('spine', 'spine', 'hips', [0, h * 0.09, 0]);
  add('chest', 'chest', 'spine', [0, h * 0.1, 0]);
  add('neck', 'neck', 'chest', [0, h * 0.1, 0]);
  add('head', 'head', 'neck', [0, h * 0.09, 0]);
  add('shoulder_l', 'shoulder.L', 'chest', [-armSpan * 0.42, h * 0.02, 0]);
  add('upper_arm_l', 'upper_arm.L', 'shoulder_l', [-armSpan * 0.32, -h * 0.03, 0]);
  add('forearm_l', 'forearm.L', 'upper_arm_l', [-armSpan * 0.3, -h * 0.16, 0]);
  add('hand_l', 'hand.L', 'forearm_l', [-armSpan * 0.2, -h * 0.13, 0]);
  add('shoulder_r', 'shoulder.R', 'chest', [armSpan * 0.42, h * 0.02, 0]);
  add('upper_arm_r', 'upper_arm.R', 'shoulder_r', [armSpan * 0.32, -h * 0.03, 0]);
  add('forearm_r', 'forearm.R', 'upper_arm_r', [armSpan * 0.3, -h * 0.16, 0]);
  add('hand_r', 'hand.R', 'forearm_r', [armSpan * 0.2, -h * 0.13, 0]);
  add('thigh_l', 'thigh.L', 'hips', [-h * 0.055, -h * 0.03, 0]);
  add('shin_l', 'shin.L', 'thigh_l', [-h * 0.008, -h * 0.24, 0]);
  add('foot_l', 'foot.L', 'shin_l', [0, -h * 0.24, h * 0.01]);
  add('thigh_r', 'thigh.R', 'hips', [h * 0.055, -h * 0.03, 0]);
  add('shin_r', 'shin.R', 'thigh_r', [h * 0.008, -h * 0.24, 0]);
  add('foot_r', 'foot.R', 'shin_r', [0, -h * 0.24, h * 0.01]);

  const jointOrder = Object.keys(nodes);
  return {
    name,
    nodes,
    jointOrder,
    restPose: 'a-pose',
    kind: 'humanoid',
    worldPositions: worldPositionsOf(nodes, jointOrder),
  };
}

function quadrupedSkeleton(geo, { name, bbox }) {
  const h = bbox.size[1] || 1;
  const l = Math.max(bbox.size[0], bbox.size[2]) || 1;
  const nodes = {};
  const add = (id, boneName, parent, translation) => {
    nodes[id] = { id, name: boneName, parent, translation, rotation: [0, 0, 0, 1] };
  };
  add('root', 'root', null, [bbox.center[0], bbox.min[1] + h * 0.5, bbox.center[2]]);
  add('spine', 'spine', 'root', [l * 0.2, h * 0.05, 0]);
  add('neck', 'neck', 'spine', [l * 0.2, h * 0.08, 0]);
  add('head', 'head', 'neck', [l * 0.1, h * 0.05, 0]);
  add('tail', 'tail', 'root', [-l * 0.3, h * 0.05, 0]);
  ['front_l', 'front_r', 'back_l', 'back_r'].forEach((id, i) => {
    add(id, id, i < 2 ? 'spine' : 'root', [i < 2 ? l * 0.2 : -l * 0.2, -h * 0.3, (i % 2 === 0 ? -1 : 1) * l * 0.18]);
  });
  return {
    name,
    nodes,
    jointOrder: Object.keys(nodes),
    restPose: 'stand',
    kind: 'quadruped',
    worldPositions: worldPositionsOf(nodes, Object.keys(nodes)),
  };
}

export function worldPositionsOf(nodes, jointOrder) {
  const out = {};
  const compute = (id) => {
    if (out[id]) return out[id];
    const node = nodes[id];
    if (!node) return [0, 0, 0];
    const parent = node.parent ? compute(node.parent) : [0, 0, 0];
    const t = node.translation ?? [0, 0, 0];
    out[id] = [parent[0] + t[0], parent[1] + t[1], parent[2] + t[2]];
    return out[id];
  };
  for (const id of jointOrder) compute(id);
  return out;
}

export function skeletonBones(skeleton) {
  const world = worldPositionsOf(skeleton.nodes, skeleton.jointOrder);
  return skeleton.jointOrder.map((id) => {
    const node = skeleton.nodes[id];
    let tail;
    const children = skeleton.jointOrder.filter((other) => skeleton.nodes[other].parent === id);
    if (children.length) {
      const avg = [0, 0, 0];
      for (const child of children) {
        const p = world[child];
        avg[0] += p[0] / children.length;
        avg[1] += p[1] / children.length;
        avg[2] += p[2] / children.length;
      }
      tail = avg;
    } else {
      const parentWorld = node.parent ? world[node.parent] : world[id];
      tail = [
        world[id][0] + (world[id][0] - parentWorld[0]) * 0.6,
        world[id][1] + (world[id][1] - parentWorld[1]) * 0.6,
        world[id][2] + (world[id][2] - parentWorld[2]) * 0.6,
      ];
    }
    return { id, name: node.name, parent: node.parent, head: world[id], tail };
  });
}

// --- automatic skinning -----------------------------------------------------

function pointSegmentDistance(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const denom = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = (apx * abx + apy * aby + apz * abz) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.hypot(dx, dy, dz);
}

/**
 * Compute smooth skin weights for every vertex against the skeleton bones.
 * @returns {{joints: Uint16Array, weights: Float32Array, bones: Array}}
 */
export function computeSkinWeights(geo, skeleton, { falloff = 3.2, smoothing = 2, maxInfluences = MAX_INFLUENCES } = {}) {
  const bones = skeletonBones(skeleton);
  const vc = vertexCount(geo);
  const p = geo.positions;
  const raw = new Float32Array(vc * bones.length);
  for (let v = 0; v < vc; v += 1) {
    const px = p[v * 3];
    const py = p[v * 3 + 1];
    const pz = p[v * 3 + 2];
    for (let b = 0; b < bones.length; b += 1) {
      const bone = bones[b];
      const d = pointSegmentDistance(px, py, pz, bone.head[0], bone.head[1], bone.head[2], bone.tail[0], bone.tail[1], bone.tail[2]);
      raw[v * bones.length + b] = 1 / Math.pow(d + 0.01, falloff);
    }
  }
  // normalise
  normaliseRows(raw, vc, bones.length);
  // smooth across the mesh graph so weight islands don't tear
  if (smoothing > 0) {
    const neighbors = adjacency(geo);
    for (let it = 0; it < smoothing; it += 1) {
      const next = new Float32Array(raw);
      for (let v = 0; v < vc; v += 1) {
        const list = neighbors[v];
        if (!list || list.length === 0) continue;
        for (let b = 0; b < bones.length; b += 1) {
          let sum = raw[v * bones.length + b] * 0.5;
          let weight = 0.5;
          for (const n of list) {
            sum += raw[n * bones.length + b];
            weight += 1;
          }
          next[v * bones.length + b] = sum / weight;
        }
      }
      raw.set(next);
      normaliseRows(raw, vc, bones.length);
    }
  }
  // limit influences and normalise
  const joints = new Uint16Array(vc * 4);
  const weights = new Float32Array(vc * 4);
  const usedBones = new Set();
  for (let v = 0; v < vc; v += 1) {
    const order = Array.from({ length: bones.length }, (_, b) => b)
      .map((b) => ({ b, w: raw[v * bones.length + b] }))
      .sort((a, z) => z.w - a.w)
      .slice(0, maxInfluences);
    const total = order.reduce((s, o) => s + o.w, 0) || 1;
    for (let k = 0; k < 4; k += 1) {
      const entry = order[k];
      joints[v * 4 + k] = entry ? bones[entry.b].index ?? entry.b : 0;
      weights[v * 4 + k] = entry ? entry.w / total : 0;
      if (entry) usedBones.add(entry.b);
    }
  }
  const boneList = bones.map((b, index) => ({ ...b, index }));
  return {
    joints,
    weights,
    bones: boneList,
    stats: {
      vertices: vc,
      bones: bones.length,
      maxInfluences,
      bonesUsed: usedBones.size,
      averageInfluences: Number(
        (Array.from({ length: vc }, (_, v) => Array.from(weights.subarray(v * 4, v * 4 + 4)).filter((w) => w > 1e-4).length).reduce((a, b) => a + b, 0) / Math.max(1, vc)).toFixed(2),
      ),
    },
  };
}

function normaliseRows(matrix, rows, cols) {
  for (let v = 0; v < rows; v += 1) {
    let sum = 0;
    for (let b = 0; b < cols; b += 1) sum += matrix[v * cols + b];
    if (sum <= 0) continue;
    for (let b = 0; b < cols; b += 1) matrix[v * cols + b] /= sum;
  }
}

/** Attach weights to geometry (returns a new geometry). */
export function applySkin(geo, { joints, weights }) {
  const vc = vertexCount(geo);
  if (joints.length !== vc * 4 || weights.length !== vc * 4) {
    fail('invalid_argument', 'Skin weight arrays do not match vertex count');
  }
  return { ...geo, joints: new Uint16Array(joints), weights: new Float32Array(weights) };
}

/** Repair / clean an existing weight set. */
export function correctSkinWeights(geo, skeleton, { limitInfluences = 4, pruneThreshold = 1e-3, smoothing = 1, symmetry = false } = {}) {
  const vc = vertexCount(geo);
  if (geo.weights.length !== vc * 4) fail('missing_weights', 'Mesh has no skin weights; rig it first', { status: 409 });
  const weights = new Float32Array(geo.weights);
  const joints = new Uint16Array(geo.joints);
  const report = { unweightedVertices: 0, renormalised: 0, prunedWeights: 0, smoothedPasses: 0, limitedVertices: 0 };

  // 1. Repair unweighted / NaN vertices using the nearest bone.
  const bones = skeleton ? skeletonBones(skeleton) : null;
  for (let v = 0; v < vc; v += 1) {
    let sum = 0;
    let nan = false;
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k];
      if (!Number.isFinite(w)) nan = true;
      else sum += w;
    }
    if (nan) {
      for (let k = 0; k < 4; k += 1) weights[v * 4 + k] = Number.isFinite(weights[v * 4 + k]) ? weights[v * 4 + k] : 0;
      sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
    }
    if (sum < 1e-4) {
      report.unweightedVertices += 1;
      if (bones && bones.length) {
        let best = 0;
        let bestDist = Infinity;
        for (let b = 0; b < bones.length; b += 1) {
          const bone = bones[b];
          const d = pointSegmentDistance(
            geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2],
            bone.head[0], bone.head[1], bone.head[2], bone.tail[0], bone.tail[1], bone.tail[2],
          );
          if (d < bestDist) {
            bestDist = d;
            best = b;
          }
        }
        joints[v * 4] = best;
        weights[v * 4] = 1;
        for (let k = 1; k < 4; k += 1) weights[v * 4 + k] = 0;
      } else {
        weights[v * 4] = 1;
      }
    }
  }

  // 2. Prune tiny influences and cap the count.
  for (let v = 0; v < vc; v += 1) {
    const entries = [0, 1, 2, 3].map((k) => ({ k, w: weights[v * 4 + k] }));
    entries.sort((a, b) => b.w - a.w);
    const keep = entries.slice(0, limitInfluences).filter((e) => e.w > pruneThreshold);
    if (keep.length !== entries.filter((e) => e.w > 0).length) report.prunedWeights += entries.length - keep.length;
    const total = keep.reduce((s, e) => s + e.w, 0) || 1;
    for (let k = 0; k < 4; k += 1) {
      const entry = keep[k];
      weights[v * 4 + k] = entry ? entry.w / total : 0;
      joints[v * 4 + k] = entry ? joints[v * 4 + entry.k] : 0;
    }
    if (Math.abs(total - 1) > 1e-3) report.renormalised += 1;
  }

  // 3. Optional weight smoothing (damps spikes at joints).
  if (smoothing > 0) {
    const neighbors = adjacency(geo);
    for (let pass = 0; pass < smoothing; pass += 1) {
      const copyJ = new Uint16Array(joints);
      const copyW = new Float32Array(weights);
      for (let v = 0; v < vc; v += 1) {
        const list = neighbors[v];
        if (!list || list.length < 2) continue;
        const accum = new Map();
        for (let k = 0; k < 4; k += 1) {
          if (copyW[v * 4 + k] > 0) accum.set(copyJ[v * 4 + k], (accum.get(copyJ[v * 4 + k]) ?? 0) + copyW[v * 4 + k] * 0.5);
        }
        for (const n of list) {
          for (let k = 0; k < 4; k += 1) {
            if (copyW[n * 4 + k] > 0) {
              accum.set(copyJ[n * 4 + k], (accum.get(copyJ[n * 4 + k]) ?? 0) + copyW[n * 4 + k] / list.length);
            }
          }
        }
        const sorted = Array.from(accum.entries()).sort((a, b) => b[1] - a[1]).slice(0, limitInfluences);
        const total = sorted.reduce((s, [, w]) => s + w, 0) || 1;
        for (let k = 0; k < 4; k += 1) {
          joints[v * 4 + k] = sorted[k]?.[0] ?? 0;
          weights[v * 4 + k] = sorted[k] ? sorted[k][1] / total : 0;
        }
      }
      report.smoothedPasses += 1;
    }
  }

  // 4. Optional left/right symmetry pass.
  if (symmetry) {
    const mid = boundingBox(geo).center[0];
    const mirror = new Map();
    for (let v = 0; v < vc; v += 1) {
      const key = `${(geo.positions[v * 3 + 1]).toFixed(3)}|${(geo.positions[v * 3 + 2]).toFixed(3)}|${Math.abs(geo.positions[v * 3] - mid).toFixed(3)}`;
      if (!mirror.has(key)) mirror.set(key, []);
      mirror.get(key).push(v);
    }
    report.symmetryPairs = 0;
    for (const pair of mirror.values()) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      for (let k = 0; k < 4; k += 1) {
        const wa = weights[a * 4 + k];
        const wb = weights[b * 4 + k];
        const avg = (wa + wb) / 2;
        weights[a * 4 + k] = avg;
        weights[b * 4 + k] = avg;
        if (wa === 0 && wb > 0) joints[a * 4 + k] = joints[b * 4 + k];
        if (wb === 0 && wa > 0) joints[b * 4 + k] = joints[a * 4 + k];
      }
      report.symmetryPairs += 1;
    }
  }

  const quality = weightQuality(geo, { joints, weights });
  return { geometry: { ...geo, joints, weights }, report: { ...report, ...quality } };
}

export function weightQuality(geo, { joints, weights }) {
  const vc = vertexCount(geo);
  let unweighted = 0;
  let maxInfluences = 0;
  let sumError = 0;
  const used = new Set();
  for (let v = 0; v < vc; v += 1) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k];
      sum += w;
      if (w > 1e-4) {
        count += 1;
        used.add(joints[v * 4 + k]);
      }
    }
    if (sum < 1e-4) unweighted += 1;
    sumError = Math.max(sumError, Math.abs(sum - 1));
    maxInfluences = Math.max(maxInfluences, count);
  }
  return {
    unweighted,
    maxInfluences,
    normalisationError: Number(sumError.toFixed(6)),
    bonesUsed: used.size,
  };
}

// --- posing -----------------------------------------------------------------

export function quatFromAxisAngle(axis, angle) {
  const half = angle / 2;
  const s = Math.sin(half);
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / len) * s, (axis[1] / len) * s, (axis[2] / len) * s, Math.cos(half)];
}

export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatEuler(deg) {
  const [rx, ry, rz] = deg.map((d) => (d * Math.PI) / 180);
  const qx = quatFromAxisAngle([1, 0, 0], rx);
  const qy = quatFromAxisAngle([0, 1, 0], ry);
  const qz = quatFromAxisAngle([0, 0, 1], rz);
  return quatMultiply(qz, quatMultiply(qy, qx));
}

/** Set bone rotations by name, e.g. { 'upper_arm.L': [-40, 0, 0] } in degrees. */
export function poseSkeleton(skeleton, rotations = {}) {
  const applied = {};
  for (const [boneName, degrees] of Object.entries(rotations)) {
    const id = skeleton.jointOrder.find((j) => j === boneName)
      ?? skeleton.jointOrder.find((j) => skeleton.nodes[j].name === boneName);
    if (!id) {
      fail('bone_not_found', `No bone named "${boneName}"`, {
        status: 404,
        details: { bones: skeleton.jointOrder.map((j) => skeleton.nodes[j].name) },
      });
    }
    skeleton.nodes[id].rotation = quatEuler(Array.isArray(degrees) ? degrees : [degrees, 0, 0]);
    applied[skeleton.nodes[id].name] = skeleton.nodes[id].rotation;
  }
  return applied;
}

/** Linear-blend-skin a mesh into world space for a posed skeleton (for previews/tests). */
export function skinPositions(geo, skeleton, { rotations = null } = {}) {
  const joints = geo.joints;
  const weights = geo.weights;
  if (!joints || !weights || weights.length === 0) fail('missing_weights', 'Mesh is not skinned');
  if (rotations) poseSkeleton(skeleton, rotations);
  const world = worldPositionsOf(skeleton.nodes, skeleton.jointOrder);
  const rest = skeleton.restWorldPositions ?? world;
  const vc = vertexCount(geo);
  const out = new Float32Array(geo.positions);
  const transforms = skeleton.jointOrder.map((id) => {
    const node = skeleton.nodes[id];
    const translations = [];
    let current = id;
    const chain = [];
    while (current) {
      chain.unshift(current);
      current = skeleton.nodes[current]?.parent;
    }
    return chain.map((c) => c);
  });
  const restWorld = skeleton.restWorldPositions ?? skeleton.worldPositions ?? rest;
  for (let v = 0; v < vc; v += 1) {
    let px = 0;
    let py = 0;
    let pz = 0;
    const x = geo.positions[v * 3];
    const y = geo.positions[v * 3 + 1];
    const z = geo.positions[v * 3 + 2];
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k];
      if (w <= 0) continue;
      const jointIndex = joints[v * 4 + k];
      const boneId = skeleton.jointOrder[jointIndex];
      if (!boneId) continue;
      const chain = transforms[jointIndex];
      // apply rotations from the joint upward, pivoting about each joint's rest position
      let jx = x;
      let jy = y;
      let jz = z;
      for (let c = chain.length - 1; c >= 0; c -= 1) {
        const id2 = chain[c];
        const node = skeleton.nodes[id2];
        const pivot = restWorld[id2] ?? world[id2];
        const q = node.rotation ?? [0, 0, 0, 1];
        if (q[3] === 1) continue;
        const dx = jx - pivot[0];
        const dy = jy - pivot[1];
        const dz = jz - pivot[2];
        const [qx, qy, qz, qw] = q;
        // v' = q * v * q^-1
        const tx = 2 * (qy * dz - qz * dy);
        const ty = 2 * (qz * dx - qx * dz);
        const tz = 2 * (qx * dy - qy * dx);
        jx = dx + qw * tx + (qy * tz - qz * ty);
        jy = dy + qw * ty + (qz * tx - qx * tz);
        jz = dz + qw * tz + (qx * ty - qy * tx);
        jx += pivot[0];
        jy += pivot[1];
        jz += pivot[2];
      }
      px += jx * w;
      py += jy * w;
      pz += jz * w;
    }
    out[v * 3] = px;
    out[v * 3 + 1] = py;
    out[v * 3 + 2] = pz;
  }
  return { ...geo, positions: out, normals: computeNormals(out, geo.indices) };
}

export function skeletonReport(skeleton) {
  const world = worldPositionsOf(skeleton.nodes, skeleton.jointOrder);
  return {
    id: skeleton.id,
    name: skeleton.name,
    kind: skeleton.kind ?? 'humanoid',
    bones: skeleton.jointOrder.map((id) => ({
      id,
      name: skeleton.nodes[id].name,
      parent: skeleton.nodes[id].parent,
      worldPosition: world[id].map((v) => Number(v.toFixed(4))),
      rotation: skeleton.nodes[id].rotation,
    })),
  };
}

export { triangleCount, vertexCount, adjacency };
