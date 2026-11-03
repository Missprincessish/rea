// Client-side VR/Desktop live editing engine for ModelStudio.
//
// Owns everything that turns raw input into world edits:
//   1. Phase 1 — comfortable thumbstick locomotion (world-gaze basis), smooth &
//      snap turning, adjustable speeds, optional teleport, UI locomotion lock.
//   2. Phase 2 — reliable B/Y toggle, Grip summon-only, persistent wrist/HUD menu
//      pill, draggable floating board, big ray targets.
//   3. Phase 3 — point-select, grab/move/rotate/resize, live fence end-to-end /
//      structure / grid snapping, ghost placement preview, duplicate/delete/
//      undo/redo — all persisted through the same command registry as desktop,
//      MCP and the AI Director.
//
// Every geometry/snapping helper is imported from `src/core/vr-interaction.mjs`
// so the browser, the CLI, the MCP server and the unit tests share one truth.

import * as THREE from 'three';
import {
  computeFenceSnap,
  computeHandLocomotion,
  computeLocomotionStep,
  computeMenuSummonPose,
  computeObjectFootprint,
  computeStructureAlignment,
  evaluateMenuAction,
  extractYawDeg,
  normalizeAngleDeg,
  parseQuestGamepad,
  solveSmartPlacement,
} from '../src/core/vr-interaction.mjs';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const GRID_ANGLE_STEP = 15;

/**
 * Create the VR/Desktop interaction engine.
 *
 * The passed `ctx` is the thin Three.js/UI adapter:
 *   { THREE, renderer, camera, playerRig, scene, objectsGroup, api, command,
 *     state, terrainHeightAt, $(sel), showReply, submitSpatialPrompt, speakReply }
 */
