// Isomorphic VR input, locomotion, menu state, object manipulation, fence
// end-to-end snapping, and magnetic structure alignment helpers.
//
// Shared by `web-src/vr-main.js` (WebXR + Desktop client), `src/core/operations.mjs`
// (`world.snap`), `src/core/world-agent.mjs` (Spatial AI editing), and automated
// regression tests (`tests/vr-controls-edit.test.mjs`).

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const DEFAULT_VR_SETTINGS = Object.freeze({
  moveSpeed: 4.5, // meters/sec (presets: 2.4 Slow, 4.5 Normal, 7.5 Fast)
  turnMode: 'smooth', // 'smooth' | 'snap'
  turnSpeedDeg: 95, // deg/sec for smooth turning (presets: 60, 95, 135)
  snapAngleDeg: 30, // degrees per snap turn (presets: 30, 45)
  teleportEnabled: false, // optional parabolic teleport on Right Stick forward
  snapEnabled: true, // magnetic fence end-to-end + structure alignment
  gridSnap: 0, // 0 = off, 0.5 = 0.5m grid, 1.0 = 1m grid
  previewPlacement: true, // show 3D ghost preview before confirming placement
});

export const SPEED_PRESETS = [
  { id: 'slow', label: 'Slow', moveSpeed: 2.4, turnSpeedDeg: 60 },
  { id: 'normal', label: 'Normal', moveSpeed: 4.5, turnSpeedDeg: 95 },
  { id: 'fast', label: 'Fast', moveSpeed: 7.5, turnSpeedDeg: 135 },
];

export function normalizeAngleDeg(deg) {
  let a = Number(deg) || 0;
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a;
}

export function shortestAngleDiffDeg(a, b) {
  return normalizeAngleDeg(a - b);
}

/**
 * Extract horizontal yaw in degrees (Three.js `Euler(0, yawRad, 0, 'XYZ')` convention)
 * from either `[rxDeg, ryDeg, rzDeg]` or quaternion `[qx, qy, qz, qw]`.
 */
export function extractYawDeg(rotation) {
  if (!Array.isArray(rotation)) return 0;
  if (rotation.length === 4) {
    const [x, y, z, w] = rotation.map((n) => Number(n) || 0);
    const siny = 2 * (w * y + x * z);
    const cosy = 1 - 2 * (y * y + z * z);
    return normalizeAngleDeg(Math.atan2(siny, cosy) * RAD);
  }
  return normalizeAngleDeg(Number(rotation[1]) || 0);
}

/**
 * Local X (rail span) and Local Z (front normal) unit vectors in world XZ for a
 * Three.js Y-Euler angle `yawDeg`.
 * Verified: yaw=0 -> localX=[1,0,0], localZ=[0,0,1]; yaw=90 -> localX=[0,0,-1], localZ=[1,0,0].
 */
export function localAxesFromYaw(yawDeg) {
  const r = (Number(yawDeg) || 0) * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    localX: [c, 0, -s],
    localZ: [s, 0, c],
  };
}

/**
 * Apply radial deadzone with smooth rescaling so subtle thumbstick deflections
 * walk gently and center rest has zero drift.
 */
export function applyStickDeadzone(rawX = 0, rawY = 0, deadzone = 0.16) {
  const x = Number(rawX) || 0;
  const y = Number(rawY) || 0;
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return { x: 0, y: 0, magnitude: 0, active: false };
  const scaled = Math.min(1, (mag - deadzone) / Math.max(1e-4, 1 - deadzone));
  const inv = scaled / mag;
  return {
    x: Number((x * inv).toFixed(4)),
    y: Number((y * inv).toFixed(4)),
    magnitude: Number(scaled.toFixed(4)),
    active: true,
  };
}

/**
 * Parse a WebXR `XRInputSource` (Meta Quest 3S Touch Plus `xr-standard` or generic
 * 2-axis WebXR gamepad) into normalized stick & button states.
 *
 * Quest Touch Plus `xr-standard` layout:
 * - axes[2], axes[3]: Thumbstick X (-1 left .. +1 right), Y (-1 forward .. +1 back)
 * - buttons[0]: Index Trigger (`select`)
 * - buttons[1]: Middle-finger Grip (`squeeze`)
 * - buttons[3]: Thumbstick Click
 * - buttons[4]: X (left) / A (right)
 * - buttons[5]: Y (left) / B (right)
 */
