import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runCommand } from '../src/core/operations.mjs';
import { Project } from '../src/core/project.mjs';
import { executeWorldPrompt } from '../src/core/world-agent.mjs';
import {
  DEFAULT_VR_SETTINGS,
  applyStickDeadzone,
  computeFenceSnap,
  computeHandLocomotion,
  computeLocomotionStep,
  computeMenuSummonPose,
  computeObjectFootprint,
  computeStructureAlignment,
  evaluateMenuAction,
  extractYawDeg,
  fenceEndpoints,
  localAxesFromYaw,
  parseQuestGamepad,
  snapPoseToGrid,
  solveSmartPlacement,
} from '../src/core/vr-interaction.mjs';
import { startServer } from '../src/server/main.mjs';

const DEG = Math.PI / 180;

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-vrctl-'));
  process.env.MODELSTUDIO_HOME = dir;
  return dir;
}

/** Advance the shared locomotion solver over N real frames (dt is clamped to 0.1s). */
function sim(frames, params, { dt = 1 / 72 } = {}) {
  let out = null;
  let rig = {
    position: params.rigPosition ?? [0, 0, 0],
    yawRad: params.rigYawRad ?? 0,
  };
  let cooldown = params.snapCooldown ?? 0;
  for (let i = 0; i < frames; i += 1) {
    out = computeLocomotionStep({
      ...params,
      rigPosition: rig.position,
      rigYawRad: rig.yawRad,
      snapCooldown: cooldown,
      dt,
    });
    rig = { position: out.position, yawRad: out.yawRad };
    cooldown = out.snapCooldown;
  }
  return out;
}

// World-scale (meters) archetype boxes, matching `WORLD_TARGET_HEIGHTS`.
const FENCE_BOX = [2.591, 1.25, 0.166];
const BARN_BOX = [5.881, 6.4, 7.062];
const SILO_BOX = [2.4, 6.5, 2.4];

function fenceAt(id, name, x, z, yawDeg) {
  return computeObjectFootprint(
    { id, name, transform: { translation: [x, 0, z], rotation: [0, yawDeg, 0] } },
    FENCE_BOX,
  );
}

/** Fake Meta Quest 3S Touch Plus `xr-standard` input source. */
function questSource(handedness, { x = 0, y = 0, buttons = {} } = {}) {
  const pressed = (idx) => Boolean(buttons[idx]);
  return {
    handedness,
    gamepad: {
      axes: [0, 0, x, y],
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: pressed(i), value: pressed(i) ? 1 : 0 })),
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — Quest 3S controller mapping & comfort locomotion
// ---------------------------------------------------------------------------

test('Quest 3S Touch Plus xr-standard mapping reads sticks & buttons', () => {
  const right = parseQuestGamepad(questSource('right', { x: 0.8, y: -0.5, buttons: { 0: true, 1: true, 4: true } }));
  assert.equal(right.hand, 'right');
  assert.equal(right.hasGamepad, true);
  assert.ok(right.stick.x > 0.7 && right.stick.x <= 1, `stick x ${right.stick.x}`);
  assert.ok(right.stick.y < -0.3, `stick y ${right.stick.y}`);
  assert.equal(right.trigger, true);
  assert.equal(right.grip, true);
  assert.equal(right.primaryButton, true); // A
  assert.equal(right.secondaryButton, false);

  const left = parseQuestGamepad(questSource('left', { buttons: { 5: true } }));
  assert.equal(left.hand, 'left');
  assert.equal(left.secondaryButton, true); // Y
  assert.equal(left.stick.active, false);

  // Legacy 2-axis pads still parse
  const legacy = parseQuestGamepad({ handedness: 'right', gamepad: { axes: [0.5, 0.5], buttons: [] } });
  assert.ok(legacy.stick.x > 0.2);
});

test('deadzone removes rest drift but keeps subtle deflections', () => {
  const rest = applyStickDeadzone(0.05, -0.04, 0.16);
  assert.equal(rest.active, false);
  assert.equal(rest.x, 0);
  const gentle = applyStickDeadzone(0.3, 0, 0.16);
  assert.equal(gentle.active, true);
  assert.ok(gentle.x > 0 && gentle.x < 0.3, 'rescaled output is smaller but non-zero');
});

