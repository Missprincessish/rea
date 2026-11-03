// Signed-distance-field modelling with marching cubes.
//
// This is the local, self-hosted geometry generator used for text-to-3D: text is
// parsed into an SDF tree (structured prompt registry), sampled, and meshed with
// marching cubes. It is not a diffusion model and does not claim to be one --
// see docs/RESEARCH.md for what is reproduced and what is not.
import { marchingCubes, surfaceNets } from '../vendor/marchingcubes.mjs';
import {
  makeGeometry,
  computeNormals,
  compactVertices,
  weldVertices,
  vertexCount,
  removeDegenerateTriangles,
  removeDuplicateTriangles,
} from '../core/geometry.mjs';
import { flipNormals } from './repair.mjs';
import { fail } from '../core/util.mjs';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);

export const sdf = {
  sphere: (r = 0.5) => ({
    type: 'sphere',
    r,
    distance: (x, y, z, cx = 0, cy = 0, cz = 0) => Math.hypot(x - cx, y - cy, z - cz) - r,
    bounds: () => [-r, -r, -r, r, r, r],
  }),

  ellipsoid: (rx = 0.5, ry = 0.5, rz = 0.5) => ({
    type: 'ellipsoid',
    distance: (x, y, z, cx = 0, cy = 0, cz = 0) => {
      const px = (x - cx) / rx;
      const py = (y - cy) / ry;
      const pz = (z - cz) / rz;
      const k0 = Math.hypot(px, py, pz);
      const k1 = Math.hypot(px / rx, py / ry, pz / rz);
      if (k1 === 0) return -Math.min(rx, ry, rz);
      return (k0 * (k0 - 1)) / k1;
    },
    bounds: () => [-rx, -ry, -rz, rx, ry, rz],
  }),

  box: (sx = 0.5, sy = 0.5, sz = 0.5, rounding = 0) => ({
    type: 'box',
    distance: (x, y, z, cx = 0, cy = 0, cz = 0) => {
      const qx = Math.abs(x - cx) - (sx - rounding);
      const qy = Math.abs(y - cy) - (sy - rounding);
      const qz = Math.abs(z - cz) - (sz - rounding);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
      return outside + inside - rounding;
    },
    bounds: () => [-sx, -sy, -sz, sx, sy, sz],
  }),

  /** Capsule from point a to point b with radius r. */
  capsule: (a, b, r = 0.1) => {
    const axis = sub(b, a);
    const axisLen = len3(axis) || 1e-6;
    const dir = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
    return {
      type: 'capsule',
      distance: (x, y, z) => {
        const px = x - a[0];
        const py = y - a[1];
        const pz = z - a[2];
        const t = Math.max(0, Math.min(axisLen, px * dir[0] + py * dir[1] + pz * dir[2]));
        const dx = px - dir[0] * t;
        const dy = py - dir[1] * t;
        const dz = pz - dir[2] * t;
        return Math.hypot(dx, dy, dz) - r;
      },
      bounds: () => {
        const pad = r;
        return [
          Math.min(a[0], b[0]) - pad,
          Math.min(a[1], b[1]) - pad,
          Math.min(a[2], b[2]) - pad,
          Math.max(a[0], b[0]) + pad,
          Math.max(a[1], b[1]) + pad,
          Math.max(a[2], b[2]) + pad,
        ];
      },
    };
  },

  cone: (height = 1, r = 0.4) => ({
    type: 'cone',
    distance: (x, y, z) => {
      // cone with tip at +height/2, base at -height/2
      const q = [Math.hypot(x, z), y];
      const tip = [0, height / 2];
      const base = [r, -height / 2];
      const axis = sub(tip, base);
      const p = sub(q, base);
      const t = Math.max(0, Math.min(1, (p[0] * axis[0] + p[1] * axis[1]) / (axis[0] ** 2 + axis[1] ** 2)));
      const dx = p[0] - axis[0] * t;
      const dy = p[1] - axis[1] * t;
      return Math.hypot(dx, dy) - 0.001;
    },
    bounds: () => [-r, -height / 2, -r, r, height / 2, r],
  }),

  torus: (R = 0.5, r = 0.15) => ({
    type: 'torus',
    distance: (x, y, z) => Math.hypot(Math.hypot(x, z) - R, y) - r,
    bounds: () => [-R - r, -r, -R - r, R + r, r, R + r],
  }),

  plane: (normalY = 0) => ({
    type: 'plane',
    distance: (x, y, z) => y - normalY,
    bounds: () => [-1, -1, -1, 1, 1, 1],
  }),
};

