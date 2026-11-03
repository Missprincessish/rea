// Image-based 3D reconstruction.
//
// Two real, well-understood algorithms are implemented here:
//   1. Silhouette extraction (alpha channel or border flood fill).
//   2. Visual-hull carving over a voxel grid using 2D signed distance fields of
//      each view's silhouette, meshed with marching cubes.
//
// With a single image the hull is a smoothed extrusion; each additional view at
// a known yaw angle carves the volume tighter. There is no learned prior, so the
// result is a shape envelope, not a semantic reconstruction. This is documented
// explicitly in docs/RESEARCH.md and surfaced in the API response.
import { marchingCubes } from '../vendor/marchingcubes.mjs';
import {
  compactVertices,
  computeNormals,
  makeGeometry,
  removeDegenerateTriangles,
  removeDuplicateTriangles,
  vertexCount,
  weldVertices,
} from '../core/geometry.mjs';
import { fillHoles, flipNormals } from './repair.mjs';
import { signedVolume } from './sdf.mjs';
import { fail } from '../core/util.mjs';
import { decodeImage } from './bake.mjs';

/**
 * Extract a boolean mask from an image.
 * @param {{width:number,height:number,rgba:Uint8Array}} image
 */
export function extractMask(image, { mode = 'auto', threshold = 0.12, floodTolerance = 0.08 } = {}) {
  const { width, height, rgba } = image;
  const mask = new Uint8Array(width * height);
  let usedAlpha = false;
  if (mode === 'alpha' || mode === 'auto') {
    let transparent = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) transparent += 1;
    if (transparent > width * height * 0.01) {
      usedAlpha = true;
      for (let i = 0; i < width * height; i += 1) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
    }
    if (mode === 'alpha' && !usedAlpha) {
      fail('mask_failed', 'Image has no meaningful alpha channel; use mode "flood"', { status: 422 });
    }
  }
  if (!usedAlpha) {
    // Border flood fill: treat connected regions similar to the border colour as background.
    const background = [0, 0, 0];
    let samples = 0;
    for (let x = 0; x < width; x += 1) {
      for (const y of [0, height - 1]) {
        const o = (y * width + x) * 4;
        background[0] += rgba[o];
        background[1] += rgba[o + 1];
        background[2] += rgba[o + 2];
        samples += 1;
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (const x of [0, width - 1]) {
        const o = (y * width + x) * 4;
        background[0] += rgba[o];
        background[1] += rgba[o + 1];
        background[2] += rgba[o + 2];
        samples += 1;
      }
    }
    for (let k = 0; k < 3; k += 1) background[k] /= Math.max(1, samples);
    const visited = new Uint8Array(width * height);
    const stack = [];
    for (let x = 0; x < width; x += 1) {
      stack.push([x, 0], [x, height - 1]);
    }
    for (let y = 0; y < height; y += 1) {
      stack.push([0, y], [width - 1, y]);
    }
    const similar = (i) => {
      const o = i * 4;
      const d = Math.hypot(
        (rgba[o] - background[0]) / 255,
        (rgba[o + 1] - background[1]) / 255,
        (rgba[o + 2] - background[2]) / 255,
      );
      return d < floodTolerance || rgba[o + 3] < 128;
    };
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = y * width + x;
      if (visited[i]) continue;
      visited[i] = 1;
      if (!similar(i)) continue;
      mask[i] = 0;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    for (let i = 0; i < width * height; i += 1) if (!visited[i]) mask[i] = 1;
  }

  // keep the largest connected foreground component to drop stray pixels
  const cleaned = largestComponent(mask, width, height);
  let count = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!cleaned[y * width + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  void threshold;
  if (count < 32) fail('mask_failed', 'Could not isolate the subject from the background; supply a transparent PNG or increase contrast', { status: 422 });
  return {
    mask: cleaned,
    width,
    height,
    bbox: { minX, maxX, minY, maxY },
    coverage: Number((count / (width * height)).toFixed(4)),
    usedAlpha,
  };
}

function largestComponent(mask, width, height) {
  const labels = new Uint8Array(width * height);
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  const sizes = [0];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    let size = 0;
    const stack = [start];
    labels[start] = label;
    while (stack.length) {
      const i = stack.pop();
      size += 1;
      const x = i % width;
      const y = (i - x) / width;
      const neighbors = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const n of neighbors) {
        if (n < 0 || labels[n] || !mask[n]) continue;
        labels[n] = label;
        stack.push(n);
      }
    }
    sizes.push(size);
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) out[i] = labels[i] === bestLabel ? 1 : 0;
  return out;
}

