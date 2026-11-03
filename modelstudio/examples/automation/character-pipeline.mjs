#!/usr/bin/env node
// External automation example: drive ModelStudio purely over HTTP, exactly the
// way ChatGPT (or any script, CI job, or editor plugin) would.
//
//   node examples/automation/character-pipeline.mjs \
//     --prompt "tall female warrior with long hair" \
//     --out ~/Desktop/modelstudio-out
//
// The script starts nothing itself: point it at a running server
// (`npm start` / `modelstudio serve`) with --url, or let it spawn one.
//
// Every step prints the server's structured result, so a failure tells you the
// command, the error code and what was expected.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const base = args.url ?? 'http://127.0.0.1:4317';
const projectName = args.project ?? `Automation ${new Date().toISOString().slice(0, 16).replace(':', '')}`;
const outDir = path.resolve((args.out ?? path.join(os.homedir(), 'Desktop', 'modelstudio-out')).replace(/^~(?=$|\/)/, os.homedir()));
const prompt = args.prompt ?? 'tall female warrior with long hair';

let child = null;

try {
  await main();
} finally {
  if (child) child.kill();
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  await ensureServer();
  const health = await get('/api/health');
  console.log(`server ok — workspace ${health.projectsRoot ?? health.data?.projectsRoot ?? '(unknown)'}`);

  // 1. Project ------------------------------------------------------------
  await post('/api/projects', { name: projectName });
  console.log(`project "${projectName}" ready`);

  // 2. Generate -----------------------------------------------------------
  const generated = await command('generate.text', { prompt, resolution: Number(args.resolution ?? 96) });
  const objectName = generated.result.objects[0].name;
  console.log(`generated ${generated.result.archetype}: ${generated.result.objects[0].triangles} tris`);

  // 3. Bake a full pipeline in one batch ----------------------------------
  const batch = await post('/api/batch', {
    project: projectName,
    commands: [
      { command: 'mesh.repair', input: { object: objectName } },
      { command: 'mesh.uv', input: { object: objectName, projection: 'cylindrical' } },
      { command: 'texture.bake', input: { object: objectName, mode: 'all', size: 1024, pattern: 'skin', aoSamples: 8 } },
      { command: 'rig.create', input: { object: objectName } },
      { command: 'rig.correct-weights', input: { object: objectName, symmetry: true } },
      { command: 'animation.create', input: { skeleton: 'all', clip: args.clip ?? 'idle' } },
    ],
  });
  for (const [index, result] of (batch.results ?? []).entries()) {
    if (!result.ok) throw new Error(`batch step ${index} (${result.command}) failed: ${JSON.stringify(result.error)}`);
  }
  console.log(`pipeline complete: ${batch.results.length} steps`);

  // 4. Verify the result before exporting (never trust, always check) ------
  const inspect = await command('object.inspect', { object: objectName });
  const info = inspect.objects[0];
  console.log(`mesh: ${info.triangles} tris, watertight=${info.watertight}, uv=${info.hasUVs}, weights=${info.hasSkinWeights}`);
  if (!info.hasSkinWeights) throw new Error('rigging did not produce skin weights');

  // 5. Export ------------------------------------------------------------
  const glbTarget = path.join(outDir, `${slug(projectName)}.glb`);
  const exported = await command('export.glb', { path: glbTarget, includeAnimations: true });
  console.log(`exported GLB → ${exported.path} (${(exported.bytes / 1024).toFixed(0)} kB, ${exported.animations} animation(s))`);

  // 6. Preview -----------------------------------------------------------
  const previewRes = await fetch(`${base}/api/projects/${encodeURIComponent(projectName)}/preview?width=900&height=900&view=three-quarter`);
  if (!previewRes.ok) throw new Error(`preview failed: ${previewRes.status}`);
  const previewFile = path.join(outDir, `${slug(projectName)}-preview.png`);
  await fs.writeFile(previewFile, Buffer.from(await previewRes.arrayBuffer()));
  console.log(`preview → ${previewFile}`);

  // 7. Report ------------------------------------------------------------
  const summary = {
    project: projectName,
    prompt,
    triangles: info.triangles,
    watertight: info.watertight,
    hasUVs: info.hasUVs,
    hasSkinWeights: info.hasSkinWeights,
    glb: exported.path,
    preview: previewFile,
  };
  const reportFile = path.join(outDir, `${slug(projectName)}-report.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`report → ${reportFile}`);
  console.log('done.');
}

// --- HTTP helpers ---------------------------------------------------------

async function request(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-JSON response from ${pathname}: ${text.slice(0, 200)}`);
  }
  if (!response.ok || payload.ok === false) {
    const error = payload.error ?? { code: `http_${response.status}`, message: text.slice(0, 300) };
    throw new Error(`${pathname} failed — ${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`);
  }
  return payload;
}

function get(pathname) {
  return request(pathname);
}

function post(pathname, body) {
  return request(pathname, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

async function command(id, input) {
  const result = await post(`/api/projects/${encodeURIComponent(projectName)}/commands/${id}`, input);
  return result.data;
}

async function ensureServer() {
  try {
    await fetch(`${base}/api/health`);
    return;
  } catch {
    if (args.url) throw new Error(`no ModelStudio server at ${base} — start it with \`npm start\``);
  }
  console.log('no server found, starting one…');
  child = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'server', 'main.mjs')], {
    stdio: 'ignore',
    env: process.env,
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {
      /* keep waiting */
    }
  }
  throw new Error('server did not become healthy within 15 s');
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}
