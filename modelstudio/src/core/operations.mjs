// The modeling command registry.
//
// Every capability of the studio is declared here exactly once: input schema,
// handler and documentation. The HTTP API, CLI, MCP server and the browser
// editor all dispatch through `runCommand`, so there is one implementation per
// capability and manual/AI edits always land on the same project files.
import fsNode from 'node:fs';
import { z } from 'zod';
import {
  EXPORTS_ROOT,
  Project,
  PROJECTS_ROOT,
  resolveProjectsRoot,
  objectStats,
  summarizeProject,
} from './project.mjs';
import { ModelStudioError, fail, vec3, asNumber, nowIso, newId, makeRandom, hashString } from './util.mjs';
import {
  BIOMES,
  TIME_PRESETS,
  WORLD_TARGET_HEIGHTS,
  addWorldClearing,
  applyWorldEnvironment,
  defaultWorld,
  listBiomes,
  normalizeWorld,
  terrainHeightAt,
} from './world.mjs';
import {
  buildVrContext,
  getVrState,
  resolveSpatialLocation,
  updateVrState,
} from './vr-state.mjs';
import {
  computeFenceSnap,
  computeObjectFootprint,
  computeStructureAlignment,
  fenceEndpoints,
  localAxesFromYaw,
  solveSmartPlacement,
} from './vr-interaction.mjs';
import { executeWorldPrompt } from './world-agent.mjs';
import {
  boundingBox,
  cloneGeometry,
  computeNormals,
  inspectGeometry,
  makeGeometry,
  normalizeGeometry,
  recomputeNormals,
  triangleCount,
  vertexCount,
} from './geometry.mjs';
import { buildPrimitive, PRIMITIVES } from '../algorithms/primitives.mjs';
import { sdfToMesh, shapeFromSpec, sdf } from '../algorithms/sdf.mjs';
import { sceneFromPrompt, listArchetypes, hasArchetype, ARCHETYPES, humanoid } from '../algorithms/prompt.mjs';
import {
  bakeAO,
  bakeBaseColor,
  bakeNormal,
  bakeAOField,
  ambientOcclusion,
  decodeImage,
  encodePng,
  solidImage,
  toRgba,
} from '../algorithms/bake.mjs';
import { projectUV, uvCoverage } from '../algorithms/uv.mjs';
import { correctSkinWeights, computeSkinWeights, applySkin, humanoidSkeleton, poseSkeleton, skeletonReport, weightQuality, skeletonBones } from './rigging.mjs';
import { buildClip, listClips, sampleClip } from '../algorithms/animation.mjs';
import { decimate, fillHoles as fillHolesOp, flipNormals as flipNormalsOp, repair as repairOp, smooth as smoothOp } from '../algorithms/repair.mjs';
import { mergeGeometries, transformGeometry, transferAttributes, voxelRemesh } from '../algorithms/remesh.mjs';
import { extractMask, projectVertexColors, visualHull } from '../algorithms/reconstruct.mjs';
import { exportModel, renderPreview, renderPreviewToFile } from './exporter.mjs';
import {
  MATERIAL_PRESETS,
  addImageTexture,
  addSolidTexture,
  createMaterial,
  editMaterial,
  listMaterialPresets,
  materialReport,
  paintTexture,
  textureDataUrl,
} from './materials.mjs';
import { importIntoProject, readGltf } from './gltf.mjs';

const number = () => z.coerce.number();
const bool = () => z.coerce.boolean();
const objectSelector = () => z.string().default('all');

function schema(shape, refine = null) {
  const base = z.object(shape);
  return refine ? base.refine(...refine) : base;
}

/** Resolve objects for an operation, sharing one project handle. */
async function withProject(ref, fn, options = {}) {
  const project = await Project.open(ref, options);
  return fn(project);
}

function geometryFor(project, object) {
  return project.getGeometry(object);
}

/**
 * Apply a geometry-producing operation to selected objects inside one undo step.
 */
async function applyToObjects(project, selector, label, operation, { save = true } = {}) {
  const objects = project.resolveObjects(selector);
  if (!objects.length) fail('object_not_found', `No object matches "${selector}"`, { status: 404 });
  return project.mutate(async () => {
    const results = [];
    for (const object of objects) {
      const before = geometryFor(project, object);
      const outcome = await operation(before, object);
      if (!outcome) {
        results.push({ object: object.name, skipped: true });
        continue;
      }
      const geometry = outcome.geometry ?? outcome;
      project.setGeometry(object, geometry);
      results.push({
        object: object.name,
        id: object.id,
        vertices: vertexCount(project.getGeometry(object)),
        triangles: triangleCount(project.getGeometry(object)),
        ...(outcome.stats ? { stats: outcome.stats } : {}),
      });
    }
    return { label, results };
  }, { label, save });
}

const COMMANDS = [];
function command(definition) {
  const id = definition.id;
  if (COMMANDS.some((c) => c.id === id)) throw new Error(`Duplicate command id: ${id}`);
  COMMANDS.push({
    id,
    category: definition.category,
    description: definition.description,
    mutates: definition.mutates ?? true,
    input: definition.input ?? schema({}),
    inputShape: definition.inputShape ?? {},
    examples: definition.examples ?? [],
    handler: definition.handler,
  });
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

command({
  id: 'project.create',
  category: 'project',
  description: 'Create a new project directory with project.json and exports/previews folders.',
  inputShape: { name: z.string().default('Untitled'), root: z.string().optional() },
  input: schema({ name: z.string().default('Untitled'), root: z.string().optional() }),
  examples: ['modelstudio project.create --name "Character"', 'modelstudio new "Character"'],
  handler: async (input) => {
    const project = await Project.create({ name: input.name, root: input.root ?? resolveProjectsRoot() });
    return { project: project.summary(), path: project.path, dir: project.dir };
  },
});

command({
  id: 'project.list',
  category: 'project',
  description: 'List projects in the workspace.',
  mutates: false,
  inputShape: { root: z.string().optional() },
  input: schema({ root: z.string().optional() }),
  examples: ['modelstudio projects'],
  handler: async (input) => {
    const activeRoot = input.root ?? resolveProjectsRoot();
    return { root: activeRoot, projects: await Project.list(activeRoot) };
  },
});

command({
  id: 'project.get',
  category: 'project',
  description: 'Get the summary of an open project (objects, materials, stats, undo state).',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  examples: ['modelstudio project.get --project Character'],
  handler: async (input) => withProject(input.project, async (project) => ({
    project: project.summary(),
    path: project.path,
    dir: project.dir,
  })),
});

command({
  id: 'project.save',
  category: 'project',
  description: 'Force a save of the project file (mutations save automatically).',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => {
    await project.save();
    return { saved: true, path: project.path, revision: project.data.revision };
  }),
});

command({
  id: 'project.snapshot',
  category: 'project',
  description: 'Export the full project state including base64 geometry, for editor synchronisation.',
  mutates: false,
  inputShape: { project: z.string(), geometry: bool().default(true) },
  input: schema({ project: z.string(), geometry: z.coerce.boolean().default(true) }),
  handler: async (input) => withProject(input.project, async (project) => {
    const objects = Object.values(project.data.objects).map((o) => ({
      ...o,
      geometry: input.geometry ? o.geometry : undefined,
      stats: objectStats(project, o),
      skeletonId: project.data.rigBindings[o.id] ?? null,
    }));
    return {
      project: project.summary(),
      world: normalizeWorld(project.data.world),
      vr: getVrState(project),
      objects,
      skeletons: Object.values(project.data.skeletons),
      animations: Object.values(project.data.animations),
      materials: Object.values(project.data.materials),
      textures: Object.values(project.data.textures).map((t) => ({ id: t.id, name: t.name, mimeType: t.mimeType, width: t.width, height: t.height, url: `/api/projects/${project.id}/textures/${t.id}` })),
      rigBindings: project.data.rigBindings,
    };
  }),
});

command({
  id: 'project.undo',
  category: 'project',
  description: 'Undo the last mutation.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => ({ ...(await project.undo()), project: project.summary() })),
});

