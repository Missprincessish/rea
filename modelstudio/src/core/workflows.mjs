// Reusable modeling workflows. Each workflow is a declarative list of registry
// commands, executed in order against the same project. Because the steps are
// ordinary commands, the same workflow can be replayed from the CLI, the API,
// the MCP server or the browser editor.
import { Project } from './project.mjs';
import { getCommand, runCommand } from './operations.mjs';
import { fail } from './util.mjs';

export const WORKFLOWS = {
  character: {
    id: 'character',
    label: 'Character from references',
    description:
      'Reference images -> visual-hull mesh -> repair -> UV -> albedo bake -> auto rig -> weight cleanup -> idle animation -> GLB export.',
    params: {
      prompt: { type: 'string', description: 'Optional prompt used when no reference images are supplied' },
      images: { type: 'array', description: '[{data|textureId|path, angle}] reference views' },
      resolution: { type: 'number', default: 96 },
      triangles: { type: 'number', description: 'Optional decimation target' },
      clip: { type: 'string', default: 'idle' },
      exportPath: { type: 'string' },
      rig: { type: 'boolean', default: true },
    },
    steps: (params) => {
      const steps = [];
      if (params.images?.length) {
        steps.push({ command: 'generate.image', input: { images: params.images, resolution: params.resolution ?? 96, name: params.name ?? 'Character' } });
      } else if (params.prompt) {
        steps.push({ command: 'generate.text', input: { prompt: params.prompt, resolution: params.resolution ?? 96 } });
      } else {
        fail('invalid_argument', 'character workflow needs `images` or `prompt`');
      }
      steps.push({ command: 'mesh.repair', input: { object: 'all' } });
      if (params.triangles) steps.push({ command: 'mesh.decimate', input: { object: 'all', triangles: params.triangles } });
      steps.push({ command: 'mesh.uv', input: { object: 'all', projection: 'cylindrical' } });
      steps.push({ command: 'texture.bake', input: { object: 'all', mode: 'all', size: params.bakeSize ?? 1024, pattern: params.pattern ?? 'skin', aoSamples: 8 } });
      if (params.rig !== false) {
        steps.push({ command: 'rig.create', input: { object: 'all', mode: 'auto' } });
        steps.push({ command: 'rig.correct-weights', input: { object: 'all', symmetry: true } });
        steps.push({ command: 'animation.create', input: { skeleton: 'all', clip: params.clip ?? 'idle' } });
      }
      steps.push({ command: 'export.glb', input: { format: 'glb', path: params.exportPath } });
      return steps;
    },
  },

  repair: {
    id: 'repair',
    label: 'Model repair',
    description: 'Import (optional) -> inspect -> weld/cleanup/fill holes -> optional remesh -> preserve UVs -> export.',
    params: {
      importPath: { type: 'string' },
      remesh: { type: 'boolean', default: false },
      resolution: { type: 'number', default: 128 },
      exportPath: { type: 'string' },
    },
    steps: (params) => {
      const steps = [];
      if (params.importPath) steps.push({ command: 'import.glb', input: { path: params.importPath } });
      steps.push({ command: 'object.inspect', input: { object: 'all' } });
      steps.push({ command: 'mesh.repair', input: { object: 'all', fillHoles: true } });
      if (params.remesh) {
        steps.push({ command: 'mesh.remesh', input: { object: 'all', resolution: params.resolution ?? 128, transferUV: true } });
      }
      steps.push({ command: 'mesh.recompute-normals', input: { object: 'all' } });
      steps.push({ command: 'export.glb', input: { format: 'glb', path: params.exportPath } });
      return steps;
    },
  },

  correct: {
    id: 'correct',
    label: 'Character correction',
    description: 'Select body region -> sculpt -> repair weights -> symmetrise -> export.',
    params: {
      object: { type: 'string', description: 'Object to correct (default: all)' },
      center: { type: 'array', description: '[x,y,z] brush centre' },
      radius: { type: 'number', default: 0.2 },
      strength: { type: 'number', default: 0.02 },
      mode: { type: 'string', default: 'inflate' },
      symmetry: { type: 'boolean', default: true },
      exportPath: { type: 'string' },
    },
    steps: (params) => {
      const steps = [];
      if (params.center) {
        steps.push({ command: 'mesh.sculpt', input: {
          object: params.object ?? 'all',
          center: params.center,
          radius: params.radius ?? 0.2,
          strength: params.strength ?? 0.02,
          mode: params.mode ?? 'inflate',
        } });
      }
      if (params.symmetry) steps.push({ command: 'mesh.symmetrize', input: { object: params.object ?? 'all', axis: 'x', keep: 'positive' } });
      steps.push({ command: 'mesh.repair', input: { object: params.object ?? 'all' } });
      steps.push({ command: 'rig.correct-weights', input: { object: params.object ?? 'all', symmetry: params.symmetry } });
      steps.push({ command: 'export.glb', input: { format: 'glb', path: params.exportPath } });
      return steps;
    },
  },

  optimize: {
    id: 'optimize',
    label: 'Game optimisation',
    description: 'Import high-poly -> repair -> decimate -> bake maps -> export low-poly GLB.',
    params: {
      importPath: { type: 'string' },
      triangles: { type: 'number', default: 30000 },
      bake: { type: 'boolean', default: true },
      exportPath: { type: 'string' },
    },
    steps: (params) => {
      const steps = [];
      if (params.importPath) steps.push({ command: 'import.glb', input: { path: params.importPath } });
      steps.push({ command: 'mesh.repair', input: { object: 'all' } });
      steps.push({ command: 'mesh.decimate', input: { object: 'all', triangles: params.triangles ?? 30000 } });
      if (params.bake !== false) steps.push({ command: 'texture.bake', input: { object: 'all', mode: 'all', size: params.bakeSize ?? 1024 } });
      steps.push({ command: 'export.glb', input: { format: 'glb', path: params.exportPath } });
      return steps;
    },
  },

  material: {
    id: 'material',
    label: 'Material correction',
    description: 'Import textured model -> edit materials -> rebake albedo with AO -> export.',
    params: {
      importPath: { type: 'string' },
      material: { type: 'object', description: '{baseColorFactor, roughnessFactor, ...} or {preset}' },
      pattern: { type: 'string' },
      exportPath: { type: 'string' },
    },
    steps: (params) => {
      const steps = [];
      if (params.importPath) steps.push({ command: 'import.glb', input: { path: params.importPath } });
      if (params.material) {
        if (params.material.preset) steps.push({ command: 'material.create', input: { preset: params.material.preset, name: params.material.name ?? params.material.preset, assignTo: params.object ?? 'all' } });
        else steps.push({ command: 'material.edit', input: { material: params.materialName ?? 'all', changes: params.material } });
      }
      steps.push({ command: 'texture.bake', input: { object: params.object ?? 'all', mode: 'albedo', size: params.bakeSize ?? 1024, pattern: params.pattern ?? 'none' } });
      steps.push({ command: 'export.glb', input: { format: 'glb', path: params.exportPath } });
      return steps;
    },
  },
};

