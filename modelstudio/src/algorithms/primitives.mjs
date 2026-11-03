// Primitive mesh construction. We use three.js geometry generators (well
// tested) and convert them into plain typed-array geometry.
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGeometry, computeNormals } from '../core/geometry.mjs';
import { fail } from '../core/util.mjs';

export function fromThreeGeometry(threeGeometry, { weld = true } = {}) {
  let geo = threeGeometry;
  const hasIndex = Boolean(geo.index);
  if (weld || !hasIndex) {
    try {
      geo = mergeVertices(geo.clone(), 1e-5);
    } catch {
      geo = geo.toNonIndexed();
    }
  }
  const position = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const normal = geo.getAttribute('normal');
  const indices = geo.index
    ? Array.from(geo.index.array)
    : Array.from({ length: position.count }, (_, i) => i);
  const out = makeGeometry(
    Array.from(position.array),
    indices,
    {
      uvs: uv ? Array.from(uv.array) : null,
      normals: normal ? Array.from(normal.array) : null,
    },
  );
  out.normals = computeNormals(out.positions, out.indices);
  return out;
}

export const PRIMITIVES = {
  cube: (o) => new THREE.BoxGeometry(o.size ?? 1, o.height ?? o.size ?? 1, o.depth ?? o.size ?? 1, o.segments ?? 1, o.segments ?? 1, o.segments ?? 1),
  sphere: (o) => new THREE.SphereGeometry(o.radius ?? 0.5, o.segments ?? 32, Math.max(3, Math.round((o.segments ?? 32) / 2))),
  cylinder: (o) => new THREE.CylinderGeometry(o.radiusTop ?? o.radius ?? 0.4, o.radiusBottom ?? o.radius ?? 0.4, o.height ?? 1, o.segments ?? 32),
  cone: (o) => new THREE.ConeGeometry(o.radius ?? 0.5, o.height ?? 1, o.segments ?? 32),
  torus: (o) => new THREE.TorusGeometry(o.radius ?? 0.5, o.tube ?? 0.15, o.radialSegments ?? 20, o.tubularSegments ?? 48),
  torusKnot: (o) => new THREE.TorusKnotGeometry(o.radius ?? 0.5, o.tube ?? 0.15, o.tubularSegments ?? 96, o.radialSegments ?? 16),
  capsule: (o) => new THREE.CapsuleGeometry(o.radius ?? 0.3, o.height ?? 0.8, o.capSegments ?? 8, o.radialSegments ?? 24),
  plane: (o) => new THREE.PlaneGeometry(o.width ?? 1, o.height ?? 1, o.segments ?? 1, o.segments ?? 1),
  icosahedron: (o) => new THREE.IcosahedronGeometry(o.radius ?? 0.6, o.detail ?? 2),
  dodecahedron: (o) => new THREE.DodecahedronGeometry(o.radius ?? 0.6, o.detail ?? 1),
  ring: (o) => new THREE.RingGeometry(o.innerRadius ?? 0.2, o.radius ?? 0.5, o.segments ?? 48),
  tube: (o) => {
    const points = (o.points ?? [[0, -0.5, 0], [0, 0.5, 0]]).map((p) => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(points);
    return new THREE.TubeGeometry(curve, o.tubularSegments ?? 64, o.radius ?? 0.1, o.radialSegments ?? 12, false);
  },
};

export function buildPrimitive(kind, options = {}) {
  const factory = PRIMITIVES[kind];
  if (!factory) {
    fail('unknown_primitive', `Unknown primitive "${kind}"`, {
      details: { available: Object.keys(PRIMITIVES) },
    });
  }
  const segments = Math.max(3, Math.min(256, Number(options.segments ?? 32) || 32));
  const geometry = factory({ ...options, segments });
  geometry.computeVertexNormals();
  return fromThreeGeometry(geometry);
}

/** Subdivide with creased normals for a smoother base surface. */
export function smoothPrimitive(kind, options = {}) {
  const geo = buildPrimitive(kind, { segments: (options.segments ?? 32) * 2, ...options });
  return geo;
}

export { toCreasedNormals };
