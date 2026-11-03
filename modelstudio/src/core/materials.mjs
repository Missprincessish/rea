// Material and texture management on top of a project.
import { fail } from '../core/util.mjs';
import { decodeImage, encodePng, solidImage, paintStroke, toRgba, decodePng } from '../algorithms/bake.mjs';

export const MATERIAL_PRESETS = {
  skin: { baseColorFactor: [0.85, 0.68, 0.58, 1], roughnessFactor: 0.6, metallicFactor: 0, subsurfaceHint: 'shade' },
  hair: { baseColorFactor: [0.14, 0.1, 0.09, 1], roughnessFactor: 0.35, metallicFactor: 0.05 },
  fabric: { baseColorFactor: [0.22, 0.26, 0.34, 1], roughnessFactor: 0.92, metallicFactor: 0 },
  leather: { baseColorFactor: [0.24, 0.16, 0.12, 1], roughnessFactor: 0.55, metallicFactor: 0.05 },
  metal: { baseColorFactor: [0.72, 0.74, 0.78, 1], roughnessFactor: 0.22, metallicFactor: 0.95 },
  gold: { baseColorFactor: [0.86, 0.68, 0.28, 1], roughnessFactor: 0.28, metallicFactor: 1 },
  chrome: { baseColorFactor: [0.85, 0.87, 0.9, 1], roughnessFactor: 0.08, metallicFactor: 1 },
  wood: { baseColorFactor: [0.48, 0.32, 0.18, 1], roughnessFactor: 0.65, metallicFactor: 0 },
  stone: { baseColorFactor: [0.5, 0.5, 0.52, 1], roughnessFactor: 0.9, metallicFactor: 0 },
  ceramic: { baseColorFactor: [0.9, 0.9, 0.92, 1], roughnessFactor: 0.2, metallicFactor: 0.02 },
  glass: { baseColorFactor: [0.75, 0.88, 0.9, 0.35], roughnessFactor: 0.05, metallicFactor: 0, alphaMode: 'BLEND' },
  emissive: { baseColorFactor: [0.2, 0.9, 0.8, 1], roughnessFactor: 0.4, metallicFactor: 0, emissiveFactor: [0.3, 1, 0.85] },
  rubber: { baseColorFactor: [0.12, 0.12, 0.13, 1], roughnessFactor: 0.95, metallicFactor: 0 },
  crystal: { baseColorFactor: [0.45, 0.85, 0.95, 0.8], roughnessFactor: 0.05, metallicFactor: 0, alphaMode: 'BLEND' },
};

const EDITABLE = [
  'name',
  'baseColorFactor',
  'metallicFactor',
  'roughnessFactor',
  'emissiveFactor',
  'alphaMode',
  'doubleSided',
  'baseColorTexture',
  'emissiveStrength',
];

export function listMaterialPresets() {
  return Object.entries(MATERIAL_PRESETS).map(([id, value]) => ({ id, ...value }));
}

export function createMaterial(project, { preset = null, name = null, ...overrides } = {}) {
  const base = preset ? MATERIAL_PRESETS[preset] : {};
  if (preset && !base) fail('unknown_preset', `Unknown material preset "${preset}"`, { details: { available: Object.keys(MATERIAL_PRESETS) } });
  const { subsurfaceHint, ...clean } = base;
  void subsurfaceHint;
  const material = project.addMaterial({ ...clean, ...overrides, ...(name ? { name } : {}) });
  return material;
}

export function editMaterial(project, target, changes = {}) {
  const material = project.requireMaterial(target);
  const applied = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!EDITABLE.includes(key)) {
      fail('invalid_argument', `Material property "${key}" is not editable`, { details: { editable: EDITABLE } });
    }
    if (key === 'baseColorFactor' || key === 'emissiveFactor') {
      if (!Array.isArray(value) || value.length < 3) fail('invalid_argument', `${key} must be an array of 3-4 numbers`);
      material[key] = value.slice(0, 3).map(Number).concat(value[3] !== undefined ? [Number(value[3])] : key === 'baseColorFactor' ? [1] : []);
      applied[key] = material[key];
      continue;
    }
    if (key === 'metallicFactor' || key === 'roughnessFactor' || key === 'emissiveStrength') {
      material[key] = Math.max(0, Math.min(4, Number(value)));
      applied[key] = material[key];
      continue;
    }
    if (key === 'baseColorTexture') {
      if (value === null) {
        material.baseColorTexture = null;
      } else {
        const texture = project.data.textures[value] ?? Object.values(project.data.textures).find((t) => t.name === value);
        if (!texture) fail('texture_not_found', `No texture matches "${value}"`, { status: 404 });
        material.baseColorTexture = texture.id;
      }
      applied[key] = material.baseColorTexture;
      continue;
    }
    material[key] = value;
    applied[key] = value;
  }
  return { material, applied };
}

export function materialReport(project) {
  return Object.values(project.data.materials).map((m) => ({
    id: m.id,
    name: m.name,
    baseColorFactor: m.baseColorFactor,
    metallicFactor: m.metallicFactor,
    roughnessFactor: m.roughnessFactor,
    emissiveFactor: m.emissiveFactor,
    alphaMode: m.alphaMode,
    doubleSided: m.doubleSided,
    texture: m.baseColorTexture ? project.data.textures[m.baseColorTexture]?.name ?? m.baseColorTexture : null,
    usedBy: Object.values(project.data.objects).filter((o) => o.materialId === m.id).map((o) => o.name),
  }));
}

/** Create a texture from an uploaded image. */
export async function addImageTexture(project, { name, bytes, mimeType }) {
  const image = await decodeImage(bytes, mimeType);
  const texture = project.addTexture({
    name: name ?? 'upload',
    mimeType: 'image/png',
    data: encodePng(image),
    width: image.width,
    height: image.height,
  });
  return { texture, image };
}

export function addSolidTexture(project, { name = 'solid', color = [1, 1, 1, 1], size = 256 }) {
  const image = solidImage(size, size, color);
  const texture = project.addTexture({
    name,
    mimeType: 'image/png',
    data: encodePng(image),
    width: size,
    height: size,
  });
  return { texture, image };
}

/** Paint strokes onto an existing texture. Coordinates are UV space (0..1). */
export function paintTexture(project, textureIdOrName, strokes, { createIfMissing = null } = {}) {
  let texture = project.data.textures[textureIdOrName]
    ?? Object.values(project.data.textures).find((t) => t.name === textureIdOrName);
  if (!texture) {
    if (!createIfMissing) {
      fail('texture_not_found', `No texture matches "${textureIdOrName}"`, {
        status: 404,
        details: { available: Object.values(project.data.textures).map((t) => t.name) },
      });
    }
    texture = addSolidTexture(project, createIfMissing).texture;
  }
  let image = decodePng(Buffer.from(texture.data, 'base64'));
  let touched = 0;
  for (const stroke of strokes) {
    if (!Array.isArray(stroke.color) || stroke.color.length < 3) fail('invalid_argument', 'stroke.color must be [r,g,b] in 0..1');
    const result = paintStroke(image, stroke);
    touched += result.touched;
    image = { width: result.width, height: result.height, rgba: result.rgba };
  }
  texture.data = encodePng(image).toString?.('base64') ?? Buffer.from(encodePng(image)).toString('base64');
  texture.width = image.width;
  texture.height = image.height;
  texture.updatedAt = new Date().toISOString();
  return { texture, touched };
}

export function textureDataUrl(project, id) {
  const tex = project.data.textures[id];
  if (!tex) return null;
  return `data:${tex.mimeType};base64,${tex.data}`;
}

export { encodePng, decodePng, toRgba };
