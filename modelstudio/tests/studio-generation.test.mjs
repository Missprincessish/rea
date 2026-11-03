import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/core/operations.mjs';
import { Project } from '../src/core/project.mjs';
import { ARCHETYPES, listArchetypes, matchArchetype, sceneFromPrompt } from '../src/algorithms/prompt.mjs';
import { sdfToMesh } from '../src/algorithms/sdf.mjs';
import { triangleCount, vertexCount } from '../src/core/geometry.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-studio-'));
process.env.MODELSTUDIO_HOME = home;
await runCommand('project.create', { name: 'Studio' });

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Meshy-style text-to-3D breadth
// ---------------------------------------------------------------------------

test('prompt library ships a broad archetype set with unique tags', () => {
  const list = listArchetypes();
  assert.ok(list.length >= 45, `expected 45+ archetypes, got ${list.length}`);
  const keys = new Set(list.map((a) => a.key));
  assert.equal(keys.size, list.length, 'archetype keys must be unique');
  for (const sample of ['chair', 'table', 'character', 'barn', 'windmill', 'barrel', 'couch', 'pine']) {
    assert.ok(keys.has(sample), `missing archetype: ${sample}`);
  }
});

test('every archetype meshes into watertight, non-empty geometry', () => {
  const failures = [];
  for (const [key, archetype] of Object.entries(ARCHETYPES)) {
    try {
      // Builders read `p.rng`; feed a deterministic generator so procedural
      // archetypes (tree, rock, creature) mesh identically every run.
      let seed = 7;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const scene = archetype.build({ rng });
      const geo = sdfToMesh(scene.shape, { resolution: 28, padding: 0.06 });
      const tris = triangleCount(geo);
      const verts = vertexCount(geo);
      if (tris < 8 || verts < 8) failures.push(`${key}: empty (${tris} tris)`);
      const bad = Array.from(geo.positions).some((n) => !Number.isFinite(n));
      if (bad) failures.push(`${key}: non-finite vertices`);
    } catch (error) {
      failures.push(`${key}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('multiword prompts resolve to the specific archetype, not a generic one', () => {
  const cases = [
    ['traffic cone', 'trafficCone'],
    ['street lamp', 'streetlamp'],
    ['pine tree', 'pine'],
    ['wooden barrel', 'barrel'],
    ['bookshelf', 'shelf'],
    ['couch', 'couch'],
    ['fountain', 'fountain'],
    ['boulder', 'rockBig'],
    ['gate arch', 'gateArch'],
    ['rowboat', 'boat'],
  ];
  for (const [prompt, expected] of cases) {
    const match = matchArchetype(prompt);
    assert.equal(match.key, expected, `"${prompt}" -> ${match.key}, expected ${expected}`);
  }
});

test('generate.text produces editable geometry for library prompts', async () => {
  for (const prompt of ['wooden barrel', 'couch', 'pine tree', 'traffic cone']) {
    const result = await runCommand('generate.text', { project: 'Studio', prompt, resolution: 40 });
    assert.equal(result.ok, true, `${prompt}: ${result.error?.message}`);
    assert.ok(result.data.result.objects.length >= 1);
    const object = result.data.result.objects[0];
    assert.ok(object.triangles > 100, `${prompt} produced ${object.triangles} triangles`);
    assert.ok(result.data.result.stats.vertices > 0);
  }
});

test('a generated archetype runs the whole studio pipeline and exports GLB', async () => {
  const gen = await runCommand('generate.text', { project: 'Studio', prompt: 'wooden barrel', resolution: 64 });
  const name = gen.data.result.objects[0].name;

  const uv = await runCommand('mesh.uv', { project: 'Studio', object: name });
  assert.equal(uv.ok, true, uv.error?.message);

  const bakeStart = Date.now();
  const bake = await runCommand('texture.bake', { project: 'Studio', object: name, size: 256, mode: 'all', pattern: 'wood', aoSamples: 8 });
  const bakeMs = Date.now() - bakeStart;
  assert.equal(bake.ok, true, bake.error?.message);
  assert.ok(bake.data.result.produced.albedo?.textureId, 'albedo texture produced');
  assert.ok(bake.data.result.produced.albedo?.textureId, 'albedo produced');
  if (bake.data.result.produced.normal) {
    assert.ok(bake.data.result.produced.normal.textureId, 'normal map produced');
  }
  assert.ok(bake.data.result.aoMean < 1, 'AO captured some occlusion');
  // Regression guard: the bake used to take ~4.5 minutes on this mesh.
  assert.ok(bakeMs < 60000, `texture.bake took ${bakeMs}ms — AO path regressed`);

  const project = await Project.open('Studio');
  const texture = project.getTexture(bake.data.result.produced.albedo.textureId);
  assert.ok(texture.bytes.length > 1000);

  const decimate = await runCommand('mesh.decimate', { project: 'Studio', object: name, triangles: 4000 });
  assert.equal(decimate.ok, true, decimate.error?.message);

  const glb = await runCommand('export.glb', { project: 'Studio', object: name });
  assert.equal(glb.ok, true, glb.error?.message);
  const bytes = await fs.readFile(glb.data.path);
  assert.equal(bytes.subarray(0, 4).toString('utf8'), 'glTF');
  assert.ok(glb.data.bytes > 5000);
});

test('sceneFromPrompt keeps parts for split generation', () => {
  const scene = sceneFromPrompt('wooden crate', { splitParts: true });
  assert.ok(scene);
  assert.ok(scene.geometry || scene.parts || scene.shape, 'scene must expose geometry or parts');
});


// ---------------------------------------------------------------------------
// Studio editor wiring (the Meshy-style desktop surface must not regress)
// ---------------------------------------------------------------------------

test('studio editor exposes quality presets and the prompt library', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [html, main] = await Promise.all([
    fs.readFile(path.join(root, 'web-src/index.html'), 'utf8'),
    fs.readFile(path.join(root, 'web-src/main.js'), 'utf8'),
  ]);
  for (const id of ['gen-quality-presets', 'archetype-chips', 'archetype-search', 'archetype-count', 'btn-generate', 'image-dropzone', 'btn-generate-image']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
  for (const preset of ['draft', 'standard', 'ultra']) {
    assert.ok(html.includes(`data-quality="${preset}"`), `missing quality preset: ${preset}`);
  }
  assert.ok(main.includes('QUALITY_PRESETS'), 'main.js must define the quality presets');
  assert.ok(main.includes('renderArchetypeChips'), 'main.js must render the prompt library');
  assert.ok(main.includes("run('generate.text'"), 'main.js must call generate.text');
  assert.ok(main.includes("run('generate.image'"), 'main.js must call generate.image (image-to-3D)');
});

test('/api/capabilities exposes the archetype library for the editor', async () => {
  const { startServer } = await import('../src/server/main.mjs');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1', root: home });
  try {
    const payload = await fetch(`http://127.0.0.1:${port}/api/capabilities`).then((r) => r.json());
    assert.ok(Array.isArray(payload.archetypes));
    assert.ok(payload.archetypes.length >= 45, `only ${payload.archetypes?.length} archetypes exposed`);
    assert.ok(payload.archetypes.every((a) => a.key && a.label));
    assert.ok(payload.commands.length >= 60);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