command({
  id: 'project.redo',
  category: 'project',
  description: 'Redo the last undone mutation.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => ({ ...(await project.redo()), project: project.summary() })),
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

command({
  id: 'generate.text',
  category: 'generation',
  description:
    'Text-to-3D using the local structured-prompt SDF generator (or a configured provider). Creates one or more objects.',
  inputShape: {
    project: z.string(),
    prompt: z.string().min(1),
    resolution: number().default(96),
    style: z.string().optional(),
    provider: z.enum(['local', 'meshy', 'auto']).default('local'),
    splitParts: bool().default(false),
    materialize: bool().default(true),
  },
  input: schema({
    project: z.string(),
    prompt: z.string().min(1),
    resolution: z.coerce.number().int().min(16).max(200).default(96),
    style: z.string().optional(),
    provider: z.enum(['local', 'meshy', 'auto']).default('local'),
    splitParts: z.coerce.boolean().default(false),
    materialize: z.coerce.boolean().default(true),
  }),
  examples: [
    'modelstudio generate --prompt "realistic wooden chair" --project Demo',
    'modelstudio generate.text --project Demo --prompt "tall female character" --splitParts',
  ],
  handler: async (input) => {
    if (input.provider !== 'local') {
      const { generateWithProvider } = await import('../providers/index.mjs');
      return generateWithProvider(input.provider, input);
    }
    return withProject(input.project, async (project) => {
      const scene = sceneFromPrompt(input.style ? `${sceneStyle(input.style)} ${input.prompt}` : input.prompt);
      const mesh = sdfToMesh(scene.shape, { resolution: input.resolution });
      const started = Date.now();
      return project.mutate(async () => {
        const material = input.materialize ? project.addMaterial({
          ...scene.material,
          name: scene.material.name ?? 'Generated',
          baseColorFactor: scene.material.baseColorFactor ?? [0.8, 0.8, 0.8, 1],
        }) : null;
        const created = [];
        const main = project.addObject({
          name: input.prompt.slice(0, 48),
          geometry: mesh,
          materialId: material?.id,
          metadata: {
            generator: 'local-sdf',
            archetype: scene.archetype,
            prompt: input.prompt,
            resolution: input.resolution,
            generatedAt: nowIso(),
            params: scene.params,
          },
        });
        created.push({ id: main.id, name: main.name, triangles: triangleCount(mesh) });
        if (input.splitParts && scene.parts?.length) {
          for (const part of scene.parts) {
            if (!part.shape) continue;
            const partMesh = sdfToMesh(part.shape, { resolution: Math.round(input.resolution * 0.7) });
            const record = project.addObject({
              name: `${main.name}_${part.name}`,
              geometry: partMesh,
              materialId: material?.id,
              metadata: { generator: 'local-sdf', part: part.name, prompt: input.prompt },
            });
            created.push({ id: record.id, name: record.name, triangles: triangleCount(partMesh) });
          }
        }
        return {
          provider: 'local',
          archetype: scene.archetype,
          alternatives: scene.alternatives,
          objects: created,
          materialId: material?.id ?? null,
          stats: mesh.stats,
          elapsedMs: Date.now() - started,
          geometry: input.materialize ? undefined : mesh,
        };
      }, { label: `generate:${input.prompt.slice(0, 24)}` });
    });
  },
});

function sceneStyle(style) {
  return style === 'realistic' ? '' : style ?? '';
}

command({
  id: 'generate.shape',
  category: 'generation',
  description: 'Generate geometry from an explicit SDF shape spec (sphere/box/capsule/union/subtract...).',
  inputShape: { project: z.string(), spec: z.any(), resolution: number().default(96), name: z.string().default('Shape') },
  input: schema({
    project: z.string(),
    spec: z.any(),
    resolution: z.coerce.number().int().min(16).max(200).default(96),
    name: z.string().default('Shape'),
  }),
  handler: async (input) => withProject(input.project, async (project) => {
    const shape = shapeFromSpec(input.spec);
    const mesh = sdfToMesh(shape, { resolution: input.resolution });
    return project.mutate(async () => {
      const material = project.addMaterial({ name: 'ShapeMaterial' });
      const object = project.addObject({ name: input.name, geometry: mesh, materialId: material.id, metadata: { generator: 'sdf-spec', spec: input.spec } });
      return { object: project.data.objects[object.id], materialId: material.id, stats: mesh.stats, project: project.summary() };
    }, { label: 'generate.shape' });
  }),
});

command({
  id: 'generate.image',
  category: 'generation',
  description:
    'Image-to-3D: silhouette extraction plus visual-hull carving from one or more reference images with yaw angles.',
  inputShape: {
    project: z.string(),
    images: z.array(z.object({ data: z.string().optional(), textureId: z.string().optional(), path: z.string().optional(), angle: number().default(0), name: z.string().optional() })),
    resolution: number().default(96),
    symmetry: bool().default(false),
    name: z.string().default('Reconstruction'),
    mode: z.enum(['auto', 'alpha', 'flood']).default('auto'),
  },
  input: schema({
    project: z.string(),
    images: z.array(z.any()).min(1),
    resolution: z.coerce.number().int().min(16).max(160).default(96),
    symmetry: z.coerce.boolean().default(false),
    name: z.string().default('Reconstruction'),
    mode: z.enum(['auto', 'alpha', 'flood']).default('auto'),
  }),
  examples: [
    'modelstudio generate.image --project Demo --image front.png:0 --image side.png:90',
    'modelstudio generate.image --project Demo --image front.png',
  ],
  handler: async (input) => withProject(input.project, async (project) => {
    const views = [];
    for (const entry of input.images) {
      const bytes = resolveImageBytes(project, entry);
      const image = await decodeImage(bytes);
      const mask = extractMask(image, { mode: input.mode });
      views.push({ image, mask: mask.mask, bbox: mask.bbox, angle: Number(entry.angle ?? 0) });
    }
    const started = Date.now();
    const hull = visualHull(views, { resolution: input.resolution, symmetry: input.symmetry });
    const colors = projectVertexColors(hull, views[0].image, hull.camera);
    return project.mutate(async () => {
      const uv = projectUV(hull, { projection: 'cylindrical' });
      const material = project.addMaterial({ name: 'Reconstructed' });
      const object = project.addObject({
        name: input.name,
        geometry: uv,
        materialId: material.id,
        metadata: {
          generator: 'visual-hull',
          views: views.length,
          angles: views.map((v) => (v.angle * 180) / Math.PI),
          resolution: input.resolution,
          generatedAt: nowIso(),
        },
      });
      return {
        object: { id: object.id, name: object.name, triangles: triangleCount(uv) },
        materialId: material.id,
        hull: hull.stats,
        colorCoverage: colors.stats,
        elapsedMs: Date.now() - started,
        limitations: [
          'Visual hull cannot recover concavities (e.g. space between arms and torso).',
          'Texture is projected from the first view for the albedo bake step.',
        ],
        project: project.summary(),
      };
    }, { label: 'generate.image' });
  }),
});

function readFileSyncSafe(file) {
  // eslint-disable-next-line global-require
  const fsSync = fsNode;
  return fsSync.readFileSync(file);
}

function resolveImageBytes(project, entry) {
  if (entry.textureId) {
    const texture = project.getTexture(entry.textureId);
    if (!texture) fail('texture_not_found', `No texture ${entry.textureId}`, { status: 404 });
    return texture.bytes;
  }
  if (entry.data) {
    const b64 = String(entry.data).includes(',') ? String(entry.data).split(',').pop() : entry.data;
    return Buffer.from(b64, 'base64');
  }
  if (entry.path) return readFileSyncSafe(entry.path);
  fail('invalid_argument', 'Each image needs data (base64), textureId or path');
  return null;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

command({
  id: 'object.list',
  category: 'objects',
  description: 'List objects with vertex/triangle counts and material bindings.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  examples: ['modelstudio objects --project Demo'],
  handler: async (input) => withProject(input.project, async (project) => ({ objects: project.summary().objects })),
});

command({
  id: 'object.inspect',
  category: 'objects',
  description: 'Detailed mesh diagnostics: watertightness, holes, loose vertices, bounds, UVs, skin weights.',
  mutates: false,
  inputShape: { project: z.string(), object: objectSelector() },
  input: schema({ project: z.string(), object: z.string().default('all') }),
  examples: ['modelstudio inspect --project Demo --object all'],
  handler: async (input) => withProject(input.project, async (project) => ({ objects: project.inspect(input.object) })),
});

command({
  id: 'object.add',
  category: 'objects',
  description: 'Add a parametric primitive (cube, sphere, cylinder, cone, torus, capsule, plane...) as a new object.',
  inputShape: { project: z.string(), primitive: z.string(), name: z.string().optional(), materialId: z.string().optional(), options: z.any().optional() },
  input: schema({
    project: z.string(),
    primitive: z.string(),
    name: z.string().optional(),
    materialId: z.string().optional(),
    options: z.any().optional(),
  }),
  examples: ['modelstudio add --project Demo --primitive sphere --name Ball', 'modelstudio object.add --project Demo --primitive capsule'],
  handler: async (input) => withProject(input.project, async (project) => {
    const geometry = buildPrimitive(input.primitive, input.options ?? {});
    return project.mutate(async () => {
      const material = input.materialId ? project.requireMaterial(input.materialId) : project.addMaterial({ name: `${input.primitive} material` });
      const object = project.addObject({
        name: input.name ?? input.primitive,
        geometry,
        materialId: material.id,
        metadata: { generator: 'primitive', primitive: input.primitive },
      });
      return {
        object: objectStats(project, object),
        id: object.id,
        materialId: material.id,
        primitives: Object.keys(PRIMITIVES),
        project: project.summary(),
      };
    }, { label: `add:${input.primitive}` });
  }),
});

command({
  id: 'object.delete',
  category: 'objects',
  description: 'Delete an object (or a glob of objects).',
  inputShape: { project: z.string(), object: z.string() },
  input: schema({ project: z.string(), object: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const objects = project.resolveObjects(input.object);
    for (const object of objects) {
      delete project.data.objects[object.id];
      delete project.data.rigBindings[object.id];
    }
    return { deleted: objects.map((o) => o.name) };
  }, { label: 'object.delete' })),
});

command({
  id: 'object.rename',
  category: 'objects',
  description: 'Rename an object.',
  inputShape: { project: z.string(), object: z.string(), name: z.string().min(1) },
  input: schema({ project: z.string(), object: z.string(), name: z.string().min(1) }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const previous = object.name;
    object.name = input.name;
    return { renamed: { from: previous, to: object.name }, id: object.id };
  }, { label: 'object.rename' })),
});

command({
  id: 'object.transform',
  category: 'objects',
  description: 'Set an object transform (translation, euler rotation in degrees, scale).',
  inputShape: { project: z.string(), object: z.string(), translation: z.any().optional(), rotation: z.any().optional(), scale: z.any().optional(), applyToGeometry: bool().default(false) },
  input: schema({
    project: z.string(),
    object: z.string(),
    translation: z.any().optional(),
    rotation: z.any().optional(),
    scale: z.any().optional(),
    applyToGeometry: z.coerce.boolean().default(false),
  }),
  examples: ['modelstudio transform --project Demo --object Chair --translation 0,0,1'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const transform = { ...object.transform };
    if (input.translation) transform.translation = vec3(input.translation, [0, 0, 0], 'translation');
    if (input.rotation) transform.rotation = vec3(input.rotation, [0, 0, 0], 'rotation');
    if (input.scale) transform.scale = vec3(input.scale, [1, 1, 1], 'scale');
    object.transform = transform;
    if (input.applyToGeometry) {
      const geo = project.getGeometry(object);
      const baked = transformGeometry(geo, {
        translation: transform.translation,
        rotation: transform.rotation.map((d) => (d * Math.PI) / 180),
        scale: transform.scale,
      });
      project.setGeometry(object, baked);
      object.transform = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    }
    return { object: object.name, transform: object.transform, appliedToGeometry: input.applyToGeometry };
  }, { label: 'object.transform' })),
});

command({
  id: 'object.duplicate',
  category: 'objects',
  description: 'Duplicate an object with its geometry, material and skin binding.',
  inputShape: { project: z.string(), object: z.string(), name: z.string().optional(), offset: z.any().optional() },
  input: schema({ project: z.string(), object: z.string(), name: z.string().optional(), offset: z.any().optional() }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const source = project.requireObject(input.object);
    const offset = input.offset ? vec3(input.offset, [0, 0, 0], 'offset') : [0, 0, 0];
    const copy = project.addObject({
      name: input.name ?? `${source.name}_copy`,
      geometry: project.getGeometry(source),
      materialId: source.materialId,
      transform: {
        translation: source.transform.translation.map((v, i) => v + offset[i]),
        rotation: [...source.transform.rotation],
        scale: [...source.transform.scale],
      },
      metadata: { ...source.metadata, duplicatedFrom: source.id },
    });
    if (project.data.rigBindings[source.id]) project.data.rigBindings[copy.id] = project.data.rigBindings[source.id];
    return { id: copy.id, name: copy.name };
  }, { label: 'object.duplicate' })),
});

command({
  id: 'object.merge',
  category: 'objects',
  description: 'Merge several objects into one (world transforms applied).',
  inputShape: { project: z.string(), objects: z.array(z.string()), name: z.string().optional(), deleteSource: bool().default(true) },
  input: schema({ project: z.string(), objects: z.array(z.string()).min(2), name: z.string().optional(), deleteSource: z.coerce.boolean().default(true) }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const records = input.objects.flatMap((selector) => project.resolveObjects(selector));
    const geometries = records.map((record) => transformGeometry(
      project.getGeometry(record),
      {
        translation: record.transform.translation,
        rotation: record.transform.rotation.map((d) => (d * Math.PI) / 180),
        scale: record.transform.scale,
      },
    ));
    const merged = mergeGeometries(geometries);
    const object = project.addObject({
      name: input.name ?? 'Merged',
      geometry: merged,
      materialId: records[0].materialId,
      metadata: { mergedFrom: records.map((r) => r.id) },
    });
    if (input.deleteSource) {
      for (const record of records) delete project.data.objects[record.id];
    }
    return { id: object.id, name: object.name, triangles: triangleCount(merged), sources: records.map((r) => r.name) };
  }, { label: 'object.merge' })),
});

// ---------------------------------------------------------------------------
// Geometry operations
// ---------------------------------------------------------------------------

command({
  id: 'mesh.repair',
  category: 'geometry',
  description: 'Weld duplicates, remove degenerate/duplicate faces, fill holes, drop loose vertices, recompute normals.',
  inputShape: { project: z.string(), object: objectSelector(), fillHoles: bool().default(true) },
  input: schema({ project: z.string(), object: z.string().default('all'), fillHoles: z.coerce.boolean().default(true) }),
  examples: ['modelstudio repair --project Demo --mesh Chair'],
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.repair', async (geo) => {
    const result = repairOp(geo, { fillHoles: input.fillHoles });
    return { geometry: result, stats: result.stats };
  })),
});

command({
  id: 'mesh.remesh',
  category: 'geometry',
  description: 'Voxel remesh (uniform topology), transferring UVs and skin weights from the source surface.',
  inputShape: { project: z.string(), object: objectSelector(), resolution: number().default(96), smooth: number().default(0), transferUV: bool().default(true) },
  input: schema({
    project: z.string(),
    object: z.string().default('all'),
    resolution: z.coerce.number().int().min(16).max(200).default(96),
    smooth: z.coerce.number().int().min(0).max(10).default(0),
    transferUV: z.coerce.boolean().default(true),
  }),
  examples: ['modelstudio remesh --project Demo --resolution 128'],
  handler: async (input) => withProject(input.project, async (project) => {
    const objects = project.resolveObjects(input.object);
    return project.mutate(async () => {
      const results = [];
      for (const object of objects) {
        const source = project.getGeometry(object);
        const remeshed = voxelRemesh(source, { voxelResolution: input.resolution, smoothIterations: input.smooth });
        const transferred = transferAttributes(source, remeshed, { transferUV: input.transferUV, transferSkin: true });
        project.setGeometry(object, transferred.geometry);
        results.push({ object: object.name, id: object.id, ...remeshed.stats, transfer: transferred.stats });
      }
      return { label: 'mesh.remesh', results };
    }, { label: 'mesh.remesh' });
  }),
});

