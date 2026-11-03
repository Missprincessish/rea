// Project store: the single source of truth for both the browser editor and the
// programmatic interfaces. Everything mutating goes through `mutate()` so undo,
// revision counters and automatic saving stay consistent.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ModelStudioError,
  b64FromBytes,
  bytesFromB64,
  deepClone,
  fail,
  newId,
  nowIso,
} from './util.mjs';
import {
  boundingBox,
  cloneGeometry,
  deserializeGeometry,
  ensureGeometry,
  inspectGeometry,
  normalizeGeometry,
  recomputeNormals,
  serializeGeometry,
  triangleCount,
  vertexCount,
} from './geometry.mjs';
import { defaultWorld, normalizeWorld } from './world.mjs';

export const SCHEMA = 'modelstudio/project@1';
const HISTORY_LIMIT = 40;

export function resolveProjectsRoot() {
  return process.env.MODELSTUDIO_HOME
    ? path.resolve(process.env.MODELSTUDIO_HOME)
    : path.join(os.homedir(), 'ModelStudio');
}

export const PROJECTS_ROOT = resolveProjectsRoot();

export const EXPORTS_ROOT = process.env.MODELSTUDIO_EXPORTS
  ? path.resolve(process.env.MODELSTUDIO_EXPORTS)
  : path.join(PROJECTS_ROOT, 'exports');

export function defaultMaterial() {
  return {
    id: newId('mat'),
    name: 'Material',
    baseColorFactor: [0.8, 0.8, 0.82, 1],
    metallicFactor: 0.05,
    roughnessFactor: 0.55,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: null,
    alphaMode: 'OPAQUE',
    doubleSided: true,
  };
}

export function emptyProject(name = 'Untitled') {
  const created = nowIso();
  const material = defaultMaterial();
  return {
    schema: SCHEMA,
    id: newId('prj'),
    name,
    createdAt: created,
    updatedAt: created,
    revision: 0,
    settings: { units: 'meters', upAxis: 'Y' },
    world: defaultWorld(),
    textures: {},
    materials: { [material.id]: material },
    objects: {},
    skeletons: {},
    animations: {},
    rigBindings: {},
    history: { undo: [], redo: [], last: null },
    metadata: {},
  };
}

function safeName(input) {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'untitled';
}

/** Immutable-ish view used by the API: geometry replaced by a compact summary. */
export function summarizeProject(project) {
  const objects = Object.values(project.objects).map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    vertices: vertexCount(o.geometry),
    triangles: triangleCount(o.geometry),
    materialId: o.materialId,
    materialName: project.materials[o.materialId]?.name ?? null,
    transform: o.transform,
    visible: o.visible,
    parentId: o.parentId ?? null,
    skeletonId: project.rigBindings[o.id] ?? null,
    metadata: o.metadata ?? {},
  }));
  return {
    schema: project.schema,
    id: project.id,
    name: project.name,
    revision: project.revision,
    updatedAt: project.updatedAt,
    world: normalizeWorld(project.world),
    objects,
    materials: Object.values(project.materials),
    textures: Object.values(project.textures).map((t) => ({
      id: t.id,
      name: t.name,
      mimeType: t.mimeType,
      width: t.width,
      height: t.height,
      bytes: t.data ? Buffer.from(t.data, 'base64').length : 0,
    })),
    skeletons: Object.values(project.skeletons).map((s) => ({
      id: s.id,
      name: s.name,
      nodes: Object.values(s.nodes).length,
      boneNames: s.jointOrder.map((id) => s.nodes[id]?.name),
    })),
    animations: Object.values(project.animations).map((a) => ({
      id: a.id,
      name: a.name,
      duration: a.duration,
      channels: a.channels.length,
    })),
    stats: {
      objects: objects.length,
      vertices: objects.reduce((s, o) => s + o.vertices, 0),
      triangles: objects.reduce((s, o) => s + o.triangles, 0),
      materials: Object.keys(project.materials).length,
      textures: Object.keys(project.textures).length,
    },
    history: {
      undoDepth: project.history.undo.length,
      redoDepth: project.history.redo.length,
      last: project.history.last,
    },
  };
}

export class Project {
  constructor({ dir, data }) {
    this.dir = dir;
    this.data = data;
  }

  get id() {
    return this.data.id;
  }

  get path() {
    return path.join(this.dir, 'project.json');
  }