export function listWorkflows() {
  return Object.values(WORKFLOWS).map((w) => ({
    id: w.id,
    label: w.label,
    description: w.description,
    params: w.params,
  }));
}

/**
 * Execute a workflow.
 * @returns {Promise<{workflow:string, project:string, steps:Array, ok:boolean}>}
 */
export async function runWorkflow(projectRef, workflowId, params = {}, { stopOnError = true } = {}) {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) fail('unknown_workflow', `Unknown workflow "${workflowId}"`, { status: 404, details: { available: Object.keys(WORKFLOWS) } });
  const project = await Project.open(projectRef);
  const steps = workflow.steps(params);
  const generatesFirst = steps.some((step) => step.command === 'generate.text' || step.command === 'generate.image' || step.command === 'generate.shape' || step.command === 'import.glb');
  if (!generatesFirst && Object.keys(project.data.objects).length === 0) {
    fail('project_empty', `Project "${project.data.name}" has no geometry yet`, {
      status: 422,
      hint: 'Generate or import a model first, or pass `images`/`prompt`/`importPath` to the workflow.',
      details: { workflow: workflowId },
    });
  }
  // Fill in the object selector defaults with the resolved target when needed.
  const results = [];
  let ok = true;
  for (const step of steps) {
    const input = { ...step.input };
    if (input.object === 'all') delete input.object;
    if (input.object === '') delete input.object;
    // Steps run through runCommand, which reopens the project: read the live
    // state so later steps see objects/skeletons created by earlier ones.
    const live = await Project.open(project.data.name);
    const cmdSchema = getCommand(step.command)?.inputSchema;
    const needsSkeleton = cmdSchema?.required?.includes('skeleton') || Object.prototype.hasOwnProperty.call(cmdSchema?.properties ?? {}, 'skeleton');
    if (needsSkeleton) {
      if (input.skeleton === 'all' || input.skeleton === undefined) {
        const skeletons = Object.values(live.data.skeletons);
        if (skeletons.length) input.skeleton = skeletons[skeletons.length - 1].name;
        else if (!stopOnError) {
          results.push({ command: step.command, ok: false, error: { code: 'no_skeleton', message: 'Skipped: project has no skeleton yet' } });
          continue;
        }
      }
    }
    // Commands that operate on a single object get the newest object when the
    // workflow used the `all` selector.
    const needsOneObject = cmdSchema?.required?.includes('object') || step.command === 'rig.create' || step.command === 'texture.bake';
    if (needsOneObject && (!input.object || input.object === 'all')) {
      const objects = Object.values(live.data.objects);
      if (objects.length) input.object = objects[objects.length - 1].name;
    }
    const run = await runCommand(step.command, { project: project.data.name, ...input });
    results.push({ command: step.command, ok: run.ok, durationMs: run.durationMs, ...(run.ok ? { data: run.data } : { error: run.error }) });
    if (!run.ok) {
      ok = false;
      if (stopOnError) break;
    }
  }
  const fresh = await Project.open(project.data.name);
  return {
    workflow: workflowId,
    ok,
    steps: results,
    project: fresh.summary(),
  };
}
