// Export (GLB/glTF) and offscreen preview rendering.
//
// The preview renderer is a small software rasteriser with a z-buffer and
// Lambert + rim shading. It runs headless in Node, so ChatGPT can request a
// screenshot of the project at any time without a GPU or browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { encodePng } from '../algorithms/bake.mjs';
import { boundingBox, computeNormals, triangleCount, vertexCount } from './geometry.mjs';
import { writeGltf } from './gltf.mjs';
import { fail } from './util.mjs';

function safeFilename(name) {
  return String(name ?? 'model')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

/**
 * Export objects to GLB/glTF.
 */
export async function exportModel(project, objects, {
  format = 'glb',
  path: target = null,
  includeAnimations = true,
  filename = null,
  exportsRoot,
} = {}) {
  if (!objects || objects.length === 0) fail('object_not_found', 'No objects selected for export', { status: 404 });
  const writable = objects.map((object) => {
    const geometry = project.getGeometry(object);
    if (vertexCount(geometry) === 0) return null;
    return {
      id: object.id,
      name: object.name,
      geometry: {
        ...geometry,
        indices: geometry.indices.length ? geometry.indices : new Uint32Array(Array.from({ length: vertexCount(geometry) }, (_, i) => i)),
      },
      materialId: object.materialId,
      transform: object.transform,
    };
  }).filter(Boolean);
  if (!writable.length) fail('empty_geometry', 'Selected objects have no geometry', { status: 409 });

  const { buffer } = await writeGltf(project, writable, { includeAnimations });
  const extension = format === 'gltf' ? '.glb' : '.glb';
  const defaultName = filename ?? `${safeFilename(project.data.name)}${extension}`;
  const directory = target && !target.endsWith('.glb') && !target.endsWith('.gltf')
    ? path.resolve(target)
    : target
      ? path.dirname(path.resolve(target))
      : path.join(exportsRoot ?? path.join(project.dir, 'exports'));
  const file = target
    ? (target.endsWith('.glb') || target.endsWith('.gltf') ? path.resolve(target) : path.join(path.resolve(target), defaultName))
    : path.join(directory, defaultName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  const stat = await fs.stat(file);
  return {
    format,
    path: file,
    bytes: stat.size,
    objects: writable.map((o) => ({ name: o.name, triangles: triangleCount(o.geometry), vertices: vertexCount(o.geometry) })),
    animations: includeAnimations ? Object.keys(project.data.animations ?? {}).length : 0,
  };
}

// --- preview renderer -------------------------------------------------------

const VIEW_ANGLES = {
  'three-quarter': { yaw: -35, pitch: 18 },
  front: { yaw: 0, pitch: 0 },
  side: { yaw: 90, pitch: 0 },
  top: { yaw: 0, pitch: 85 },
  back: { yaw: 180, pitch: 0 },
};

export function renderPreview(project, objects, { width = 768, height = 768, view = 'three-quarter', path: target = null, background = 'studio', shadows = true } = {}) {
  const scene = [];
  for (const object of objects) {
    const geometry = project.getGeometry(object);
    if (vertexCount(geometry) === 0) continue;
    const material = project.data.materials[object.materialId] ?? { baseColorFactor: [0.75, 0.78, 0.8, 1], roughnessFactor: 0.6 };
    scene.push({ geometry, material, transform: object.transform, name: object.name });
  }
  if (!scene.length) fail('empty_geometry', 'Nothing to render', { status: 409 });

  const { yaw, pitch } = VIEW_ANGLES[view] ?? VIEW_ANGLES['three-quarter'];
  const yawRad = (yaw * Math.PI) / 180;
  // positive pitch = camera above the horizon looking down
  const pitchRad = (-pitch * Math.PI) / 180;
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const cosP = Math.cos(pitchRad);
  const sinP = Math.sin(pitchRad);

  // World-space vertices (object transforms applied) and scene bounds.
  const worldVerts = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const item of scene) {
    const p = item.geometry.positions;
    const t = item.transform?.translation ?? [0, 0, 0];
    const s = item.transform?.scale ?? [1, 1, 1];
    // Rotation matters: an object turned 90° in VR used to render axis-aligned.
    const euler = item.transform?.rotation ?? [0, 0, 0];
    const rot = eulerRotation(euler);
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const sx = p[i] * s[0];
      const sy = p[i + 1] * s[1];
      const sz = p[i + 2] * s[2];
      const x = rot[0] * sx + rot[1] * sy + rot[2] * sz + t[0];
      const y = rot[3] * sx + rot[4] * sy + rot[5] * sz + t[1];
      const z = rot[6] * sx + rot[7] * sy + rot[8] * sz + t[2];
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
      if (x < bounds.min[0]) bounds.min[0] = x;
      if (y < bounds.min[1]) bounds.min[1] = y;
      if (z < bounds.min[2]) bounds.min[2] = z;
      if (x > bounds.max[0]) bounds.max[0] = x;
      if (y > bounds.max[1]) bounds.max[1] = y;
      if (z > bounds.max[2]) bounds.max[2] = z;
    }
    worldVerts.push(out);
  }
  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    1e-3,
  ) * 0.5;
  const floorY = bounds.min[1] - radius * 0.004;

  const fov = 0.86;
  // Frame the bounding sphere with a small margin instead of leaving the model
  // as a speck in a huge grid (the previous 1.62 factor over-zoomed out).
  const distance = (radius / Math.tan(fov / 2)) * 1.12;
  const scale = (0.5 * Math.min(width, height)) / Math.tan(fov / 2);

  const rotate = (x, y, z) => {
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    const x1 = dx * cosY - dz * sinY;
    const z1 = dx * sinY + dz * cosY;
    const y2 = dy * cosP - z1 * sinP;
    const z2 = dy * sinP + z1 * cosP;
    return [x1, y2, z2];
  };
  const projectPoint = (x, y, z) => {
    const [x1, y2, z2] = rotate(x, y, z);
    const depth = z2 + distance;
    if (depth <= 1e-4) return { x: 0, y: 0, z: -1 };
    return { x: width / 2 + (x1 * scale) / depth, y: height / 2 - (y2 * scale) / depth, z: depth };
  };

  // ---- shadow map (orthographic directional light) ----
  const lightDir = normalize([-0.55, 1.0, 0.75]); // direction *towards* the light
  const right = normalize(cross(lightDir, [0, 1, 0]));
  const up = normalize(cross(right, lightDir));
  const SHADOW_RES = 512;
  const shadowDepth = new Float32Array(SHADOW_RES * SHADOW_RES).fill(Infinity);
  const shadowExtent = radius * 1.35;
  const lightU = (x, y, z) => (x - center[0]) * right[0] + (y - center[1]) * right[1] + (z - center[2]) * right[2];
  const lightV = (x, y, z) => (x - center[0]) * up[0] + (y - center[1]) * up[1] + (z - center[2]) * up[2];
  const lightD = (x, y, z) => (x - center[0]) * lightDir[0] + (y - center[1]) * lightDir[1] + (z - center[2]) * lightDir[2];
  if (shadows) {
    for (let s = 0; s < scene.length; s += 1) {
      const geo = scene[s].geometry;
      const pos = worldVerts[s];
      for (let i = 0; i < geo.indices.length; i += 3) {
        const ids = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
        const us = ids.map((id) => ((lightU(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]) / shadowExtent) * 0.5 + 0.5) * SHADOW_RES);
        const vs = ids.map((id) => ((lightV(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]) / shadowExtent) * 0.5 + 0.5) * SHADOW_RES);
        const ds = ids.map((id) => lightD(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]));
        const minX = Math.max(0, Math.floor(Math.min(...us)));
        const maxX = Math.min(SHADOW_RES - 1, Math.ceil(Math.max(...us)));
        const minY = Math.max(0, Math.floor(Math.min(...vs)));
        const maxY = Math.min(SHADOW_RES - 1, Math.ceil(Math.max(...vs)));
        const area = (us[1] - us[0]) * (vs[2] - vs[0]) - (us[2] - us[0]) * (vs[1] - vs[0]);
        if (Math.abs(area) < 1e-9) continue;
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const px = x + 0.5;
            const py = y + 0.5;
            const w0 = ((us[1] - px) * (vs[2] - py) - (us[2] - px) * (vs[1] - py)) / area;
            const w1 = ((us[2] - px) * (vs[0] - py) - (us[0] - px) * (vs[2] - py)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const d = w0 * ds[0] + w1 * ds[1] + w2 * ds[2];
            const idx = y * SHADOW_RES + x;
            if (d < shadowDepth[idx]) shadowDepth[idx] = d;
          }
        }
      }
    }
  }
  const shadowAt = (x, y, z) => {
    if (!shadows) return 1;
    const u = Math.floor(((lightU(x, y, z) / shadowExtent) * 0.5 + 0.5) * SHADOW_RES);
    const v = Math.floor(((lightV(x, y, z) / shadowExtent) * 0.5 + 0.5) * SHADOW_RES);
    if (u < 0 || v < 0 || u >= SHADOW_RES || v >= SHADOW_RES) return 1;
    const d = lightD(x, y, z);
    let lit = 0;
    let samples = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const uu = u + dx;
        const vv = v + dy;
        if (uu < 0 || vv < 0 || uu >= SHADOW_RES || vv >= SHADOW_RES) continue;
        samples += 1;
        const stored = shadowDepth[vv * SHADOW_RES + uu];
        if (stored === Infinity || d - 0.012 * radius <= stored) lit += 1;
      }
    }
    return samples ? lit / samples : 1;
  };

  // ---- buffers ----
  const color = new Float32Array(width * height * 3);
  const depthBuffer = new Float32Array(width * height).fill(Infinity);

  for (let y = 0; y < height; y += 1) {
    const t = y / height;
    const r = background === 'studio' ? 0.045 + 0.035 * (1 - t) : 0.01;
    const g = background === 'studio' ? 0.052 + 0.045 * (1 - t) : 0.012;
    const b = background === 'studio' ? 0.062 + 0.075 * (1 - t) : 0.016;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      color[i] = r;
      color[i + 1] = g;
      color[i + 2] = b;
    }
  }

  // ---- floor with grid + shadow ----
  {
    const ext = radius * 2.1;
    const step = Math.pow(10, Math.round(Math.log10(radius) * 2) / 2) / 2 || 0.1;
    const floorBase = [0.052, 0.07, 0.08];
    const gridCol = [0.1, 0.2, 0.2];
    const camX = center[0] - distance * cosP * sinY;
    const camY = center[1] - distance * sinP;
    const camZ = center[2] - distance * cosP * cosY;
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const vx = ((px + 0.5) - width / 2) / scale;
        const vy = -((py + 0.5) - height / 2) / scale;
        const vz = 1;
        // view -> world direction
        const wy2 = vy * cosP + vz * sinP;
        const wz2 = -vy * sinP + vz * cosP;
        const wx = vx * cosY + wz2 * sinY;
        const wy = wy2;
        const wz = -vx * sinY + wz2 * cosY;
        if (wy >= -1e-5) continue;
        const t = (floorY - camY) / wy;
        if (t <= 0) continue;
        const hx = camX + wx * t;
        const hz = camZ + wz * t;
        if (Math.abs(hx - center[0]) > ext || Math.abs(hz - center[2]) > ext) continue;
        const idx = py * width + px;
        const depth = t;
        if (depth >= depthBuffer[idx]) continue;
        depthBuffer[idx] = depth;
        const shadow = shadowAt(hx, floorY + 1e-3, hz);
        const gx = Math.abs(((hx / step) % 1 + 1) % 1);
        const gz = Math.abs(((hz / step) % 1 + 1) % 1);
        const lineW = Math.max(0.004, 0.25 / (t * 40));
        const line = gx < lineW || gz < lineW;
        const dist = Math.hypot(hx - center[0], hz - center[2]);
        const fade = Math.max(0, 1 - dist / (ext * 1.02)) ** 1.4;
        const base = line ? gridCol : floorBase;
        const shade = 0.35 + 0.75 * shadow;
        for (let k = 0; k < 3; k += 1) {
          const floorValue = base[k] * shade * (0.6 + 0.8 * fade);
          color[idx * 3 + k] = color[idx * 3 + k] * (1 - fade) + floorValue * fade;
        }
      }
    }
  }

  // ---- meshes ----
  let trianglesDrawn = 0;
  const fill = normalize([0.65, 0.25, 0.55]);
  for (let s = 0; s < scene.length; s += 1) {
    const item = scene[s];
    const geo = item.geometry;
    const positions = worldVerts[s];
    const base = item.material.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    const metallic = item.material.metallicFactor ?? 0;
    const roughness = item.material.roughnessFactor ?? 0.6;
    const emissive = item.material.emissiveFactor ?? [0, 0, 0];

    for (let i = 0; i < geo.indices.length; i += 3) {
      const ia = geo.indices[i];
      const ib = geo.indices[i + 1];
      const ic = geo.indices[i + 2];
      const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
      const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
      const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
      const pa = projectPoint(ax, ay, az);
      const pb = projectPoint(bx, by, bz);
      const pc = projectPoint(cx, cy, cz);
      if (pa.z <= 0 || pb.z <= 0 || pc.z <= 0) continue;
      const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
      if (area >= -1e-9) continue; // backface cull
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
      const centroid = [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3];
      const lambert = Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);
      const shadow = shadowAt(centroid[0] + nx * 0.006, centroid[1] + ny * 0.006, centroid[2] + nz * 0.006);
      const fillTerm = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]) * 0.25;
      // view-space normal for rim + specular
      const [vnx, vny, vnz] = rotate(nx + center[0], ny + center[1], nz + center[2]).map((v, k) => v - [0, 0, 0][k]);
      void vnx; void vny;
      const rim = Math.pow(1 - Math.min(1, Math.abs(vnz)), 2.6) * 0.5;
      const shininess = 4 + (1 - roughness) * 90;
      const specular = Math.pow(lambert, shininess) * (0.18 + metallic * 1.1) * (0.35 + 0.65 * shadow);
      const ambient = 0.16 + 0.1 * (1 - roughness);
      const shadeValue = ambient + lambert * 0.95 * shadow + fillTerm * (0.4 + 0.6 * shadow);

      const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
      const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
      if (maxX < minX || maxY < minY) continue;
      trianglesDrawn += 1;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((pb.x - px) * (pc.y - py) - (pc.x - px) * (pb.y - py)) / area;
          const w1 = ((pc.x - px) * (pa.y - py) - (pa.x - px) * (pc.y - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pa.z + w1 * pb.z + w2 * pc.z;
          const idx = y * width + x;
          if (z >= depthBuffer[idx]) continue;
          depthBuffer[idx] = z;
          const c = idx * 3;
          color[c] = base[0] * shadeValue + specular + emissive[0] * 0.9 + rim * 0.12;
          color[c + 1] = base[1] * shadeValue + specular * 0.98 + emissive[1] * 0.9 + rim * 0.2;
          color[c + 2] = base[2] * shadeValue + specular * 0.95 + emissive[2] * 0.9 + rim * 0.32;
        }
      }
    }
  }

  // tonemap + gamma
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = Math.max(0, color[i * 3 + k]);
      const mapped = v / (1 + v * 0.55);
      const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * Math.pow(mapped, 1 / 2.4) - 0.055;
      rgba[i * 4 + k] = Math.max(0, Math.min(255, Math.round(srgb * 255)));
    }
    rgba[i * 4 + 3] = 255;
  }
  const png = encodePng({ width, height, rgba });
  const outPath = target ?? path.join(project.dir, 'previews', `preview-${view}-${Date.now()}.png`);
  return { path: outPath, bytes: 0, trianglesDrawn, png, width, height, generator: 'software-rasteriser' };
}

/** Euler XYZ rotation (degrees) to a 3x3 row-major matrix. */
function eulerRotation(euler) {
  const [rx, ry, rz] = euler.map((d) => (Number(d) || 0) * (Math.PI / 180));
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cy * cz, cy * sz, -sy,
    sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
    cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
  ];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Render and write to disk. */
export async function renderPreviewToFile(project, objects, options) {
  const result = renderPreview(project, objects, options);
  await fs.mkdir(path.dirname(result.path), { recursive: true });
  await fs.writeFile(result.path, result.png);
  const stat = await fs.stat(result.path);
  const { png, ...rest } = result;
  void png;
  return { ...rest, bytes: stat.size, base64: options?.inline ? Buffer.from(stat.size ? await fs.readFile(result.path) : '').toString('base64') : undefined };
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export { boundingBox };