  static async list(root = resolveProjectsRoot()) {
    if (!fs.existsSync(root)) return [];
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'project.json');
      if (!fs.existsSync(file)) continue;
      try {
        const stat = await fsp.stat(file);
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        projects.push({
          id: data.id,
          slug: entry.name,
          name: data.name,
          revision: data.revision,
          updatedAt: data.updatedAt,
          objects: Object.keys(data.objects ?? {}).length,
          triangles: Object.values(data.objects ?? {}).reduce(
            (s, o) => s + Math.floor((o.geometry?.indices?.length ?? 0) / 4 / 3),
            0,
          ),
          bytes: stat.size,
          path: file,
        });
      } catch {
        // ignore unreadable projects, keep the listing usable
      }
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  static async create({ name = 'Untitled', root = resolveProjectsRoot() } = {}) {
    await fsp.mkdir(root, { recursive: true });
    let slug = safeName(name);
    let dir = path.join(root, slug);
    let n = 2;
    while (fs.existsSync(dir)) {
      dir = path.join(root, `${slug}-${n}`);
      n += 1;
    }
    await fsp.mkdir(path.join(dir, 'exports'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'previews'), { recursive: true });
    const project = new Project({ dir, data: emptyProject(name) });
    await project.save();
    return project;
  }

  static async open(ref, { root = resolveProjectsRoot() } = {}) {
    if (!ref) fail('invalid_argument', 'Project reference is required');
    const candidates = [];
    if (path.isAbsolute(ref)) candidates.push(ref);
    candidates.push(path.join(root, safeName(ref)), path.join(root, String(ref)));
    for (const candidate of candidates) {
      const file = candidate.endsWith('.json') ? candidate : path.join(candidate, 'project.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!data.id) fail('invalid_project', `Not a ModelStudio project: ${file}`, { status: 422 });
        data.history = data.history ?? { undo: [], redo: [], last: null };
        data.world = normalizeWorld(data.world);
        return new Project({ dir: path.dirname(file), data });
      }
    }
    fail('project_not_found', `Project not found: ${ref}`, {
      status: 404,
      details: { searched: candidates.map((c) => path.join(c, 'project.json')) },
      hint: 'Use `modelstudio projects list` to see available projects.',
    });
  }