export function parseQuestGamepad(inputSource, { deadzone = 0.16 } = {}) {
  const hand = inputSource?.handedness === 'left' || inputSource?.handedness === 'right'
    ? inputSource.handedness
    : 'right';
  const gp = inputSource?.gamepad;
  if (!gp) {
    return {
      hand,
      hasGamepad: false,
      isHandTracking: Boolean(inputSource?.hand),
      stick: { x: 0, y: 0, magnitude: 0, active: false },
      trigger: false,
      triggerValue: 0,
      grip: false,
      gripValue: 0,
      stickClick: false,
      primaryButton: false, // A / X
      secondaryButton: false, // B / Y
    };
  }

  const axes = gp.axes ?? [];
  let rawX = axes.length >= 4 ? (axes[2] ?? 0) : (axes[0] ?? 0);
  let rawY = axes.length >= 4 ? (axes[3] ?? 0) : (axes[1] ?? 0);
  if (axes.length >= 4 && Math.hypot(rawX, rawY) < 1e-4 && Math.hypot(axes[0] ?? 0, axes[1] ?? 0) > deadzone) {
    rawX = axes[0] ?? 0;
    rawY = axes[1] ?? 0;
  }

  const stick = applyStickDeadzone(rawX, rawY, deadzone);
  const btns = gp.buttons ?? [];
  const pressed = (idx) => Boolean(btns[idx]?.pressed || (btns[idx]?.value ?? 0) > 0.65);

  return {
    hand,
    hasGamepad: true,
    isHandTracking: Boolean(inputSource?.hand),
    stick,
    trigger: pressed(0),
    triggerValue: Number(btns[0]?.value ?? 0),
    grip: pressed(1),
    gripValue: Number(btns[1]?.value ?? 0),
    stickClick: pressed(3),
    primaryButton: pressed(4), // A on Right, X on Left
    secondaryButton: pressed(5), // B on Right, Y on Left
  };
}

/**
 * Compute one frame of VR thumbstick locomotion & turning.
 *
 * CRITICAL: `headWorldForward` MUST be the headset's WORLD-SPACE forward vector
 * (`xrCamera.getWorldQuaternion()` applied to `[0, 0, -1]`), NOT local quaternion,
 * so forward/back/strafe always match where the user is actually looking even
 * after smooth or snap turning `playerRig.rotation.y`!
 */