command({
  id: 'mesh.decimate',
  category: 'geometry',
  description: 'Quadric decimation to a target triangle count, preserving UVs and skin weights.',
  inputShape: { project: z.string(), object: objectSelector(), triangles: number(), error: number().default(0.01) },
  input: schema({
    project: z.string(),
    object: z.string().default('all'),
    triangles: z.coerce.number().int().min(4),
    error: z.coerce.number().min(1e-4).max(10).default(0.01),
  }),
  examples: ['modelstudio decimate --project Demo --triangles 30000'],
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.decimate', async (geo) => {
    const result = await decimate(geo, { targetTriangles: input.triangles, targetError: input.error });
    return { geometry: result, stats: result.stats };
  })),
});

command({
  id: 'mesh.smooth',
  category: 'geometry',
  description: 'Laplacian smoothing with boundary preservation.',
  inputShape: { project: z.string(), object: objectSelector(), iterations: number().default(1), factor: number().default(0.5) },
  input: schema({ project: z.string(), object: z.string().default('all'), iterations: z.coerce.number().int().min(1).max(50).default(1), factor: z.coerce.number().min(0.01).max(1).default(0.5) }),
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.smooth', async (geo) => ({
    geometry: smoothOp(geo, { iterations: input.iterations, factor: input.factor }),
  }))),
});

command({
  id: 'mesh.fill-holes',
  category: 'geometry',
  description: 'Close boundary loops by fanning them to their centroid.',
  inputShape: { project: z.string(), object: objectSelector(), maxHoleVertices: number().default(64) },
  input: schema({ project: z.string(), object: z.string().default('all'), maxHoleVertices: z.coerce.number().int().default(64) }),
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.fill-holes', async (geo) => {
    const result = fillHolesOp(geo, { maxHoleVertices: input.maxHoleVertices });
    return { geometry: result, stats: result.stats };
  })),
});

command({
  id: 'mesh.flip-normals',
  category: 'geometry',
  description: 'Invert triangle winding and recompute normals.',
  inputShape: { project: z.string(), object: objectSelector() },
  input: schema({ project: z.string(), object: z.string().default('all') }),
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.flip-normals', async (geo) => ({
    geometry: flipNormalsOp(geo),
  }))),
});

command({
  id: 'mesh.recompute-normals',
  category: 'geometry',
  description: 'Recompute smooth vertex normals (optionally with a crease angle).',
  inputShape: { project: z.string(), object: objectSelector(), smoothAngle: number().default(80) },
  input: schema({ project: z.string(), object: z.string().default('all'), smoothAngle: z.coerce.number().min(1).max(180).default(80) }),
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.recompute-normals', async (geo) => ({
    geometry: recomputeNormals(geo, { smoothAngle: input.smoothAngle }),
  }))),
});

command({
  id: 'mesh.uv',
  category: 'geometry',
  description: 'Generate UV coordinates with cylindrical/spherical/planar/box projection.',
  inputShape: { project: z.string(), object: objectSelector(), projection: z.string().default('auto'), scale: number().default(1), rotation: number().default(0) },
  input: schema({
    project: z.string(),
    object: z.string().default('all'),
    projection: z.enum(['auto', 'cylindrical', 'spherical', 'planar', 'box', 'top']).default('auto'),
    scale: z.coerce.number().default(1),
    rotation: z.coerce.number().default(0),
  }),
  examples: ['modelstudio uv --project Demo --projection cylindrical'],
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.uv', async (geo) => {
    const result = projectUV(geo, { projection: input.projection, scale: input.scale, rotation: input.rotation });
    return { geometry: result, stats: result.stats };
  })),
});

command({
  id: 'mesh.sculpt',
  category: 'geometry',
  description:
    'Sculpt with a radial brush over world/object space: modes grab, inflate, pinch, flatten, smooth, erase-selection.',
  inputShape: {
    project: z.string(),
    object: z.string(),
    center: z.any(),
    radius: number().default(0.1),
    strength: number().default(0.02),
    mode: z.enum(['grab', 'inflate', 'pinch', 'flatten', 'smooth', 'flatten-plane']).default('inflate'),
    direction: z.any().optional(),
    falloff: z.enum(['smooth', 'linear', 'constant']).default('smooth'),
  },
  input: schema({
    project: z.string(),
    object: z.string(),
    // Numbers arrive as CLI strings when passed through
    // `notebook --center 0,1,0`; coerce each component.
    center: z.union([z.string(), z.array(z.any())]).transform((v, ctx) => {
      try {
        return vec3(v, null, 'center');
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: error.message });
        return z.NEVER;
      }
    }),
    radius: z.coerce.number().positive().default(0.1),
    strength: z.coerce.number().default(0.02),
    mode: z.enum(['grab', 'inflate', 'pinch', 'flatten', 'smooth', 'flatten-plane']).default('inflate'),
    direction: z.union([z.string(), z.array(z.any())]).optional().transform((v) => (v === undefined ? undefined : vec3(v, [0, 1, 0], 'direction'))),
    falloff: z.enum(['smooth', 'linear', 'constant']).default('smooth'),
  }),
  examples: ['modelstudio sculpt --project Demo --object Body --center 0,1,0 --radius 0.2 --strength 0.03 --mode inflate'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const geo = project.getGeometry(object);
    const result = sculpt(geo, {
      center: input.center,
      radius: input.radius,
      strength: input.strength,
      mode: input.mode,
      direction: input.direction ?? null,
      falloff: input.falloff,
    });
    project.setGeometry(object, result.geometry);
    return { object: object.name, affected: result.affected, mode: input.mode, stats: result.stats };
  }, { label: `sculpt:${input.mode}` })),
});

command({
  id: 'mesh.symmetrize',
  category: 'geometry',
  description: 'Mirror one half of the mesh onto the other across an axis.',
  inputShape: { project: z.string(), object: z.string(), axis: z.enum(['x', 'y', 'z']).default('x'), keep: z.enum(['positive', 'negative']).default('positive') },
  input: schema({ project: z.string(), object: z.string(), axis: z.enum(['x', 'y', 'z']).default('x'), keep: z.enum(['positive', 'negative']).default('positive') }),
  handler: async (input) => withProject(input.project, async (project) => applyToObjects(project, input.object, 'mesh.symmetrize', async (geo) => {
    const axisIndex = { x: 0, y: 1, z: 2 }[input.axis];
    const bbox = boundingBox(geo);
    const mid = bbox.center[axisIndex];
    const keepSign = input.keep === 'positive' ? 1 : -1;
    const keptIndices = [];
    for (let i = 0; i < geo.indices.length; i += 3) {
      const cx = [0, 1, 2].map((k) => (geo.positions[geo.indices[i] * 3 + k] + geo.positions[geo.indices[i + 1] * 3 + k] + geo.positions[geo.indices[i + 2] * 3 + k]) / 3);
      if ((cx[axisIndex] - mid) * keepSign >= 0) keptIndices.push(geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]);
    }
    const half = { ...geo, indices: new Uint32Array(keptIndices) };
    const mirrored = { ...half, positions: new Float32Array(half.positions) };
    for (let i = 0; i < mirrored.positions.length; i += 3) mirrored.positions[i + axisIndex] = 2 * mid - mirrored.positions[i + axisIndex];
    const flipped = flipNormalsOp(mirrored);
    const merged = mergeGeometries([half, flipped]);
    const repaired = repairOp(merged, {});
    return { geometry: recomputed(repaired), stats: { keptTriangles: keptIndices.length / 3, axis: input.axis } };
  })),
});

function recomputed(geo) {
  return { ...geo, normals: computeNormals(geo.positions, geo.indices) };
}

/** Radial sculpt brush. Pure geometry maths over the vertex buffer. */
export function sculpt(geo, { center, radius, strength, mode, direction, falloff }) {
  const positions = new Float32Array(geo.positions);
  const vc = vertexCount(geo);
  const normals = geo.normals.length === vc * 3 ? geo.normals : computeNormals(geo.positions, geo.indices);
  const dir = direction ?? [0, 1, 0];
  let affected = 0;
  const falloffFn = (t) => {
    if (falloff === 'constant') return 1;
    if (falloff === 'linear') return 1 - t;
    return 1 - t * t * (3 - 2 * t);
  };
  // planar flatten reference
  let planePoint = center;
  let planeNormal = dir;
  if (mode === 'flatten' || mode === 'flatten-plane') {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let count = 0;
    for (let v = 0; v < vc; v += 1) {
      if (Math.hypot(positions[v * 3] - center[0], positions[v * 3 + 1] - center[1], positions[v * 3 + 2] - center[2]) > radius) continue;
      nx += normals[v * 3];
      ny += normals[v * 3 + 1];
      nz += normals[v * 3 + 2];
      count += 1;
    }
    if (count > 0) {
      const len = Math.hypot(nx, ny, nz) || 1;
      planeNormal = [nx / len, ny / len, nz / len];
    }
    planePoint = center;
  }
  const smoothed = mode === 'smooth' ? (() => {
    const out = new Float32Array(positions);
    for (let v = 0; v < vc; v += 1) {
      const d = Math.hypot(positions[v * 3] - center[0], positions[v * 3 + 1] - center[1], positions[v * 3 + 2] - center[2]);
      if (d > radius) continue;
      // gather neighbours from the index buffer lazily via one pass over faces
      out[v * 3] = positions[v * 3];
    }
    return out;
  })() : null;
  const neighbors = mode === 'smooth' ? buildAdjacency(geo) : null;

  for (let v = 0; v < vc; v += 1) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const d = Math.hypot(x - center[0], y - center[1], z - center[2]);
    if (d > radius) continue;
    const weight = falloffFn(Math.min(1, d / radius));
    const amount = strength * weight;
    if (mode === 'grab') {
      positions[v * 3] += dir[0] * amount;
      positions[v * 3 + 1] += dir[1] * amount;
      positions[v * 3 + 2] += dir[2] * amount;
    } else if (mode === 'inflate') {
      positions[v * 3] += normals[v * 3] * amount;
      positions[v * 3 + 1] += normals[v * 3 + 1] * amount;
      positions[v * 3 + 2] += normals[v * 3 + 2] * amount;
    } else if (mode === 'pinch') {
      const dx = center[0] - x;
      const dy = center[1] - y;
      const dz = center[2] - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      positions[v * 3] += (dx / len) * amount;
      positions[v * 3 + 1] += (dy / len) * amount;
      positions[v * 3 + 2] += (dz / len) * amount;
    } else if (mode === 'flatten' || mode === 'flatten-plane') {
      const dist = (x - planePoint[0]) * planeNormal[0] + (y - planePoint[1]) * planeNormal[1] + (z - planePoint[2]) * planeNormal[2];
      positions[v * 3] -= planeNormal[0] * dist * weight;
      positions[v * 3 + 1] -= planeNormal[1] * dist * weight;
      positions[v * 3 + 2] -= planeNormal[2] * dist * weight;
    } else if (mode === 'smooth' && neighbors) {
      const list = neighbors[v];
      if (list.length) {
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const n of list) {
          sx += geo.positions[n * 3];
          sy += geo.positions[n * 3 + 1];
          sz += geo.positions[n * 3 + 2];
        }
        sx /= list.length;
        sy /= list.length;
        sz /= list.length;
        positions[v * 3] += (sx - x) * weight * Math.min(1, Math.abs(strength) * 20);
        positions[v * 3 + 1] += (sy - y) * weight * Math.min(1, Math.abs(strength) * 20);
        positions[v * 3 + 2] += (sz - z) * weight * Math.min(1, Math.abs(strength) * 20);
      }
    }
    affected += 1;
  }
  void smoothed;
  const out = { ...geo, positions, normals: computeNormals(positions, geo.indices) };
  return { geometry: out, affected, stats: { affected, radius, mode } };
}

/** Newest skeleton in the project (used when `skeleton: "all"`). */
function newestSkeleton(project) {
  const skeletons = Object.values(project.data.skeletons ?? {});
  if (!skeletons.length) fail('skeleton_not_found', 'Project has no skeleton yet; run rig.create first', { status: 404 });
  return skeletons[skeletons.length - 1];
}

