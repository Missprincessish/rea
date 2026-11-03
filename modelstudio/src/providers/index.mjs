// Pluggable 3D generation providers.
//
// The studio ships with two real providers:
//   local  - structured-prompt SDF generation (always available, no credits)
//   meshy  - Meshy's public HTTP API, used only when MESHY_API_KEY is set
//
// Provider output is always converted into ordinary project geometry, so every
// later operation (repair, rig, export...) is provider-independent.
import fs from 'node:fs/promises';
import { Project, PROJECTS_ROOT } from '../core/project.mjs';
import { fail, nowIso } from '../core/util.mjs';
import { readGltf } from '../core/gltf.mjs';
import { importIntoProject } from '../core/gltf.mjs';
import { triangleCount } from '../core/geometry.mjs';

export function listProviders() {
  return [
    {
      id: 'local',
      label: 'Local structured-prompt SDF generator',
      available: true,
      needsCredentials: false,
      modes: ['text-to-3d'],
      notes: 'Deterministic, offline, no credits. Builds articulated shapes from a prompt registry; not a diffusion model.',
    },
    {
      id: 'meshy',
      label: 'Meshy public API (bring your own key)',
      available: Boolean(process.env.MESHY_API_KEY),
      needsCredentials: true,
      envVar: 'MESHY_API_KEY',
      modes: ['text-to-3d', 'image-to-3d'],
      notes: 'Requires a paid Meshy account. Used through the documented REST API only; no proprietary weights or private endpoints.',
    },
    {
      id: 'remote',
      label: 'Any self-hosted generator behind MODELSTUDIO_REMOTE_URL',
      available: Boolean(process.env.MODELSTUDIO_REMOTE_URL),
      needsCredentials: Boolean(process.env.MODELSTUDIO_REMOTE_TOKEN),
      envVar: 'MODELSTUDIO_REMOTE_URL',
      modes: ['text-to-3d', 'image-to-3d'],
      notes: 'POST {prompt, images} -> {glbBase64}. Wire this to a local diffusion/trellis/hunyuan server you run yourself.',
    },
  ];
}

async function meshyRequest(path, { method = 'GET', body = null, apiKey } = {}) {
  const key = apiKey ?? process.env.MESHY_API_KEY;
  if (!key) fail('provider_unavailable', 'MESHY_API_KEY is not set', { status: 503, hint: 'export MESHY_API_KEY=... to enable the Meshy provider' });
  const response = await fetch(`https://api.meshy.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    fail('provider_error', `Meshy API ${response.status}: ${text.slice(0, 400)}`, { status: 502 });
  }
  return response.json();
}

async function downloadToBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) fail('provider_error', `Could not download generated model (${response.status})`, { status: 502 });
  return Buffer.from(await response.arrayBuffer());
}

async function pollTask(taskId, { intervalMs = 4000, timeoutMs = 300000 } = {}) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    const task = await meshyRequest(`/openapi/v2/text-to-3d/${taskId}`);
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      fail('provider_failed', `Meshy task ${taskId} ${task.status}: ${JSON.stringify(task.task_error ?? {})}`, { status: 502 });
    }
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs * attempt, 15000)));
  }
  fail('provider_timeout', `Meshy task ${taskId} did not finish in time`, { status: 504 });
  return null;
}

/**
 * Generate through a non-local provider and import the result into the project.
 */
export async function generateWithProvider(provider, input) {
  if (provider === 'meshy' || (provider === 'auto' && process.env.MESHY_API_KEY)) {
    return generateWithMeshy(input);
  }
  if (provider === 'remote') return generateWithRemote(input);
  fail('provider_unavailable', `Provider "${provider}" is not configured`, { status: 503, details: { providers: listProviders() } });
  return null;
}

async function generateWithMeshy(input) {
  const project = await Project.open(input.project);
  const body = {
    mode: 'preview',
    prompt: input.prompt,
    target_formats: ['glb'],
  };
  const created = await meshyRequest('/openapi/v2/text-to-3d', { method: 'POST', body });
  const task = await pollTask(created.result);
  const glbUrl = task.model_urls?.glb;
  if (!glbUrl) fail('provider_error', 'Meshy returned no GLB URL', { status: 502 });
  const bytes = await downloadToBuffer(glbUrl);
  const imported = await project.mutate(async () => {
    const result = await importIntoProject(project, bytes, { namePrefix: 'meshy_', sourceName: 'meshy' });
    return result;
  }, { label: 'generate:meshy' });
  return {
    provider: 'meshy',
    taskId: created.result,
    status: task.status,
    objects: imported.objects.map((o) => ({ id: o.id, name: o.name, triangles: triangleCount(project.getGeometry(o)) })),
    project: project.summary(),
  };
}

async function generateWithRemote(input) {
  const url = process.env.MODELSTUDIO_REMOTE_URL;
  if (!url) fail('provider_unavailable', 'MODELSTUDIO_REMOTE_URL is not set', { status: 503 });
  const project = await Project.open(input.project);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.MODELSTUDIO_REMOTE_TOKEN ? { Authorization: `Bearer ${process.env.MODELSTUDIO_REMOTE_TOKEN}` } : {}),
    },
    body: JSON.stringify({ prompt: input.prompt, images: input.images ?? [], resolution: input.resolution }),
  });
  if (!response.ok) fail('provider_error', `Remote generator ${response.status}`, { status: 502 });
  const payload = await response.json();
  if (!payload.glbBase64) fail('provider_error', 'Remote generator must return { glbBase64 }', { status: 502 });
  const bytes = Buffer.from(payload.glbBase64, 'base64');
  const imported = await project.mutate(async () => importIntoProject(project, bytes, { namePrefix: 'remote_', sourceName: 'remote' }), { label: 'generate:remote' });
  return {
    provider: 'remote',
    objects: imported.objects.map((o) => ({ id: o.id, name: o.name, triangles: triangleCount(project.getGeometry(o)) })),
    project: project.summary(),
    generatedAt: nowIso(),
  };
}

export { PROJECTS_ROOT, fs };
