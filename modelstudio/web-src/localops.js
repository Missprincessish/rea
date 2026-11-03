// Client-side preview maths.
//
// The authoritative sculpt happens in the engine (mesh.sculpt) when the stroke
// ends. This module only applies the *same* radial falloff to the three.js
// geometry so dragging feels immediate; the engine result then replaces it via
// a project resync.

export const localGeometryCache = new Map();

export function applySculptLocally(geometry, { center, radius, strength, mode, falloff = 'smooth' }) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!position || !normal) return 0;
  const falloffFn = (t) => {
    if (falloff === 'linear') return 1 - t;
    if (falloff === 'constant') return 1;
    return 1 - t * t * (3 - 2 * t);
  };
  let affected = 0;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const d = Math.hypot(x - center[0], y - center[1], z - center[2]);
    if (d > radius) continue;
    const w = falloffFn(Math.min(1, d / radius)) * strength;
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    if (mode === 'inflate') {
      position.setXYZ(i, x + nx * w, y + ny * w, z + nz * w);
    } else if (mode === 'pinch') {
      const dx = center[0] - x;
      const dy = center[1] - y;
      const dz = center[2] - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      position.setXYZ(i, x + (dx / len) * w, y + (dy / len) * w, z + (dz / len) * w);
    } else if (mode === 'grab') {
      position.setXYZ(i, x, y + w, z);
    } else if (mode === 'flatten') {
      const dist = (x - center[0]) * nx + (y - center[1]) * ny + (z - center[2]) * nz;
      position.setXYZ(i, x - nx * dist * w * 20, y - ny * dist * w * 20, z - nz * dist * w * 20);
    }
    affected += 1;
  }
  if (affected) {
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }
  return affected;
}