function buildAdjacency(geo) {
  const vc = vertexCount(geo);
  const sets = new Array(vc);
  const push = (a, b) => {
    if (!sets[a]) sets[a] = new Set();
    sets[a].add(b);
  };
  for (let i = 0; i < geo.indices.length; i += 3) {
    const a = geo.indices[i];
    const b = geo.indices[i + 1];
    const c = geo.indices[i + 2];
    push(a, b); push(a, c); push(b, a); push(b, c); push(c, a); push(c, b);
  }
  return sets.map((s) => (s ? Array.from(s) : []));
}

command({
  id: 'mesh.set-vertex-positions',
  category: 'geometry',
  description: 'Replace vertex positions (used by the editor for direct manipulation).',
  inputShape: { project: z.string(), object: z.string(), positions: z.string(), recomputeNormals: bool().default(true) },
  input: schema({ project: z.string(), object: z.string(), positions: z.string(), recomputeNormals: z.coerce.boolean().default(true) }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const geo = project.getGeometry(object);
    const buffer = Buffer.from(input.positions, 'base64');
    const positions = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    if (positions.length !== geo.positions.length) {
      fail('invalid_argument', `Expected ${geo.positions.length} floats, received ${positions.length}`);
    }
    project.setGeometry(object, { ...geo, positions }, { recompute: input.recomputeNormals });
    return { object: object.name, vertices: vertexCount(geo) };
  }, { label: 'mesh.set-vertex-positions' })),
});

// ---------------------------------------------------------------------------
// Materials & textures
// ---------------------------------------------------------------------------

command({
  id: 'material.list',
  category: 'materials',
  description: 'List materials, presets and which objects use them.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  examples: ['modelstudio materials --project Demo'],
  handler: async (input) => withProject(input.project, async (project) => ({
    materials: materialReport(project),
    presets: listMaterialPresets(),
  })),
});

command({
  id: 'material.create',
  category: 'materials',
  description: 'Create a material from a preset (skin, metal, wood, glass...) or explicit factors.',
  inputShape: { project: z.string(), preset: z.string().optional(), name: z.string().optional(), baseColorFactor: z.any().optional(), metallicFactor: number().optional(), roughnessFactor: number().optional(), assignTo: z.string().optional() },
  input: schema({
    project: z.string(),
    preset: z.string().optional(),
    name: z.string().optional(),
    baseColorFactor: z.any().optional(),
    metallicFactor: z.coerce.number().optional(),
    roughnessFactor: z.coerce.number().optional(),
    assignTo: z.string().optional(),
  }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const overrides = {};
    if (input.baseColorFactor) overrides.baseColorFactor = input.baseColorFactor;
    if (input.metallicFactor !== undefined) overrides.metallicFactor = input.metallicFactor;
    if (input.roughnessFactor !== undefined) overrides.roughnessFactor = input.roughnessFactor;
    const material = createMaterial(project, { preset: input.preset, name: input.name ?? (input.preset ? `${input.preset} material` : 'Material'), ...overrides });
    const assigned = [];
    if (input.assignTo) {
      for (const object of project.resolveObjects(input.assignTo)) {
        object.materialId = material.id;
        assigned.push(object.name);
      }
    }
    return { material: materialReport(project).find((m) => m.id === material.id), assigned };
  }, { label: 'material.create' })),
});

command({
  id: 'material.edit',
  category: 'materials',
  description: 'Edit material properties: base colour, metallic, roughness, emissive, alpha mode, texture binding.',
  inputShape: { project: z.string(), material: z.string(), changes: z.any() },
  input: schema({ project: z.string(), material: z.string(), changes: z.any() }),
  examples: ['modelstudio material.edit --project Demo --material Wood --changes \'{"baseColorFactor":[0.9,0.2,0.2,1],"roughnessFactor":0.25}\''],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const result = editMaterial(project, input.material, input.changes);
    return { material: materialReport(project).find((m) => m.id === result.material.id), applied: result.applied };
  }, { label: 'material.edit' })),
});

command({
  id: 'material.assign',
  category: 'materials',
  description: 'Assign an existing material to objects.',
  inputShape: { project: z.string(), material: z.string(), object: z.string() },
  input: schema({ project: z.string(), material: z.string(), object: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const material = project.requireMaterial(input.material);
    const objects = project.resolveObjects(input.object);
    for (const object of objects) object.materialId = material.id;
    return { material: material.name, objects: objects.map((o) => o.name) };
  }, { label: 'material.assign' })),
});

command({
  id: 'texture.upload',
  category: 'materials',
  description: 'Upload an image (base64 or file path) as a project texture.',
  inputShape: { project: z.string(), name: z.string().default('upload'), data: z.string().optional(), path: z.string().optional(), mimeType: z.string().default('image/png') },
  input: schema({ project: z.string(), name: z.string().default('upload'), data: z.string().optional(), path: z.string().optional(), mimeType: z.string().default('image/png') }),
  handler: async (input) => withProject(input.project, async (project) => {
    const bytes = input.data ? Buffer.from(String(input.data).includes(',') ? String(input.data).split(',').pop() : input.data, 'base64') : await readFileMaybe(input.path);
    return project.mutate(async () => {
      const { texture, image } = await addImageTexture(project, { name: input.name, bytes, mimeType: input.mimeType });
      return { texture: { id: texture.id, name: texture.name, width: image.width, height: image.height } };
    }, { label: 'texture.upload' });
  }),
});

command({
  id: 'texture.paint',
  category: 'materials',
  description: 'Paint brush strokes into a texture in UV space (0..1 coordinates).',
  inputShape: { project: z.string(), texture: z.string().optional(), object: z.string().optional(), strokes: z.array(z.any()), size: number().default(1024) },
  input: schema({
    project: z.string(),
    texture: z.string().optional(),
    object: z.string().optional(),
    strokes: z.array(z.any()).min(1),
    size: z.coerce.number().int().min(64).max(4096).default(1024),
  }),
  examples: ['modelstudio paint --project Demo --object Body --strokes \'[{"x":0.5,"y":0.6,"radius":0.05,"color":[1,0,0]}]\''],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    let textureRef = input.texture;
    if (!textureRef && input.object) {
      const object = project.requireObject(input.object);
      const material = project.data.materials[object.materialId];
      textureRef = material?.baseColorTexture ?? null;
      if (!textureRef) {
        const created = addSolidTexture(project, { name: `${object.name}_paint`, color: material?.baseColorFactor ?? [0.8, 0.8, 0.8, 1], size: input.size });
        if (material) material.baseColorTexture = created.texture.id;
        textureRef = created.texture.id;
      }
    }
    const result = paintTexture(project, textureRef, input.strokes, {
      createIfMissing: { name: 'paint', color: [1, 1, 1, 1], size: input.size },
    });
    return { texture: { id: result.texture.id, name: result.texture.name, width: result.texture.width, height: result.texture.height }, touchedPixels: result.touched };
  }, { label: 'texture.paint' })),
});

command({
  id: 'texture.bake',
  category: 'materials',
  description: 'Bake albedo / AO / normal maps from geometry and assign them to the object material.',
  inputShape: {
    project: z.string(),
    object: objectSelector(),
    size: number().default(1024),
    mode: z.enum(['albedo', 'ao', 'normal', 'all']).default('all'),
    pattern: z.enum(['none', 'wood', 'stone', 'metal', 'fabric', 'skin', 'crystal']).default('none'),
    aoSamples: number().default(12),
    perTexel: bool().default(false),
  },
  input: schema({
    project: z.string(),
    object: z.string().default('all'),
    size: z.coerce.number().int().min(64).max(2048).default(1024),
    mode: z.enum(['albedo', 'ao', 'normal', 'all']).default('all'),
    pattern: z.enum(['none', 'wood', 'stone', 'metal', 'fabric', 'skin', 'crystal']).default('none'),
    aoSamples: z.coerce.number().int().min(1).max(64).default(12),
    perTexel: z.coerce.boolean().default(false),
  }),
  examples: ['modelstudio bake --project Demo --object Chair --size 1024 --pattern wood'],
  handler: async (input) => withProject(input.project, async (project) => {
    if (input.object === 'all' && Object.keys(project.data.objects).length > 1) {
      fail('ambiguous_object', 'texture.bake needs a single object; pass `object` when the project has several', {
        details: { objects: Object.values(project.data.objects).map((o) => o.name) },
      });
    }
    const object = project.requireObject(input.object === 'all' ? Object.values(project.data.objects)[0]?.name ?? 'all' : input.object);
    const geo = project.getGeometry(object);
    if (vertexCount(geo) === 0) fail('empty_geometry', 'Object has no geometry');
    const needsUv = uvCoverage(geo) < 0.001;
    const working = needsUv ? projectUV(geo, { projection: 'auto' }) : geo;
    const started = Date.now();
    // Per-texel AO (lazy, one occluder grid per triangle) instead of a full
    // per-vertex pass: minutes -> seconds on dense meshes.
    const aoField = input.mode === 'normal'
      ? null
      : bakeAOField(working, { samples: input.aoSamples, perTexel: input.perTexel });
    const material = project.data.materials[object.materialId];
    const baseColor = material?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    const produced = {};
    return project.mutate(async () => {
      if (needsUv) project.setGeometry(object, working);
      if (input.mode === 'albedo' || input.mode === 'all') {
        const bake = bakeBaseColor(working, { size: input.size, aoField, pattern: input.pattern, baseColor: baseColor.slice(0, 3) });
        const texture = project.addTexture({ name: `${object.name}_albedo`, mimeType: 'image/png', data: bake.png, width: input.size, height: input.size, metadata: { bake: 'albedo' } });
        if (material) material.baseColorTexture = texture.id;
        produced.albedo = { textureId: texture.id, coverage: bake.coverage };
      }
      if (input.mode === 'ao') {
        const bake = bakeAO(working, { size: input.size, aoField });
        const texture = project.addTexture({ name: `${object.name}_ao`, mimeType: 'image/png', data: bake.png, width: input.size, height: input.size, metadata: { bake: 'ao' } });
        produced.ao = { textureId: texture.id };
      }
      if (input.mode === 'normal') {
        const bake = bakeNormal(working, { size: input.size });
        const texture = project.addTexture({ name: `${object.name}_normal`, mimeType: 'image/png', data: bake.png, width: input.size, height: input.size, metadata: { bake: 'normal' } });
        produced.normal = { textureId: texture.id };
      }
      // Mean AO is a cheap, honest "how much shading did this bake capture"
      // number for the UI and for regression tests.
      const aoMean = aoField ? meanAO(working, aoField) : undefined;
      return {
        object: object.name,
        produced,
        generatedUVs: needsUv,
        elapsedMs: Date.now() - started,
        aoSamples: aoField?.samples ?? 0,
        aoPerTexel: Boolean(aoField?.perTexel),
        aoMean,
      };
    }, { label: `texture.bake:${input.mode}` });
  }),
});

/**
 * Average AO over a mesh, sampled at the midpoints of up to 4096 triangles.
 * Used for the reported `aoMean` without paying for a full per-vertex pass.
 */
function meanAO(geo, aoField) {
  const triCount = Math.floor(geo.indices.length / 3);
  if (!triCount) return 1;
  const stride = Math.max(1, Math.floor(triCount / 4096));
  let sum = 0;
  let n = 0;
  for (let t = 0; t < triCount; t += stride) {
    const ia = geo.indices[t * 3];
    const ib = geo.indices[t * 3 + 1];
    const ic = geo.indices[t * 3 + 2];
    sum += aoField.sample({ ia, ib, ic, w0: 1 / 3, w1: 1 / 3, w2: 1 / 3 });
    n += 1;
  }
  return Number((sum / Math.max(1, n)).toFixed(3));
}

async function readFileMaybe(file) {
  if (!file) fail('invalid_argument', 'Provide data (base64) or path');
  const fs = await import('node:fs/promises');
  return fs.readFile(file);
}

// ---------------------------------------------------------------------------
// Rigging
// ---------------------------------------------------------------------------

