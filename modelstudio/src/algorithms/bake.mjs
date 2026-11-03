// Texture baking on the CPU: rasterise triangles into UV space and evaluate a
// shader per texel. Produces base colour, ambient occlusion and normal maps.
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { computeNormals, triangleCount, vertexCount } from '../core/geometry.mjs';
import { fail } from '../core/util.mjs';

// --- PNG encoding -----------------------------------------------------------

export function encodePng({ width, height, rgba }) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  return PNG.sync.write(png, { colorType: 6 });
}

export function decodePng(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, rgba: new Uint8Array(png.data) };
}

/** Parse a PNG or JPEG upload into raw RGBA. */
export async function decodeImage(bytes, mimeType = 'image/png') {
  const buf = Buffer.from(bytes);
  if (mimeType.includes('jpeg') || mimeType.includes('jpg') || buf.slice(0, 2).toString('hex') === 'ffd8') {
    const jpeg = await import('jpeg-js');
    const decoded = (jpeg.default ?? jpeg).decode(buf, { useTArray: true });
    return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data) };
  }
  return decodePng(buf);
}

// --- rasteriser -------------------------------------------------------------

/**
 * Rasterise the mesh in UV space and call `shade(px, py, z)` for each covered
 * texel, where z is a barycentric-ish depth used for z-buffering.
 */
export function rasterizeUV(geo, size, shade, { dilation = 2 } = {}) {
  const vc = vertexCount(geo);
  if (geo.uvs.length !== vc * 2) fail('missing_uvs', 'Mesh has no UV coordinates; run project-uv first', { status: 409 });
  const width = size;
  const height = size;
  const color = new Float64Array(width * height * 3);
  const alpha = new Float64Array(width * height);
  const depth = new Float64Array(width * height).fill(-Infinity);
  const normalsOut = new Float64Array(width * height * 3);
  let covered = 0;

  for (let i = 0; i < geo.indices.length; i += 3) {
    const ia = geo.indices[i];
    const ib = geo.indices[i + 1];
    const ic = geo.indices[i + 2];
    const ax = geo.uvs[ia * 2] * width;
    const ay = (1 - geo.uvs[ia * 2 + 1]) * height;
    const bx = geo.uvs[ib * 2] * width;
    const by = (1 - geo.uvs[ib * 2 + 1]) * height;
    const cx = geo.uvs[ic * 2] * width;
    const cy = (1 - geo.uvs[ic * 2 + 1]) * height;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    if (maxX < minX || maxY < minY) continue;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const idx = y * width + x;
        const z = w0 * 0.3 + w1 * 0.5 + w2 * 0.7;
        const shaded = shade({ w0, w1, w2, ia, ib, ic, triangle: i / 3, x, y, u: (x + 0.5) / width, v: 1 - (y + 0.5) / height });
        if (shaded.depth !== undefined && shaded.depth <= depth[idx]) continue;
        if (shaded.depth !== undefined) depth[idx] = shaded.depth;
        else if (z < depth[idx]) continue;
        else depth[idx] = z;
        if (alpha[idx] === 0) covered += 1;
        color[idx * 3] = shaded.color[0];
        color[idx * 3 + 1] = shaded.color[1];
        color[idx * 3 + 2] = shaded.color[2];
        alpha[idx] = shaded.alpha ?? 1;
        if (shaded.normal) {
          normalsOut[idx * 3] = shaded.normal[0];
          normalsOut[idx * 3 + 1] = shaded.normal[1];
          normalsOut[idx * 3 + 2] = shaded.normal[2];
        }
      }
    }
  }

  // Dilation: fill empty texels from covered neighbours to avoid seam bleeding.
  if (dilation > 0) {
    for (let pass = 0; pass < dilation; pass += 1) {
      const nextAlpha = Float64Array.from(alpha);
      const nextColor = Float64Array.from(color);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x;
          if (alpha[idx] > 0) continue;
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const nidx = ny * width + nx;
              if (alpha[nidx] > 0) {
                r += color[nidx * 3];
                g += color[nidx * 3 + 1];
                b += color[nidx * 3 + 2];
                n += 1;
              }
            }
          }
          if (n > 0) {
            nextColor[idx * 3] = r / n;
            nextColor[idx * 3 + 1] = g / n;
            nextColor[idx * 3 + 2] = b / n;
            nextAlpha[idx] = 0.001;
          }
        }
      }
      for (let i = 0; i < alpha.length; i += 1) {
        alpha[i] = nextAlpha[i] > 0 && alpha[i] === 0 ? 1 : alpha[i];
      }
      color.set(nextColor);
    }
  }

  return { width, height, color, alpha, covered, coverage: covered / (width * height) };
}

