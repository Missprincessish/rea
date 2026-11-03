// End-to-end tests for the modeling engine and every control surface.
//
// Run with: npm test   (node --test tests/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelstudio-test-'));
process.env.MODELSTUDIO_HOME = WORKSPACE;
process.env.MODELSTUDIO_EXPORTS = path.join(WORKSPACE, 'exports');

const { runCommand, listCommands, getCommand } = await import('../src/core/operations.mjs');
const { Project } = await import('../src/core/project.mjs');
const { inspectGeometry, triangleCount, vertexCount, boundingBox } = await import('../src/core/geometry.mjs');
const { readGltf } = await import('../src/core/gltf.mjs');
const { encodePng, decodePng } = await import('../src/algorithms/bake.mjs');
const { visualHull } = await import('../src/algorithms/reconstruct.mjs');
const { openApiDocument } = await import('../src/server/openapi.mjs');

const PROJECT = 'TestProject';
let projectDir = null;

async function ok(command, input = {}) {
  const result = await runCommand(command, input);
  if (!result.ok) {
    throw new Error(`${command} failed: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

before(async () => {
  const created = await ok('project.create', { name: PROJECT });
  projectDir = created.dir;
});

after(async () => {
  await fsp.rm(WORKSPACE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// registry + docs
// ---------------------------------------------------------------------------

test('command registry is complete and documented', () => {
  const commands = listCommands();
  assert.ok(commands.length >= 45, `expected many commands, got ${commands.length}`);
  for (const command of commands) {
    assert.ok(command.id.includes('.'), `${command.id} should be namespaced`);
    assert.ok(command.description.length > 10, `${command.id} needs a description`);
    assert.equal(command.inputSchema.type, 'object');
  }
  const ids = commands.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'command ids must be unique');
  // The capabilities the brief requires must exist.
  for (const required of [
    'generate.text', 'generate.image', 'mesh.repair', 'mesh.remesh', 'mesh.decimate',
    'mesh.uv', 'texture.bake', 'texture.paint', 'rig.create', 'rig.correct-weights',
    'animation.create', 'import.glb', 'export.glb', 'preview.render', 'mesh.sculpt',
    'material.edit', 'project.undo', 'workflow.run',
  ]) {
    assert.ok(ids.includes(required), `missing command ${required}`);
  }
});

test('OpenAPI document covers every command', () => {
  const document = openApiDocument();
  assert.equal(document.openapi, '3.1.0');
  for (const command of listCommands()) {
    assert.ok(document.paths[`/api/commands/${command.id}`], `missing path for ${command.id}`);
  }
  assert.ok(document.paths['/api/projects/{project}/preview']);
});

test('validation errors are structured', async () => {
  const result = await runCommand('mesh.decimate', { project: PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'validation_failed');
  assert.ok(result.error.details.issues.length > 0);
});

// ---------------------------------------------------------------------------
// generation (real geometry, both text and image paths)
// ---------------------------------------------------------------------------

test('text prompt generates editable watertight geometry', async () => {
  const data = await ok('generate.text', { project: PROJECT, prompt: 'realistic wooden chair', resolution: 72 });
  assert.equal(data.result.provider, 'local');
  assert.equal(data.result.archetype, 'chair');
  const objects = await ok('object.inspect', { project: PROJECT });
  const chair = objects.objects[0];
  assert.ok(chair.triangles > 1000, 'should produce a real mesh');
  assert.equal(chair.watertight, true, 'local generator should emit closed surfaces');
  assert.equal(chair.duplicateTriangles, 0);
  assert.equal(chair.degenerateTriangles, 0);
});

test('prompt parameters change the generated geometry', async () => {
  await ok('project.create', { name: 'Params' });
  const tall = await ok('generate.text', { project: 'Params', prompt: 'tall female character', resolution: 64 });
  const short = await ok('generate.text', { project: 'Params', prompt: 'short female character', resolution: 64 });
  const tallObject = await (async () => (await Project.open('Params')).resolveObjects(tall.result.objects[0].name)[0])();
  const shortObject = await (async () => (await Project.open('Params')).resolveObjects(short.result.objects[0].name)[0])();
  const project = await Project.open('Params');
  const tallHeight = boundingBox(project.getGeometry(tallObject)).size[1];
  const shortHeight = boundingBox(project.getGeometry(shortObject)).size[1];
  assert.ok(tallHeight > shortHeight, `tall (${tallHeight}) should exceed short (${shortHeight})`);
});

test('unmatched prompt returns an actionable error', async () => {
  const result = await runCommand('generate.text', { project: PROJECT, prompt: 'zzzz nothing here' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'prompt_unmatched');
  assert.ok(result.error.hint.includes('archetypes'));
});

test('image reconstruction builds a hull from silhouettes', async () => {
  await ok('project.create', { name: 'Images' });
  const image = syntheticFigure();
  const rawHull = visualHull([{ image, angle: 0 }, { image, angle: 90 }], { resolution: 64 });
  const hullStats = inspectGeometry(rawHull);
  assert.equal(hullStats.watertight, true, 'raw visual hull should be closed and manifold');
  assert.equal(hullStats.degenerateTriangles, 0);

  const png = encodePng(image);
  const base64 = Buffer.from(png).toString('base64');
  const data = await ok('generate.image', {
    project: 'Images',
    images: [{ data: base64, angle: 0 }, { data: base64, angle: 90 }],
    resolution: 64,
  });
  assert.ok(data.result.object.triangles > 1000);
  assert.equal(data.result.hull.views, 2);
  assert.ok(data.result.limitations.length > 0, 'limitations must be reported');
});

test('SDF shape spec generation', async () => {
  const data = await ok('generate.shape', {
    project: PROJECT,
    name: 'SpecShape',
    resolution: 48,
    spec: { op: 'subtract', child: { op: 'box', size: [0.4, 0.4, 0.4] }, children: [{ op: 'sphere', radius: 0.42 }] },
  });
  assert.ok(data.result.stats.triangles > 100);
});

// ---------------------------------------------------------------------------
// geometry operations
// ---------------------------------------------------------------------------

test('decimation preserves attributes and hits the target', async () => {
  await ok('mesh.uv', { project: PROJECT, object: 'all' });
  const target = 3000;
  const data = await ok('mesh.decimate', { project: PROJECT, object: 'all', triangles: target });
  const stats = data.result.results[0].stats;
  assert.ok(stats.trianglesAfter <= target * 1.05, `got ${stats.trianglesAfter} tris`);
  assert.ok(stats.trianglesAfter >= target * 0.85, `too aggressive: ${stats.trianglesAfter}`);
  const inspect = await ok('object.inspect', { project: PROJECT, object: 'all' });
  assert.equal(inspect.objects[0].hasUVs, true, 'UVs must survive decimation');
});

test('repair fixes broken meshes', async () => {
  await ok('project.create', { name: 'Repair' });
  await ok('object.add', { project: 'Repair', primitive: 'cylinder', name: 'Broken', options: { segments: 48 } });
  // Break it: punch a small hole by deleting a handful of faces.
  const project = await Project.open('Repair');
  await project.mutate(async () => {
    const object = project.resolveObjects('Broken')[0];
    const geo = project.getGeometry(object);
    project.setGeometry(object, { ...geo, indices: geo.indices.slice(0, geo.indices.length - 6) });
  }, { label: 'break' });
  const before = (await ok('object.inspect', { project: 'Repair', object: 'Broken' })).objects[0];
  assert.ok(before.boundaryEdges > 0, 'test fixture should have holes');
  const repaired = await ok('mesh.repair', { project: 'Repair', object: 'Broken' });
  const after = (await ok('object.inspect', { project: 'Repair', object: 'Broken' })).objects[0];
  assert.ok(after.boundaryEdges < before.boundaryEdges, 'holes should be reduced');
  assert.ok(repaired.result.results[0].stats.actions.length > 0);
  assert.equal(after.looseVertices, 0);
});

test('remesh produces uniform topology and transfers UVs', async () => {
  const data = await ok('mesh.remesh', { project: PROJECT, object: 'all', resolution: 72 });
  const stats = data.result.results[0];
  assert.ok(stats.trianglesAfter > 0);
  assert.equal(stats.transfer.coverage, 1);
  assert.equal(stats.transfer.transferredUV, true);
});

test('UV projection covers the mesh', async () => {
  const data = await ok('mesh.uv', { project: PROJECT, projection: 'cylindrical' });
  assert.ok(data.result.results[0].stats.uvCoverage > 0.2);
  assert.equal(data.result.results[0].stats.uvCoverage <= 1.05, true);
});

test('sculpt modifies vertex positions with a radial falloff', async () => {
  const project = await Project.open(PROJECT);
  const object = project.resolveObjects('all')[0];
  const geometry = project.getGeometry(object);
  const before = Float32Array.from(geometry.positions);
  // Brush centre must sit on the surface (a bounding-box centre can be empty air).
  const center = [geometry.positions[0], geometry.positions[1], geometry.positions[2]];
  const data = await ok('mesh.sculpt', {
    project: PROJECT,
    object: object.name,
    center,
    radius: 0.15,
    strength: 0.05,
    mode: 'inflate',
  });
  assert.ok(data.result.affected > 0);
  const afterHandle = await Project.open(PROJECT);
  const after = afterHandle.getGeometry(afterHandle.resolveObjects(object.name)[0]).positions;
  let moved = 0;
  for (let i = 0; i < before.length; i += 3) {
    if (Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2]) > 1e-6) moved += 1;
  }
  assert.ok(moved > 0, 'geometry must actually change');
  // The brush reports vertices it touched; a vertex sitting exactly in the
  // falloff's outermost ring can round to no displacement, so allow tiny drift.
  assert.ok(Math.abs(moved - data.result.affected) <= 2, `moved ${moved} vs reported ${data.result.affected}`);
});

test('transforms can be baked into geometry', async () => {
  await ok('project.create', { name: 'Transform' });
  await ok('object.add', { project: 'Transform', primitive: 'cube', name: 'Box' });
  const before = (await ok('object.inspect', { project: 'Transform' })).objects[0].boundingBox;
  await ok('object.transform', { project: 'Transform', object: 'Box', translation: [1, 2, 3], applyToGeometry: true });
  const after = (await ok('object.inspect', { project: 'Transform' })).objects[0].boundingBox;
  assert.ok(Math.abs(after.center[0] - (before.center[0] + 1)) < 1e-4);
  assert.ok(Math.abs(after.center[1] - (before.center[1] + 2)) < 1e-4);
});

// ---------------------------------------------------------------------------
// materials + textures
// ---------------------------------------------------------------------------

test('material edits persist and are reflected in export', async () => {
  const created = await ok('material.create', { project: PROJECT, preset: 'metal', name: 'Chrome', assignTo: 'all' });
  assert.equal(created.result.material.metallicFactor, 0.95);
  const edited = await ok('material.edit', {
    project: PROJECT,
    material: 'Chrome',
    changes: { baseColorFactor: [0.9, 0.2, 0.3, 1], roughnessFactor: 0.2, emissiveFactor: [0.1, 0, 0] },
  });
  const editedMaterial = edited.material ?? edited.result.material;
  assert.deepEqual(editedMaterial.baseColorFactor, [0.9, 0.2, 0.3, 1]);
  assert.equal(editedMaterial.roughnessFactor, 0.2);

  const exported = await ok('export.glb', { project: PROJECT });
  const parsed = await readGltf(await fsp.readFile(exported.path));
  const { NodeIO } = await import('@gltf-transform/core');
  const parsedDoc = await new NodeIO().readBinary(new Uint8Array(await fsp.readFile(exported.path)));
  const materials = parsedDoc.getRoot().listMaterials();
  assert.ok(materials.length >= 1);
  assert.ok(materials.some((m) => Math.abs(m.getBaseColorFactor()[0] - 0.9) < 1e-5));
  assert.ok(parsed.objects.length >= 1);
});

test('texture bakes produce real PNG images with AO', async () => {
  const data = await ok('texture.bake', {
    project: PROJECT,
    object: (await ok('object.inspect', { project: PROJECT })).objects[0].name,
    mode: 'all',
    size: 512,
    pattern: 'wood',
    aoSamples: 6,
  });
  assert.ok(data.result.produced.albedo, 'albedo produced');
  assert.ok(data.result.aoMean < 1, 'AO should darken some texels');
  const project = await Project.open(PROJECT);
  const texture = project.getTexture(data.result.produced.albedo.textureId);
  assert.ok(texture.bytes.length > 1000);
  const decoded = decodePng(texture.bytes);
  assert.equal(decoded.width, 512);
  // the bake must actually vary across the image
  const unique = new Set();
  for (let i = 0; i < decoded.rgba.length; i += 4 * 97) unique.add(decoded.rgba[i]);
  assert.ok(unique.size > 5, 'baked texture should not be flat');
});

test('texture painting writes pixels', async () => {
  const project = await Project.open(PROJECT);
  const object = project.resolveObjects('all')[0];
  const before = await ok('texture.paint', {
    project: PROJECT,
    object: object.name,
    strokes: [{ x: 0.5, y: 0.5, radius: 0.02, color: [0, 0, 0] }],
    size: 256,
  });
  const after = await ok('texture.paint', {
    project: PROJECT,
    object: object.name,
    strokes: [{ x: 0.5, y: 0.5, radius: 0.08, color: [1, 0, 0], opacity: 1 }],
    size: 256,
  });
  assert.ok(after.result.touchedPixels > before.result.touchedPixels);
  const texture = (await Project.open(PROJECT)).getTexture(after.result.texture.id);
  const decoded = decodePng(texture.bytes);
  const center = (Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width / 2)) * 4;
  assert.ok(decoded.rgba[center] > 200, 'painted pixel should be red');
});

// ---------------------------------------------------------------------------
// rigging + animation
// ---------------------------------------------------------------------------

test('automatic rigging binds weights and animates', async () => {
  const rig = await ok('rig.create', { project: PROJECT, object: 'all' });
  assert.ok(rig.result.skeleton.bones.length >= 15, 'humanoid skeleton');
  assert.ok(rig.result.skin.averageInfluences <= 4);
  assert.equal(rig.result.skin.bonesUsed > 5, true);

  const inspect = await ok('object.inspect', { project: PROJECT });
  assert.equal(inspect.objects[0].hasSkinWeights, true);

  const corrected = await ok('rig.correct-weights', { project: PROJECT, object: 'all', symmetry: true });
  assert.equal(corrected.result.report.unweighted, 0);
  assert.ok(corrected.result.report.normalisationError < 1e-4);

  const clip = await ok('animation.create', { project: PROJECT, skeleton: rig.result.skeleton.name, clip: 'walk' });
  assert.ok(clip.result.animation.tracks >= 5);
  const sampled = await ok('animation.sample', { project: PROJECT, animation: clip.result.animation.id, time: 0.3, apply: true });
  assert.ok(Object.keys(sampled.result.pose).length > 0);
});

test('rigged and animated GLB exports skins and clips', async () => {
  const exported = await ok('export.glb', { project: PROJECT, includeAnimations: true });
  const { NodeIO } = await import('@gltf-transform/core');
  const doc = await new NodeIO().readBinary(new Uint8Array(await fsp.readFile(exported.path)));
  const skins = doc.getRoot().listSkins();
  const animations = doc.getRoot().listAnimations();
  assert.ok(skins.length >= 1, 'export must contain a skin');
  assert.ok(skins[0].listJoints().length >= 15, 'skin joints exported');
  assert.ok(animations.length >= 1, 'animation exported');
  assert.ok(animations[0].listChannels().length >= 5);
  const primitive = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.ok(primitive.getAttribute('JOINTS_0'), 'JOINTS_0 present');
  assert.ok(primitive.getAttribute('WEIGHTS_0'), 'WEIGHTS_0 present');
  assert.ok(primitive.getAttribute('TEXCOORD_0'), 'UVs present');
});

// ---------------------------------------------------------------------------
// import / export round trip
// ---------------------------------------------------------------------------

test('GLB export -> import round trip preserves the model', async () => {
  await ok('project.create', { name: 'RoundTrip' });
  await ok('generate.text', { project: 'RoundTrip', prompt: 'robot mech', resolution: 56 });
  await ok('mesh.decimate', { project: 'RoundTrip', object: 'all', triangles: 1500 });
  await ok('mesh.uv', { project: 'RoundTrip' });
  await ok('rig.create', { project: 'RoundTrip', object: 'all' });
  const exported = await ok('export.glb', { project: 'RoundTrip' });
  const bytes = await fsp.readFile(exported.path);

  const source = await Project.open('RoundTrip');
  const sourceObject = Object.values(source.data.objects)[0];
  const sourceTris = triangleCount(source.getGeometry(sourceObject));

  const imported = await ok('import.glb', { project: PROJECT, data: Buffer.from(bytes).toString('base64'), namePrefix: 'rt_' });
  assert.equal(imported.result.imported.length, 1);
  assert.equal(imported.result.imported[0].triangles, sourceTris, 'triangle count must survive the round trip');
  assert.ok(imported.result.skeletons >= 1, 'skeleton imported');
  const inspect = await ok('object.inspect', { project: PROJECT, object: imported.result.imported[0].name });
  assert.equal(inspect.objects[0].hasSkinWeights, true);
});

test('import.inspect works without mutating a project', async () => {
  const exported = await ok('export.glb', { project: PROJECT });
  const inspected = await ok('import.inspect', { path: exported.path });
  assert.ok(inspected.objects.length >= 1);
  assert.ok(inspected.diagnostics.triangles > 0);
});

// ---------------------------------------------------------------------------
// persistence, undo/redo
// ---------------------------------------------------------------------------

test('project state persists to disk and reopens identically', async () => {
  const before = await ok('project.snapshot', { project: PROJECT });
  const reopened = await Project.open(PROJECT);
  const after = reopened.summary();
  assert.equal(after.id, before.project.id);
  assert.equal(after.stats.triangles, before.project.stats.triangles);
  assert.equal(after.objects.length, before.project.objects.length);
  assert.ok(fs.existsSync(path.join(projectDir, 'project.json')));
});

test('undo and redo restore geometry exactly', async () => {
  const project = await Project.open(PROJECT);
  const object = project.resolveObjects('all')[0];
  const liveGeometry = project.getGeometry(object);
  const base = Array.from(liveGeometry.positions.slice(0, 30));
  const center = Array.from(liveGeometry.positions.slice(0, 3));
  await ok('mesh.sculpt', { project: PROJECT, object: object.name, center, radius: 0.3, strength: 0.06, mode: 'grab' });
  const mutated = await positionsOf(PROJECT, object.name);
  assert.notDeepEqual(mutated, base);
  await ok('project.undo', { project: PROJECT });
  assert.deepEqual(await positionsOf(PROJECT, object.name), base);
  await ok('project.redo', { project: PROJECT });
  assert.deepEqual(await positionsOf(PROJECT, object.name), mutated);
});

// ---------------------------------------------------------------------------
// previews
// ---------------------------------------------------------------------------

test('preview renders a non-empty PNG from real geometry', async () => {
  const data = await ok('preview.render', { project: PROJECT, width: 320, height: 320, view: 'front' });
  assert.ok(fs.existsSync(data.path));
  const decoded = decodePng(await fsp.readFile(data.path));
  assert.equal(decoded.width, 320);
  const unique = new Set();
  for (let i = 0; i < decoded.rgba.length; i += 4 * 53) {
    unique.add(`${decoded.rgba[i]},${decoded.rgba[i + 1]},${decoded.rgba[i + 2]}`);
  }
  assert.ok(unique.size > 20, 'preview should contain a rendered model, not a flat fill');
  assert.ok(data.trianglesDrawn > 100);
});

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

test('optimize workflow reduces triangles and exports', async () => {
  await ok('project.create', { name: 'Optimize' });
  await ok('generate.text', { project: 'Optimize', prompt: 'house', resolution: 56 });
  const run = (await ok('workflow.run', {
    project: 'Optimize',
    workflow: 'optimize',
    input: { triangles: 2000, exportPath: path.join(WORKSPACE, 'optimized.glb') },
  }));
  assert.equal(run.ok, true, JSON.stringify(run.steps.filter((s) => !s.ok)));
  assert.ok(fs.existsSync(path.join(WORKSPACE, 'optimized.glb')));
  const inspect = await ok('object.inspect', { project: 'Optimize' });
  assert.ok(inspect.objects[0].triangles <= 2100);
});

test('character workflow runs rigging and export end to end', async () => {
  await ok('project.create', { name: 'CharFlow' });
  const run = (await ok('workflow.run', {
    project: 'CharFlow',
    workflow: 'character',
    input: { prompt: 'female character', resolution: 56, bakeSize: 256, exportPath: path.join(WORKSPACE, 'character.glb') },
  }));
  assert.equal(run.ok, true, JSON.stringify(run.steps.filter((s) => !s.ok).map((s) => [s.command, s.error?.code])));
  const exported = run.steps.find((s) => s.command === 'export.glb');
  assert.ok(exported.data.bytes > 1000);
  assert.ok(fs.existsSync(path.join(WORKSPACE, 'character.glb')));
});

test('repair workflow handles a broken mesh', async () => {
  await ok('project.create', { name: 'RepairFlow' });
  await ok('generate.text', { project: 'RepairFlow', prompt: 'vase', resolution: 56 });
  const run = (await ok('workflow.run', {
    project: 'RepairFlow',
    workflow: 'repair',
    input: { exportPath: path.join(WORKSPACE, 'repaired.glb') },
  }));
  assert.equal(run.ok, true, JSON.stringify(run.steps.filter((s) => !s.ok)));
});

// ---------------------------------------------------------------------------
// HTTP API surface
// ---------------------------------------------------------------------------

test('HTTP API executes commands and serves previews', async () => {
  const { startServer } = await import('../src/server/main.mjs');
  const started = await startServer({ port: 0, root: WORKSPACE });
  const { server, port } = started;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);

    const created = await (await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ApiDemo' }),
    })).json();
    assert.equal(created.ok, true);

    const generated = await (await fetch(`${base}/api/projects/ApiDemo/commands/generate.text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'wooden table', resolution: 48 }),
    })).json();
    assert.equal(generated.ok, true);

    const state = await (await fetch(`${base}/api/projects/ApiDemo/state`)).json();
    assert.equal(state.ok, true);
    assert.equal(state.data.objects.length, 1);

    const preview = await fetch(`${base}/api/projects/ApiDemo/preview?width=200&height=200`);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const png = new Uint8Array(await preview.arrayBuffer());
    assert.deepEqual(Array.from(png.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);

    const openapi = await (await fetch(`${base}/api/openapi.json`)).json();
    assert.equal(openapi.openapi, '3.1.0');

    const bad = await fetch(`${base}/api/projects/ApiDemo/commands/does.not.exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(bad.status, 404);

    const batch = await (await fetch(`${base}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'ApiDemo',
        commands: [
          { command: 'mesh.decimate', input: { object: 'all', triangles: 500 } },
          { command: 'export.glb', input: {} },
        ],
      }),
    })).json();
    assert.equal(batch.ok, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CLI and API produce equivalent results', async () => {
  // Same command through the registry (API path) and through the CLI parser.
  const { resolveInput } = await import('../src/cli/main.mjs');
  await ok('project.create', { name: 'Parity' });
  await ok('object.add', { project: 'Parity', primitive: 'sphere', name: 'Ball', options: { segments: 48 } });

  const cliInput = resolveInput(getCommand('mesh.decimate'), ['--project', 'Parity', '--object', 'Ball', '--triangles', '600']);
  const viaCli = await runCommand('mesh.decimate', cliInput);
  const cliTriangles = viaCli.data.result.results[0].triangles;

  await ok('project.undo', { project: 'Parity' });
  const viaApi = await runCommand('mesh.decimate', { project: 'Parity', object: 'Ball', triangles: 600 });
  const apiTriangles = viaApi.data.result.results[0].triangles;

  assert.equal(cliTriangles, apiTriangles, 'CLI and API must run the same operation');
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test('MCP server exposes tools backed by the registry', async () => {
  const { createMcpServer } = await import('../src/mcp/server.mjs');
  const server = createMcpServer();
  assert.ok(server);
  // Exercise the underlying handlers through a light-weight fake transport.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of ['modelstudio_status', 'modelstudio_commands', 'modelstudio_run', 'modelstudio_batch', 'modelstudio_workflow', 'modelstudio_preview']) {
      assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
    }
    const result = await client.callTool({
      name: 'modelstudio_run',
      arguments: { command: 'object.list', input: { project: PROJECT } },
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok((payload.data.objects ?? payload.data.result?.objects ?? []).length >= 1);
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Reopen the project and read the first 30 position floats of a named object. */
async function positionsOf(projectName, objectName) {
  const handle = await Project.open(projectName);
  const target = handle.resolveObjects(objectName)[0];
  assert.ok(target, `object ${objectName} disappeared from ${projectName}`);
  return Array.from(handle.getGeometry(target).positions.slice(0, 30));
}

function syntheticFigure() {
  const width = 128;
  const height = 128;
  const rgba = new Uint8Array(width * height * 4);
  const ellipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const inside =
        ellipse(px, py, 64, 60, 18, 32) ||
        ellipse(px, py, 64, 26, 11, 13) ||
        ellipse(px, py, 64, 96, 14, 22) ||
        ellipse(px, py, 42, 58, 6, 24) ||
        ellipse(px, py, 86, 58, 6, 24);
      const offset = (y * width + x) * 4;
      rgba[offset] = inside ? 200 : 245;
      rgba[offset + 1] = inside ? 130 : 245;
      rgba[offset + 2] = inside ? 110 : 245;
      rgba[offset + 3] = inside ? 255 : 0;
    }
  }
  return { width, height, rgba };
}

void vertexCount;
void inspectGeometry;