/** Smooth minimum (polynomial) for blending shapes. */
export function smin(a, b, k = 0.05) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

export function translate(shape, offset) {
  return {
    ...shape,
    distance: (x, y, z) => shape.distance(x - offset[0], y - offset[1], z - offset[2]),
    bounds: () => {
      const b = shape.bounds();
      return [b[0] + offset[0], b[1] + offset[1], b[2] + offset[2], b[3] + offset[0], b[4] + offset[1], b[5] + offset[2]];
    },
  };
}

export function scaleShape(shape, factor) {
  const f = Array.isArray(factor) ? factor : [factor, factor, factor];
  return {
    ...shape,
    distance: (x, y, z) => shape.distance(x / f[0], y / f[1], z / f[2]) * Math.min(f[0], f[1], f[2]),
    bounds: () => {
      const b = shape.bounds();
      return [b[0] * f[0], b[1] * f[1], b[2] * f[2], b[3] * f[0], b[4] * f[1], b[5] * f[2]];
    },
  };
}

export function union(...shapes) {
  const [first, ...rest] = shapes;
  return {
    type: 'union',
    distance: (x, y, z) => rest.reduce((acc, s) => Math.min(acc, s.distance(x, y, z)), first.distance(x, y, z)),
    bounds: () => mergeBounds(shapes.map((s) => s.bounds())),
  };
}

export function smoothUnion(shapes, k = 0.05) {
  const [first, ...rest] = shapes;
  return {
    type: 'smoothUnion',
    distance: (x, y, z) =>
      rest.reduce((acc, s) => smin(acc, s.distance(x, y, z), k), first.distance(x, y, z)),
    bounds: () => mergeBounds(shapes.map((s) => s.bounds())),
  };
}

export function subtract(shape, ...cutters) {
  return {
    type: 'subtract',
    distance: (x, y, z) =>
      cutters.reduce((acc, c) => Math.max(acc, -c.distance(x, y, z)), shape.distance(x, y, z)),
    bounds: () => shape.bounds(),
  };
}

export function intersect(shape, ...others) {
  return {
    type: 'intersect',
    distance: (x, y, z) => others.reduce((acc, o) => Math.max(acc, o.distance(x, y, z)), shape.distance(x, y, z)),
    bounds: () => mergeBounds([shape.bounds(), ...others.map((o) => o.bounds())]),
  };
}

export function mergeBounds(boundsList) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of boundsList) {
    out[0] = Math.min(out[0], b[0]);
    out[1] = Math.min(out[1], b[1]);
    out[2] = Math.min(out[2], b[2]);
    out[3] = Math.max(out[3], b[3]);
    out[4] = Math.max(out[4], b[4]);
    out[5] = Math.max(out[5], b[5]);
  }
  return out;
}

/**
 * Sample an SDF into a mesh.
 * @param {object} shape SDF node
 * @param {object} options resolution (max dimension cells), padding, isoLevel, method
 */