command({
  id: 'rig.create',
  category: 'rigging',
  description: 'Auto-generate a skeleton sized to the mesh (humanoid or quadruped) and bind skin weights.',
  inputShape: { project: z.string(), object: z.string(), name: z.string().optional(), mode: z.enum(['auto', 'humanoid', 'quadruped']).default('auto'), falloff: number().default(3.2), smoothing: number().default(2) },
  input: schema({
    project: z.string(),
    object: objectSelector(),
    name: z.string().optional(),
    mode: z.enum(['auto', 'humanoid', 'quadruped']).default('auto'),
    falloff: z.coerce.number().min(1).max(12).default(3.2),
    smoothing: z.coerce.number().int().min(0).max(10).default(2),
  }),
  examples: ['modelstudio rig --project Demo --object Character'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const geo = project.getGeometry(object);
    const skeletonInput = humanoidSkeleton(geo, { name: input.name ?? `${object.name}_rig`, mode: input.mode === 'auto' ? 'auto' : input.mode });
    const skeleton = project.addSkeleton(skeletonInput);
    skeleton.restWorldPositions = skeletonInput.worldPositions;
    skeleton.worldPositions = skeletonInput.worldPositions;
    const skin = computeSkinWeights(geo, skeleton, { falloff: input.falloff, smoothing: input.smoothing });
    project.setGeometry(object, applySkin(geo, skin));
    project.data.rigBindings[object.id] = skeleton.id;
    return {
      skeletonId: skeleton.id,
      skeleton: skeletonReport(skeleton),
      skin: skin.stats,
      object: object.name,
    };
  }, { label: 'rig.create' })),
});

command({
  id: 'rig.list',
  category: 'rigging',
  description: 'List skeletons and bound objects.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => ({
    skeletons: Object.values(project.data.skeletons).map((s) => ({ ...skeletonReport(s), boundObjects: Object.entries(project.data.rigBindings).filter(([, id]) => id === s.id).map(([objectId]) => project.data.objects[objectId]?.name) })),
    animations: Object.values(project.data.animations).map((a) => ({ id: a.id, name: a.name, duration: a.duration, tracks: a.tracks.length, skeletonId: a.skeletonId })),
  })),
});

command({
  id: 'rig.bind',
  category: 'rigging',
  description: 'Compute and apply skin weights for an object against an existing skeleton.',
  inputShape: { project: z.string(), object: z.string(), skeleton: z.string(), falloff: number().default(3.2), smoothing: number().default(2) },
  input: schema({ project: z.string(), object: z.string(), skeleton: z.string(), falloff: z.coerce.number().default(3.2), smoothing: z.coerce.number().int().default(2) }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const skeleton = project.requireSkeleton(input.skeleton);
    const geo = project.getGeometry(object);
    const skin = computeSkinWeights(geo, skeleton, { falloff: input.falloff, smoothing: input.smoothing });
    project.setGeometry(object, applySkin(geo, skin));
    project.data.rigBindings[object.id] = skeleton.id;
    return { object: object.name, skeletonId: skeleton.id, skin: skin.stats };
  }, { label: 'rig.bind' })),
});

command({
  id: 'rig.correct-weights',
  category: 'rigging',
  description: 'Clean up skin weights: repair unweighted vertices, prune influences, renormalise, smooth and symmetrise.',
  inputShape: { project: z.string(), object: z.string(), limitInfluences: number().default(4), smoothing: number().default(1), symmetry: bool().default(false) },
  input: schema({
    project: z.string(),
    object: z.string(),
    limitInfluences: z.coerce.number().int().min(1).max(4).default(4),
    smoothing: z.coerce.number().int().min(0).max(8).default(1),
    symmetry: z.coerce.boolean().default(false),
  }),
  examples: ['modelstudio rigid.correct-weights --project Demo --object Character --symmetry'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const object = project.requireObject(input.object);
    const geo = project.getGeometry(object);
    const skeletonId = project.data.rigBindings[object.id];
    const skeleton = skeletonId ? project.data.skeletons[skeletonId] : null;
    const result = correctSkinWeights(geo, skeleton, {
      limitInfluences: input.limitInfluences,
      smoothing: input.smoothing,
      symmetry: input.symmetry,
    });
    project.setGeometry(object, result.geometry);
    return { object: object.name, report: result.report };
  }, { label: 'rig.correct-weights' })),
});

command({
  id: 'rig.pose',
  category: 'rigging',
  description: 'Set bone rotations in degrees by bone name (applies to the stored skeleton).',
  inputShape: { project: z.string(), skeleton: z.string(), rotations: z.any(), applyToMesh: bool().default(false) },
  input: schema({ project: z.string(), skeleton: z.string(), rotations: z.any(), applyToMesh: z.coerce.boolean().default(false) }),
  examples: ['modelstudio pose --project Demo --skeleton Character_rig --rotations \'{"upper_arm.L":[-45,0,0]}\''],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const skeleton = project.requireSkeleton(input.skeleton);
    const applied = poseSkeleton(skeleton, input.rotations ?? {});
    return { skeletonId: skeleton.id, applied: Object.keys(applied) };
  }, { label: 'rig.pose' })),
});

command({
  id: 'rig.edit-bone',
  category: 'rigging',
  description: 'Edit a bone: rename, reparent or move its rest position.',
  inputShape: { project: z.string(), skeleton: z.string(), bone: z.string(), name: z.string().optional(), parent: z.string().nullable().optional(), translation: z.any().optional() },
  input: schema({
    project: z.string(),
    skeleton: z.string(),
    bone: z.string(),
    name: z.string().optional(),
    parent: z.string().nullable().optional(),
    translation: z.any().optional(),
  }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const skeleton = project.requireSkeleton(input.skeleton);
    const id = skeleton.jointOrder.find((j) => j === input.bone || skeleton.nodes[j].name === input.bone);
    if (!id) fail('bone_not_found', `No bone matches "${input.bone}"`, { status: 404 });
    if (input.name) skeleton.nodes[id].name = input.name;
    if (input.parent !== undefined) {
      if (input.parent && !Object.keys(skeleton.nodes).some((j) => j === input.parent || skeleton.nodes[j].name === input.parent)) {
        fail('bone_not_found', `No parent bone matches "${input.parent}"`, { status: 404 });
      }
      skeleton.nodes[id].parent = input.parent ? (skeleton.nodes[input.parent] ? input.parent : skeleton.jointOrder.find((j) => skeleton.nodes[j].name === input.parent)) : null;
    }
    if (input.translation) skeleton.nodes[id].translation = vec3(input.translation, [0, 0, 0], 'translation');
    return { bone: skeleton.nodes[id] };
  }, { label: 'rig.edit-bone' })),
});

command({
  id: 'rig.inspect',
  category: 'rigging',
  description: 'Inspect a skeleton: bones, world positions, weight quality of bound meshes.',
  mutates: false,
  inputShape: { project: z.string(), skeleton: z.string().optional(), object: z.string().optional() },
  input: schema({ project: z.string(), skeleton: z.string().optional(), object: z.string().optional() }),
  handler: async (input) => withProject(input.project, async (project) => {
    const skeletons = input.skeleton
      ? [project.requireSkeleton(input.skeleton)]
      : Object.values(project.data.skeletons);
    const objects = input.object ? project.resolveObjects(input.object) : Object.values(project.data.objects);
    return {
      skeletons: skeletons.map((s) => ({ ...skeletonReport(s), bones: skeletonBones(s) })),
      weights: objects.filter((o) => project.getGeometry(o).weights?.some?.((w) => w > 0)).map((o) => {
        const geo = project.getGeometry(o);
        return { object: o.name, ...(geo.weights.length ? weightQuality(geo, geo) : {}) };
      }),
    };
  }),
});

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

command({
  id: 'animation.list',
  category: 'animation',
  description: 'List available procedural clips and clips stored on the project.',
  mutates: false,
  inputShape: { project: z.string().optional() },
  input: schema({ project: z.string().optional() }),
  handler: async (input) => {
    const stored = input.project
      ? await withProject(input.project, async (project) => Object.values(project.data.animations).map((a) => ({ id: a.id, name: a.name, duration: a.duration, tracks: a.tracks.length })))
      : [];
    return { clips: listClips(), stored };
  },
});

command({
  id: 'animation.create',
  category: 'animation',
  description: 'Add a procedural animation clip to the project for a skeleton.',
  inputShape: { project: z.string(), skeleton: z.string().default('all'), clip: z.string().default('idle'), fps: number().default(30) },
  input: schema({ project: z.string(), skeleton: z.string().default('all'), clip: z.string().default('idle'), fps: z.coerce.number().int().default(30) }),
  examples: ['modelstudio animate --project Demo --skeleton Character_rig --clip walk'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const skeleton = project.requireSkeleton(input.skeleton === 'all' ? newestSkeleton(project).name : input.skeleton);
    const animation = buildClip(skeleton, input.clip);
    const id = newId('anim');
    project.data.animations[id] = {
      id,
      ...animation,
      skeletonId: skeleton.id,
      fps: input.fps,
      createdAt: nowIso(),
    };
    return { animation: { id, name: animation.name, duration: animation.duration, tracks: animation.tracks.length }, skeletonId: skeleton.id };
  }, { label: `animation.create:${input.clip}` })),
});

command({
  id: 'animation.sample',
  category: 'animation',
  description: 'Sample an animation at a time and optionally apply the pose to the skeleton.',
  inputShape: { project: z.string(), animation: z.string(), time: number().default(0), apply: bool().default(true) },
  input: schema({ project: z.string(), animation: z.string(), time: z.coerce.number().default(0), apply: z.coerce.boolean().default(true) }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const animation = project.data.animations[input.animation]
      ?? Object.values(project.data.animations).find((a) => a.name === input.animation);
    if (!animation) fail('animation_not_found', `No animation "${input.animation}"`, { status: 404 });
    const pose = sampleClip(animation, input.time);
    if (input.apply && animation.skeletonId) {
      const skeleton = project.data.skeletons[animation.skeletonId];
      if (skeleton) {
        for (const [bone, quaternion] of Object.entries(pose)) {
          const id = skeleton.jointOrder.find((j) => skeleton.nodes[j].name === bone);
          if (id) skeleton.nodes[id].rotation = quaternion;
        }
      }
    }
    return { animation: animation.name, time: input.time, pose };
  }, { label: 'animation.sample', save: input.apply })),
});

command({
  id: 'animation.delete',
  category: 'animation',
  description: 'Delete a stored animation clip.',
  inputShape: { project: z.string(), animation: z.string() },
  input: schema({ project: z.string(), animation: z.string() }),
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const id = project.data.animations[input.animation] ? input.animation : Object.values(project.data.animations).find((a) => a.name === input.animation)?.id;
    if (!id) fail('animation_not_found', `No animation "${input.animation}"`, { status: 404 });
    delete project.data.animations[id];
    return { deleted: id };
  }, { label: 'animation.delete' })),
});

// ---------------------------------------------------------------------------
// Import / export / preview
// ---------------------------------------------------------------------------

command({
  id: 'import.glb',
  category: 'import-export',
  description: 'Import a glTF/GLB file (from disk or base64) into the project, including skins and animations.',
  inputShape: { project: z.string(), path: z.string().optional(), data: z.string().optional(), namePrefix: z.string().default(''), applyMaterials: bool().default(true) },
  input: schema({
    project: z.string(),
    path: z.string().optional(),
    data: z.string().optional(),
    namePrefix: z.string().default(''),
    applyMaterials: z.coerce.boolean().default(true),
  }),
  examples: ['modelstudio import character.glb --project Demo', 'modelstudio import.glb --project Demo --path ./character.glb'],
  handler: async (input) => withProject(input.project, async (project) => {
    let bytes;
    if (input.path) bytes = await readFileMaybe(input.path);
    else if (input.data) bytes = Buffer.from(String(input.data).includes(',') ? String(input.data).split(',').pop() : input.data, 'base64');
    else fail('invalid_argument', 'Provide path or data');
    return project.mutate(async () => {
      const result = await importIntoProject(project, bytes, { namePrefix: input.namePrefix, applyMaterials: input.applyMaterials, sourceName: input.path ?? 'upload' });
      return {
        imported: result.objects.map((o) => ({ id: o.id, name: o.name, triangles: triangleCount(project.getGeometry(o)) })),
        skeletons: result.skeletonIds.length,
        animations: result.animationCount,
        diagnostics: result.diagnostics,
        project: project.summary(),
      };
    }, { label: 'import.glb' });
  }),
});