/** Exact 2D signed distance field of a mask (Felzenszwalb squared EDT). */
export function maskSignedDistance(mask, width, height) {
  const INF = 1e20;
  const inside = new Float64Array(width * height).fill(INF);
  const outside = new Float64Array(width * height).fill(INF);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) inside[i] = 0;
    else outside[i] = 0;
  }
  const edt = (grid) => {
    // columns then rows
    const f = new Float64Array(Math.max(width, height));
    const d = new Float64Array(Math.max(width, height));
    const v = new Int32Array(Math.max(width, height));
    const z = new Float64Array(Math.max(width, height) + 1);
    const transform1d = (n) => {
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < n; q += 1) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k -= 1;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q += 1) {
        while (z[k + 1] < q) k += 1;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    const temp = new Float64Array(width * height);
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) f[y] = grid[y * width + x];
      transform1d(height);
      for (let y = 0; y < height; y += 1) temp[y * width + x] = d[y];
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) f[x] = temp[y * width + x];
      transform1d(width);
      for (let x = 0; x < width; x += 1) temp[y * width + x] = d[x];
    }
    return temp;
  };
  const insideDist = edt(inside);
  const outsideDist = edt(outside);
  const out = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    out[i] = Math.sqrt(insideDist[i]) - Math.sqrt(outsideDist[i]);
  }
  return out;
}

/**
 * Carve a visual hull from one or more views.
 *
 * @param {Array<{image:object, angle:number, weight?:number}>} views
 *   angle is the yaw (degrees) the object is rotated by for that view.
 * @param {object} options resolution, symmetry, smoothing
 */
export function visualHull(views, { resolution = 96, symmetry = false, padding = 0.04, smoothIterations = 1 } = {}) {
  if (!views.length) fail('invalid_argument', 'At least one view is required');
  const prepared = views.map((view) => {
    const mask = view.mask ?? extractMask(view.image).mask;
    const { width, height } = view.image;
    const sdf = maskSignedDistance(mask, width, height);
    return {
      sdf,
      mask,
      width,
      height,
      angle: (view.angle ?? 0) * (Math.PI / 180),
      bbox: view.bbox ?? computeBBox(mask, width, height),
    };
  });

  const res = Math.max(16, Math.min(160, Math.round(resolution)));
  // World height = 1 unit ([0, 1]); each view's silhouette bbox defines its scale.
  const front = prepared[0];
  const frontH = Math.max(1, front.bbox.maxY - front.bbox.minY);
  const frontW = Math.max(1, front.bbox.maxX - front.bbox.minX);
  const halfWidth = ((frontW / frontH) || 0.6) * 0.5;
  const depthGuess = Math.max(0.25, halfWidth * 1.1);
  const pad = Math.max(padding, 0.08);
  const min = [-halfWidth - pad, -pad, -depthGuess - pad];
  const max = [halfWidth + pad, 1 + pad, depthGuess + pad];
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const dims = span.map((s) => Math.max(16, Math.round((s / Math.max(...span)) * res)));
  const h = [span[0] / (dims[0] - 1), span[1] / (dims[1] - 1), span[2] / (dims[2] - 1)];
  const singleView = prepared.length === 1;

  const sampleView = (view, wx, wy, wz) => {
    const ca = Math.cos(-view.angle);
    const sa = Math.sin(-view.angle);
    const rx = wx * ca - wz * sa;
    const rz = wx * sa + wz * ca;
    const { bbox } = view;
    const vH = Math.max(1, bbox.maxY - bbox.minY);
    const vW = Math.max(1, bbox.maxX - bbox.minX);
    const vHalfW = (vW / vH) * 0.5;
    const u = (rx / Math.max(1e-6, vHalfW)) * 0.5 + 0.5;
    const imageX = bbox.minX + u * vW;
    const imageY = bbox.maxY - wy * vH;
    const d2d = sampleSdf(view.sdf, view.width, view.height, imageX, imageY) / vH;
    if (singleView) {
      // Single-view silhouettes have no depth constraint; cap thickness smoothly
      // from local medial distance so the result is a closed, rounded 3D hull.
      const halfDepth = Math.min(depthGuess * 0.85, Math.max(0, -d2d) * 1.15 + 0.03);
      const dz = Math.abs(rz) - halfDepth;
      return Math.hypot(Math.max(0, d2d), Math.max(0, dz)) + Math.min(0, Math.max(d2d, dz));
    }
    return Math.max(d2d, Math.abs(rz) - depthGuess);
  };

  const field = (x, y, z) => {
    const sx = symmetry ? Math.abs(x) : x;
    // Visual hull = intersection of view cones (max over signed distances).
    let worst = -Infinity;
    for (const view of prepared) {
      const d = sampleView(view, sx, y, z);
      if (d > worst) worst = d;
    }
    // Keep the zero level-set strictly inside the grid box so marching cubes closes cleanly.
    const boxCap = Math.max(
      (min[0] + h[0]) - x,
      x - (max[0] - h[0]),
      (min[1] + h[1]) - y,
      y - (max[1] - h[1]),
      (min[2] + h[2]) - z,
      z - (max[2] - h[2]),
    );
    return Math.max(worst, boxCap);
  };

  const mesh = marchingCubes(dims, field, [min, max]);
  if (!mesh || mesh.cells.length === 0) {
    fail('reconstruction_failed', 'Visual hull is empty; check the masks and view angles', { status: 422 });
  }
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
  let out = weldVertices(makeGeometry(positions, indices), 1e-6);
  out = compactVertices(removeDuplicateTriangles(removeDegenerateTriangles(out)));
  const filled = fillHoles(out, { maxHoleVertices: 16 });
  out = filled.geometry ?? filled;
  if (signedVolume(out) < 0) out = flipNormals(out);
  out.normals = computeNormals(out.positions, out.indices);
  out.uvs = new Float32Array(vertexCount(out) * 2);
  return {
    ...out,
    stats: {
      views: prepared.length,
      resolution: dims,
      triangles: out.indices.length / 3,
      vertices: vertexCount(out),
      worldBounds: { min, max },
      gridSpacing: Number(Math.min(...h).toFixed(5)),
      smoothIterations,
    },
    camera: { halfWidth, depthGuess, bounds: { min, max } },
  };
}