export function computeLocomotionStep({
  leftStick = { x: 0, y: 0 },
  rightStick = { x: 0, y: 0 },
  headWorldForward = [0, 0, -1],
  rigPosition = [0, 0, 0],
  rigYawRad = 0,
  dt = 1 / 72,
  settings = DEFAULT_VR_SETTINGS,
  snapCooldown = 0,
  uiBlocked = false,
  terrainHeightFn = null,
} = {}) {
  const clampedDt = Math.min(0.1, Math.max(0, Number(dt) || 0));
  let nextCooldown = Math.max(0, (Number(snapCooldown) || 0) - clampedDt);

  if (uiBlocked) {
    return {
      position: [...rigPosition],
      yawRad: rigYawRad,
      snapCooldown: nextCooldown,
      moved: false,
      turned: false,
      teleportAiming: false,
    };
  }

  // Horizontal basis from world-space headset gaze
  let fx = Number(headWorldForward[0]) || 0;
  let fz = Number(headWorldForward[2]) || 0;
  const flen = Math.hypot(fx, fz);
  if (flen < 1e-5) {
    fx = -Math.sin(rigYawRad);
    fz = -Math.cos(rigYawRad);
  } else {
    fx /= flen;
    fz /= flen;
  }
  // Right-handed Three.js: forward × up = [fx, 0, fz] × [0, 1, 0] = [-fz, 0, fx]
  const rx = -fz;
  const rz = fx;

  const walkForward = -(Number(leftStick?.y) || 0); // stick Y = -1 is forward
  const strafeRight = Number(leftStick?.x) || 0; // stick X = +1 is right
  const moveSpeed = Math.max(0.5, Number(settings?.moveSpeed ?? DEFAULT_VR_SETTINGS.moveSpeed));

  let nx = Number(rigPosition[0]) || 0;
  let ny = Number(rigPosition[1]) || 0;
  let nz = Number(rigPosition[2]) || 0;
  let moved = false;

  if (Math.hypot(walkForward, strafeRight) > 1e-4) {
    const step = moveSpeed * clampedDt;
    nx += (fx * walkForward + rx * strafeRight) * step;
    nz += (fz * walkForward + rz * strafeRight) * step;
    if (typeof terrainHeightFn === 'function') {
      ny = terrainHeightFn(nx, nz);
    }
    moved = true;
  }

  let nextYaw = Number(rigYawRad) || 0;
  let turned = false;
  const turnX = Number(rightStick?.x) || 0;
  const turnMode = settings?.turnMode === 'snap' ? 'snap' : 'smooth';

  if (turnMode === 'smooth') {
    if (Math.abs(turnX) > 1e-4) {
      const turnRateRad = Math.max(15, Number(settings?.turnSpeedDeg ?? 95)) * DEG;
      // Pushing Right Stick right (+X) rotates player clockwise (-Y Euler in Three.js)
      nextYaw -= turnX * turnRateRad * clampedDt;
      turned = true;
    }
  } else if (Math.abs(turnX) > 0.62 && nextCooldown <= 0) {
    const snapRad = Math.max(15, Number(settings?.snapAngleDeg ?? 30)) * DEG;
    nextYaw -= Math.sign(turnX) * snapRad;
    nextCooldown = 0.28;
    turned = true;
  }

  const teleportAiming = Boolean(
    settings?.teleportEnabled &&
    (Number(rightStick?.y) || 0) < -0.74 &&
    Math.abs(turnX) < 0.45,
  );

  return {
    position: [nx, ny, nz],
    yawRad: nextYaw,
    snapCooldown: nextCooldown,
    moved,
    turned,
    teleportAiming,
    basis: { forward: [fx, 0, fz], right: [rx, 0, rz] },
  };
}

/**
 * Locomotion for hand-tracking users (no thumbsticks).
 *
 * Pinch-and-pull on either hand walks: the horizontal displacement of the hand
 * from its pinch-start anchor is mapped to metres, then applied along world-space
 * headset gaze exactly like `computeLocomotionStep`. Releasing the pinch drops
 * the anchor, so the world never drifts.
 */
export function computeHandLocomotion({
  handWorldPos = [0, 1.4, 0],
  pinchStart = null,
  headWorldForward = [0, 0, -1],
  rigPosition = [0, 0, 0],
  gain = 1.6,
  maxStep = 0.45,
  terrainHeightFn = null,
} = {}) {
  if (!pinchStart) {
    return { active: false, anchor: [...handWorldPos], delta: [0, 0, 0], position: [...rigPosition] };
  }
  const dx = (handWorldPos[0] - pinchStart[0]) * gain;
  const dz = (handWorldPos[2] - pinchStart[2]) * gain;
  const magnitude = Math.hypot(dx, dz);
  if (magnitude < 1e-4) {
    return { active: true, anchor: [...pinchStart], delta: [0, 0, 0], position: [...rigPosition] };
  }
  const clamped = Math.min(magnitude, maxStep);
  let fx = Number(headWorldForward[0]) || 0;
  let fz = Number(headWorldForward[2]) || 0;
  const flen = Math.hypot(fx, fz) || 1;
  fx /= flen;
  fz /= flen;
  const rx = -fz;
  const rz = fx;
  // Pull toward yourself = walk backwards; push away = walk forward.
  const forwardAmount = (dx * fx + dz * fz) / magnitude;
  const strafeAmount = (dx * rx + dz * rz) / magnitude;
  const nx = Number(rigPosition[0]) + fx * forwardAmount * clamped + rx * strafeAmount * clamped;
  const nz = Number(rigPosition[2]) + fz * forwardAmount * clamped + rz * strafeAmount * clamped;
  const ny = typeof terrainHeightFn === 'function' ? terrainHeightFn(nx, nz) : Number(rigPosition[1]) || 0;
  return {
    active: true,
    anchor: [...pinchStart],
    delta: [Number(dx.toFixed(4)), 0, Number(dz.toFixed(4))],
    position: [Number(nx.toFixed(4)), Number(ny.toFixed(4)), Number(nz.toFixed(4))],
  };
}