function toRgba({ width, height, color, alpha }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = Math.max(0, Math.min(255, Math.round(srgb(color[i * 3]) * 255)));
    rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(srgb(color[i * 3 + 1]) * 255)));
    rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(srgb(color[i * 3 + 2]) * 255)));
    rgba[i * 4 + 3] = 255;
    void alpha;
  }
  return rgba;
}

const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);

// --- ambient occlusion ------------------------------------------------------

/** Ray-cast ambient occlusion against the mesh itself (BVH-free, sampled). */
export function ambientOcclusion(geo, { samples = 24, maxDistance = 0.4, strength = 1.4, seed = 3 } = {}) {
  const vc = vertexCount(geo);
  const normals = geo.normals.length === vc * 3 ? geo.normals : computeNormals(geo.positions, geo.indices);
  const grid = buildTriangleGrid(geo, normals);
  const random = mulberry(seed);
  const ao = new Float32Array(vc).fill(1);
  const p = geo.positions;
  for (let v = 0; v < vc; v += 1) {
    const nx = normals[v * 3];
    const ny = normals[v * 3 + 1];
    const nz = normals[v * 3 + 2];
    const [t0, t1] = tangentFrame(nx, ny, nz);
    let occluded = 0;
    for (let s = 0; s < samples; s += 1) {
      const r1 = random();
      const r2 = random();
      const theta = Math.acos(Math.sqrt(1 - r1 * 0.995));
      const phi = 2 * Math.PI * r2;
      const dx = Math.cos(phi) * Math.sin(theta);
      const dy = Math.sin(phi) * Math.sin(theta);
      const dz = Math.cos(theta);
      const dirX = t0[0] * dx + t1[0] * dy + nx * dz;
      const dirY = t0[1] * dx + t1[1] * dy + ny * dz;
      const dirZ = t0[2] * dx + t1[2] * dy + nz * dz;
      const ox = p[v * 3] + nx * 1e-3;
      const oy = p[v * 3 + 1] + ny * 1e-3;
      const oz = p[v * 3 + 2] + nz * 1e-3;
      if (anyHit(grid, ox, oy, oz, dirX, dirY, dirZ, maxDistance)) occluded += 1 - dz * 0.5;
    }
    const value = 1 - (occluded / samples) * strength;
    ao[v] = Math.max(0.12, Math.min(1, value));
  }
  return ao;
}

function tangentFrame(nx, ny, nz) {
  const helper = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let tx = helper[1] * nz - helper[2] * ny;
  let ty = helper[2] * nx - helper[0] * nz;
  let tz = helper[0] * ny - helper[1] * nx;
  const len = Math.hypot(tx, ty, tz) || 1;
  tx /= len;
  ty /= len;
  tz /= len;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;
  return [[tx, ty, tz], [bx, by, bz]];
}