test('world-gaze locomotion walks where the headset looks after turning the rig', () => {
  // User turned 90° to the right (rig yaw = -90°): headset now looks toward +X.
  const rigYaw = -90 * DEG;
  const headForward = [1, 0, 0];

  // ~1s of frames at 72Hz, 4.5 m/s
  const fwd = sim(72, {
    leftStick: { x: 0, y: -1 },
    headWorldForward: headForward,
    rigYawRad: rigYaw,
    settings: { ...DEFAULT_VR_SETTINGS, moveSpeed: 4.5 },
  });
  assert.ok(fwd.moved);
  assert.ok(fwd.position[0] > 4, `expected +X walk, got ${fwd.position}`);
  assert.ok(Math.abs(fwd.position[2]) < 1e-6);

  const strafeRight = sim(72, {
    leftStick: { x: 1, y: 0 },
    headWorldForward: headForward,
    rigYawRad: rigYaw,
    settings: { ...DEFAULT_VR_SETTINGS, moveSpeed: 4.5 },
  });
  // Facing +X, the player's right is +Z (forward × up) in Three.js space
  assert.ok(strafeRight.position[2] > 4, `expected +Z strafe, got ${strafeRight.position}`);

  // Walk-back must reverse exactly (predictable, no drift)
  const back = sim(72, {
    leftStick: { x: 0, y: 1 },
    headWorldForward: headForward,
    rigYawRad: rigYaw,
    settings: { ...DEFAULT_VR_SETTINGS, moveSpeed: 4.5 },
  });
  assert.ok(Math.abs(back.position[0] + fwd.position[0]) < 1e-6);
});

test('locomotion respects UI lock and never teleports during turning', () => {
  const blocked = computeLocomotionStep({
    leftStick: { x: 0, y: -1 },
    rightStick: { x: 1, y: -1 },
    headWorldForward: [0, 0, -1],
    rigPosition: [2, 0, 3],
    rigYawRad: 0,
    dt: 1,
    uiBlocked: true,
  });
  assert.deepEqual(blocked.position, [2, 0, 3]);
  assert.equal(blocked.moved, false);
  assert.equal(blocked.turned, false);

  // Teleport only "aims" — it never moves the rig by itself
  const aiming = computeLocomotionStep({
    rightStick: { x: 0, y: -1 },
    rigPosition: [0, 0, 0],
    rigYawRad: 0,
    dt: 1 / 72,
    settings: { ...DEFAULT_VR_SETTINGS, teleportEnabled: true },
  });
  assert.equal(aiming.teleportAiming, true);
  assert.deepEqual(aiming.position, [0, 0, 0]);
});

test('hand-tracking pinch-and-pull locomotion follows head gaze', () => {
  const anchor = [0, 1.3, 0];
  const forward = [0, 0, -1];
  // Pushing the hand away from you walks forward
  const push = computeHandLocomotion({ handWorldPos: [0, 1.3, -0.2], pinchStart: anchor, headWorldForward: forward });
  assert.equal(push.active, true);
  assert.ok(push.position[2] < -0.1, `expected forward walk, got ${push.position}`);
  // Pulling back toward you walks backwards
  const pull = computeHandLocomotion({ handWorldPos: [0, 1.3, 0.2], pinchStart: anchor, headWorldForward: forward });
  assert.ok(pull.position[2] > 0.1, `expected backward walk, got ${pull.position}`);
  // Lateral motion strafes
  const strafe = computeHandLocomotion({ handWorldPos: [0.3, 1.3, 0], pinchStart: anchor, headWorldForward: forward });
  assert.ok(Math.abs(strafe.position[0]) > 0.1);
  // Step is capped so a wild hand movement cannot fling the player
  const far = computeHandLocomotion({ handWorldPos: [0, 1.3, -4], pinchStart: anchor, headWorldForward: forward });
  assert.ok(Math.hypot(far.position[0], far.position[2]) <= 0.451);
  // No pinch = no motion
  const idle = computeHandLocomotion({ handWorldPos: [0, 1.3, -4], pinchStart: null });
  assert.equal(idle.active, false);
  assert.deepEqual(idle.position, [0, 0, 0]);
});