/**
 * Compute comfortable world-space position & yaw for summoning the Floating VR
 * Command Board in front of the user's current headset gaze.
 */
export function computeMenuSummonPose({
  headWorldPos = [0, 1.68, 3.5],
  headWorldForward = [0, 0, -1],
  distance = 1.38,
  verticalOffset = -0.16,
  minHeightAboveFloor = 0.85,
  floorY = 0,
} = {}) {
  let fx = Number(headWorldForward[0]) || 0;
  let fz = Number(headWorldForward[2]) || 0;
  const len = Math.hypot(fx, fz);
  if (len < 1e-4) {
    fx = 0;
    fz = -1;
  } else {
    fx /= len;
    fz /= len;
  }
  const d = Math.max(0.75, Math.min(2.8, Number(distance) || 1.38));
  const px = headWorldPos[0] + fx * d;
  const pz = headWorldPos[2] + fz * d;
  const py = Math.max(floorY + minHeightAboveFloor, headWorldPos[1] + verticalOffset);

  // Face back toward the user's head (+Z of plane points toward head)
  const yawRad = Math.atan2(-fx, -fz);
  return {
    position: [Number(px.toFixed(4)), Number(py.toFixed(4)), Number(pz.toFixed(4))],
    yawRad,
    yawDeg: Number((yawRad * RAD).toFixed(2)),
  };
}

/**
 * Decide how the Floating VR Menu should respond to B/Y toggle vs Grip summon.
 *
 * - `trigger === 'grip'`: Summon/refocus in front of gaze; NEVER dismisses!
 * - `trigger === 'toggle'` (B/Y or persistent Menu pill):
 *   - Hidden -> summon in front of gaze (`visible: true, summon: true`)
 *   - Visible AND comfortably in front of gaze -> hide (`visible: false, summon: false`)
 *   - Visible BUT left behind / out of view -> re-summon in front of gaze (`visible: true, summon: true`)!
 */
export function evaluateMenuAction({
  visible = false,
  menuWorldPos = [0, 1.5, 2.0],
  headWorldPos = [0, 1.68, 3.5],
  headWorldForward = [0, 0, -1],
  trigger = 'toggle',
} = {}) {
  if (trigger === 'grip' || trigger === 'summon') {
    return { visible: true, summon: true };
  }
  if (!visible) {
    return { visible: true, summon: true };
  }
  const dx = menuWorldPos[0] - headWorldPos[0];
  const dy = menuWorldPos[1] - headWorldPos[1];
  const dz = menuWorldPos[2] - headWorldPos[2];
  const dist = Math.hypot(dx, dy, dz);
  const hDist = Math.hypot(dx, dz);

  let fx = Number(headWorldForward[0]) || 0;
  let fz = Number(headWorldForward[2]) || 0;
  const flen = Math.hypot(fx, fz) || 1;
  fx /= flen;
  fz /= flen;

  const dot = hDist > 1e-4 ? (dx * fx + dz * fz) / hDist : 1;
  const inComfortableView = dist <= 2.65 && dot >= 0.35;
  if (inComfortableView) {
    return { visible: false, summon: false };
  }
  // Menu was behind the player or far away — bring it right in front of them!
  return { visible: true, summon: true };
}

// ---------------------------------------------------------------------------
// Phase 3: Object Footprints, Fence End-to-End Snapping & Structure Alignment
// ---------------------------------------------------------------------------

/**
 * Compute world-scaled span `[sizeX, sizeY, sizeZ]` (in unrotated local axes) and
 * archetype tag for an object record.
 */
