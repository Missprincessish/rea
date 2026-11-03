// ModelStudio editor.
// Every action calls a registry command through the HTTP API, so manual edits
// and ChatGPT edits are the same operations on the same files.
import { api } from './api.js';
import { Viewport } from './viewport.js';
import { localGeometryCache, applySculptLocally } from './localops.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  project: null,
  snapshot: null,
  selection: null,
  mode: 'select',
  sculptMode: 'inflate',
  brushSize: 0.14,
  brushStrength: 0.03,
  painting: false,
  paintColor: '#ff5c8a',
  paintSize: 0.06,
  images: [],
  revision: 0,
  busy: 0,
};

const viewport = new Viewport($('#viewport'));

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function toast(message, kind = 'ok') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-stack').appendChild(element);
  setTimeout(() => element.remove(), kind === 'err' ? 6200 : 3200);
}

function setBusy(on, label = 'working…') {
  state.busy += on ? 1 : -1;
  if (state.busy < 0) state.busy = 0;
  $('#busy-label').textContent = label;
  $('#busy').classList.toggle('hidden', state.busy === 0);
}

function logActivity(command, ok, detail = '') {
  const list = $('#activity-log');
  const item = document.createElement('li');
  if (!ok) item.className = 'err';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.innerHTML = `<time>${time}</time><span class="cmd">${command}</span><span>${ok ? 'ok' : 'failed'}${detail ? ` · ${detail}` : ''}</span>`;
  list.prepend(item);
  while (list.children.length > 60) list.lastChild.remove();
}

async function run(command, input = {}, { quiet = false, busy = null, refresh = true } = {}) {
  if (busy) setBusy(true, busy);
  try {
    const result = await api.command(state.project, command, input);
    logActivity(command, true, result?.durationMs ? `${result.durationMs}ms` : '');
    if (refresh) state.revision = 0; // force resync
    return result;
  } catch (error) {
    logActivity(command, false, error.code ?? '');
    if (!quiet) toast(error.message ?? String(error), 'err');
    throw error;
  } finally {
    if (busy) setBusy(false);
  }
}

function activeObjectName() {
  return state.selection?.name ?? 'all';
}

// ---------------------------------------------------------------------------
// project lifecycle + sync
// ---------------------------------------------------------------------------

async function refreshProjects() {
  const { projects } = await api.projects();
  const select = $('#project-select');
  select.innerHTML = '';
  for (const project of projects) {
    const option = document.createElement('option');
    option.value = project.name;
    option.textContent = `${project.name} · ${project.objects} obj`;
    select.appendChild(option);
  }
  if (!projects.length) {
    select.innerHTML = '<option value="">no projects</option>';
  }
  if (state.project) select.value = state.project;
  return projects;
}

async function openProject(name) {
  state.project = name;
  state.selection = null;
  state.revision = 0;
  localStorage.setItem('modelstudio.project', name);
  await sync({ force: true });
  $('#project-label').textContent = name;
}

async function sync({ force = false } = {}) {
  if (!state.project) return;
  try {
    const result = await api.state(state.project, force ? -1 : state.revision);
    if (result?.unchanged) return;
    if (!result?.ok) return;
    const snapshot = result.data;
    state.snapshot = snapshot;
    state.revision = snapshot.project.revision;
    await viewport.sync(snapshot, state.project, { api });
    if (state.selection) {
      const mesh = viewport.meshes.get(state.selection.id);
      if (mesh) {
        viewport.select(mesh);
        renderInspector();
      } else {
        state.selection = null;
        renderInspector();
      }
    }
    renderScenePanels();
    renderStats();
    $('#revision-badge').textContent = `rev ${snapshot.project.revision}`;
  } catch (error) {
    console.error('[sync]', error);
  }
}

function renderStats() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const stats = snapshot.project.stats;
  $('#scene-stats').textContent = `${stats.objects} objects · ${stats.triangles.toLocaleString()} tris · ${stats.vertices.toLocaleString()} verts · ${stats.textures} tex`;
}