test('smooth and snap turning use configurable speeds and steps', () => {
  const smooth = sim(72, {
    rightStick: { x: 1, y: 0 },
    settings: { ...DEFAULT_VR_SETTINGS, turnMode: 'smooth', turnSpeedDeg: 90 },
  });
  assert.ok(smooth.turned);
  assert.ok(Math.abs(smooth.yawRad + Math.PI / 2) < 1e-6, `yaw ${smooth.yawRad}`);

  const snap = computeLocomotionStep({
    rightStick: { x: 1, y: 0 },
    rigYawRad: 0,
    dt: 1 / 72,
    settings: { ...DEFAULT_VR_SETTINGS, turnMode: 'snap', snapAngleDeg: 45 },
  });
  assert.ok(Math.abs(snap.yawRad + 45 * DEG) < 1e-6);
  assert.ok(snap.snapCooldown > 0, 'snap turn applies a cooldown so it cannot spam');

  const onCooldown = computeLocomotionStep({
    rightStick: { x: 1, y: 0 },
    rigYawRad: -45 * DEG,
    snapCooldown: 0.2,
    settings: { ...DEFAULT_VR_SETTINGS, turnMode: 'snap', snapAngleDeg: 45 },
  });
  assert.equal(onCooldown.turned, false);
  assert.ok(Math.abs(onCooldown.yawRad + 45 * DEG) < 1e-6);
});

// ---------------------------------------------------------------------------
// Phase 2 — Floating menu behaviour
// ---------------------------------------------------------------------------

test('B/Y hides only an in-view board, otherwise re-summons it in front of the user', () => {
  const head = { headWorldPos: [0, 1.68, 0], headWorldForward: [0, 0, -1] };

  const summonWhenHidden = evaluateMenuAction({ visible: false, menuWorldPos: [0, 1.5, -1.2], ...head });
  assert.deepEqual(summonWhenHidden, { visible: true, summon: true });

  const hideWhenInView = evaluateMenuAction({ visible: true, menuWorldPos: [0, 1.5, -1.2], ...head });
  assert.deepEqual(hideWhenInView, { visible: false, summon: false });

  // Board was left behind the player after a 180° turn -> must jump back into view
  const reSummonBehind = evaluateMenuAction({ visible: true, menuWorldPos: [0, 1.5, 4.0], ...head });
  assert.deepEqual(reSummonBehind, { visible: true, summon: true });

  // Very far away -> re-summon as well
  const reSummonFar = evaluateMenuAction({ visible: true, menuWorldPos: [0, 1.5, -9.0], ...head });
  assert.deepEqual(reSummonFar, { visible: true, summon: true });

  // Grip is summon-only: a visible, in-view board is never dismissed
  const grip = evaluateMenuAction({ visible: true, menuWorldPos: [0, 1.5, -1.2], ...head, trigger: 'grip' });
  assert.deepEqual(grip, { visible: true, summon: true });
});

test('menu summon pose lands in front of world-space gaze after the rig is rotated', () => {
  const head = { headWorldPos: [3, 1.68, 2], headWorldForward: [1, 0, 0] }; // looking toward +X
  const pose = computeMenuSummonPose(head);
  assert.ok(pose.position[0] > 4, `expected board in front (+X), got ${pose.position}`);
  assert.ok(Math.abs(pose.position[2] - 2) < 1e-6);
  assert.ok(pose.position[1] >= 0.95, 'board stays at a comfortable height');
  // Plane normal (+localZ) must point back toward the user (i.e. -X here)
  const { localZ } = localAxesFromYaw(pose.yawDeg);
  const toHead = [head.headWorldPos[0] - pose.position[0], head.headWorldPos[2] - pose.position[2]];
  const dot = (localZ[0] * toHead[0] + localZ[2] * toHead[1]) / Math.hypot(toHead[0], toHead[1]);
  assert.ok(dot > 0.99, `board must face the user, dot=${dot}`);
});