export function computeObjectFootprint(object, rawBoxSize = null) {
  const scale = object?.transform?.scale ?? [1, 1, 1];
  const sx = Math.abs(Number(scale[0]) || 1);
  const sy = Math.abs(Number(scale[1]) || 1);
  const sz = Math.abs(Number(scale[2]) || 1);
  const name = String(object?.name ?? '').toLowerCase();
  const archetype = object?.metadata?.archetype
    ?? (name.includes('fence') ? 'fence'
      : name.includes('barn') ? 'barn'
      : name.includes('windmill') ? 'windmill'
      : name.includes('silo') ? 'silo'
      : name.includes('house') ? 'house'
      : name.includes('hay') ? 'haybale'
      : 'prop');

  // Default raw bounds match `src/algorithms/prompt.mjs` archetypes when geometry box isn't passed
  const fallbackRaw = archetype === 'fence'
    ? [1.003, 0.484, 0.064]
    : archetype === 'barn'
      ? [0.953, 1.037, 1.144]
      : archetype === 'windmill'
        ? [0.614, 1.122, 0.538]
        : [1.0, 1.0, 1.0];

  const base = Array.isArray(rawBoxSize) && rawBoxSize.length >= 3 ? rawBoxSize : fallbackRaw;
  return {
    id: object?.id ?? null,
    name: object?.name ?? archetype,
    archetype,
    position: [...(object?.transform?.translation ?? [0, 0, 0])].map((n) => Number(n) || 0),
    yawDeg: extractYawDeg(object?.transform?.rotation),
    scale: [sx, sy, sz],
    size: [base[0] * sx, base[1] * sy, base[2] * sz],
  };
}

/**
 * World-space left (`-localX`) and right (`+localX`) endpoints of a fence section.
 */
export function fenceEndpoints(footprint) {
  const { localX } = localAxesFromYaw(footprint.yawDeg);
  const half = footprint.size[0] * 0.5;
  const [cx, cy, cz] = footprint.position;
  return {
    minus: [cx - localX[0] * half, cy, cz - localX[2] * half],
    plus: [cx + localX[0] * half, cy, cz + localX[2] * half],
    localX,
    halfSpan: half,
  };
}

/**
 * Snap a moving/previewed fence end-to-end onto the nearest existing fence post!
 *
 * Supports both:
 * - **Inline continuation** (`fence-inline`): extends the fence seamlessly in a straight line.
 * - **90° paddock corner** (`fence-corner`): when the moving fence's yaw is closer to ±90°
 *   from the neighbor fence, snaps post-to-post at an exact right angle!
 */
