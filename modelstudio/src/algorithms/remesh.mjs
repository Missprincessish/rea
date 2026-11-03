// Voxel remeshing + attribute transfer.
//
// Remesh samples a signed distance field derived from the input mesh on a
// regular grid and re-extracts the surface with marching cubes. That welds
// disjoint shells, closes small holes and equalises triangle density, which is
// the same class of operation as Meshy's "remesh" stage.
import { marchingCubes } from '../vendor/marchingcubes.mjs';
import {
  boundingBox,
  compactVertices,
  computeNormals,
  makeGeometry,
  triangleCount,
  vertexCount,
  weldVertices,
} from '../core/geometry.mjs';
import { fail } from '../core/util.mjs';

export function buildTriangleGrid(geo, { cell = null } = {}) {
  const bbox = boundingBox(geo);
  const size = Math.max(bbox.size[0], bbox.size[1], bbox.size[2]) || 1;
  const grid = cell ?? size / 48;
  const p = geo.positions;
  const cells = new Map();
  const tris = [];
  for (let i = 0; i < geo.indices.length; i += 3) {
    const ia = geo.indices[i];
    const ib = geo.indices[i + 1];
    const ic = geo.indices[i + 2];
    const tri = {
      a: [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]],
      b: [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]],
      c: [p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]],
      ia,
      ib,
      ic,
    };
    const index = tris.push(tri) - 1;
    const min = [
      Math.min(tri.a[0], tri.b[0], tri.c[0]) - grid,
      Math.min(tri.a[1], tri.b[1], tri.c[1]) - grid,
      Math.min(tri.a[2], tri.b[2], tri.c[2]) - grid,
    ];
    const max = [
      Math.max(tri.a[0], tri.b[0], tri.c[0]) + grid,
      Math.max(tri.a[1], tri.b[1], tri.c[1]) + grid,
      Math.max(tri.a[2], tri.b[2], tri.c[2]) + grid,
    ];
    for (let x = Math.floor(min[0] / grid); x <= Math.floor(max[0] / grid); x += 1) {
      for (let y = Math.floor(min[1] / grid); y <= Math.floor(max[1] / grid); y += 1) {
        for (let z = Math.floor(min[2] / grid); z <= Math.floor(max[2] / grid); z += 1) {
          const key = `${x},${y},${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(index);
        }
      }
    }
  }
  return { cells, tris, cell: grid, bbox };
}

export function closestPointOnTriangles(grid, x, y, z, { maxDistance = Infinity } = {}) {
  const { cells, tris, cell } = grid;
  let best = { distance: Infinity, tri: null, bary: null, point: null, index: -1 };
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const cz = Math.floor(z / cell);
  const maxRing = Number.isFinite(maxDistance)
    ? Math.ceil(maxDistance / cell) + 1
    : Math.ceil(cell * 400);
  for (let ring = 0; ring <= maxRing; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dz = -ring; dz <= ring; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const index of list) {
            const tri = tris[index];
            const result = closestOnTri(x, y, z, tri);
            if (result.distance < best.distance) best = { ...result, tri, index };
          }
        }
      }
    }
    // the current ring guarantees every point inside (ring-1)*cell was tested
    if (best.tri && best.distance <= (ring - 1) * cell) break;
    if (!Number.isFinite(maxDistance) && ring >= 8 && best.tri) break;
  }
  if (best.distance > maxDistance) return { distance: maxDistance, tri: null, bary: null, point: null, index: -1 };
  return best;
}

function closestOnTri(px, py, pz, tri) {
  const [ax, ay, az] = tri.a;
  const [bx, by, bz] = tri.b;
  const [cx, cy, cz] = tri.c;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { distance: Math.hypot(apx, apy, apz), bary: [1, 0, 0], point: [ax, ay, az] };
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { distance: Math.hypot(bpx, bpy, bpz), bary: [0, 1, 0], point: [bx, by, bz] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const point = [ax + abx * v, ay + aby * v, az + abz * v];
    return { distance: Math.hypot(px - point[0], py - point[1], pz - point[2]), bary: [1 - v, v, 0], point };
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { distance: Math.hypot(cpx, cpy, cpz), bary: [0, 0, 1], point: [cx, cy, cz] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const point = [ax + acx * w, ay + acy * w, az + acz * w];
    return { distance: Math.hypot(px - point[0], py - point[1], pz - point[2]), bary: [1 - w, 0, w], point };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const point = [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w];
    return { distance: Math.hypot(px - point[0], py - point[1], pz - point[2]), bary: [0, 1 - w, w], point };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const point = [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
  return {
    distance: Math.hypot(px - point[0], py - point[1], pz - point[2]),
    bary: [1 - v - w, v, w],
    point,
  };
}

function triangleNormal(tri) {
  const abx = tri.b[0] - tri.a[0], aby = tri.b[1] - tri.a[1], abz = tri.b[2] - tri.a[2];
  const acx = tri.c[0] - tri.a[0], acy = tri.c[1] - tri.a[1], acz = tri.c[2] - tri.a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

let smoothFn = null;
/** repair.mjs injects its Laplacian smoother here (avoids a circular import). */
export function injectSmooth(fn) {
  smoothFn = fn;
}

/**
 * Compute a signed distance field on a regular grid using a vector distance
 * transform (Danielsson sweeps). O(cells) after seeding, so remeshing a
 * 100k-triangle mesh stays interactive.
 */
export function signedDistanceField(geo, { dims, min, max }) {
  const [nx, ny, nz] = dims;
  const h = [
    (max[0] - min[0]) / (nx - 1),
    (max[1] - min[1]) / (ny - 1),
    (max[2] - min[2]) / (nz - 1),
  ];
  const count = nx * ny * nz;
  const nearest = new Float32Array(count * 3).fill(Infinity);
  const normals = new Float32Array(count * 3);
  const index = (x, y, z) => (z * ny + y) * nx + x;
  const p = geo.positions;

  // 1. Seed cells from triangles (exact closest point per covered cell).
  for (let i = 0; i < geo.indices.length; i += 3) {
    const tri = {
      a: [p[geo.indices[i] * 3], p[geo.indices[i] * 3 + 1], p[geo.indices[i] * 3 + 2]],
      b: [p[geo.indices[i + 1] * 3], p[geo.indices[i + 1] * 3 + 1], p[geo.indices[i + 1] * 3 + 2]],
      c: [p[geo.indices[i + 2] * 3], p[geo.indices[i + 2] * 3 + 1], p[geo.indices[i + 2] * 3 + 2]],
    };
    const n = triangleNormal(tri);
    const expand = Math.max(h[0], h[1], h[2]) * 1.5;
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(tri.a[k], tri.b[k], tri.c[k]) - expand - min[k]) / h[k])));
    const hi = [0, 1, 2].map((k) => Math.min(dims[k] - 1, Math.ceil((Math.max(tri.a[k], tri.b[k], tri.c[k]) + expand - min[k]) / h[k])));
    for (let z = lo[2]; z <= hi[2]; z += 1) {
      for (let y = lo[1]; y <= hi[1]; y += 1) {
        for (let x = lo[0]; x <= hi[0]; x += 1) {
          const px = min[0] + x * h[0];
          const py = min[1] + y * h[1];
          const pz = min[2] + z * h[2];
          const result = closestOnTri(px, py, pz, tri);
          const cell = index(x, y, z);
          const current = nearest[cell * 3] === Infinity
            ? Infinity
            : (nearest[cell * 3] - px) ** 2 + (nearest[cell * 3 + 1] - py) ** 2 + (nearest[cell * 3 + 2] - pz) ** 2;
          if (result.distance * result.distance < current) {
            nearest[cell * 3] = result.point[0];
            nearest[cell * 3 + 1] = result.point[1];
            nearest[cell * 3 + 2] = result.point[2];
            normals[cell * 3] = n[0];
            normals[cell * 3 + 1] = n[1];
            normals[cell * 3 + 2] = n[2];
          }
        }
      }
    }
  }

  // 2. Propagate nearest-surface vectors through the volume.
  const offsets = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        offsets.push([dx, dy, dz]);
      }
    }
  }
  // sort offsets so nearer neighbours come first (fewer updates)
  offsets.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2])) - (Math.abs(b[0]) + Math.abs(b[1]) + Math.abs(b[2])));
  const passes = [];
  for (let sz = -1; sz <= 1; sz += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sx = -1; sx <= 1; sx += 2) passes.push([sx, sy, sz]);
    }
  }
  for (const [sx, sy, sz] of passes) {
    const xStart = sx > 0 ? 0 : nx - 1;
    const yStart = sy > 0 ? 0 : ny - 1;
    const zStart = sz > 0 ? 0 : nz - 1;
    for (let zi = 0; zi < nz; zi += 1) {
      const z = zStart + sz * zi;
      for (let yi = 0; yi < ny; yi += 1) {
        const y = yStart + sy * yi;
        for (let xi = 0; xi < nx; xi += 1) {
          const x = xStart + sx * xi;
          const cell = index(x, y, z);
          const px = min[0] + x * h[0];
          const py = min[1] + y * h[1];
          const pz = min[2] + z * h[2];
          let bestD = nearest[cell * 3] === Infinity
            ? Infinity
            : (nearest[cell * 3] - px) ** 2 + (nearest[cell * 3 + 1] - py) ** 2 + (nearest[cell * 3 + 2] - pz) ** 2;
          let best = null;
          for (const [dx, dy, dz] of offsets) {
            const nx2 = x + dx;
            const ny2 = y + dy;
            const nz2 = z + dz;
            if (nx2 < 0 || ny2 < 0 || nz2 < 0 || nx2 >= nx || ny2 >= ny || nz2 >= nz) continue;
            const ncell = index(nx2, ny2, nz2);
            const qx = nearest[ncell * 3];
            if (qx === Infinity) continue;
            const qy = nearest[ncell * 3 + 1];
            const qz = nearest[ncell * 3 + 2];
            const d = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
            if (d < bestD) {
              bestD = d;
              best = ncell;
            }
          }
          if (best !== null) {
            nearest[cell * 3] = nearest[best * 3];
            nearest[cell * 3 + 1] = nearest[best * 3 + 1];
            nearest[cell * 3 + 2] = nearest[best * 3 + 2];
            normals[cell * 3] = normals[best * 3];
            normals[cell * 3 + 1] = normals[best * 3 + 1];
            normals[cell * 3 + 2] = normals[best * 3 + 2];
          }
        }
      }
    }
  }

  // 3. Sample the field at arbitrary points (trilinear on the vector field).
  const sample = (x, y, z) => {
    const gx = Math.max(0, Math.min(nx - 1, (x - min[0]) / h[0]));
    const gy = Math.max(0, Math.min(ny - 1, (y - min[1]) / h[1]));
    const gz = Math.max(0, Math.min(nz - 1, (z - min[2]) / h[2]));
    const ix = Math.round(gx);
    const iy = Math.round(gy);
    const iz = Math.round(gz);
    const cell = index(ix, iy, iz);
    const qx = nearest[cell * 3];
    if (qx === Infinity) return Math.max(h[0], h[1], h[2]) * 2;
    const qy = nearest[cell * 3 + 1];
    const qz = nearest[cell * 3 + 2];
    const d = Math.hypot(x - qx, y - qy, z - qz);
    const side = (x - qx) * normals[cell * 3] + (y - qy) * normals[cell * 3 + 1] + (z - qz) * normals[cell * 3 + 2];
    return side >= 0 ? d : -d;
  };
  return { sample, dims, min, max, h };
}

/**
 * Voxel remesh a mesh.
 */
export function voxelRemesh(geo, { voxelResolution = 96, padding = 0.02, smoothIterations = 0 } = {}) {
  if (triangleCount(geo) === 0) fail('empty_geometry', 'Cannot remesh an empty mesh');
  const resolution = Math.max(16, Math.min(200, Math.round(voxelResolution)));
  const bbox = boundingBox(geo);
  const size = Math.max(bbox.size[0], bbox.size[1], bbox.size[2]) || 1;
  const pad = size * padding + size * 0.01;
  const min = [bbox.min[0] - pad, bbox.min[1] - pad, bbox.min[2] - pad];
  const max = [bbox.max[0] + pad, bbox.max[1] + pad, bbox.max[2] + pad];
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const dims = span.map((s) => Math.max(12, Math.round((s / Math.max(...span)) * resolution)));
  const field = signedDistanceField(geo, { dims, min, max });
  const mesh = marchingCubes(dims, field.sample, [min, max]);
  if (!mesh || mesh.cells.length === 0) fail('remesh_failed', 'Remesh produced an empty surface', { status: 422 });
  const positions = new Float32Array(mesh.positions.length * 3);
  mesh.positions.forEach(([x, y, z], i) => {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  });
  const indices = new Uint32Array(mesh.cells.length * 3);
  mesh.cells.forEach(([a, b, c], i) => {
    indices[i * 3] = a;
    indices[i * 3 + 1] = b;
    indices[i * 3 + 2] = c;
  });
  let out = compactVertices(weldVertices(makeGeometry(positions, indices), Math.max(1e-6, (size / resolution) * 0.05)));
  out.normals = computeNormals(out.positions, out.indices);
  out.uvs = new Float32Array(vertexCount(out) * 2);
  if (smoothIterations > 0 && smoothFn) {
    out = smoothFn(out, { iterations: smoothIterations, factor: 0.35 });
  }
  return {
    ...out,
    stats: {
      resolution: dims,
      trianglesBefore: triangleCount(geo),
      trianglesAfter: triangleCount(out),
      verticesAfter: vertexCount(out),
      gridSpacing: Number(Math.max(...field.h).toFixed(5)),
    },
  };
}

/**
 * Transfer UVs (and optionally skin weights) from a source mesh to a target
 * mesh by closest-point sampling. This is how textures survive a remesh.
 */
export function transferAttributes(source, target, { transferUV = true, transferSkin = true } = {}) {
  const grid = buildTriangleGrid(source, {});
  const tvc = vertexCount(target);
  const svc = vertexCount(source);
  const uvs = new Float32Array(tvc * 2);
  const joints = new Uint16Array(tvc * 4);
  const weights = new Float32Array(tvc * 4);
  const sourceHasUv = source.uvs.length === svc * 2;
  const sourceHasSkin = source.weights.length === svc * 4;
  let matched = 0;
  let maxDistance = 0;
  for (let v = 0; v < tvc; v += 1) {
    const x = target.positions[v * 3];
    const y = target.positions[v * 3 + 1];
    const z = target.positions[v * 3 + 2];
    const closest = closestPointOnTriangles(grid, x, y, z);
    if (!closest.tri) continue;
    matched += 1;
    maxDistance = Math.max(maxDistance, closest.distance);
    if (transferUV && sourceHasUv) {
      const [w0, w1, w2] = closest.bary;
      const ia = closest.tri.ia;
      const ib = closest.tri.ib;
      const ic = closest.tri.ic;
      uvs[v * 2] = source.uvs[ia * 2] * w0 + source.uvs[ib * 2] * w1 + source.uvs[ic * 2] * w2;
      uvs[v * 2 + 1] = source.uvs[ia * 2 + 1] * w0 + source.uvs[ib * 2 + 1] * w1 + source.uvs[ic * 2 + 1] * w2;
    }
    if (transferSkin && sourceHasSkin) {
      const [w0, w1, w2] = closest.bary;
      const ia = closest.tri.ia;
      const ib = closest.tri.ib;
      const ic = closest.tri.ic;
      const accum = new Map();
      for (const [index, weight] of [[ia, w0], [ib, w1], [ic, w2]]) {
        for (let k = 0; k < 4; k += 1) {
          const bone = source.joints[index * 4 + k];
          const w = source.weights[index * 4 + k] * weight;
          if (w > 0) accum.set(bone, (accum.get(bone) ?? 0) + w);
        }
      }
      const sorted = Array.from(accum.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = sorted.reduce((s, [, w]) => s + w, 0) || 1;
      for (let k = 0; k < 4; k += 1) {
        joints[v * 4 + k] = sorted[k]?.[0] ?? 0;
        weights[v * 4 + k] = sorted[k] ? sorted[k][1] / total : 0;
      }
    }
  }
  return {
    geometry: {
      ...target,
      uvs: transferUV && sourceHasUv ? uvs : target.uvs,
      joints: transferSkin && sourceHasSkin ? joints : target.joints,
      weights: transferSkin && sourceHasSkin ? weights : target.weights,
    },
    stats: {
      vertices: tvc,
      matched,
      coverage: Number((matched / Math.max(1, tvc)).toFixed(4)),
      maxDistance: Number(maxDistance.toFixed(5)),
      transferredUV: transferUV && sourceHasUv,
      transferredSkin: transferSkin && sourceHasSkin,
    },
  };
}

/** Merge several geometries into one (world transforms applied by caller). */
export function mergeGeometries(geometries) {
  const valid = geometries.filter((g) => g && g.positions.length > 0);
  if (!valid.length) fail('empty_geometry', 'Nothing to merge');
  let vertexTotal = 0;
  let indexTotal = 0;
  const anyUv = valid.some((g) => g.uvs.length === vertexCount(g) * 2);
  const anySkin = valid.some((g) => g.weights.length === vertexCount(g) * 4);
  for (const g of valid) {
    vertexTotal += vertexCount(g);
    indexTotal += g.indices.length;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const uvs = anyUv ? new Float32Array(vertexTotal * 2) : new Float32Array(0);
  const joints = anySkin ? new Uint16Array(vertexTotal * 4) : new Uint16Array(0);
  const weights = anySkin ? new Float32Array(vertexTotal * 4) : new Float32Array(0);
  let vo = 0;
  let io = 0;
  for (const g of valid) {
    const vc = vertexCount(g);
    positions.set(g.positions, vo * 3);
    for (let i = 0; i < g.indices.length; i += 1) indices[io + i] = g.indices[i] + vo;
    io += g.indices.length;
    if (anyUv) {
      if (g.uvs.length === vc * 2) uvs.set(g.uvs, vo * 2);
    }
    if (anySkin && g.weights.length === vc * 4) {
      joints.set(g.joints, vo * 4);
      weights.set(g.weights, vo * 4);
    }
    vo += vc;
  }
  return {
    positions,
    indices,
    uvs,
    joints,
    weights,
    normals: computeNormals(positions, indices),
  };
}

/** Transform geometry by translation / rotation (euler radians) / scale. */
export function transformGeometry(geo, { translation = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] }) {
  const p = new Float32Array(geo.positions);
  const [sx, sy, sz] = scale;
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i] * sx;
    let y = p[i + 1] * sy;
    let z = p[i + 2] * sz;
    // rotate X
    let ty = y * cx - z * sxr;
    let tz = y * sxr + z * cx;
    y = ty;
    z = tz;
    // rotate Y
    let tx = x * cy + z * syr;
    tz = -x * syr + z * cy;
    x = tx;
    z = tz;
    // rotate Z
    tx = x * cz - y * szr;
    ty = x * szr + y * cz;
    x = tx;
    y = ty;
    p[i] = x + translation[0];
    p[i + 1] = y + translation[1];
    p[i + 2] = z + translation[2];
  }
  return { ...geo, positions: p, normals: computeNormals(p, geo.indices) };
}