// ---------------------------------------------------------------------------
// Phase 3 — Selection, manipulation, fence snapping, alignment, grid
// ---------------------------------------------------------------------------

test('fence footprints expose both end posts and snap inline end-to-end', () => {
  const fenceA = fenceAt('a', 'wooden_fence_1', 0, 0, 0);
  assert.equal(fenceA.size[0], FENCE_BOX[0]);
  const ends = fenceEndpoints(fenceA);
  assert.ok(ends.plus[0] > 1.2 && ends.minus[0] < -1.2, `ends ${ends.plus} / ${ends.minus}`);

  // Drag a second fence near the +X post, slightly rotated and offset
  const fenceB = fenceAt('b', 'wooden_fence_2', 2.9, 0.4, 6);
  const snap = computeFenceSnap(fenceB, [fenceA]);
  assert.equal(snap.snapped, true);
  assert.equal(snap.kind, 'fence-inline');
  assert.ok(Math.abs(snap.yawDeg) < 1e-6, `yaw ${snap.yawDeg}`);
  const expectedCenterX = ends.halfSpan + fenceB.size[0] / 2;
  assert.ok(Math.abs(snap.position[0] - expectedCenterX) < 0.02, `center ${snap.position[0]} vs ${expectedCenterX}`);
  assert.ok(Math.abs(snap.position[2]) < 0.02, 'sideways offset removed');
});

test('fence snapping supports 90° paddock corners', () => {
  const fenceA = fenceAt('a', 'fence_a', 0, 0, 0);
  const corner = fenceAt('b', 'fence_b', 1.6, 1.9, 90);
  const snap = computeFenceSnap(corner, [fenceA]);
  assert.equal(snap.snapped, true);
  assert.equal(snap.kind, 'fence-corner');
  // Corner post must be shared exactly
  const target = fenceEndpoints(fenceA).plus;
  assert.ok(Math.abs(snap.anchorPoint[0] - target[0]) < 1e-6);
  assert.ok(Math.abs(snap.anchorPoint[2] - target[2]) < 1e-6);
  // The new fence's own end must sit on that same post
  const placed = fenceEndpoints({ ...corner, position: snap.position, yawDeg: snap.yawDeg });
  const touching = Math.min(
    Math.hypot(placed.plus[0] - target[0], placed.plus[2] - target[2]),
    Math.hypot(placed.minus[0] - target[0], placed.minus[2] - target[2]),
  );
  assert.ok(touching < 1e-3, `corner gap ${touching}`);
});

test('structures magnetically align yaw and centerline', () => {
  const barn = computeObjectFootprint(
    { id: 'barn', name: 'green_barn_1', transform: { translation: [10, 0, -6], rotation: [0, 30, 0] } },
    BARN_BOX,
  );
  // Offset 6m along the barn's own localX, only 0.3m off its centreline (localZ)
  const { localX, localZ } = localAxesFromYaw(30);
  const nearPos = [
    10 + localX[0] * 6 + localZ[0] * 0.3,
    0,
    -6 + localX[2] * 6 + localZ[2] * 0.3,
  ];
  const near = computeObjectFootprint(
    { id: 'silo', name: 'grain_silo_1', transform: { translation: nearPos, rotation: [0, 34, 0] } },
    SILO_BOX,
  );
  const aligned = computeStructureAlignment(near, [barn]);
  assert.equal(aligned.aligned, true);
  assert.ok(Math.abs(aligned.yawDeg - 30) < 1e-6);
  // Perpendicular (localZ) offset must be pulled onto the barn's centreline
  const offZ = (aligned.position[0] - barn.position[0]) * localZ[0]
    + (aligned.position[2] - barn.position[2]) * localZ[2];
  assert.ok(Math.abs(offZ) < 1e-3, `centreline offset ${offZ}`);
  const offX = (aligned.position[0] - barn.position[0]) * localX[0]
    + (aligned.position[2] - barn.position[2]) * localX[2];
  assert.ok(Math.abs(offX - 6) < 0.05, `kept its 6m offset along the barn axis, got ${offX}`);
});