  /** Find the project that owns an exported file path, useful for round-trip import. */
  static async openContaining(filePath, { root = resolveProjectsRoot() } = {}) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    const candidates = [dir, path.dirname(dir)];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'project.json'))) return Project.open(candidate, { root });
    }
    return null;
  }

  async save() {
    this.data.updatedAt = nowIso();
    const tmp = `${this.path}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data));
    await fsp.rename(tmp, this.path);
  }

  summary() {
    return summarizeProject(this.data);
  }

  // ---- objects -------------------------------------------------------------

  getObject(id) {
    return this.data.objects[id] ?? null;
  }

  /**
   * Resolve a selector to object records. Accepts an id, an exact name, a
   * case-insensitive name, `all`, or a glob such as `mesh_*`.
   */
  resolveObjects(selector = 'all') {
    const objects = Object.values(this.data.objects).filter((o) => o.visible !== false);
    if (!selector || selector === 'all' || selector === '*') return objects;
    if (selector === 'selected') return objects;
    const byId = this.data.objects[selector];
    if (byId) return [byId];
    const lower = String(selector).toLowerCase();
    const exact = objects.filter((o) => o.name === selector || o.name.toLowerCase() === lower);
    if (exact.length) return exact;
    if (String(selector).includes('*')) {
      const pattern = new RegExp(`^${String(selector).split('*').map(escapeRegExp).join('.*')}$`, 'i');
      return objects.filter((o) => pattern.test(o.name));
    }
    fail('object_not_found', `No object matches "${selector}"`, {
      status: 404,
      details: { available: objects.map((o) => o.name) },
    });
  }

  requireObject(selector) {
    const [object] = this.resolveObjects(selector);
    if (!object) fail('object_not_found', `No object matches "${selector}"`, { status: 404 });
    return object;
  }

  addObject({
    name = 'Object',
    geometry,
    materialId = null,
    transform = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    metadata = {},
    parentId = null,
  }) {
    const geo = normalizeGeometry(geometry);
    const id = newId('obj');
    const matId = materialId ?? Object.keys(this.data.materials)[0];
    const object = {
      id,
      name: uniqueObjectName(this.data, name),
      type: 'mesh',
      geometry: serializeGeometry(geo),
      materialId: matId,
      transform,
      parentId,
      visible: true,
      metadata: { ...metadata, createdAt: nowIso() },
    };
    this.data.objects[id] = object;
    return object;
  }

  getGeometry(object) {
    return deserializeGeometry(object.geometry);
  }

  setGeometry(object, geometry, { recompute = false } = {}) {
    const geo = normalizeGeometry(geometry);
    object.geometry = serializeGeometry(recompute ? recomputeNormals(geo) : geo);
    return object;
  }

  addMaterial(partial = {}) {
    const mat = { ...defaultMaterial(), ...partial, id: newId('mat') };
    this.data.materials[mat.id] = mat;
    return mat;
  }

  requireMaterial(idOrName) {
    const byId = this.data.materials[idOrName];
    if (byId) return byId;
    const lower = String(idOrName ?? '').toLowerCase();
    const byName = Object.values(this.data.materials).find((m) => m.name.toLowerCase() === lower);
    if (!byName) {
      fail('material_not_found', `No material matches "${idOrName}"`, {
        status: 404,
        details: { available: Object.values(this.data.materials).map((m) => m.name) },
      });
    }
    return byName;
  }

  addTexture({ name = 'texture', mimeType = 'image/png', data, width = null, height = null, metadata = {} }) {
    if (!data) fail('invalid_argument', 'Texture requires image data');
    const id = newId('tex');
    this.data.textures[id] = {
      id,
      name,
      mimeType,
      data: typeof data === 'string' ? data : b64FromBytes(data),
      width,
      height,
      createdAt: nowIso(),
      metadata,
    };
    return this.data.textures[id];
  }

  getTexture(id) {
    const tex = this.data.textures[id];
    if (!tex) return null;
    return { ...tex, bytes: bytesFromB64(tex.data) };
  }

  // ---- skeletons -----------------------------------------------------------

  addSkeleton({ name = 'Skeleton', nodes, jointOrder = null }) {
    const id = newId('skl');
    const skeleton = {
      id,
      name,
      nodes,
      jointOrder: jointOrder ?? Object.keys(nodes),
      createdAt: nowIso(),
    };
    this.data.skeletons[id] = skeleton;
    return skeleton;
  }

  requireSkeleton(idOrName) {
    const byId = this.data.skeletons[idOrName];
    if (byId) return byId;
    const byName = Object.values(this.data.skeletons).find((s) => s.name === idOrName);
    if (!byName) {
      fail('skeleton_not_found', `No skeleton matches "${idOrName}"`, {
        status: 404,
        details: { available: Object.values(this.data.skeletons).map((s) => s.name) },
      });
    }
    return byName;
  }

  // ---- mutation + history --------------------------------------------------

  /**
   * Apply a mutation with undo support and automatic saving.
   * `fn` receives the mutable project data and returns a result object.
   */
  async mutate(fn, { label = 'edit', save = true } = {}) {
    const before = snapshotState(this.data);
    const result = await fn(this.data);
    this.data.revision = (this.data.revision ?? 0) + 1;
    this.data.history.undo.push({ label, at: nowIso(), state: before });
    if (this.data.history.undo.length > HISTORY_LIMIT) this.data.history.undo.shift();
    this.data.history.redo = [];
    this.data.history.last = { label, at: nowIso(), revision: this.data.revision };
    if (save) await this.save();
    return { result, revision: this.data.revision };
  }

  async undo() {
    const entry = this.data.history.undo.pop();
    if (!entry) fail('nothing_to_undo', 'Undo history is empty', { status: 409 });
    const current = snapshotState(this.data);
    this.data.history.redo.push({ ...entry, state: current });
    restoreState(this.data, entry.state);
    this.data.revision += 1;
    await this.save();
    return { undone: entry.label, revision: this.data.revision };
  }

  async redo() {
    const entry = this.data.history.redo.pop();
    if (!entry) fail('nothing_to_redo', 'Redo history is empty', { status: 409 });
    const current = snapshotState(this.data);
    this.data.history.undo.push({ ...entry, state: current });
    restoreState(this.data, entry.state);
    this.data.revision += 1;
    await this.save();
    return { redone: entry.label, revision: this.data.revision };
  }

  inspect(selector = 'all') {
    const objects = this.resolveObjects(selector);
    return objects.map((o) => {
      const geo = cloneGeometry(this.getGeometry(o));
      return {
        id: o.id,
        name: o.name,
        materialId: o.materialId,
        transform: o.transform,
        skeletonId: this.data.rigBindings[o.id] ?? null,
        ...inspectGeometry(geo),
      };
    });
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueObjectName(data, desired) {
  const base = String(desired || 'Object').trim() || 'Object';
  let candidate = base;
  let n = 2;
  const names = new Set(Object.values(data.objects).map((o) => o.name));
  while (names.has(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

const STATE_KEYS = ['objects', 'materials', 'textures', 'skeletons', 'animations', 'rigBindings', 'settings', 'world'];

function snapshotState(data) {
  const state = {};
  for (const key of STATE_KEYS) state[key] = deepClone(data[key] ?? (key === 'world' ? defaultWorld() : {}));
  return state;
}

function restoreState(data, state) {
  for (const key of STATE_KEYS) data[key] = deepClone(state[key]);
}

/** Guard used by operations that need real geometry. */
export function withGeometry(project, object, fn) {
  const geo = ensureGeometry(project.getGeometry(object));
  return fn(geo);
}

export function objectStats(project, object) {
  const geo = project.getGeometry(object);
  return {
    name: object.name,
    vertices: vertexCount(geo),
    triangles: triangleCount(geo),
    boundingBox: boundingBox(geo),
  };
}

export { ModelStudioError };