function renderScenePanels() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const list = $('#object-list');
  list.innerHTML = '';
  for (const object of snapshot.objects) {
    const li = document.createElement('li');
    if (state.selection?.id === object.id) li.className = 'active';
    li.innerHTML = `<span>${object.name}</span><span class="meta">${object.stats.triangles.toLocaleString()}t</span>`;
    li.addEventListener('click', () => {
      const mesh = viewport.meshes.get(object.id);
      if (mesh) {
        viewport.select(mesh);
        state.selection = { id: object.id, name: object.name, object };
        renderInspector();
        renderScenePanels();
      }
    });
    list.appendChild(li);
  }

  const materials = $('#material-list');
  materials.innerHTML = '';
  for (const material of snapshot.materials) {
    const li = document.createElement('li');
    if (state.materialId === material.id) li.className = 'active';
    const used = snapshot.objects.filter((o) => o.materialId === material.id).length;
    li.innerHTML = `<span>${material.name}</span><span class="meta">${used} obj</span>`;
    li.addEventListener('click', () => {
      state.materialId = material.id;
      renderScenePanels();
      openMaterialEditor(material);
    });
    materials.appendChild(li);
  }

  const boneSelect = $('#bone-select');
  if (snapshot.skeletons.length) {
    const bones = snapshot.skeletons[snapshot.skeletons.length - 1].boneNames ?? [];
    const current = boneSelect.value;
    boneSelect.innerHTML = bones.map((name) => `<option value="${name}">${name}</option>`).join('');
    if (bones.includes(current)) boneSelect.value = current;
  }

  const clipSelect = $('#clip-select');
  if (!clipSelect.options.length) clipSelect.innerHTML = '<option value="idle">idle</option><option value="walk">walk</option><option value="run">run</option><option value="wave">wave</option><option value="punch">punch</option><option value="jump">jump</option>';
}