function buildTriangleGrid(geo, normals) {
  const cell = 0.08;
  const cells = new Map();
  const p = geo.positions;
  const vn = (i) => [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
  const tris = [];
  for (let i = 0; i < geo.indices.length; i += 3) {
    const ia = geo.indices[i], ib = geo.indices[i + 1], ic = geo.indices[i + 2];
    const a = [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]];
    const b = [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]];
    const c = [p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]];
    const na = vn(ia), nb = vn(ib), nc = vn(ic);
    const tri = { a, b, c, na, nb, nc, min: [0, 0, 0], max: [0, 0, 0] };
    for (let k = 0; k < 3; k += 1) {
      tri.min[k] = Math.min(a[k], b[k], c[k]) - cell;
      tri.max[k] = Math.max(a[k], b[k], c[k]) + cell;
    }
    const index = tris.push(tri) - 1;
    for (let x = Math.floor(tri.min[0] / cell); x <= Math.floor(tri.max[0] / cell); x += 1) {
      for (let y = Math.floor(tri.min[1] / cell); y <= Math.floor(tri.max[1] / cell); y += 1) {
        for (let z = Math.floor(tri.min[2] / cell); z <= Math.floor(tri.max[2] / cell); z += 1) {
          const key = `${x},${y},${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(index);
        }
      }
    }
  }
  return { cells, tris, cell };
}

function anyHit(grid, ox, oy, oz, dx, dy, dz, maxDistance) {
  const { cells, tris, cell } = grid;
  const visited = new Set();
  let t = 0.002;
  while (t < maxDistance) {
    const x = Math.floor((ox + dx * t) / cell);
    const y = Math.floor((oy + dy * t) / cell);
    const z = Math.floor((oz + dz * t) / cell);
    const key = `${x},${y},${z}`;
    if (!visited.has(key)) {
      visited.add(key);
      const list = cells.get(key);
      if (list) {
        for (const index of list) {
          if (rayTriangle(ox, oy, oz, dx, dy, dz, tris[index])) return true;
        }
      }
    }
    t += cell * 0.7;
  }
  return false;
}

function rayTriangle(ox, oy, oz, dx, dy, dz, tri) {
  const e1x = tri.b[0] - tri.a[0], e1y = tri.b[1] - tri.a[1], e1z = tri.b[2] - tri.a[2];
  const e2x = tri.c[0] - tri.a[0], e2y = tri.c[1] - tri.a[1], e2z = tri.c[2] - tri.a[2];
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const tx = ox - tri.a[0], ty = oy - tri.a[1], tz = oz - tri.a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 1e-5;
}

function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- bakes ------------------------------------------------------------------

/**
 * Bake a base-colour texture from vertex AO + material colour (+ optional
 * procedural pattern and painted overlay).
 */
export function bakeBaseColor(geo, {
  size = 1024,
  baseColor = [0.8, 0.8, 0.8],
  ao = null,
  pattern = 'none',
  painted = null,
  roughnessHighlights = 0.15,
} = {}) {
  const aoValues = ao ?? ambientOcclusion(geo);
  const vc = vertexCount(geo);
  const raster = rasterizeUV(geo, size, ({ w0, w1, w2, ia, ib, ic, u, v }) => {
    const a = aoValues[ia] * w0 + aoValues[ib] * w1 + aoValues[ic] * w2;
    let tint = [1, 1, 1];
    let value = 1;
    if (pattern !== 'none') {
      const { tint: t, value: val } = proceduralPattern(pattern, u, v);
      tint = t;
      value = val;
    }
    let color = [baseColor[0] * tint[0], baseColor[1] * tint[1], baseColor[2] * tint[2]];
    color = color.map((c) => c * (0.55 + 0.45 * a) * value * (1 + roughnessHighlights * (a - 0.5)));
    if (painted) {
      const px = Math.min(painted.width - 1, Math.floor(u * painted.width));
      const py = Math.min(painted.height - 1, Math.floor((1 - v) * painted.height));
      const o = (py * painted.width + px) * 4;
      const alpha = painted.rgba[o + 3] / 255;
      if (alpha > 0.01) {
        const paintedColor = [painted.rgba[o] / 255, painted.rgba[o + 1] / 255, painted.rgba[o + 2] / 255];
        color = color.map((c, i) => c * (1 - alpha) + paintedColor[i] * alpha);
      }
    }
    return { color, alpha: 1 };
  });
  return { ...raster, png: encodePng({ width: size, height: size, rgba: toRgba(raster) }), aoValues };
}

/** Bake an AO map (grayscale in RGB). */
export function bakeAO(geo, { size = 1024, ao = null, strength = 1 } = {}) {
  const aoValues = ao ?? ambientOcclusion(geo);
  const raster = rasterizeUV(geo, size, ({ w0, w1, w2, ia, ib, ic }) => {
    const a = (aoValues[ia] * w0 + aoValues[ib] * w1 + aoValues[ic] * w2) ** strength;
    return { color: [a, a, a], alpha: 1 };
  });
  return { ...raster, png: encodePng({ width: size, height: size, rgba: toRgba(raster) }) };
}

/** Bake a tangent-space-ish normal map from the mesh normals. */
export function bakeNormal(geo, { size = 1024 } = {}) {
  const vc = vertexCount(geo);
  const normals = geo.normals.length === vc * 3 ? geo.normals : computeNormals(geo.positions, geo.indices);
  const raster = rasterizeUV(geo, size, ({ w0, w1, w2, ia, ib, ic }) => {
    const nx = normals[ia * 3] * w0 + normals[ib * 3] * w1 + normals[ic * 3] * w2;
    const ny = normals[ia * 3 + 1] * w0 + normals[ib * 3 + 1] * w1 + normals[ic * 3 + 1] * w2;
    const nz = normals[ia * 3 + 2] * w0 + normals[ib * 3 + 2] * w1 + normals[ic * 3 + 2] * w2;
    return { color: [nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5], alpha: 1, normal: [nx, ny, nz] };
  });
  return { ...raster, png: encodePng({ width: size, height: size, rgba: toRgba(raster) }) };
}

function proceduralPattern(pattern, u, v) {
  switch (pattern) {
    case 'wood': {
      const grain = Math.sin((u * 40 + Math.sin(v * 9) * 1.2) * Math.PI) * 0.5 + 0.5;
      const rings = Math.sin((v * 14 + grain * 0.6) * Math.PI * 2) * 0.5 + 0.5;
      const value = 0.8 + rings * 0.25;
      return { tint: [1.05, 0.95, 0.82], value };
    }
    case 'stone': {
      const n = noise2(u * 18, v * 18) * 0.5 + noise2(u * 60, v * 60) * 0.25;
      return { tint: [0.95, 0.95, 0.97], value: 0.82 + n * 0.4 };
    }
    case 'metal': {
      const brushed = noise2(u * 120, v * 6) * 0.3;
      return { tint: [1, 1, 1.02], value: 0.85 + brushed };
    }
    case 'fabric': {
      const weave = (Math.sin(u * 220) * Math.sin(v * 220)) * 0.12;
      return { tint: [1, 1, 1], value: 0.9 + weave };
    }
    case 'skin': {
      const blush = noise2(u * 8, v * 8) * 0.2;
      return { tint: [1 + blush * 0.1, 0.96 + blush * 0.02, 0.94], value: 0.97 + blush * 0.06 };
    }
    case 'crystal': {
      const facet = Math.abs(Math.sin(u * 12) + Math.cos(v * 10));
      return { tint: [0.9, 1, 1.05], value: 0.7 + facet * 0.5 };
    }
    default:
      return { tint: [1, 1, 1], value: 1 };
  }
}

function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const hash = (a, b) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Paint a round brush stroke directly into a texture image. */
export function paintStroke(image, stroke) {
  const { width, height, rgba } = image;
  const { x, y, radius = 0.05, color = [1, 0, 0], hardness = 0.6, opacity = 1, erase = false } = stroke;
  const cx = x * width;
  const cy = (1 - y) * height;
  const r = Math.max(1, radius * Math.max(width, height));
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(width - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(height - 1, Math.ceil(cy + r));
  const out = new Uint8Array(rgba);
  let touched = 0;
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / r;
      if (d > 1) continue;
      const falloff = d <= hardness ? 1 : 1 - (d - hardness) / (1 - hardness);
      const a = Math.min(1, falloff * opacity);
      const o = (py * width + px) * 4;
      if (erase) {
        out[o + 3] = Math.round(out[o + 3] * (1 - a));
      } else {
        out[o] = Math.round(out[o] * (1 - a) + color[0] * 255 * a);
        out[o + 1] = Math.round(out[o + 1] * (1 - a) + color[1] * 255 * a);
        out[o + 2] = Math.round(out[o + 2] * (1 - a) + color[2] * 255 * a);
        out[o + 3] = Math.max(out[o + 3], Math.round(a * 255));
      }
      touched += 1;
    }
  }
  return { width, height, rgba: out, touched };
}

export function solidImage(width, height, color = [1, 1, 1, 1]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = Math.round(Math.min(1, color[0]) * 255);
    rgba[i * 4 + 1] = Math.round(Math.min(1, color[1]) * 255);
    rgba[i * 4 + 2] = Math.round(Math.min(1, color[2]) * 255);
    rgba[i * 4 + 3] = Math.round((color[3] ?? 1) * 255);
  }
  return { width, height, rgba };
}

export { toRgba, triangleCount, zlib };