test('grid snapping rounds position and yaw and follows terrain height', () => {
  const terrain = (x, z) => 0.25 * Math.sin(x) + 0.1 * z;
  const grid = snapPoseToGrid([1.32, 0, -2.61], 37, { gridStep: 0.5, angleStepDeg: 15, terrainHeightFn: terrain });
  assert.equal(grid.position[0], 1.5);
  assert.equal(grid.position[2], -2.5);
  assert.equal(grid.yawDeg, 30);
  assert.ok(Math.abs(grid.position[1] - terrain(1.5, -2.5)) < 1e-3);
});

test('smart placement prefers fences, then structures, then grid', () => {
  const other = fenceAt('a', 'fence_a', 0, 0, 0);
  const movingFence = fenceAt('b', 'fence_b', 2.7, 0.3, 0);
  const fenceSnap = solveSmartPlacement(movingFence, [other], { snapEnabled: true });
  assert.equal(fenceSnap.snapped, true);
  assert.equal(fenceSnap.kind, 'fence-inline');

  const freeProp = computeObjectFootprint(
    { id: 'c', name: 'rock_1', transform: { translation: [1.23, 0, 4.44], rotation: [0, 12, 0] } },
    [0.8, 0.7, 0.9],
  );
  const gridded = solveSmartPlacement(freeProp, [], { snapEnabled: true, gridSnap: 0.5 });
  assert.equal(gridded.kind, 'grid');
  assert.equal(gridded.position[0], 1);
  assert.equal(gridded.position[2], 4.5);
});

// ---------------------------------------------------------------------------
// Phase 3/5 — Registry commands: snap, duplicate, transform, undo/redo
// ---------------------------------------------------------------------------