export function sdfToMesh(shape, { resolution = 64, padding = 0.04, isoLevel = 0, method = 'marching-cubes' } = {}) {
  const bounds = shape.bounds();
  const size = [bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]];
  const pad = Math.max(...size) * padding + 1e-4;
  const min = [bounds[0] - pad, bounds[1] - pad, bounds[2] - pad];
  const max = [bounds[3] + pad, bounds[4] + pad, bounds[5] + pad];
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cells = Math.max(8, Math.min(220, Math.round(resolution)));
  const dims = span.map((s) => Math.max(8, Math.round((s / Math.max(...span)) * cells)));
  const fn = method === 'surface-nets' ? surfaceNets : marchingCubes;
  const mesh = fn(dims, (x, y, z) => shape.distance(x, y, z), [min, max]);
  if (!mesh || mesh.cells.length === 0) {
    fail('generation_failed', 'SDF produced no surface; adjust size or shape parameters', { status: 422 });
  }
  const rawVertexCount = mesh.positions.length;
  const positions = new Float32Array(rawVertexCount * 3);
  for (let i = 0; i < rawVertexCount; i += 1) {
    const [x, y, z] = mesh.positions[i];
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  const indices = new Uint32Array(mesh.cells.length * 3);
  for (let i = 0; i < mesh.cells.length; i += 1) {
    indices[i * 3] = mesh.cells[i][0];
    indices[i * 3 + 1] = mesh.cells[i][1];
    indices[i * 3 + 2] = mesh.cells[i][2];
  }
  const raw = makeGeometry(positions, indices);
  // Marching cubes emits per-cell vertices; weld so the result is a connected,
  // repairable surface rather than triangle soup.
  const tolerance = Math.max(1e-6, (Math.max(...span) / Math.max(...dims)) * 0.05);
  const welded = weldVertices(raw, tolerance);
  // Marching cubes emits zero-area triangles wherever the isosurface passes
  // exactly through a grid node. They are invisible but break every downstream
  // manifold test, so drop them (and exact duplicates) before returning.
  const withoutDegenerate = removeDegenerateTriangles(welded);
  const deduplicated = removeDuplicateTriangles(withoutDegenerate);
  const compacted = compactVertices(deduplicated);
  let out = {
    ...compacted,
    normals: computeNormals(compacted.positions, compacted.indices),
  };
  if (signedVolume(out) < 0) {
    const flipped = flipNormals(out);
    out = { ...flipped, normals: computeNormals(flipped.positions, flipped.indices) };
  }
  if (out.uvs.length !== vertexCount(out) * 2) out.uvs = new Float32Array(vertexCount(out) * 2);
  return {
    ...out,
    stats: {
      resolution: dims,
      samples: dims[0] * dims[1] * dims[2],
      method,
      isoLevel,
      verticesRaw: vertexCount(raw),
      vertices: vertexCount(out),
      triangles: out.indices.length / 3,
    },
  };
}

export function signedVolume(geo) {
  const p = geo.positions;
  let volume = 0;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const a = geo.indices[i] * 3;
    const b = geo.indices[i + 1] * 3;
    const c = geo.indices[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/** Compose a shape from a compact JSON description (used by prompts and the API). */
export function shapeFromSpec(spec) {
  if (!spec || typeof spec !== 'object') fail('invalid_argument', 'shape spec must be an object');
  const op = spec.op ?? spec.type;
  switch (op) {
    case 'sphere':
      return translate(sdf.sphere(spec.radius ?? 0.5), spec.at ?? [0, 0, 0]);
    case 'ellipsoid':
      return translate(
        sdf.ellipsoid(spec.radius?.[0] ?? spec.rx ?? 0.5, spec.radius?.[1] ?? spec.ry ?? 0.4, spec.radius?.[2] ?? spec.rz ?? 0.4),
        spec.at ?? [0, 0, 0],
      );
    case 'box':
      return translate(
        sdf.box(spec.size?.[0] ?? 0.5, spec.size?.[1] ?? 0.5, spec.size?.[2] ?? 0.5, spec.rounding ?? 0.02),
        spec.at ?? [0, 0, 0],
      );
    case 'capsule':
      return sdf.capsule(spec.from ?? [0, -0.5, 0], spec.to ?? [0, 0.5, 0], spec.radius ?? 0.1);
    case 'cone':
      return translate(sdf.cone(spec.height ?? 1, spec.radius ?? 0.4), spec.at ?? [0, 0, 0]);
    case 'torus':
      return translate(sdf.torus(spec.radius ?? 0.5, spec.tube ?? 0.15), spec.at ?? [0, 0, 0]);
    case 'union':
    case 'smooth-union':
      return op === 'union'
        ? union(...(spec.children ?? []).map(shapeFromSpec))
        : smoothUnion((spec.children ?? []).map(shapeFromSpec), spec.k ?? 0.05);
    case 'subtract':
      return subtract(shapeFromSpec(spec.child), ...(spec.children ?? []).map(shapeFromSpec));
    case 'intersect':
      return intersect(shapeFromSpec(spec.child), ...(spec.children ?? []).map(shapeFromSpec));
    case 'translate':
      return translate(shapeFromSpec(spec.child), spec.at ?? [0, 0, 0]);
    case 'scale':
      return scaleShape(shapeFromSpec(spec.child), spec.factor ?? 1);
    default:
      fail('unknown_shape', `Unknown SDF op "${op}"`, {
        details: { ops: ['sphere', 'ellipsoid', 'box', 'capsule', 'cone', 'torus', 'union', 'smooth-union', 'subtract', 'intersect', 'translate', 'scale'] },
      });
  }
}