export function createVrEditor(ctx) {
  const {
    renderer, camera, playerRig, scene, objectsGroup, api, state, $,
    terrainHeightAt, showReply, submitSpatialPrompt,
  } = ctx;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function terrain(world, x, z) {
    return terrainHeightAt(world ?? state.world, x, z);
  }

  function headPose() {
    const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    xrCam.getWorldPosition(pos);
    xrCam.getWorldQuaternion(quat);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();
    return { pos, quat, fwd };
  }

  function headArrays() {
    const { pos, fwd } = headPose();
    return {
      position: [pos.x, pos.y, pos.z],
      forward: [fwd.x, fwd.y, fwd.z],
      yawRad: Math.atan2(-fwd.x, -fwd.z),
    };
  }

  function objectById(id) {
    return state.objects.find((o) => o.id === id) ?? null;
  }

  function meshById(id) {
    return objectsGroup.children.find((c) => c.userData?.objectId === id) ?? null;
  }

  function rawBoxOf(obj) {
    const mesh = meshById(obj.id);
    if (mesh) {
      const box = new THREE.Box3().setFromObject(mesh);
      const size = box.getSize(new THREE.Vector3());
      if (size.length() > 1e-4) return [size.x, size.y, size.z];
    }
    return null;
  }

  function footprintOf(obj) {
    return computeObjectFootprint(obj, rawBoxOf(obj));
  }

  function otherFootprints(excludeId = null) {
    return state.objects.filter((o) => o.id !== excludeId).map((o) => footprintOf(o));
  }

  /**
   * World-safe command dispatcher: never throws at the UI layer and unwraps the
   * registry envelope (`{ ok, data: { revision, result } }`) so callers get the
   * command's own result payload.
   */
  async function command(id, input = {}) {
    try {
      const payload = await api.command(state.project, id, input);
      const ok = payload?.ok !== false;
      const data = payload?.data?.result ?? payload?.data ?? payload ?? null;
      return { ok, data, error: payload?.error ?? null };
    } catch (error) {
      return { ok: false, data: null, error: { code: error.code ?? 'command_failed', message: error.message } };
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.52, 44),
    new THREE.MeshBasicMaterial({ color: 0x2ce8c4, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.visible = false;
  scene.add(selectionRing);

  const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xf5b942);
  selectionBox.material.transparent = true;
  selectionBox.material.opacity = 0.7;
  selectionBox.visible = false;
  scene.add(selectionBox);

  function refreshSelectionVisual() {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    const mesh = state.selectedId ? meshById(state.selectedId) : null;
    if (!obj || !mesh) {
      selectionRing.visible = false;
      selectionBox.visible = false;
      return;
    }
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    selectionRing.position.set(center.x, box.min.y + 0.02, center.z);
    const r = Math.max(0.45, Math.hypot(size.x, size.z) * 0.55);
    selectionRing.scale.setScalar(r / 0.47);
    selectionRing.visible = true;
    selectionBox.box.copy(box);
    selectionBox.visible = true;
  }

  function selectObject(id, { announce = false } = {}) {
    if (!id || !objectById(id)) {
      deselect();
      return;
    }
    state.selectedId = id;
    const obj = objectById(id);
    refreshSelectionVisual();
    renderSelectionUi();
    if (announce) showReply('Selected', `${obj.name} — grab, rotate, resize, snap or duplicate it.`);
  }

  function deselect() {
    state.selectedId = null;
    state.dragging = null;
    selectionRing.visible = false;
    selectionBox.visible = false;
    renderSelectionUi();
  }

  function renderSelectionUi() {
    const box = $('#vr-object-inspector');
    if (!box) return;
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    $('#sel-obj-name').textContent = obj.name;
    $('#btn-drag-move').classList.toggle('active', Boolean(state.dragging));
  }

  /** Is anything open in the DOM (drawer, typed text) that should not eat stick input? */
  function uiHasFocus() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    const drawerOpen = typeof document !== 'undefined'
      && ['#locomotion-drawer', '#ai-drawer'].some((sel) => {
        const el = document.querySelector(sel);
        return el && !el.classList.contains('hidden');
      });
    return Boolean(typing || drawerOpen);
  }

  function setSnapBadge(text) {
    const badge = $('#sel-snap-badge');
    if (!badge) return;
    if (text) {
      badge.textContent = text;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    state.snapHint = text ?? '';
  }

  // -------------------------------------------------------------------------
  // Placement Ghost Preview (Phase 3 "3D placement preview before confirming")
  // -------------------------------------------------------------------------

  const previewMaterial = new THREE.MeshStandardMaterial({
    color: 0x2ce8c4,
    emissive: 0x0a5c4c,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  let previewMesh = null;

  function clearPreview({ keepPrompt = false } = {}) {
    if (previewMesh) {
      scene.remove(previewMesh);
      previewMesh.geometry?.dispose?.();
      previewMesh = null;
    }
    state.preview = null;
    if (!keepPrompt) {
      $('#vr-preview-banner')?.classList.add('hidden');
      $('#vr-preview-label').textContent = '';
    }
    setSnapBadge('');
  }

  /**
   * Build the ghost. `prompt` is either an archetype phrase for a NEW object or
   * `{ cloneOf: id }` for duplicating an existing mesh.
   */
  function startPreview(source, { at = null } = {}) {
    clearPreview();
    let geometry = null;
    let name = 'object';
    let cloneOf = null;

    if (source.cloneOf) {
      const mesh = meshById(source.cloneOf);
      if (!mesh) return false;
      geometry = mesh.geometry.clone();
      name = meshById(source.cloneOf)?.userData?.objectName ?? 'object';
      cloneOf = source.cloneOf;
    } else {
      // Reuse an existing archetype mesh as a dimension reference when possible
      const archetype = String(source.prompt ?? '').toLowerCase();
      const reference = state.objects.find((o) => {
        const n = o.name.toLowerCase();
        if (archetype.includes('fence')) return n.includes('fence');
        if (archetype.includes('barn')) return n.includes('barn');
        if (archetype.includes('windmill')) return n.includes('windmill');
        if (archetype.includes('silo')) return n.includes('silo');
        if (archetype.includes('hay')) return n.includes('hay');
        return false;
      });
      if (reference) {
        const mesh = meshById(reference.id);
        geometry = mesh.geometry.clone();
      } else {
        geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2);
      }
      name = source.prompt;
    }

    previewMesh = new THREE.Mesh(geometry, previewMaterial);
    previewMesh.userData = { preview: true, cloneOf, prompt: source.prompt ?? null };
    const spawnAt = at ?? state.pin?.point ?? state.pointer.hitPoint ?? [0, 0, -3];
    previewMesh.position.set(spawnAt[0], spawnAt[1], spawnAt[2]);
    previewMesh.rotation.set(0, 0, 0);
    scene.add(previewMesh);

    state.preview = {
      prompt: source.prompt ?? null,
      cloneOf,
      name,
      yawDeg: 0,
      position: [...previewMesh.position.toArray()],
    };
    $('#vr-preview-banner')?.classList.remove('hidden');
    $('#vr-preview-label').textContent = `👻 Previewing: ${name} — aim & click to place, R/E rotate, Esc cancel`;
    return true;
  }

  function rotatePreview(deltaDeg) {
    if (!state.preview) return;
    state.preview.yawDeg = normalizeAngleDeg(state.preview.yawDeg + deltaDeg);
    if (previewMesh) previewMesh.rotation.y = state.preview.yawDeg * DEG;
  }

  /** Live-snap the ghost every frame it is visible. */
  function updatePreviewSnap() {
    if (!state.preview || !previewMesh) return;
    const target = state.pin?.point ?? state.pointer.hitPoint;
    if (!target) return;

    previewMesh.position.set(target[0], terrain(state.world, target[0], target[2]), target[2]);
    previewMesh.rotation.y = state.preview.yawDeg * DEG;

    const box = new THREE.Box3().setFromObject(previewMesh);
    const size = box.getSize(new THREE.Vector3());
    const fp = computeObjectFootprint({
      id: '__preview',
      name: state.preview.name,
      transform: {
        translation: previewMesh.position.toArray(),
        rotation: [0, state.preview.yawDeg, 0],
        scale: [1, 1, 1],
      },
      metadata: { archetype: state.preview.prompt?.includes('fence') ? 'fence' : undefined },
    }, [size.x, size.y, size.z]);

    const solved = solveSmartPlacement(fp, otherFootprints(), {
      snapEnabled: Boolean(state.settings.snapEnabled),
      gridSnap: Number(state.settings.gridSnap) || 0,
      terrainHeightFn: (x, z) => terrain(state.world, x, z),
    });

    if (solved?.snapped) {
      previewMesh.position.set(solved.position[0], solved.position[1], solved.position[2]);
      previewMesh.rotation.y = solved.yawDeg * DEG;
      state.preview.yawDeg = solved.yawDeg;
      const label = solved.kind === 'fence-inline' ? '🧲 fence end-to-end'
        : solved.kind === 'fence-corner' ? '🧲 90° fence corner'
          : solved.kind === 'grid' ? '📐 grid snap'
            : '🧲 aligned to structure';
      setSnapBadge(label);
    } else {
      setSnapBadge('');
    }
    state.preview.position = previewMesh.position.toArray();
  }

  async function confirmPreview() {
    if (!state.preview) return false;
    const { prompt, cloneOf, yawDeg, position } = state.preview;
    const placement = {
      translation: position.map((n) => Number(n.toFixed(3))),
      rotation: [0, Number(yawDeg.toFixed(2)), 0],
    };
    clearPreview();
    if (cloneOf) {
      const res = await command('world.duplicate', { object: cloneOf, snapEndToEnd: true, cornerDeg: 0 });
      if (res.ok && res.data?.id) {
        await applyTransform(res.data.id, placement);
        selectObject(res.data.id);
      }
      return res.ok;
    }
    const res = await command('world.spawn', {
      prompt,
      at: placement.translation,
      yaw: placement.rotation[1],
      facePlayer: false,
      snap: true,
    });
    if (res.ok) {
      if (res.data?.object?.id) selectObject(res.data.object.id);
      showReply('Placed', `${prompt} placed in the world — synced to desktop & MCP.`);
    } else {
      showReply('Could not place', res.error?.message ?? 'Unknown error');
    }
    return res.ok;
  }

  /** Place a new archetype: ghost preview when enabled, otherwise immediate. */
  async function placeObject(prompt) {
    if (state.settings.previewPlacement) return startPreview({ prompt });
    const at = state.pin?.point ?? state.pointer.hitPoint ?? [0, 0, -3];
    const res = await command('world.spawn', { prompt, at, snap: true });
    if (res.ok) {
      const id = res.data?.object?.id;
      if (id) selectObject(id);
      await ctx.refresh();
    } else {
      showReply('Could not place', res.error?.message ?? 'Unknown error');
    }
    return res.ok;
  }

  // -------------------------------------------------------------------------
  // Object manipulation (move / rotate / resize / snap / duplicate / delete)
  // -------------------------------------------------------------------------

  async function applyTransform(id, { translation, rotation, scale }) {
    const payload = { object: id };
    if (translation) payload.translation = translation.map((n) => Number(Number(n).toFixed(3)));
    if (rotation) payload.rotation = rotation;
    if (scale) payload.scale = scale.map((n) => Number(Number(n).toFixed(4)));
    const res = await command('object.transform', payload);
    if (res.ok) await applyLocalTransform(id, payload);
    return res;
  }

  /** Immediately move the local mesh so VR drag feels 1:1 before the round trip. */
  function applyLocalTransform(id, { translation, rotation, scale }) {
    const mesh = meshById(id);
    if (!mesh) return;
    if (translation) mesh.position.fromArray(translation);
    if (rotation) mesh.rotation.set((rotation[0] ?? 0) * DEG, (rotation[1] ?? 0) * DEG, (rotation[2] ?? 0) * DEG);
    if (scale) mesh.scale.fromArray(scale);
    const obj = objectById(id);
    if (obj) {
      obj.transform = {
        ...(obj.transform ?? {}),
        ...(translation ? { translation } : {}),
        ...(rotation ? { rotation } : {}),
        ...(scale ? { scale } : {}),
      };
    }
    refreshSelectionVisual();
  }

  async function moveSelectedTo(point, { snap = null, silent = false } = {}) {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const fp = footprintOf(obj);
    let position = [point[0], terrain(state.world, point[0], point[2]), point[2]];
    let yawDeg = fp.yawDeg;
    let kind = null;
    const useSnap = snap === null ? Boolean(state.settings.snapEnabled) || Number(state.settings.gridSnap) > 0 : snap;

    if (useSnap) {
      const solved = solveSmartPlacement(
        { ...fp, position },
        otherFootprints(obj.id),
        {
          snapEnabled: Boolean(state.settings.snapEnabled),
          gridSnap: Number(state.settings.gridSnap) || 0,
          terrainHeightFn: (x, z) => terrain(state.world, x, z),
        },
      );
      position = solved.position;
      yawDeg = solved.yawDeg;
      kind = solved.snapped ? solved.kind : null;
    }

    const res = await applyTransform(obj.id, {
      translation: position,
      rotation: [0, Number(yawDeg.toFixed(2)), 0],
    });
    setSnapBadge(kind === 'fence-inline' ? '🧲 fence end-to-end'
      : kind === 'fence-corner' ? '🧲 90° fence corner'
        : kind === 'grid' ? '📐 grid snap'
          : kind && kind !== 'free' ? '🧲 aligned' : '');
    if (!silent) {
      showReply(kind ? 'Snapped' : 'Moved', `${obj.name} → ${position.map((n) => n.toFixed(1)).join(', ')}`);
    }
    return res.ok;
  }

  async function rotateSelected(deltaDeg) {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const yaw = normalizeAngleDeg(extractYawDeg(obj.transform?.rotation) + Number(deltaDeg));
    return (await applyTransform(obj.id, { rotation: [0, Number(yaw.toFixed(2)), 0] })).ok;
  }

  async function resizeSelected(factor) {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const cur = obj.transform?.scale ?? [1, 1, 1];
    const next = cur.map((v) => Number(clamp(Number(v) * factor, 0.12, 12).toFixed(4)));
    return (await applyTransform(obj.id, { scale: next })).ok;
  }

  async function snapSelected() {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const res = await command('world.snap', { object: obj.id, mode: 'auto', gridSnap: Number(state.settings.gridSnap) || 0 });
    if (res.ok) {
      const info = res.data ?? {};
      if (info.position) applyLocalTransform(obj.id, { translation: info.position, rotation: info.rotation ?? [0, info.yawDeg ?? 0, 0] });
      setSnapBadge(info.snapped ? `🧲 ${info.kind ?? 'snapped'}` : '');
      showReply(info.snapped ? 'Snapped' : 'Nothing nearby', info.snapped
        ? `${obj.name} snapped to ${info.targetName ?? 'the grid'} (${info.kind}).`
        : `${obj.name} has no fence or structure close enough to snap to.`);
    }
    return res.ok;
  }

  async function duplicateSelected() {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const res = await command('world.duplicate', { object: obj.id, snapEndToEnd: true });
    if (res.ok) {
      const info = res.data ?? {};
      if (info?.id) selectObject(info.id);
      showReply('Duplicated', `${obj.name} duplicated${info?.archetype === 'fence' ? ' end-to-end, extending the fence line' : ''}.`);
      await ctx.refresh();
    }
    return res.ok;
  }

  async function deleteSelected() {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const res = await command('object.delete', { object: obj.id });
    if (res.ok) {
      deselect();
      showReply('Deleted', `${obj.name} removed (undo available).`);
      await ctx.refresh();
    }
    return res.ok;
  }

  async function undo() {
    const res = await command('project.undo', {});
    showReply('Undo', res.ok ? 'Reverted the last world change.' : res.error?.message ?? 'Nothing to undo.');
    await ctx.refresh();
    return res.ok;
  }

  async function redo() {
    const res = await command('project.redo', {});
    showReply('Redo', res.ok ? 'Re-applied the change.' : res.error?.message ?? 'Nothing to redo.');
    await ctx.refresh();
    return res.ok;
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Locomotion, turning, teleport & UI lock
  // -------------------------------------------------------------------------

  const teleportArc = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x2ce8c4, transparent: true, opacity: 0.9 }),
  );
  teleportArc.visible = false;
  scene.add(teleportArc);

  const teleportMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 40),
    new THREE.MeshBasicMaterial({ color: 0x2ce8c4, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  teleportMarker.rotation.x = -Math.PI / 2;
  teleportMarker.visible = false;
  scene.add(teleportMarker);

  let snapCooldown = 0;
  let teleportHoldMs = 0;
  let teleportAiming = false;

  function computeTeleportTarget(head) {
    const start = head.position.map((n) => Number(n));
    const dir = head.forward;
    const points = [];
    const g = 9.8;
    const speed = 11;
    let px = start[0];
    let py = start[1];
    let pz = start[2];
    let vx = dir[0] * speed;
    let vy = dir[1] * speed + 2.4;
    let vz = dir[2] * speed;
    let hit = null;
    const dt = 1 / 60;
    for (let i = 0; i < 110; i += 1) {
      px += vx * dt;
      pz += vz * dt;
      vy -= g * dt;
      py += vy * dt;
      const ground = terrain(state.world, px, pz);
      points.push(new THREE.Vector3(px, py, pz));
      if (py <= ground + 0.02) {
        hit = [px, ground, pz];
        points.push(new THREE.Vector3(px, ground, pz));
        break;
      }
      if (Math.hypot(px - start[0], pz - start[2]) > 26) break;
    }
    return { points, hit };
  }

  function updateTeleport(dt) {
    const settings = state.settings;
    if (!settings.teleportEnabled || !state.inVR) {
      teleportArc.visible = false;
      teleportMarker.visible = false;
      teleportAiming = false;
      return;
    }
    if (!teleportAiming) {
      teleportArc.visible = false;
      teleportMarker.visible = false;
      return;
    }
    teleportHoldMs += dt * 1000;
    const head = headPose();
    const { points, hit } = computeTeleportTarget({
      position: head.pos.toArray(),
      forward: head.fwd.toArray(),
    });
    if (points.length < 2) return;
    teleportArc.geometry.dispose();
    teleportArc.geometry = new THREE.BufferGeometry().setFromPoints(points);
    teleportArc.visible = true;
    if (hit) {
      teleportMarker.position.set(hit[0], hit[1] + 0.02, hit[2]);
      teleportMarker.visible = true;
      state.teleportPreview = hit;
    } else {
      teleportMarker.visible = false;
      state.teleportPreview = null;
    }
  }

  function commitTeleport() {
    const hit = state.teleportPreview;
    teleportAiming = false;
    teleportArc.visible = false;
    teleportMarker.visible = false;
    if (!hit) return false;
    playerRig.position.set(hit[0], hit[1], hit[2]);
    state.teleportPreview = null;
    return true;
  }

  /**
   * One frame of VR input: locomotion, turning, teleport, menu buttons and
   * grab/drag of the selected object.
   */
  function updateVrInput(dt, { uiBlocked = false } = {}) {
    const session = renderer.xr.getSession();
    if (!session) return;
    uiBlocked = uiBlocked || uiHasFocus();
    snapCooldown = Math.max(0, snapCooldown - dt);

    const head = headPose();
    const headArr = {
      position: head.pos.toArray(),
      forward: head.fwd.toArray(),
    };

    let left = null;
    let right = null;
    for (const source of session.inputSources) {
      const parsed = parseQuestGamepad(source);
      if (parsed.hand === 'left' && !left) left = { ...parsed, source };
      else if (parsed.hand === 'right' && !right) right = { ...parsed, source };
      else if (!left) left = { ...parsed, source };
      else right = { ...parsed, source };
    }

    // ---- Locomotion (left stick) & turning (right stick) -------------------
    const step = computeLocomotionStep({
      leftStick: left?.stick ?? { x: 0, y: 0 },
      rightStick: right?.stick ?? { x: 0, y: 0 },
      headWorldForward: headArr.forward,
      rigPosition: playerRig.position.toArray(),
      rigYawRad: playerRig.rotation.y,
      dt,
      settings: { ...state.settings, teleportEnabled: false },
      snapCooldown,
      uiBlocked,
      terrainHeightFn: (x, z) => terrain(state.world, x, z),
    });
    snapCooldown = step.snapCooldown;

    if (step.moved || step.turned) {
      playerRig.position.fromArray(step.position);
      playerRig.rotation.y = step.yawRad;
      cancelDrag({ silent: true });
    }

    // ---- Optional parabolic teleport (right stick tilted forward) ---------
    const rightY = right?.stick?.y ?? 0;
    const wantsTeleport = Boolean(state.settings.teleportEnabled)
      && rightY < -0.72
      && Math.abs(right?.stick?.x ?? 0) < 0.4
      && !uiBlocked;
    if (wantsTeleport) {
      teleportAiming = true;
    } else if (teleportAiming) {
      commitTeleport();
    }
    updateTeleport(dt);

    // ---- Hand tracking (pinch = trigger, no sticks) ----------------------
    // Quest 3S hand tracking gives no gamepad, so a pinch selects / drags and
    // the "look" direction walks. This keeps the app usable without controllers.
    const hands = session.inputSources.filter((src) => src.hand);
    const usingControllers = Boolean(left?.hasGamepad || right?.hasGamepad);
    for (const hand of hands) {
      // Controllers win when both are active; hands only drive when controller-free.
      if (usingControllers) break;
      const xrHand = hand.hand;
      const tip = xrHand?.get?.('index-finger-tip');
      const thumb = xrHand?.get?.('thumb-tip');
      if (!tip?.position || !thumb?.position) continue;
      const gap = Math.hypot(
        tip.position.x - thumb.position.x,
        tip.position.y - thumb.position.y,
        tip.position.z - thumb.position.z,
      );
      const pinch = gap < 0.032;

      if (pinch && !hand._prevPinch) {
        hand._pinchAnchor = [state.pointer.hitPoint[0], tip.position.y, state.pointer.hitPoint[2]];
        if (state.preview) confirmPreview();
        else if (state.pointer.hitObjectId) selectObject(state.pointer.hitObjectId, { announce: true });
      }

      // Pinch + pull = walk (hand-tracking locomotion), applied along head gaze.
      if (pinch && hand._pinchAnchor && !state.dragging) {
        const step = computeHandLocomotion({
          handWorldPos: [state.pointer.origin?.[0] ?? 0, tip.position.y, state.pointer.origin?.[2] ?? 0],
          pinchStart: hand._pinchAnchor,
          headWorldForward: headArr.forward,
          rigPosition: playerRig.position.toArray(),
          terrainHeightFn: (x, z) => terrain(state.world, x, z),
        });
        if (step.active) playerRig.position.fromArray(step.position);
      }

      if (pinch && state.selectedId && !state.dragging) startGrab({ pointer: state.pointer.hitPoint });
      if (!pinch && state.dragging) endGrab();
      if (!pinch) hand._pinchAnchor = null;
      hand._prevPinch = pinch;
    }

    // ---- Buttons ----------------------------------------------------------
    for (const pad of [left, right]) {
      if (!pad) continue;
      if (pad.secondaryButton && !pad._prevSecondary) {
        // B / Y always toggles the board — re-summons it if it drifted out of view
        toggleMenu();
      }
      if (pad.secondaryButton) pad._prevSecondary = true;
      else pad._prevSecondary = false;

      if (pad.primaryButton && !pad._prevPrimary) {
        if (state.preview) {
          confirmPreview();
        } else {
          toggleVoiceCapture();
        }
      }
      if (pad.primaryButton) pad._prevPrimary = true;
      else pad._prevPrimary = false;

      // Grip is handled by the controller `squeezestart`/`squeezeend` events
      // (summon-only menu + grab), so we deliberately do not duplicate it here.
    }

    // ---- Live grab: keep following the pointer/head while grip is held -----
    if (state.dragging) {
      const hit = state.pin?.point ?? state.pointer.hitPoint;
      if (hit && performance.now() - state.dragging.lastPush > 70) {
        state.dragging.lastPush = performance.now();
        const target = [
          hit[0] + (state.dragging.offset?.[0] ?? 0),
          hit[1],
          hit[2] + (state.dragging.offset?.[2] ?? 0),
        ];
        moveSelectedTo(target, { silent: true }).catch(() => {});
      }
    }

    refreshSelectionVisual();
  }

  // ---- Grab / drag ---------------------------------------------------------

  function startGrab({ pointer = null } = {}) {
    const obj = state.selectedId ? objectById(state.selectedId) : null;
    if (!obj) return false;
    const start = pointer ?? state.pointer.hitPoint ?? obj.transform?.translation ?? [0, 0, 0];
    state.dragging = {
      id: obj.id,
      // Offset from object origin to where the user grabbed, so it doesn't jump
      offset: [
        (obj.transform?.translation?.[0] ?? 0) - start[0],
        0,
        (obj.transform?.translation?.[2] ?? 0) - start[2],
      ],
      lastPush: 0,
    };
    renderSelectionUi();
    showReply('Grabbed', `${obj.name} — move your head/hand; it snaps to fences, structures or the grid.`);
    return true;
  }

  function endGrab() {
    if (!state.dragging) return false;
    const id = state.dragging.id;
    state.dragging = null;
    renderSelectionUi();
    const obj = objectById(id);
    if (obj) {
      const tr = obj.transform?.translation ?? [0, 0, 0];
      moveSelectedTo([tr[0], tr[1], tr[2]], { snap: true, silent: false }).catch(() => {});
    }
    return true;
  }

  function cancelDrag({ silent = false } = {}) {
    if (!state.dragging) return;
    state.dragging = null;
    renderSelectionUi();
    if (!silent) showReply('Move cancelled', 'Release grip to drop the object.');
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Floating board: toggle, summon-only, drag, wrist pill
  // -------------------------------------------------------------------------

  function boardWorldPose() {
    const mesh = ctx.boardMesh();
    if (!mesh) return null;
    const pos = new THREE.Vector3();
    mesh.getWorldPosition(pos);
    return { position: pos.toArray(), mesh };
  }

  function summonMenu() {
    const mesh = ctx.boardMesh();
    if (!mesh) return;
    mesh.visible = true;
    ctx.placeBoard();
    ctx.redrawBoard();
  }

  function hideMenu() {
    const mesh = ctx.boardMesh();
    if (!mesh) return;
    mesh.visible = false;
    state.menuGrab = null;
  }

  /**
   * `B`/`Y` (or a menu tab tap) behaviour: hide only when already comfortably in
   * view, otherwise re-summon in front of the user's gaze.
   */
  function toggleMenu() {
    const mesh = ctx.boardMesh();
    if (!mesh) return;
    const pose = boardWorldPose();
    const head = headArrays();
    const decision = evaluateMenuAction({
      visible: mesh.visible,
      menuWorldPos: pose.position,
      headWorldPos: head.position,
      headWorldForward: head.forward,
      trigger: 'toggle',
    });
    if (decision.visible) {
      mesh.visible = true;
      ctx.placeBoard();
      ctx.redrawBoard();
    } else {
      hideMenu();
    }
  }

  /** Desktop/menu-pill tab: always ensure the board is visible & in front. */
  function ensureMenuVisible() {
    const mesh = ctx.boardMesh();
    if (!mesh) return;
    if (!mesh.visible) {
      mesh.visible = true;
      ctx.placeBoard();
    }
    ctx.redrawBoard();
  }

  /** Called from the board's drag handle area (top strip) each frame. */
  function beginBoardDrag(uv) {
    const mesh = ctx.boardMesh();
    if (!mesh) return;
    state.menuGrab = {
      planeY: mesh.getWorldPosition(new THREE.Vector3()).y,
      offsetUv: uv ? { u: uv.x, v: uv.y } : { u: 0.5, v: 1 },
    };
  }

  function dragBoardTo(point, uv = null) {
    const mesh = ctx.boardMesh();
    if (!mesh || !state.menuGrab) return;
    if (!uv) return;
    // Keep the panel's grabbed point under the controller ray, capped to reach
    mesh.position.copy(point);
    mesh.lookAt(playerRig.localToWorld(headPose().pos.clone()));
  }

  function endBoardDrag() {
    state.menuGrab = null;
  }

  // -------------------------------------------------------------------------
  // Phase 2/3 — Unified board action handler (VR + on-screen mirror)
  // -------------------------------------------------------------------------

  async function runBoardAction(id) {
    if (!id) return;
    if (id === 'menu') {
      ensureMenuVisible();
      return;
    }
    if (id === 'speak') return toggleVoiceCapture();
    if (id === 'pin') return ctx.pinCurrentSpot();
    if (id === 'undo') return undo();
    if (id === 'redo') return redo();
    if (id === 'exit-vr') {
      renderer.xr.getSession()?.end();
      return;
    }
    if (id === 'select-mode') {
      showReply('Select mode', 'Point at any object and pull the trigger to select it.');
      return;
    }
    if (id === 'rotate-l') return rotateSelected(-45);
    if (id === 'rotate-r') return rotateSelected(45);
    if (id === 'bigger') return resizeSelected(1.18);
    if (id === 'smaller') return resizeSelected(0.85);
    if (id === 'snap') return snapSelected();
    if (id === 'duplicate') return duplicateSelected();
    if (id === 'delete') return deleteSelected();
    if (id === 'deselect') return deselect();
    if (id.startsWith('cmd:')) {
      await submitSpatialPrompt(id.slice(4));
      return;
    }
    if (id.startsWith('place:')) {
      await placeObject(id.slice(6));
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Desktop / pointer interaction (click-to-select + drag-to-move)
  // -------------------------------------------------------------------------

  async function onPointerPrimaryDown(pointerHit) {
    if (state.preview) {
      await confirmPreview();
      return true;
    }
    if (state.menuGrab) {
      state.menuGrab = { ...state.menuGrab, active: true };
      return true;
    }
    return false;
  }

  async function onPointerPrimaryUp({ moved = false, hit = null, wasDragging = false } = {}) {
    if (wasDragging) {
      endGrab();
      return true;
    }
    if (state.menuGrab?.active) {
      state.menuGrab.active = false;
      return true;
    }
    if (!hit) return false;
    if (hit.objectId) {
      selectObject(hit.objectId, { announce: true });
      return true;
    }
    // Ground click: if something is selected, drag it there, else pin "right there".
    if (state.selectedId && !state.dragging) {
      await moveSelectedTo([hit.point[0], hit.point[1], hit.point[2]]);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  return {
    // selection
    selectObject,
    deselect,
    renderSelectionUi,
    refreshSelectionVisual,
    // preview
    placeObject,
    startPreview,
    confirmPreview,
    clearPreview,
    rotatePreview,
    updatePreviewSnap,
    isPreviewing: () => Boolean(state.preview),
    // editing
    moveSelectedTo,
    rotateSelected,
    resizeSelected,
    snapSelected,
    duplicateSelected,
    deleteSelected,
    undo,
    redo,
    applyTransform,
    applyLocalTransform,
    // drag
    startGrab,
    endGrab,
    cancelDrag,
    // locomotion / input
    updateVrInput,
    headPose,
    headArrays,
    // menu
    toggleMenu,
    summonMenu,
    hideMenu,
    ensureMenuVisible,
    beginBoardDrag,
    dragBoardTo,
    endBoardDrag,
    runBoardAction,
    // pointer
    onPointerPrimaryDown,
    onPointerPrimaryUp,
    // helper exports used by the visual layer
    footprintOf,
    otherFootprints,
  };
}