test('world.spawn snaps a fence onto an existing fence line', async () => {
  const home = await tempWorkspace();
  try {
    await runCommand('project.create', { name: 'SnapYard', root: home });
    const first = await runCommand('world.spawn', { project: 'SnapYard', prompt: 'wooden fence', at: [0, 0, 0], yaw: 0, snap: false });
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const fenceName = first.data.result.object.name;

    const second = await runCommand('world.spawn', {
      project: 'SnapYard',
      prompt: 'wooden fence',
      at: [2.6, 0, 0.3],
      yaw: 8,
      snap: true,
    });
    assert.equal(second.ok, true, JSON.stringify(second.error));
    assert.equal(second.data.result.snap.snapped, true);
    assert.equal(second.data.result.snap.kind, 'fence-inline');
    assert.ok(Math.abs(second.data.result.object.yaw) < 1e-6, 'yaw straightened to match the fence line');

    const world = await runCommand('world.get', { project: 'SnapYard' });
    assert.ok(world.ok);
    assert.ok(world.data.context.vr.inVR !== undefined);
    const snapshot = await runCommand('object.list', { project: 'SnapYard' });
    assert.ok(snapshot.ok);
    const names = (snapshot.data.result?.objects ?? snapshot.data.objects).map((o) => o.name);
    assert.ok(names.includes(fenceName), names.join(','));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('world.snap + world.duplicate extend a fence line end-to-end', async () => {
  const home = await tempWorkspace();
  try {
    await runCommand('project.create', { name: 'Paddock', root: home });
    const base = await runCommand('world.spawn', { project: 'Paddock', prompt: 'wooden fence', at: [0, 0, 0], yaw: 0, snap: false });
    const baseId = base.data.result.object.id;

    const dup = await runCommand('world.duplicate', { project: 'Paddock', object: baseId, snapEndToEnd: true });
    assert.equal(dup.ok, true, JSON.stringify(dup.error));
    const dupInfo = dup.data.result;
    assert.ok(dupInfo.position[0] > 2.0, `duplicate placed beyond the post: ${dupInfo.position}`);

    // Move the duplicate off-line, then snap it back
    await runCommand('object.transform', { project: 'Paddock', object: dupInfo.id, translation: [3.4, 0, 0.9], rotation: [0, 12, 0] });
    const snapped = await runCommand('world.snap', { project: 'Paddock', object: dupInfo.id, mode: 'auto' });
    assert.equal(snapped.ok, true, JSON.stringify(snapped.error));
    assert.equal(snapped.data.result.snapped, true);

    const project = await Project.open('Paddock', { root: home });
    const a = project.data.objects[baseId];
    const b = project.data.objects[dupInfo.id];
    const endsA = fenceEndpoints(computeObjectFootprint(a));
    const endsB = fenceEndpoints(computeObjectFootprint(b));
    const gap = Math.min(
      Math.hypot(endsA.plus[0] - endsB.plus[0], endsA.plus[2] - endsB.plus[2]),
      Math.hypot(endsA.plus[0] - endsB.minus[0], endsA.plus[2] - endsB.minus[2]),
      Math.hypot(endsA.minus[0] - endsB.plus[0], endsA.minus[2] - endsB.plus[2]),
    );
    assert.ok(gap < 0.05, `posts should meet, gap=${gap}`);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('object.transform drives grab-move, rotate and resize; undo/redo round-trip', async () => {
  const home = await tempWorkspace();
  try {
    await runCommand('project.create', { name: 'EditBay', root: home });
    const spawned = await runCommand('world.spawn', { project: 'EditBay', prompt: 'green barn', at: [4, 0, -6], snap: false });
    const id = spawned.data.result.object.id;
    const baseline = await Project.open('EditBay', { root: home });
    const baseScale = [...baseline.data.objects[id].transform.scale];

    const moved = await runCommand('object.transform', { project: 'EditBay', object: id, translation: [6, 0, -9] });
    assert.deepEqual(moved.data.result.transform.translation, [6, 0, -9]);

    const rotated = await runCommand('object.transform', { project: 'EditBay', object: id, rotation: [0, 90, 0] });
    assert.equal(rotated.data.result.transform.rotation[1], 90);

    const doubled = baseScale.map((v) => Number((v * 2).toFixed(4)));
    const scaled = await runCommand('object.transform', { project: 'EditBay', object: id, scale: doubled });
    assert.deepEqual(scaled.data.result.transform.scale, doubled);

    const undone = await runCommand('project.undo', { project: 'EditBay' });
    assert.equal(undone.ok, true);
    let project = await Project.open('EditBay', { root: home });
    assert.deepEqual(project.data.objects[id].transform.scale, baseScale);

    const redone = await runCommand('project.redo', { project: 'EditBay' });
    assert.equal(redone.ok, true);
    project = await Project.open('EditBay', { root: home });
    assert.deepEqual(project.data.objects[id].transform.scale, doubled);

    const deleted = await runCommand('object.delete', { project: 'EditBay', object: id });
    assert.equal(deleted.ok, true);
    project = await Project.open('EditBay', { root: home });
    assert.equal(project.data.objects[id], undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 3/5 — AI spatial editing (offline zero-key planner)
// ---------------------------------------------------------------------------

test('AI spatial edits: "move that fence closer", "rotate this windmill", duplicate, snap', async () => {
  const home = await tempWorkspace();
  try {
    await runCommand('project.create', { name: 'DirectorVR', root: home });

    const fence = await runCommand('world.spawn', { project: 'DirectorVR', prompt: 'wooden fence', at: [0, 0, -6], yaw: 0, snap: false });
    const fenceId = fence.data.result.object.id;
    const windmill = await runCommand('world.spawn', { project: 'DirectorVR', prompt: 'tall windmill', at: [7, 0, -10], snap: false });
    const windmillId = windmill.data.result.object.id;

    // Pointing at the fence from 4m away
    await runCommand('vr.point', {
      project: 'DirectorVR',
      inVR: true,
      head: { position: [0, 1.68, 2], forward: [0, 0, -1] },
      pointer: {
        active: true,
        hand: 'right',
        hitPoint: [0, 0, -6],
        hitKind: 'object',
        hitObjectId: fenceId,
        hitObjectName: 'wooden_fence_1',
      },
      pinCurrent: true,
    });

    const closer = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'move that fence closer',
      provider: 'local',
    });
    assert.equal(closer.actions[0].ok, true, JSON.stringify(closer.actions));
    const afterCloser = await Project.open('DirectorVR', { root: home });
    const movedZ = afterCloser.data.objects[fenceId].transform.translation[2];
    assert.ok(movedZ > -6, `fence should move toward the player, got z=${movedZ}`);

    const rotate = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'rotate this windmill to 90 degrees',
      provider: 'local',
    });
    assert.equal(rotate.actions[0].ok, true, JSON.stringify(rotate.actions));
    let project = await Project.open('DirectorVR', { root: home });
    const windmillYaw = extractYawDeg(project.data.objects[windmillId].transform.rotation);
    assert.ok(Math.abs(windmillYaw - 90) < 1e-6, `windmill yaw ${windmillYaw}`);

    const dup = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'duplicate that fence',
      provider: 'local',
    });
    assert.equal(dup.actions[0].ok, true, JSON.stringify(dup.actions));
    project = await Project.open('DirectorVR', { root: home });
    assert.equal(Object.keys(project.data.objects).length, 3);

    const snap = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'snap that fence',
      provider: 'local',
    });
    assert.equal(snap.actions[0].ok, true, JSON.stringify(snap.actions));

    const undo = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'undo',
      provider: 'local',
    });
    assert.equal(undo.actions[0].ok, true, JSON.stringify(undo.actions));
    const redo = await executeWorldPrompt({
      project: await Project.open('DirectorVR', { root: home }),
      runCommand,
      instruction: 'redo',
      provider: 'local',
    });
    assert.equal(redo.actions[0].ok, true, JSON.stringify(redo.actions));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 5 — MCP parity + GLB export
// ---------------------------------------------------------------------------

test('MCP tools expose snap/duplicate and stay in sync with VR edits', async () => {
  const home = await tempWorkspace();
  const { server, port } = await startServer({ port: 0, root: home, host: '127.0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'vr-controls-edit-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await runCommand('project.create', { name: 'McpYard', root: home });
    const spawned = await runCommand('world.spawn', { project: 'McpYard', prompt: 'wooden fence', at: [0, 0, 0], yaw: 0, snap: false });
    const fenceId = spawned.data.result.object.id;

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('modelstudio_world_snap'), names.join(','));
    assert.ok(names.includes('modelstudio_world_duplicate'), names.join(','));

    const duplicate = await client.callTool({
      name: 'modelstudio_world_duplicate',
      arguments: { project: 'McpYard', object: fenceId, snapEndToEnd: true },
    });
    assert.ok(!duplicate.isError, JSON.stringify(duplicate.content));

    const prompt = await client.callTool({
      name: 'modelstudio_world_prompt',
      arguments: { project: 'McpYard', instruction: 'move that fence closer', provider: 'local' },
    });
    assert.ok(!prompt.isError, JSON.stringify(prompt.content));

    const snap = await client.callTool({
      name: 'modelstudio_world_snap',
      arguments: { project: 'McpYard', object: fenceId, mode: 'auto' },
    });
    assert.ok(!snap.isError, JSON.stringify(snap.content));

    const state = await runCommand('world.get', { project: 'McpYard' });
    assert.ok(state.data.context.objects.length >= 2, JSON.stringify(state.data.context?.objects));

    // GLB export still works after live VR-style edits
    const glb = await runCommand('export.glb', { project: 'McpYard' });
    assert.equal(glb.ok, true, JSON.stringify(glb.error));
    const glbPath = glb.data.path;
    const bytes = await fs.readFile(glbPath);
    assert.equal(bytes.subarray(0, 4).toString('utf8'), 'glTF');
  } finally {
    await transport.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('local axis math stays consistent with Three.js Y-Euler rotation', () => {
  assert.deepEqual(localAxesFromYaw(0).localX.map((n) => Math.round(n)), [1, 0, -0]);
  const y90 = localAxesFromYaw(90);
  assert.ok(Math.abs(y90.localX[0]) < 1e-9 && Math.abs(y90.localX[2] + 1) < 1e-9);
  assert.equal(extractYawDeg([0, 45, 0]), 45);
  const quat = [0, Math.sin(45 * DEG / 2), 0, Math.cos(45 * DEG / 2)]; // yaw 45° as quaternion
  assert.ok(Math.abs(extractYawDeg(quat) - 45) < 1e-6);
});