command({
  id: 'import.inspect',
  category: 'import-export',
  description: 'Inspect an external glTF/GLB file without importing it.',
  mutates: false,
  inputShape: { path: z.string().optional(), data: z.string().optional() },
  input: schema({ path: z.string().optional(), data: z.string().optional() }),
  handler: async (input) => {
    const bytes = input.path ? await readFileMaybe(input.path) : Buffer.from(String(input.data).split(',').pop(), 'base64');
    const parsed = await readGltf(bytes, { sourceName: input.path ?? 'inline' });
    return {
      objects: parsed.objects.map((o) => ({
        name: o.name,
        vertices: vertexCount(o.geometry),
        triangles: triangleCount(o.geometry),
        hasUVs: o.geometry.uvs.length > 0,
        skinned: Boolean(o.geometry.weights?.length),
        bounds: boundingBox(o.geometry),
      })),
      skeletons: parsed.skeletons.map((s) => ({ name: s.name, joints: s.jointOrder.length, kind: s.kind })),
      animations: parsed.animations.map((a) => ({ name: a.name, duration: a.duration, tracks: a.tracks.length })),
      diagnostics: parsed.diagnostics,
    };
  },
});

command({
  id: 'export.glb',
  category: 'import-export',
  description: 'Export the project (or selected objects) to GLB/glTF. Writes into the project exports folder or an absolute path.',
  mutates: false,
  inputShape: {
    project: z.string(),
    format: z.enum(['glb', 'gltf']).default('glb'),
    path: z.string().optional(),
    object: z.string().default('all'),
    includeAnimations: bool().default(true),
    filename: z.string().optional(),
  },
  input: schema({
    project: z.string(),
    format: z.enum(['glb', 'gltf']).default('glb'),
    path: z.string().optional(),
    object: z.string().default('all'),
    includeAnimations: z.coerce.boolean().default(true),
    filename: z.string().optional(),
  }),
  examples: ['modelstudio export --project Demo --format glb', 'modelstudio export.glb --project Demo --path ~/Desktop/out.glb'],
  handler: async (input) => withProject(input.project, async (project) => {
    const objects = project.resolveObjects(input.object);
    return exportModel(project, objects, {
      format: input.format,
      path: input.path,
      includeAnimations: input.includeAnimations,
      filename: input.filename,
      exportsRoot: EXPORTS_ROOT,
    });
  }),
});

command({
  id: 'preview.render',
  category: 'preview',
  description: 'Render a PNG preview (software rasteriser, orbit camera) for an object or the whole project.',
  mutates: false,
  inputShape: { project: z.string(), object: z.string().default('all'), width: number().default(768), height: number().default(768), view: z.enum(['three-quarter', 'front', 'side', 'top', 'back']).default('three-quarter'), path: z.string().optional() },
  input: schema({
    project: z.string(),
    object: z.string().default('all'),
    width: z.coerce.number().int().min(64).max(2048).default(768),
    height: z.coerce.number().int().min(64).max(2048).default(768),
    view: z.enum(['three-quarter', 'front', 'side', 'top', 'back']).default('three-quarter'),
    path: z.string().optional(),
  }),
  examples: ['modelstudio preview --project Demo --object Chair --width 512'],
  handler: async (input) => withProject(input.project, async (project) => {
    const objects = project.resolveObjects(input.object);
    return renderPreviewToFile(project, objects, {
      width: input.width,
      height: input.height,
      view: input.view,
      path: input.path,
    });
  }),
});

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

command({
  id: 'workflow.run',
  category: 'workflow',
  description: 'Run a multi-step workflow (character, repair, correct, optimize, material).',
  inputShape: { project: z.string(), workflow: z.string(), input: z.any().optional(), stopOnError: bool().default(true) },
  input: schema({ project: z.string(), workflow: z.string(), input: z.any().optional(), stopOnError: z.coerce.boolean().default(true) }),
  examples: ['modelstudio workflow --project Demo --workflow optimize --input \'{"triangles":20000}\''],
  handler: async (input) => {
    const { runWorkflow } = await import('./workflows.mjs');
    return runWorkflow(input.project, input.workflow, input.input ?? {}, { stopOnError: input.stopOnError });
  },
});

command({
  id: 'workflow.list',
  category: 'workflow',
  description: 'List available workflows and their parameters.',
  mutates: false,
  inputShape: {},
  input: schema({}),
  handler: async () => {
    const { listWorkflows } = await import('./workflows.mjs');
    return { workflows: listWorkflows() };
  },
});

// ---------------------------------------------------------------------------
// 11. Immersive 3D World & WebXR Spatial Control
// ---------------------------------------------------------------------------

function spawnGeneratedInProject(project, {
  prompt,
  name = null,
  position = [0, 0, 0],
  yaw = 0,
  scaleMultiplier = 1,
  resolution = 64,
  color = null,
  extraMeta = {},
  carveClearing = true,
}) {
  const scene = sceneFromPrompt(prompt);
  const mesh = sdfToMesh(scene.shape, { resolution });
  const rawBox = boundingBox(mesh);
  const rawHeight = Math.max(0.05, rawBox.size[1]);
  const promptScale = scene.params?.scale ?? 1;
  const targetHeight = (WORLD_TARGET_HEIGHTS[scene.archetype] ?? 1.2) * promptScale * scaleMultiplier;
  const factor = Number((targetHeight / rawHeight).toFixed(4));
  const footprintRadius = Math.max(rawBox.size[0], rawBox.size[2]) * factor * 0.58;

  const matConfig = {
    ...scene.material,
    name: scene.material.name ?? scene.archetype,
    baseColorFactor: color ? [...color.slice(0, 3), 1] : (scene.material.baseColorFactor ?? [0.8, 0.8, 0.8, 1]),
  };
  const material = project.addMaterial(matConfig);
  const created = project.addObject({
    name: name ?? prompt.slice(0, 48),
    geometry: mesh,
    materialId: material.id,
    transform: {
      translation: position,
      rotation: [0, Number(yaw.toFixed(2)), 0],
      scale: [factor, factor, factor],
    },
    metadata: {
      generator: 'world-sdf',
      archetype: scene.archetype,
      prompt,
      worldHeightMeters: Number(targetHeight.toFixed(2)),
      ...extraMeta,
    },
  });

  if (carveClearing && footprintRadius >= 1.0) {
    project.data.world = normalizeWorld(project.data.world);
    addWorldClearing(project.data.world, position[0], position[2], footprintRadius + 0.65);
  }

  return {
    object: created,
    archetype: scene.archetype,
    materialId: material.id,
    worldHeightMeters: Number(targetHeight.toFixed(2)),
    footprintRadius: Number(footprintRadius.toFixed(2)),
    triangles: triangleCount(mesh),
  };
}

function projectFootprints(project, excludeId = null) {
  const list = [];
  for (const obj of Object.values(project.data.objects)) {
    if (!obj || obj.id === excludeId) continue;
    let rawSize = null;
    try {
      rawSize = boundingBox(project.getGeometry(obj)).size;
    } catch {
      rawSize = null;
    }
    list.push(computeObjectFootprint(obj, rawSize));
  }
  return list;
}

function resolveWorldObject(project, selector = 'targeted') {
  const sel = String(selector ?? 'targeted').trim();
  const vr = getVrState(project);
  if (!sel || sel === 'targeted' || sel === 'that' || sel === 'this') {
    const targetId = vr.pointer?.hitObjectId ?? vr.pin?.objectId;
    if (targetId && project.data.objects[targetId]) return project.data.objects[targetId];
    const targetName = vr.pointer?.hitObjectName ?? vr.pin?.objectName;
    if (targetName) {
      const found = project.resolveObjects(targetName)[0];
      if (found) return found;
    }
    // Fallback to most recently added object
    const all = Object.values(project.data.objects);
    if (all.length) return all[all.length - 1];
    fail('object_not_found', 'No object is currently targeted or present in the scene', { status: 404 });
  }
  const direct = project.resolveObjects(sel)[0];
  if (direct) return direct;
  const lower = sel.toLowerCase();
  const partial = Object.values(project.data.objects).filter(
    (o) => o.name.toLowerCase().includes(lower) || (o.metadata?.archetype ?? '').toLowerCase().includes(lower),
  );
  if (partial.length) {
    // Prefer targeted object if it matches, else closest to VR pointer/head
    const targetId = vr.pointer?.hitObjectId ?? vr.pin?.objectId;
    const hit = partial.find((o) => o.id === targetId);
    if (hit) return hit;
    const refPt = vr.pin?.point ?? vr.pointer?.hitPoint ?? vr.head?.position ?? [0, 0, 0];
    partial.sort((a, b) => {
      const pa = a.transform?.translation ?? [0, 0, 0];
      const pb = b.transform?.translation ?? [0, 0, 0];
      return Math.hypot(pa[0] - refPt[0], pa[2] - refPt[2]) - Math.hypot(pb[0] - refPt[0], pb[2] - refPt[2]);
    });
    return partial[0];
  }
  return project.requireObject(sel);
}

command({
  id: 'world.get',
  category: 'world',
  description: 'Inspect the 3D world environment (biome, terrain, sky, foliage) and live VR spatial state.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  examples: ['modelstudio world.get --project Demo'],
  handler: async (input) => withProject(input.project, async (project) => ({
    world: normalizeWorld(project.data.world),
    biomes: listBiomes(),
    timePresets: Object.keys(TIME_PRESETS),
    context: buildVrContext(project),
  })),
});

command({
  id: 'world.environment',
  category: 'world',
  description:
    'Transform the surrounding 3D world: apply a biome preset (hayfield, meadow, forest, snow, desert, beach, mars, night-clearing, cyberpunk, courtyard, studio), time of day, rolling hills, sky, fog, and wind-swaying foliage.',
  inputShape: {
    project: z.string(),
    biome: z.string().optional(),
    timeOfDay: z.string().optional(),
    hillHeight: number().optional(),
    hillScale: number().optional(),
    groundColor: z.array(number()).optional(),
    grid: bool().optional(),
    scatterProps: bool().default(false),
    clearFoliage: bool().default(false),
  },
  input: schema({
    project: z.string(),
    biome: z.enum(Object.keys(BIOMES)).optional(),
    timeOfDay: z.enum(Object.keys(TIME_PRESETS)).optional(),
    hillHeight: z.coerce.number().min(0).max(12).optional(),
    hillScale: z.coerce.number().min(0.005).max(0.25).optional(),
    groundColor: z.array(z.coerce.number()).min(3).max(4).optional(),
    ground: z.record(z.string(), z.any()).optional(),
    sky: z.record(z.string(), z.any()).optional(),
    fog: z.record(z.string(), z.any()).optional(),
    foliage: z.array(z.record(z.string(), z.any())).optional(),
    grid: z.coerce.boolean().optional(),
    scatterProps: z.coerce.boolean().default(false),
    clearFoliage: z.coerce.boolean().default(false),
    resetClearings: z.coerce.boolean().default(false),
  }),
  examples: [
    'modelstudio biome --project Demo --biome hayfield --scatterProps true',
    'modelstudio world.environment --project Demo --biome forest --timeOfDay sunset',
  ],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const nextWorld = applyWorldEnvironment(project.data.world, input);
    project.data.world = nextWorld;

    const scattered = [];
    if (input.biome) {
      // Remove previous auto-scattered biome props while keeping user-spawned buildings & objects.
      for (const [id, obj] of Object.entries(project.data.objects)) {
        if (obj.metadata?.biomeProp) {
          delete project.data.objects[id];
        } else {
          // Re-ground user objects to the new terrain hill height.
          const pos = obj.transform?.translation ?? [0, 0, 0];
          obj.transform = {
            ...obj.transform,
            translation: [pos[0], Number(terrainHeightAt(nextWorld, pos[0], pos[2]).toFixed(3)), pos[2]],
          };
        }
      }
    }

    if (input.scatterProps && input.biome && BIOMES[input.biome]?.defaultScatter?.length) {
      const vr = getVrState(project);
      const center = vr.head?.position ?? [0, 0, 3.5];
      const rng = makeRandom(hashString(`${project.id}:${input.biome}`));
      for (const group of BIOMES[input.biome].defaultScatter) {
        const scene = sceneFromPrompt(group.prompt);
        const mesh = sdfToMesh(scene.shape, { resolution: 48 });
        const rawHeight = Math.max(0.05, boundingBox(mesh).size[1]);
        const baseTarget = WORLD_TARGET_HEIGHTS[scene.archetype] ?? 1.2;
        const material = project.addMaterial({
          ...scene.material,
          name: scene.material.name ?? scene.archetype,
        });
        for (let i = 0; i < group.count; i += 1) {
          const angle = rng() * Math.PI * 2;
          const dist = group.minRadius + rng() * (group.radius - group.minRadius);
          const x = Number((center[0] + Math.cos(angle) * dist).toFixed(3));
          const z = Number((center[2] + Math.sin(angle) * dist).toFixed(3));
          const y = Number(terrainHeightAt(nextWorld, x, z).toFixed(3));
          const vary = 0.82 + rng() * 0.38;
          const factor = Number(((baseTarget * vary) / rawHeight).toFixed(4));
          const yaw = Number((rng() * 360).toFixed(1));
          const obj = project.addObject({
            name: group.prompt,
            geometry: cloneGeometry(mesh),
            materialId: material.id,
            transform: { translation: [x, y, z], rotation: [0, yaw, 0], scale: [factor, factor, factor] },
            metadata: { generator: 'world-biome-scatter', archetype: scene.archetype, biomeProp: true },
          });
          scattered.push({ id: obj.id, name: obj.name, position: [x, y, z] });
        }
      }
    }

    return { world: nextWorld, scattered };
  }, { label: `world.environment:${input.biome ?? input.timeOfDay ?? 'custom'}` })),
});