export function computeFenceSnap(movingFootprint, otherFootprints = [], { snapRadius = 1.45, terrainHeightFn = null } = {}) {
  if (!movingFootprint || movingFootprint.archetype !== 'fence') return { snapped: false };
  const movingHalf = movingFootprint.size[0] * 0.5;
  const movingEnds = fenceEndpoints(movingFootprint);

  let best = null;

  for (const other of otherFootprints) {
    if (!other || other.id === movingFootprint.id || other.archetype !== 'fence') continue;
    const targetEnds = fenceEndpoints(other);

    for (const side of [
      { key: 'plus', point: targetEnds.plus, outward: targetEnds.localX },
      { key: 'minus', point: targetEnds.minus, outward: [-targetEnds.localX[0], 0, -targetEnds.localX[2]] },
    ]) {
      // Distance from target post to either moving post OR moving center-to-ideal-center
      const idealInlineCenter = [
        side.point[0] + side.outward[0] * movingHalf,
        side.point[1],
        side.point[2] + side.outward[2] * movingHalf,
      ];
      const distCenter = Math.hypot(
        movingFootprint.position[0] - idealInlineCenter[0],
        movingFootprint.position[2] - idealInlineCenter[2],
      );
      const distMinus = Math.hypot(movingEnds.minus[0] - side.point[0], movingEnds.minus[2] - side.point[2]);
      const distPlus = Math.hypot(movingEnds.plus[0] - side.point[0], movingEnds.plus[2] - side.point[2]);
      const scoreDist = Math.min(distCenter, distMinus, distPlus);

      if (scoreDist > snapRadius) continue;

      // Determine whether user is aiming for straight-line (0°/180°) or 90° corner (±90°)
      const candidates = [
        { kind: 'fence-inline', yawDeg: other.yawDeg },
        { kind: 'fence-inline', yawDeg: normalizeAngleDeg(other.yawDeg + 180) },
        { kind: 'fence-corner', yawDeg: normalizeAngleDeg(other.yawDeg + 90) },
        { kind: 'fence-corner', yawDeg: normalizeAngleDeg(other.yawDeg - 90) },
      ];
      candidates.sort(
        (a, b) => Math.abs(shortestAngleDiffDeg(movingFootprint.yawDeg, a.yawDeg))
          - Math.abs(shortestAngleDiffDeg(movingFootprint.yawDeg, b.yawDeg)),
      );
      const chosen = candidates[0];

      let snappedPos;
      if (chosen.kind === 'fence-inline') {
        snappedPos = [...idealInlineCenter];
      } else {
        // Place corner fence extending away from target post along chosen localX
        const { localX: cornerX } = localAxesFromYaw(chosen.yawDeg);
        const toMovingX = movingFootprint.position[0] - side.point[0];
        const toMovingZ = movingFootprint.position[2] - side.point[2];
        const dirSign = (toMovingX * cornerX[0] + toMovingZ * cornerX[2]) >= 0 ? 1 : -1;
        snappedPos = [
          side.point[0] + cornerX[0] * dirSign * movingHalf,
          side.point[1],
          side.point[2] + cornerX[2] * dirSign * movingHalf,
        ];
      }

      if (typeof terrainHeightFn === 'function') {
        snappedPos[1] = terrainHeightFn(snappedPos[0], snappedPos[2]);
      }

      if (!best || scoreDist < best.distance) {
        best = {
          snapped: true,
          kind: chosen.kind,
          distance: Number(scoreDist.toFixed(4)),
          position: snappedPos.map((n) => Number(n.toFixed(4))),
          yawDeg: Number(chosen.yawDeg.toFixed(2)),
          anchorPoint: side.point.map((n) => Number(n.toFixed(4))),
          targetId: other.id,
          targetName: other.name,
        };
      }
    }
  }

  return best ?? { snapped: false };
}

/**
 * Magnetic alignment of an object's yaw and centerline axes to nearby structures
 * (barns, windmills, houses, silos, tables, fences).
 */
export function computeStructureAlignment(
  movingFootprint,
  otherFootprints = [],
  { maxRange = 14, angleThresholdDeg = 14, axisThresholdMeters = 0.48, terrainHeightFn = null } = {},
) {
  if (!movingFootprint) return { aligned: false };

  let nearest = null;
  let nearestDist = Infinity;
  for (const other of otherFootprints) {
    if (!other || other.id === movingFootprint.id) continue;
    const d = Math.hypot(
      movingFootprint.position[0] - other.position[0],
      movingFootprint.position[2] - other.position[2],
    );
    if (d < maxRange && d < nearestDist) {
      nearest = other;
      nearestDist = d;
    }
  }
  if (!nearest) return { aligned: false };

  let yawDeg = movingFootprint.yawDeg;
  let yawAligned = false;
  const cardinalYaws = [
    nearest.yawDeg,
    normalizeAngleDeg(nearest.yawDeg + 90),
    normalizeAngleDeg(nearest.yawDeg + 180),
    normalizeAngleDeg(nearest.yawDeg - 90),
  ];
  for (const targetYaw of cardinalYaws) {
    if (Math.abs(shortestAngleDiffDeg(movingFootprint.yawDeg, targetYaw)) <= angleThresholdDeg) {
      yawDeg = targetYaw;
      yawAligned = true;
      break;
    }
  }

  // Project relative offset onto nearest structure's localX / localZ axes for magnetic centerline alignment
  const { localX, localZ } = localAxesFromYaw(nearest.yawDeg);
  const dx = movingFootprint.position[0] - nearest.position[0];
  const dz = movingFootprint.position[2] - nearest.position[2];
  let alongX = dx * localX[0] + dz * localX[2];
  let alongZ = dx * localZ[0] + dz * localZ[2];
  let posAligned = false;

  if (Math.abs(alongX) <= axisThresholdMeters && Math.abs(alongZ) > nearest.size[2] * 0.45) {
    alongX = 0;
    posAligned = true;
  } else if (Math.abs(alongZ) <= axisThresholdMeters && Math.abs(alongX) > nearest.size[0] * 0.45) {
    alongZ = 0;
    posAligned = true;
  }

  if (!yawAligned && !posAligned) return { aligned: false };

  const nx = nearest.position[0] + localX[0] * alongX + localZ[0] * alongZ;
  const nz = nearest.position[2] + localX[2] * alongX + localZ[2] * alongZ;
  const ny = typeof terrainHeightFn === 'function' ? terrainHeightFn(nx, nz) : movingFootprint.position[1];

  return {
    aligned: true,
    kind: posAligned ? 'structure-axis' : 'structure-angle',
    position: [Number(nx.toFixed(4)), Number(ny.toFixed(4)), Number(nz.toFixed(4))],
    yawDeg: Number(yawDeg.toFixed(2)),
    anchorPoint: [...nearest.position],
    targetId: nearest.id,
    targetName: nearest.name,
  };
}