function renderInspector() {
  const container = $('#inspector');
  if (!state.selection) {
    container.innerHTML = '<p class="hint">Select an object to see its stats.</p>';
    return;
  }
  const object = state.snapshot.objects.find((o) => o.id === state.selection.id);
  if (!object) {
    container.innerHTML = '<p class="hint">Object no longer exists.</p>';
    return;
  }
  const stats = object.stats;
  const bbox = stats.boundingBox?.size?.map((v) => v.toFixed(2)).join(' × ') ?? '—';
  container.innerHTML = `
    <h3>${object.name}</h3>
    <div class="kv">
      <span class="k">triangles</span><span class="v">${stats.triangles.toLocaleString()}</span>
      <span class="k">vertices</span><span class="v">${stats.vertices.toLocaleString()}</span>
      <span class="k">size</span><span class="v">${bbox}</span>
      <span class="k">material</span><span class="v">${object.materialName ?? object.materialId ?? '—'}</span>
      <span class="k">uvs</span><span class="v">${stats.hasUVs ? 'yes' : 'no'}</span>
      <span class="k">skin weights</span><span class="v">${stats.hasSkinWeights ? 'yes' : 'no'}</span>
      <span class="k">skeleton</span><span class="v">${object.skeletonId ?? '—'}</span>
    </div>
    <div class="health">
      <span class="chip ${stats.closed ? 'ok' : 'warn'}">${stats.closed ? 'closed' : `${stats.boundaryEdges} boundary edges`}</span>
      <span class="chip ${stats.nonManifoldEdges ? 'warn' : 'ok'}">${stats.nonManifoldEdges} non-manifold</span>
      <span class="chip ${stats.looseVertices ? 'warn' : 'ok'}">${stats.looseVertices} loose</span>
      ${stats.hasUVs ? '' : '<span class="chip warn">no uv</span>'}
    </div>
    <button class="btn ghost wide" id="btn-inspect-deep">Run full inspection</button>
  `;
  $('#btn-inspect-deep').addEventListener('click', async () => {
    const result = await run('object.inspect', { object: object.name }, { busy: 'inspecting' });
    const detail = result?.data?.objects?.[0];
    if (detail) {
      toast(`${detail.triangles} tris · ${detail.closed ? 'closed' : `${detail.boundaryEdges} holes`} · area ${detail.surfaceArea.toFixed(3)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

// Quality presets mirror Meshy's draft / standard / high-detail workflow.
const QUALITY_PRESETS = {
  draft: {
    resolution: 64,
    note: 'Draft: 64 detail — fastest preview, no post-processing.',
    post: [],
  },
  standard: {
    resolution: 96,
    note: 'Standard: 96 detail + auto UV unwrap + baked albedo texture.',
    post: ['mesh.uv', 'texture.bake'],
  },
  ultra: {
    resolution: 144,
    note: 'Ultra: 144 detail + repair + UV + bake — game/VR ready, heavier.',
    post: ['mesh.repair', 'mesh.uv', 'texture.bake'],
  },
};

let qualityPreset = 'standard';

function applyQualityPreset(id, { announce = true } = {}) {
  const preset = QUALITY_PRESETS[id];
  if (!preset) return;
  qualityPreset = id;
  $('#gen-resolution').value = preset.resolution;
  $('#gen-resolution-out').textContent = preset.resolution;
  $('#gen-quality-note').textContent = preset.note;
  document.querySelectorAll('#gen-quality-presets button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.quality === id);
  });
  if (announce) toast(`Quality preset: ${id}`);
}

/** Everything in the prompt library, filtered by the search box. */
function renderArchetypeChips(filter = '') {
  const list = state.capabilities?.archetypes ?? [];
  $('#archetype-count').textContent = list.length ? `(${list.length})` : '';
  const needle = filter.trim().toLowerCase();
  const shown = !needle
    ? list
    : list.filter((a) => a.label.toLowerCase().includes(needle)
      || a.key.toLowerCase().includes(needle)
      || (a.tags ?? []).some((t) => t.includes(needle)));
  $('#archetype-chips').innerHTML = shown
    .map((a) => `<button type="button" data-prompt="${a.label}" title="${a.tags.join(', ')}">${a.label}</button>`)
    .join('');
}

async function generateText() {
  const prompt = $('#prompt-input').value.trim();
  if (!prompt) return toast('Type a prompt first', 'err');
  const resolution = Number($('#gen-resolution').value);
  const splitParts = $('#gen-split').checked;
  const preset = QUALITY_PRESETS[qualityPreset] ?? QUALITY_PRESETS.standard;
  try {
    const result = await run('generate.text', { prompt, resolution, splitParts }, { busy: 'generating geometry' });
    const archetype = result?.data?.result?.archetype;
    const created = result?.data?.result?.objects?.[0]?.name;
    toast(`Generated ${archetype ?? 'mesh'} · ${result?.data?.result?.objects?.length ?? 0} object(s)`);

    // Post-process the freshly generated mesh according to the quality preset.
    for (const command of preset.post) {
      if (!created) break;
      try {
        const args = { object: created };
        if (command === 'texture.bake') Object.assign(args, { size: 512, pattern: 'none', mode: 'albedo' });
        await run(command, args, { busy: command.split('.').pop(), quiet: true, refresh: false });
      } catch {
        /* a preset step must never block the generation itself */
      }
    }
    if (preset.post.length) toast(`Applied ${preset.post.length} finishing step(s) (${qualityPreset})`);
    await sync({ force: true });
    viewport.frameAll();
  } catch {
    /* toasted already */
  }
}

async function generateFromImages() {
  if (!state.images.length) return toast('Add reference images first', 'err');
  const resolution = Number($('#gen-resolution').value);
  try {
    const images = state.images.map((image) => ({ data: image.dataUrl.split(',').pop(), angle: image.angle, name: image.name }));
    const result = await run('generate.image', {
      images,
      resolution,
      name: images.length > 1 ? 'Reconstruction' : 'Extrusion',
    }, { busy: 'carving visual hull' });
    toast(`Reconstructed ${result?.data?.result?.object?.triangles ?? 0} triangles from ${images.length} view(s)`);
    await sync({ force: true });
    viewport.frameAll();
  } catch {
    /* toasted */
  }
}

function angleFromFilename(name) {
  const lower = name.toLowerCase();
  if (lower.includes('back') || lower.includes('rear')) return 180;
  if (lower.includes('side') && lower.includes('left')) return 270;
  if (lower.includes('side')) return 90;
  if (lower.includes('front')) return 0;
  return null;
}

async function addImages(files) {
  const incoming = Array.from(files).filter((file) => file.type.startsWith('image/'));
  for (const file of incoming) {
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    let angle = angleFromFilename(file.name);
    if (angle === null) angle = state.images.length * 90;
    state.images.push({ name: file.name, dataUrl, angle });
  }
  renderThumbs();
}

function renderThumbs() {
  const list = $('#image-thumbs');
  list.innerHTML = '';
  for (const [index, image] of state.images.entries()) {
    const li = document.createElement('li');
    li.innerHTML = `<img src="${image.dataUrl}" alt=""><span class="angle">${image.angle}°</span>`;
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      state.images.splice(index, 1);
      renderThumbs();
    });
    li.appendChild(remove);
    li.title = `${image.name} — click to cycle angle`;
    li.addEventListener('click', () => {
      image.angle = (image.angle + 45) % 360;
      renderThumbs();
    });
    list.appendChild(li);
  }
  $('#btn-generate-image').disabled = state.images.length === 0;
}

// ---------------------------------------------------------------------------
// mesh operations
// ---------------------------------------------------------------------------

async function meshOp(command, extra = {}) {
  const target = activeObjectName();
  try {
    const result = await run(command, { object: target, ...extra }, { busy: command.split('.').pop() });
    const results = result?.data?.result?.results ?? [];
    const stats = results[0]?.stats;
    toast(stats ? `${command} · ${stats.trianglesAfter?.toLocaleString?.() ?? results[0]?.triangles?.toLocaleString?.() ?? ''} tris` : `${command} done`);
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

async function applyScultStroke(event) {
  if (!state.selection || state.mode !== 'sculpt') return;
  const point = viewport.worldPoint(event);
  if (!point) return;
  const mesh = viewport.meshes.get(state.selection.id);
  if (!mesh) return;
  // Deterministic local preview so the stroke feels responsive...
  applySculptLocally(mesh.geometry, {
    center: [point.x - mesh.position.x, point.y - mesh.position.y, point.z - mesh.position.z],
    radius: state.brushSize,
    strength: state.brushStrength,
    mode: state.sculptMode,
    falloff: 'smooth',
  });
  // ...then the exact same command is committed to the project on release.
  state.pendingSculpt = {
    center: [point.x - mesh.position.x, point.y - mesh.position.y, point.z - mesh.position.z],
    radius: state.brushSize,
    strength: state.brushStrength,
    mode: state.sculptMode,
  };
}

async function commitSculpt() {
  if (!state.pendingSculpt || !state.selection) return;
  const stroke = state.pendingSculpt;
  state.pendingSculpt = null;
  try {
    await run('mesh.sculpt', { object: state.selection.name, ...stroke });
    await sync({ force: true });
  } catch {
    await sync({ force: true });
  }
}

// ---------------------------------------------------------------------------
// paint
// ---------------------------------------------------------------------------

async function paintAt(event) {
  if (!state.selection || !state.painting) return;
  const hit = viewport.pick(event, { onlySelected: true });
  if (!hit || !hit.uv) return;
  viewport.setPaintMarker(true, hit.point, state.paintSize);
  const color = hexToRgb($('#paint-color').value);
  try {
    await run('texture.paint', {
      object: state.selection.name,
      strokes: [{ x: hit.uv.x, y: hit.uv.y, radius: state.paintSize, color, hardness: 0.55, opacity: 0.9 }],
      size: 1024,
    }, { refresh: false, quiet: true });
    state.needsTextureRefresh = true;
  } catch {
    /* handled by run */
  }
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255];
}

// ---------------------------------------------------------------------------
// rig / animation
// ---------------------------------------------------------------------------

async function rigSelection() {
  const target = activeObjectName();
  try {
    const result = await run('rig.create', { object: target }, { busy: 'building skeleton' });
    const bones = result?.data?.result?.skeleton?.bones?.length ?? 0;
    toast(`Rigged with ${bones} bones · avg ${result?.data?.result?.skin?.averageInfluences ?? '?'} influences/vertex`);
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

async function addClip() {
  const clip = $('#clip-select').value;
  const skeletons = state.snapshot?.skeletons ?? [];
  if (!skeletons.length) return toast('Rig a mesh first', 'err');
  try {
    await run('animation.create', { skeleton: skeletons[skeletons.length - 1].name, clip }, { busy: 'authoring clip' });
    toast(`Added ${clip} clip`);
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

async function applyBoneRotation() {
  const bone = $('#bone-select').value;
  if (!bone) return toast('Rig a mesh first', 'err');
  const skeleton = state.snapshot?.skeletons?.[state.snapshot.skeletons.length - 1];
  const rotations = {
    [bone]: [Number($('#bone-rx').value), Number($('#bone-ry').value), Number($('#bone-rz').value)],
  };
  try {
    await run('rig.pose', { skeleton: skeleton.name, rotations }, { busy: 'posing' });
    toast(`${bone} rotated`);
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

async function runWorkflow() {
  const workflow = $('#workflow-select').value;
  const params = {};
  if (state.selection) params.object = state.selection.name;
  if (state.images.length) params.images = state.images.map((image) => ({ data: image.dataUrl.split(',').pop(), angle: image.angle }));
  const prompt = $('#prompt-input').value.trim();
  if (prompt) params.prompt = prompt;
  try {
    const result = await run('workflow.run', { workflow, input: params }, { busy: `workflow: ${workflow}` });
    const payload = result?.data?.result ?? result?.data ?? {};
    const steps = payload.steps ?? [];
    toast(`${workflow}: ${steps.filter((s) => s.ok).length}/${steps.length} steps ok`, payload.ok ? 'ok' : 'err');
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

function openMaterialEditor(material) {
  const editor = $('#material-editor');
  editor.classList.remove('hidden');
  $('#mat-color').value = rgbToHex(material.baseColorFactor.slice(0, 3));
  $('#mat-metallic').value = material.metallicFactor;
  $('#mat-roughness').value = material.roughnessFactor;
  const preset = $('#mat-preset');
  if (!preset.options.length) {
    preset.innerHTML = '<option value="">custom</option>' + (state.capabilities?.presets ?? [])
      .map((p) => `<option value="${p.id}">${p.id}</option>`).join('');
  }
  preset.onchange = async () => {
    if (!preset.value) return;
    try {
      await run('material.create', { preset: preset.value, name: preset.value, assignTo: activeObjectName() }, { busy: 'material preset' });
      toast(`${preset.value} preset applied`);
      await sync({ force: true });
    } catch { /* toasted */ }
  };
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')}`;
}

async function applyMaterial() {
  if (!state.materialId) return toast('Select a material', 'err');
  const color = hexToRgb($('#mat-color').value);
  try {
    await run('material.edit', {
      material: state.materialId,
      changes: {
        baseColorFactor: [...color, 1],
        metallicFactor: Number($('#mat-metallic').value),
        roughnessFactor: Number($('#mat-roughness').value),
      },
    }, { busy: 'updating material' });
    toast('Material updated');
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

async function bakeMaterial() {
  const target = activeObjectName();
  try {
    const result = await run('texture.bake', { object: target, mode: 'all', size: 1024, aoSamples: 10 }, { busy: 'baking maps' });
    const produced = Object.keys(result?.data?.result?.produced ?? {});
    toast(`Baked ${produced.join(', ') || 'nothing'}`);
    await sync({ force: true });
  } catch {
    /* toasted */
  }
}

// ---------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------

async function importGlb(file) {
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  try {
    const result = await run('import.glb', { data: dataUrl.split(',').pop(), path: file.name }, { busy: `importing ${file.name}` });
    const imported = result?.data?.result?.imported ?? [];
    toast(`Imported ${imported.length} object(s)${result?.data?.result?.skeletons ? ` · ${result.data.result.skeletons} skeleton(s)` : ''}`);
    await sync({ force: true });
    viewport.frameAll();
  } catch {
    /* toasted */
  }
}

async function exportGlb() {
  try {
    const result = await run('export.glb', { format: 'glb', object: 'all' }, { busy: 'exporting GLB' });
    const exported = result?.data?.result ?? result?.data ?? {};
    const path = exported.path;
    toast(`Exported ${((exported.bytes ?? 0) / 1024).toFixed(0)} KB → ${path}`);
    if (path) {
      const name = path.split('/').pop();
      const link = document.createElement('a');
      link.href = `/api/projects/${encodeURIComponent(state.project)}/export/${encodeURIComponent(name)}`;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  } catch {
    /* toasted */
  }
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function bindEvents() {
  $$('#tool-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#tool-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.panel));
    });
  });

  $('#project-select').addEventListener('change', (event) => {
    if (event.target.value) openProject(event.target.value);
  });

  $('#btn-new-project').addEventListener('click', async () => {
    const name = prompt('Project name', `Project ${new Date().toLocaleDateString()}`);
    if (!name) return;
    try {
      const result = await api.createProject(name);
      await refreshProjects();
      await openProject(result.data.project.name);
      toast(`Created ${name}`);
    } catch (error) {
      toast(error.message, 'err');
    }
  });

  $('#btn-generate').addEventListener('click', generateText);
  $('#gen-quality-presets').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-quality]');
    if (btn) applyQualityPreset(btn.dataset.quality);
  });
  $('#archetype-search').addEventListener('input', (event) => renderArchetypeChips(event.target.value));
  $('#archetype-chips').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-prompt]');
    if (!btn) return;
    $('#prompt-input').value = btn.dataset.prompt;
    $('#prompt-input').focus();
    toast(`Prompt set: ${btn.dataset.prompt} — press Generate mesh`);
  });
  $('#gen-resolution').addEventListener('input', (e) => { $('#gen-resolution-out').textContent = e.target.value; });
  $('#remesh-resolution').addEventListener('input', (e) => { $('#remesh-resolution-out').textContent = e.target.value; });
  $('#prompt-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) generateText();
  });

  const dropzone = $('#image-dropzone');
  dropzone.addEventListener('click', () => $('#image-input').click());
  $('#image-input').addEventListener('change', (event) => addImages(event.target.files));
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  }));
  dropzone.addEventListener('drop', (event) => addImages(event.dataTransfer.files));
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) {
      const file = event.dataTransfer.files[0];
      if (file.name.endsWith('.glb') || file.name.endsWith('.gltf')) importGlb(file);
      else addImages(event.dataTransfer.files);
    }
  });

  $('#btn-generate-image').addEventListener('click', generateFromImages);

  $$('#mode-bar .mode').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      $$('#mode-bar .mode').forEach((b) => b.classList.toggle('active', b === button));
      viewport.setMode(state.mode);
      state.painting = state.mode === 'paint';
      if (state.mode !== 'transform') viewport.attachGizmo(state.mode === 'select' ? viewport.selection : null);
      if (state.mode === 'transform') viewport.attachGizmo(viewport.selection);
    });
  });

  $$('#gizmo-bar .mode').forEach((button) => {
    button.addEventListener('click', () => {
      $$('#gizmo-bar .mode').forEach((b) => b.classList.toggle('active', b === button));
      viewport.setGizmoMode(button.dataset.gizmo);
    });
  });

  $$('#sculpt-modes button').forEach((button) => {
    button.addEventListener('click', () => {
      state.sculptMode = button.dataset.sculpt;
      $$('#sculpt-modes button').forEach((b) => b.classList.toggle('active', b === button));
    });
  });

  $('#brush-size').addEventListener('input', (event) => { state.brushSize = Number(event.target.value); viewport.brushRadius = state.brushSize; });
  $('#brush-strength').addEventListener('input', (event) => { state.brushStrength = Number(event.target.value); });

  viewport.onPointerDown = (event) => {
    if (state.mode === 'sculpt' && state.selection && event.button === 0) {
      if (event.altKey) return;
      state.sculpting = true;
      applyScultStroke(event);
    }
    if (state.mode === 'paint' && event.button === 0) paintAt(event);
  };
  viewport.onPointerMove = (event) => {
    if (state.mode === 'sculpt' && state.sculpting) applyScultStroke(event);
    if (state.painting && event.buttons === 1) paintAt(event);
    if (state.mode === 'paint' && !state.painting) {
      const hit = viewport.pick(event, { onlySelected: true });
      viewport.setPaintMarker(Boolean(hit), hit?.point, state.paintSize);
    }
  };
  viewport.onPointerUp = () => {
    if (state.sculpting) {
      state.sculpting = false;
      commitSculpt();
    }
    if (state.needsTextureRefresh) {
      state.needsTextureRefresh = false;
      sync({ force: true });
    }
  };

  viewport.onSelect = (mesh) => {
    if (!mesh) {
      state.selection = null;
    } else {
      state.selection = { id: mesh.userData.id, name: mesh.userData.name, object: mesh.userData.object };
    }
    renderScenePanels();
    renderInspector();
  };

  viewport.onTransformCommit = async (mesh) => {
    if (!mesh) return;
    try {
      await run('object.transform', {
        object: mesh.userData.name,
        translation: mesh.position.toArray(),
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((r) => (r * 180) / Math.PI),
        scale: mesh.scale.toArray(),
      });
      toast(`${mesh.userData.name} transformed`);
      await sync({ force: true });
    } catch {
      /* toasted */
    }
  };

  $$('[data-op]').forEach((button) => {
    button.addEventListener('click', () => {
      const op = button.dataset.op;
      if (op === 'decimate') meshOp('mesh.decimate', { triangles: Number($('#decimate-target').value) });
      else if (op === 'remesh') meshOp('mesh.remesh', { resolution: Number($('#remesh-resolution').value) });
      else meshOp(op);
    });
  });

  $('#btn-paint-toggle').addEventListener('click', () => {
    state.painting = !state.painting;
    state.mode = state.painting ? 'paint' : 'select';
    viewport.setMode(state.mode);
    $$('#mode-bar .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    $('#btn-paint-toggle').textContent = state.painting ? 'Exit paint mode' : 'Enter paint mode';
  });

  $('#btn-paint-fit').addEventListener('click', async () => {
    if (!state.selection) return toast('Select an object first', 'err');
    try {
      await run('texture.bake', { object: state.selection.name, mode: 'albedo', size: 2048 }, { busy: 'baking 2048 base colour' });
      toast('Base colour texture ready to paint');
      await sync({ force: true });
    } catch {
      /* toasted */
    }
  });

  $('#btn-rig').addEventListener('click', rigSelection);
  $('#btn-correct-weights').addEventListener('click', () => meshOp('rig.correct-weights', { smoothing: 1 }));
  $('#btn-symmetrise-weights').addEventListener('click', () => meshOp('rig.correct-weights', { symmetry: true }));
  $('#btn-add-clip').addEventListener('click', addClip);
  $('#btn-apply-pose').addEventListener('click', applyBoneRotation);

  $('#btn-preview-clip').addEventListener('click', async () => {
    const clip = $('#clip-select').value;
    const skeleton = state.snapshot?.skeletons?.[state.snapshot.skeletons.length - 1];
    if (!skeleton) return toast('Rig a mesh first', 'err');
    const animList = await run('animation.list', { project: state.project }, { refresh: false });
    const stored = animList?.data?.stored ?? animList?.data?.result?.stored ?? [];
    const existing = stored.find((a) => a.name === clip);
    const animation = existing ?? (await run('animation.create', { skeleton: skeleton.name, clip }, { refresh: false })).data?.result?.animation;
    if (!animation) return;
    const duration = animation.duration ?? 2;
    const start = performance.now();
    setBusy(true, `playing ${clip}`);
    const tick = async () => {
      const t = ((performance.now() - start) / 1000) % duration;
      await run('animation.sample', { animation: animation.id ?? existing?.id, time: t, apply: true }, { refresh: false, quiet: true });
      await sync({ force: true });
      if (performance.now() - start < duration * 1000 * 2) requestAnimationFrame(tick);
      else setBusy(false);
    };
    tick();
  });

  $('#workflow-select').addEventListener('focus', async () => {
    const select = $('#workflow-select');
    if (select.options.length) return;
    const list = await api.capabilities();
    select.innerHTML = (list.workflows ?? []).map((w) => `<option value="${w.id}">${w.label}</option>`).join('');
  });
  $('#btn-run-workflow').addEventListener('click', async () => {
    if (!$('#workflow-select').options.length) {
      const list = await api.capabilities();
      $('#workflow-select').innerHTML = (list.workflows ?? []).map((w) => `<option value="${w.id}">${w.label}</option>`).join('');
    }
    runWorkflow();
  });

  $('#btn-import').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', (event) => {
    if (event.target.files[0]) importGlb(event.target.files[0]);
    event.target.value = '';
  });
  $('#btn-export').addEventListener('click', exportGlb);

  $('#btn-undo').addEventListener('click', async () => {
    try {
      await run('project.undo', {}, { busy: 'undo' });
      toast('Undone');
      await sync({ force: true });
    } catch { /* toasted */ }
  });
  $('#btn-redo').addEventListener('click', async () => {
    try {
      await run('project.redo', {}, { busy: 'redo' });
      toast('Redone');
      await sync({ force: true });
    } catch { /* toasted */ }
  });

  $('#btn-focus').addEventListener('click', () => viewport.focusOn(viewport.selection));
  $('#btn-frame-all').addEventListener('click', () => viewport.frameAll());
  $('#btn-snapshot').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = viewport.screenshot();
    link.download = `${state.project}-viewport.png`;
    link.click();
  });
  $('#btn-duplicate').addEventListener('click', () => state.selection && meshOp('object.duplicate'));
  $('#btn-delete').addEventListener('click', async () => {
    if (!state.selection) return;
    if (!confirm(`Delete ${state.selection.name}?`)) return;
    try {
      await run('object.delete', { object: state.selection.name }, { busy: 'delete' });
      state.selection = null;
      toast('Deleted');
      await sync({ force: true });
    } catch { /* toasted */ }
  });
  $('#btn-apply-material').addEventListener('click', applyMaterial);
  $('#btn-bake-material').addEventListener('click', bakeMaterial);

  window.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      (event.shiftKey ? $('#btn-redo') : $('#btn-undo')).click();
    }
    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      run('project.save', {}, { refresh: false }).then(() => toast('Project saved'));
    }
    if (meta && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      exportGlb();
    }
    if (event.key === 's' && !meta && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      state.mode = 'sculpt';
      viewport.setMode('sculpt');
      $$('#mode-bar .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'sculpt'));
    }
    if (event.key === 'Escape') {
      viewport.select(null);
      state.selection = null;
      renderInspector();
    }
  });
}