function computeBBox(mask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return { minX: 0, maxX: width - 1, minY: 0, maxY: height - 1 };
  return { minX, maxX, minY, maxY };
}

function sampleSdf(sdf, width, height, x, y) {
  const xi = Math.max(0, Math.min(width - 1, x));
  const yi = Math.max(0, Math.min(height - 1, y));
  const extra = Math.hypot(x - xi, y - yi);
  const x0 = Math.floor(xi);
  const y0 = Math.floor(yi);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = xi - x0;
  const ty = yi - y0;
  const a = sdf[y0 * width + x0] * (1 - tx) + sdf[y0 * width + x1] * tx;
  const b = sdf[y1 * width + x0] * (1 - tx) + sdf[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty + extra;
}

/**
 * Sample per-vertex colours from a view image (front projection).
 * Returns Float32Array of linear-ish RGB per vertex.
 */
export function projectVertexColors(geo, image, camera) {
  const { halfWidth } = camera;
  const maskResult = extractMask(image);
  const { bbox } = maskResult;
  const vc = vertexCount(geo);
  const colors = new Float32Array(vc * 3).fill(0.7);
  let hits = 0;
  for (let v = 0; v < vc; v += 1) {
    const wx = geo.positions[v * 3];
    const wy = geo.positions[v * 3 + 1];
    const wz = geo.positions[v * 3 + 2];
    const height01 = Math.max(0, Math.min(1, wy));
    const u = (wx / Math.max(1e-6, halfWidth)) * 0.5 + 0.5;
    const facing = wz;
    if (u < 0 || u > 1) continue;
    const imageX = bbox.minX + u * (bbox.maxX - bbox.minX);
    const imageY = bbox.maxY - height01 * (bbox.maxY - bbox.minY);
    const xi = Math.round(imageX);
    const yi = Math.round(imageY);
    if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) continue;
    const o = (yi * image.width + xi) * 4;
    const alpha = image.rgba[o + 3] / 255;
    if (alpha < 0.1) continue;
    void facing;
    colors[v * 3] = image.rgba[o] / 255;
    colors[v * 3 + 1] = image.rgba[o + 1] / 255;
    colors[v * 3 + 2] = image.rgba[o + 2] / 255;
    hits += 1;
  }
  return { colors, stats: { vertices: vc, sampled: hits, coverage: Number((hits / Math.max(1, vc)).toFixed(3)) } };
}

export { decodeImage };