/**
 * Snap `[x, y, z]` and `yawDeg` to an optional world grid (`gridStep > 0`).
 */
export function snapPoseToGrid(position, yawDeg, { gridStep = 0.5, angleStepDeg = 15, terrainHeightFn = null } = {}) {
  const step = Number(gridStep) || 0;
  let [x, y, z] = position;
  if (step > 0) {
    x = Math.round(x / step) * step;
    z = Math.round(z / step) * step;
    if (typeof terrainHeightFn === 'function') y = terrainHeightFn(x, z);
  }
  const aStep = Number(angleStepDeg) || 0;
  const snappedYaw = aStep > 0 ? normalizeAngleDeg(Math.round(yawDeg / aStep) * aStep) : yawDeg;
  return {
    position: [Number(x.toFixed(4)), Number(y.toFixed(4)), Number(z.toFixed(4))],
    yawDeg: Number(snappedYaw.toFixed(2)),
  };
}

/**
 * Unified smart placement solver: applies Fence End-to-End Snap first (if fence &
 * `snapEnabled`), else Structure Magnetic Alignment (if `snapEnabled`), plus optional
 * Grid Snap fallback!
 */
export function solveSmartPlacement(
  movingFootprint,
  otherFootprints = [],
  { snapEnabled = true, gridSnap = 0, terrainHeightFn = null } = {},
) {
  let pos = [...movingFootprint.position];
  let yawDeg = movingFootprint.yawDeg;

  if (typeof terrainHeightFn === 'function') {
    pos[1] = terrainHeightFn(pos[0], pos[2]);
  }

  if (snapEnabled) {
    if (movingFootprint.archetype === 'fence') {
      const fenceSnap = computeFenceSnap({ ...movingFootprint, position: pos, yawDeg }, otherFootprints, { terrainHeightFn });
      if (fenceSnap.snapped) return fenceSnap;
    }
    const aligned = computeStructureAlignment({ ...movingFootprint, position: pos, yawDeg }, otherFootprints, { terrainHeightFn });
    if (aligned.aligned) {
      return {
        snapped: true,
        kind: aligned.kind,
        position: aligned.position,
        yawDeg: aligned.yawDeg,
        anchorPoint: aligned.anchorPoint,
        targetId: aligned.targetId,
        targetName: aligned.targetName,
      };
    }
  }

  if (gridSnap > 0) {
    const gridded = snapPoseToGrid(pos, yawDeg, { gridStep: gridSnap, angleStepDeg: 15, terrainHeightFn });
    return {
      snapped: true,
      kind: 'grid',
      position: gridded.position,
      yawDeg: gridded.yawDeg,
      anchorPoint: null,
      targetId: null,
      targetName: null,
    };
  }

  return {
    snapped: false,
    kind: 'free',
    position: pos.map((n) => Number(n.toFixed(4))),
    yawDeg: Number(yawDeg.toFixed(2)),
    anchorPoint: null,
    targetId: null,
    targetName: null,
  };
}