async function renderProviders(capabilities) {
  const list = $('#provider-list');
  list.innerHTML = '';
  for (const provider of capabilities.providers ?? []) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span style="display:flex;align-items:center;gap:7px"><span class="dot ${provider.available ? 'on' : ''}"></span>${provider.id}</span>
      <span class="meta">${provider.available ? 'ready' : provider.envVar ?? 'n/a'}</span>
    `;
    li.title = provider.notes;
    list.appendChild(li);
  }
}

async function boot() {
  bindEvents();
  viewport.brushRadius = state.brushSize;
  const health = await api.health();
  if (!health?.ok) {
    toast('API unavailable — run `modelstudio serve`', 'err');
    return;
  }
  const capabilities = await api.capabilities();
  state.capabilities = capabilities;
  renderProviders(capabilities);
  $('#workflow-select').innerHTML = (capabilities.workflows ?? []).map((w) => `<option value="${w.id}">${w.label}</option>`).join('');
  $('#mat-preset').innerHTML = '<option value="">custom</option>' + (capabilities.presets ?? []).map((p) => `<option value="${p.id}">${p.id}</option>`).join('');
  renderArchetypeChips();
  applyQualityPreset(qualityPreset, { announce: false });

  const projects = await refreshProjects();
  const queryProj = new URLSearchParams(location.search).get('project');
  const remembered = queryProj || localStorage.getItem('modelstudio.project');
  const target = projects.find((p) => p.name === remembered)?.name ?? projects[0]?.name;
  $('#btn-open-vr')?.addEventListener('click', () => {
    location.href = `/vr?project=${encodeURIComponent(state.project ?? 'Demo')}`;
  });
  if (target) {
    await openProject(target);
    viewport.frameAll();
  } else {
    const result = await api.createProject('Demo');
    await refreshProjects();
    await openProject(result.data.project.name);
  }

  const events = api.events();
  events.addEventListener('change', (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (!payload.project || payload.project === state.project) sync({ force: true });
    } catch {
      /* ignore malformed events */
    }
  });
  // Baseline poll in case SSE is blocked by a proxy.
  setInterval(() => sync(), 4000);
}

boot().catch((error) => {
  console.error(error);
  toast(error.message ?? String(error), 'err');
});

void localGeometryCache;