command({
  id: 'world.spawn',
  category: 'world',
  description:
    'Generate and place a 1:1 VR-scale 3D building, prop, creature, or character at a spatial target ("pointer" = where the VR user points / "right there", "in-front", "left", "right", "behind", or [x,y,z]), grounded to the terrain.',
  inputShape: {
    project: z.string(),
    prompt: z.string().min(1),
    at: z.any().default('pointer'),
    name: z.string().optional(),
    scale: number().default(1),
    yaw: number().optional(),
    facePlayer: bool().default(true),
    snap: bool().default(true),
    gridSnap: number().default(0),
    distance: number().default(8),
    resolution: number().default(64),
  },
  input: schema({
    project: z.string(),
    prompt: z.string().min(1),
    at: z.any().default('pointer'),
    name: z.string().optional(),
    scale: z.coerce.number().min(0.05).max(30).default(1),
    yaw: z.coerce.number().optional(),
    facePlayer: z.coerce.boolean().default(true),
    snap: z.coerce.boolean().default(true),
    gridSnap: z.coerce.number().min(0).max(20).default(0),
    distance: z.coerce.number().min(0.5).max(120).default(8),
    resolution: z.coerce.number().int().min(24).max(160).default(64),
    pointer: z.record(z.string(), z.any()).optional(),
    head: z.record(z.string(), z.any()).optional(),
  }),
  examples: [
    'modelstudio spawn --project Demo --prompt "green barn" --at pointer',
    'modelstudio world.spawn --project Demo --prompt "tall windmill" --at -12,0,-18',
  ],
  handler: async (input) => withProject(input.project, async (project) => {
    if (input.pointer || input.head) {
      await updateVrState(project, { pointer: input.pointer, head: input.head }, { immediate: true });
    }
    const loc = resolveSpatialLocation(project, input.at, {
      distance: input.distance,
      snapToGround: true,
      overridePointer: input.pointer,
      overrideHead: input.head,
    });
    const initialYaw = input.yaw !== undefined ? Number(input.yaw) : (input.facePlayer ? loc.yawToPlayerDeg : 0);
    return project.mutate(async () => {
      const others = projectFootprints(project);
      const spawned = spawnGeneratedInProject(project, {
        prompt: input.prompt,
        name: input.name,
        position: loc.position,
        yaw: initialYaw,
        scaleMultiplier: input.scale,
        resolution: input.resolution,
      });

      let finalPos = [...loc.position];
      let finalYaw = initialYaw;
      let snapInfo = { snapped: false, kind: 'free' };

      if (input.snap || input.gridSnap > 0) {
        const world = normalizeWorld(project.data.world);
        const rawSize = boundingBox(project.getGeometry(spawned.object)).size;
        const movingFp = computeObjectFootprint(spawned.object, rawSize);
        snapInfo = solveSmartPlacement(movingFp, others, {
          snapEnabled: input.snap,
          gridSnap: input.gridSnap,
          terrainHeightFn: (x, z) => terrainHeightAt(world, x, z),
        });
        if (snapInfo.snapped) {
          finalPos = snapInfo.position.map((n) => Number(n.toFixed(3)));
          finalYaw = snapInfo.yawDeg;
          spawned.object.transform = {
            ...spawned.object.transform,
            translation: finalPos,
            rotation: [0, Number(finalYaw.toFixed(2)), 0],
          };
        }
      }

      return {
        object: {
          id: spawned.object.id,
          name: spawned.object.name,
          archetype: spawned.archetype,
          position: finalPos,
          yaw: Number(finalYaw.toFixed(2)),
          worldHeightMeters: spawned.worldHeightMeters,
          triangles: spawned.triangles,
        },
        placementSource: loc.source,
        snap: snapInfo,
      };
    }, { label: `world.spawn:${input.prompt.slice(0, 28)}` });
  }),
});

command({
  id: 'world.snap',
  category: 'world',
  description:
    'Snap a fence end-to-end onto the nearest existing fence, magnetically align an object to nearby structures, or snap to a world grid.',
  inputShape: {
    project: z.string(),
    object: z.string().default('targeted'),
    mode: z.string().default('auto'),
    gridSnap: number().default(0),
    snapRadius: number().default(8),
  },
  input: schema({
    project: z.string(),
    object: z.string().default('targeted'),
    mode: z.enum(['auto', 'fence', 'align', 'grid']).default('auto'),
    gridSnap: z.coerce.number().min(0).max(20).default(0),
    snapRadius: z.coerce.number().min(0.2).max(40).default(8),
  }),
  examples: ['modelstudio world.snap --project Demo --object fence_2'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const obj = resolveWorldObject(project, input.object);
    const world = normalizeWorld(project.data.world);
    const terrainFn = (x, z) => terrainHeightAt(world, x, z);
    const rawSize = boundingBox(project.getGeometry(obj)).size;
    const movingFp = computeObjectFootprint(obj, rawSize);
    const others = projectFootprints(project, obj.id);

    let outcome = { snapped: false, kind: 'none', position: movingFp.position, yawDeg: movingFp.yawDeg };

    if ((input.mode === 'auto' || input.mode === 'fence') && movingFp.archetype === 'fence') {
      const fs = computeFenceSnap(movingFp, others, { snapRadius: input.snapRadius, terrainHeightFn: terrainFn });
      if (fs.snapped) outcome = fs;
    }
    if (!outcome.snapped && (input.mode === 'auto' || input.mode === 'align')) {
      const al = computeStructureAlignment(movingFp, others, {
        maxRange: Math.max(14, input.snapRadius * 2),
        angleThresholdDeg: 45,
        axisThresholdMeters: 1.25,
        terrainHeightFn: terrainFn,
      });
      if (al.aligned) outcome = { ...al, snapped: true };
    }
    if (!outcome.snapped && (input.mode === 'grid' || input.gridSnap > 0)) {
      const step = input.gridSnap > 0 ? input.gridSnap : 0.5;
      outcome = solveSmartPlacement(movingFp, [], { snapEnabled: false, gridSnap: step, terrainHeightFn: terrainFn });
    }

    if (outcome.snapped) {
      const pos = outcome.position.map((n) => Number(n.toFixed(3)));
      const yaw = Number(outcome.yawDeg.toFixed(2));
      obj.transform = {
        ...obj.transform,
        translation: pos,
        rotation: [0, yaw, 0],
      };
    }

    return {
      id: obj.id,
      name: obj.name,
      snapped: outcome.snapped,
      kind: outcome.kind,
      position: obj.transform.translation,
      rotation: obj.transform.rotation,
      targetName: outcome.targetName ?? null,
    };
  }, { label: `world.snap:${input.object}` })),
});

command({
  id: 'world.duplicate',
  category: 'world',
  description:
    'Duplicate a world object grounded on the terrain; for fences, automatically extends the fence line end-to-end onto an open post.',
  inputShape: {
    project: z.string(),
    object: z.string().default('targeted'),
    snapEndToEnd: bool().default(true),
    cornerDeg: number().default(0),
    offset: z.any().optional(),
  },
  input: schema({
    project: z.string(),
    object: z.string().default('targeted'),
    snapEndToEnd: z.coerce.boolean().default(true),
    cornerDeg: z.coerce.number().default(0),
    offset: z.any().optional(),
  }),
  examples: ['modelstudio world.duplicate --project Demo --object "wooden fence"'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const source = resolveWorldObject(project, input.object);
    const world = normalizeWorld(project.data.world);
    const rawSize = boundingBox(project.getGeometry(source)).size;
    const fp = computeObjectFootprint(source, rawSize);
    const others = projectFootprints(project, source.id);

    let nextPos;
    let nextYaw = fp.yawDeg;

    if (input.offset) {
      const off = vec3(input.offset, [0, 0, 0], 'offset');
      nextPos = [fp.position[0] + off[0], fp.position[1] + off[1], fp.position[2] + off[2]];
    } else if (fp.archetype === 'fence' && input.snapEndToEnd) {
      const ends = fenceEndpoints(fp);
      // Prefer whichever post (+X or -X) doesn't already have an adjacent fence within 0.6 m
      const postOccupied = (pt) => others.some((o) => {
        if (o.archetype !== 'fence') return false;
        const oe = fenceEndpoints(o);
        return Math.hypot(oe.plus[0] - pt[0], oe.plus[2] - pt[2]) < 0.6
          || Math.hypot(oe.minus[0] - pt[0], oe.minus[2] - pt[2]) < 0.6;
      });
      const useMinus = postOccupied(ends.plus) && !postOccupied(ends.minus);
      const anchor = useMinus ? ends.minus : ends.plus;
      const dirSign = useMinus ? -1 : 1;
      nextYaw = fp.yawDeg + (Number(input.cornerDeg) || 0);
      const { localX } = localAxesFromYaw(nextYaw);
      nextPos = [
        anchor[0] + localX[0] * dirSign * ends.halfSpan,
        anchor[1],
        anchor[2] + localX[2] * dirSign * ends.halfSpan,
      ];
    } else {
      const { localX } = localAxesFromYaw(fp.yawDeg);
      const step = Math.max(1.2, fp.size[0] + 0.85);
      nextPos = [fp.position[0] + localX[0] * step, fp.position[1], fp.position[2] + localX[2] * step];
    }

    nextPos[1] = Number(terrainHeightAt(world, nextPos[0], nextPos[2]).toFixed(3));
    nextPos = nextPos.map((n) => Number(n.toFixed(3)));

    const copy = project.addObject({
      name: `${source.name.replace(/_\d+$/, '')}_${Object.keys(project.data.objects).length + 1}`,
      geometry: project.getGeometry(source),
      materialId: source.materialId,
      transform: {
        translation: nextPos,
        rotation: [0, Number(nextYaw.toFixed(2)), 0],
        scale: [...(source.transform?.scale ?? [1, 1, 1])],
      },
      metadata: { ...source.metadata, duplicatedFrom: source.id },
    });
    if (project.data.rigBindings[source.id]) {
      project.data.rigBindings[copy.id] = project.data.rigBindings[source.id];
    }

    return {
      id: copy.id,
      name: copy.name,
      position: nextPos,
      yaw: Number(nextYaw.toFixed(2)),
      archetype: fp.archetype,
    };
  }, { label: `world.duplicate:${input.object}` })),
});

command({
  id: 'world.scatter',
  category: 'world',
  description: 'Scatter multiple 1:1 VR-scale 3D objects (e.g. hay bales, pine trees, rocks, fences) across the terrain around the player or pointer.',
  inputShape: {
    project: z.string(),
    prompt: z.string().min(1),
    count: number().default(6),
    at: z.any().default('around-player'),
    radius: number().default(26),
    minRadius: number().default(5),
    resolution: number().default(48),
  },
  input: schema({
    project: z.string(),
    prompt: z.string().min(1),
    count: z.coerce.number().int().min(1).max(40).default(6),
    at: z.any().default('around-player'),
    radius: z.coerce.number().min(1).max(120).default(26),
    minRadius: z.coerce.number().min(0).max(80).default(5),
    scale: z.coerce.number().min(0.1).max(10).default(1),
    seed: z.coerce.number().int().optional(),
    resolution: z.coerce.number().int().min(24).max(112).default(48),
  }),
  examples: ['modelstudio scatter --project Demo --prompt "golden haybale" --count 8'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const world = normalizeWorld(project.data.world);
    const centerLoc = input.at === 'around-player'
      ? resolveSpatialLocation(project, 'player')
      : resolveSpatialLocation(project, input.at);
    const minR = input.at === 'around-player' ? Math.max(3.5, input.minRadius) : Math.min(input.minRadius, input.radius * 0.25);
    const maxR = Math.max(minR + 1, input.radius);

    const scene = sceneFromPrompt(input.prompt);
    const mesh = sdfToMesh(scene.shape, { resolution: input.resolution });
    const rawHeight = Math.max(0.05, boundingBox(mesh).size[1]);
    const baseHeight = (WORLD_TARGET_HEIGHTS[scene.archetype] ?? 1.2) * (scene.params?.scale ?? 1) * input.scale;
    const material = project.addMaterial({
      ...scene.material,
      name: scene.material.name ?? scene.archetype,
    });

    const rng = makeRandom(input.seed ?? hashString(`${input.prompt}:${Date.now()}`));
    const created = [];
    for (let i = 0; i < input.count; i += 1) {
      const a = rng() * Math.PI * 2;
      const r = minR + Math.sqrt(rng()) * (maxR - minR);
      const x = Number((centerLoc.position[0] + Math.cos(a) * r).toFixed(3));
      const z = Number((centerLoc.position[2] + Math.sin(a) * r).toFixed(3));
      const y = Number(terrainHeightAt(world, x, z).toFixed(3));
      const vary = 0.84 + rng() * 0.34;
      const factor = Number(((baseHeight * vary) / rawHeight).toFixed(4));
      const yaw = Number((rng() * 360).toFixed(1));
      const obj = project.addObject({
        name: input.prompt.slice(0, 36),
        geometry: cloneGeometry(mesh),
        materialId: material.id,
        transform: { translation: [x, y, z], rotation: [0, yaw, 0], scale: [factor, factor, factor] },
        metadata: { generator: 'world-scatter', archetype: scene.archetype, prompt: input.prompt },
      });
      created.push({ id: obj.id, name: obj.name, position: [x, y, z] });
    }
    return { archetype: scene.archetype, count: created.length, center: centerLoc.position, created };
  }, { label: `world.scatter:${input.prompt.slice(0, 24)}x${input.count}` })),
});

command({
  id: 'world.clear',
  category: 'world',
  description: 'Remove objects from the 3D world (all or matching a name filter) and optionally reset the world environment.',
  inputShape: { project: z.string(), filter: z.string().optional(), resetEnvironment: bool().default(false) },
  input: schema({
    project: z.string(),
    filter: z.string().optional(),
    resetEnvironment: z.coerce.boolean().default(false),
  }),
  examples: ['modelstudio world.clear --project Demo --resetEnvironment true'],
  handler: async (input) => withProject(input.project, async (project) => project.mutate(async () => {
    const needle = input.filter && input.filter !== 'all' ? input.filter.toLowerCase() : null;
    const removed = [];
    for (const [id, obj] of Object.entries(project.data.objects)) {
      if (!needle || obj.name.toLowerCase().includes(needle) || obj.metadata?.archetype?.toLowerCase() === needle) {
        removed.push(obj.name);
        delete project.data.objects[id];
        delete project.data.rigBindings[id];
      }
    }
    if (!needle) project.data.world = { ...normalizeWorld(project.data.world), clearings: [] };
    if (input.resetEnvironment) project.data.world = defaultWorld();
    return { removedCount: removed.length, removed, world: project.data.world };
  }, { label: 'world.clear' })),
});

command({
  id: 'vr.point',
  category: 'vr',
  description:
    'Update the live VR headset pose, controller/hand pointing ray, raycast hit point, and optional "right there" spatial pin.',
  mutates: false,
  inputShape: {
    project: z.string(),
    inVR: bool().optional(),
    device: z.string().optional(),
    head: z.any().optional(),
    pointer: z.any().optional(),
    pin: z.any().optional(),
    pinCurrent: bool().optional(),
    clearPin: bool().optional(),
  },
  input: schema({
    project: z.string(),
    inVR: z.coerce.boolean().optional(),
    device: z.string().optional(),
    head: z.record(z.string(), z.any()).optional(),
    pointer: z.record(z.string(), z.any()).optional(),
    controllers: z.record(z.string(), z.any()).optional(),
    pin: z.any().optional(),
    pinCurrent: z.coerce.boolean().optional(),
    clearPin: z.coerce.boolean().optional(),
  }),
  examples: ['modelstudio vr.point --project Demo --pin "[8,0,-12]"'],
  handler: async (input) => withProject(input.project, async (project) => {
    const parsedPin = typeof input.pin === 'string'
      ? input.pin.replace(/^\[|\]$/g, '').split(/[\s,]+/).map(Number)
      : input.pin;
    const vr = await updateVrState(project, { ...input, pin: parsedPin });
    return { vr, rightThere: vr.pin?.point ?? vr.pointer?.hitPoint };
  }),
});

command({
  id: 'vr.context',
  category: 'vr',
  description:
    'Read the live VR spatial briefing: headset position/gaze, controller ray hit ("right there"), targeted object ("that"), biome, and relative distances/directions to nearby objects.',
  mutates: false,
  inputShape: { project: z.string() },
  input: schema({ project: z.string() }),
  examples: ['modelstudio vr --project Demo'],
  handler: async (input) => withProject(input.project, async (project) => buildVrContext(project)),
});

command({
  id: 'world.prompt',
  category: 'world',
  description:
    'Execute a natural-language spatial world command (spoken or typed inside VR, e.g. "make this a hayfield and put a green barn right there") using the live VR pointer context and either a configured OpenAI-compatible LLM or the built-in offline spatial planner.',
  inputShape: {
    project: z.string(),
    instruction: z.string().min(1),
    provider: z.enum(['auto', 'openai', 'local']).default('auto'),
    pointer: z.any().optional(),
    head: z.any().optional(),
  },
  input: schema({
    project: z.string(),
    instruction: z.string().min(1),
    provider: z.enum(['auto', 'openai', 'local']).default('auto'),
    pointer: z.record(z.string(), z.any()).optional(),
    head: z.record(z.string(), z.any()).optional(),
    inVR: z.coerce.boolean().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  examples: [
    'modelstudio say --project Demo --instruction "make this a hayfield and put a green barn right there"',
  ],
  handler: async (input) => withProject(input.project, async (project) => executeWorldPrompt({
    project,
    runCommand,
    instruction: input.instruction,
    pointer: input.pointer ?? null,
    head: input.head ?? null,
    inVR: input.inVR,
    provider: input.provider,
    model: input.model ?? null,
    baseUrl: input.baseUrl ?? null,
    apiKey: input.apiKey ?? null,
  })),
});

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

export function listCommands() {
  return COMMANDS.map((c) => ({
    id: c.id,
    category: c.category,
    description: c.description,
    mutates: c.mutates,
    examples: c.examples,
    inputSchema: zodToJsonSchema(c.input),
  }));
}

export function getCommand(id) {
  const entry = COMMANDS.find((c) => c.id === id);
  if (!entry) return null;
  // Cache the JSON Schema on the entry so the CLI and skill docs can read it.
  if (!entry.inputSchema) entry.inputSchema = zodToJsonSchema(entry.input);
  return entry;
}

/**
 * Run one command. All interfaces funnel through here.
 * @returns {Promise<{ok:boolean, command:string, data?:any, error?:object, durationMs:number}>}
 */
export async function runCommand(id, rawInput = {}) {
  const started = Date.now();
  const entry = getCommand(id);
  if (!entry) {
    return {
      ok: false,
      command: id,
      durationMs: Date.now() - started,
      error: {
        code: 'unknown_command',
        message: `Unknown command "${id}"`,
        details: { available: COMMANDS.map((c) => c.id) },
      },
    };
  }
  try {
    const parsed = entry.input.parse(rawInput);
    const data = await entry.handler(parsed);
    return { ok: true, command: id, durationMs: Date.now() - started, data };
  } catch (error) {
    return { ok: false, command: id, durationMs: Date.now() - started, error: toErrorPayload(error) };
  }
}

export function toErrorPayload(error) {
  if (error instanceof ModelStudioError) {
    return { code: error.code, message: error.message, status: error.status, ...(error.details !== undefined ? { details: error.details } : {}), ...(error.hint ? { hint: error.hint } : {}) };
  }
  if (error?.issues) {
    return { code: 'validation_failed', message: 'Input did not match the command schema', details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
  }
  return { code: 'internal_error', message: error?.message ?? String(error) };
}

/** Minimal zod -> JSON Schema conversion (subset used by our command inputs). */
export function zodToJsonSchema(schemaDef, { required = true } = {}) {
  return typeToJson(schemaDef, required);
}

function objectToJsonSchema(shape) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(shape)) {
    const json = typeToJson(value, true);
    properties[key] = json;
    if (json._required === true) required.push(key);
    delete json._required;
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function typeToJson(def, isRequired = true) {
  const json = convert(def) ?? {};
  json._required = json._required === false ? false : Boolean(isRequired);
  return json;
}

function convert(def) {
  if (!def || !def._def) return {};
  const d = def._def;
  const description = d.description ?? d.innerType?._def?.description;
  const base = description ? { description } : {};
  switch (d.type) {
    case 'object': {
      const shape = typeof d.shape === 'function' ? d.shape() : d.shape ?? {};
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => {
        const child = typeToJson(v, true);
        delete child._required;
        return [k, child];
      })), required: Object.entries(shape).filter(([, v]) => v._def.type !== 'optional' && v._def.type !== 'default').map(([k]) => k), additionalProperties: false };
    }
    case 'string': {
      const out = { type: 'string', ...base };
      for (const check of d.checks ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
      }
      return out;
    }
    case 'number': {
      const out = { type: 'number', ...base };
      for (const check of d.checks ?? []) {
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
        if (check.kind === 'int') out.type = 'integer';
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean', ...base };
    case 'enum':
      return { type: 'string', enum: Object.values(d.entries ?? d.values ?? {}), ...base };
    case 'array':
      return { type: 'array', items: typeToJson(d.element, true), ...(d.checks ?? []).reduce((acc, c) => (c.kind === 'min' ? { ...acc, minItems: c.value } : acc), {}), ...base };
    case 'default': {
      const inner = convert(d.innerType) ?? {};
      let defaultValue;
      try {
        defaultValue = typeof d.defaultValue === 'function' ? d.defaultValue() : d.defaultValue;
      } catch {
        defaultValue = undefined;
      }
      return { ...inner, default: defaultValue, _required: false };
    }
    case 'optional':
    case 'nullable':
      return { ...(convert(d.innerType) ?? {}), _required: false, ...base };
    case 'literal':
      return { enum: [d.value], ...base };
    case 'any':
      return { ...base };
    case 'union':
      return { anyOf: (d.options ?? []).map((o) => typeToJson(o, true)), ...base };
    case 'pipeline':
    case 'effects':
    case 'prefault':
      return { ...(convert(d.in ?? d.schema ?? d.innerType) ?? {}), ...base };
    default:
      return { type: d.type ?? 'unknown', ...base };
  }
}

export { COMMANDS, PROJECTS_ROOT, EXPORTS_ROOT, summarizeProject, cloneGeometry, normalizeGeometry, makeGeometry, encodePng, solidImage, toRgba, decodeImage, hasArchetype, ARCHETYPES, humanoid, sdf, MATERIAL_PRESETS, triangleCount, vertexCount, inspectGeometry };
