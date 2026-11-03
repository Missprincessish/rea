// Live VR spatial session state (headset pose, controller/hand rays, raycast
// hit point, and "right there" spatial pin).
//
// Stored in memory for zero-latency streaming AND mirrored to
// `<projectDir>/vr-state.json` (throttled) so external stdio MCP servers and
// CLI invocations in separate OS processes see the exact spot the user is
// pointing at inside their VR headset.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from './util.mjs';
import { normalizeWorld, terrainHeightAt } from './world.mjs';

const MEMORY = new Map();
const LAST_FLUSH = new Map();
const FLUSH_INTERVAL_MS = 140;

export function defaultVrState() {
  return {
    updatedAt: null,
    inVR: false,
    device: 'desktop',
    head: {
      position: [0, 1.68, 3.5],
      forward: [0, -0.1, -1],
      up: [0, 1, 0],
    },
    pointer: {
      active: false,
      hand: 'right',
      origin: [0.2, 1.45, 3.3],
      direction: [0, -0.25, -0.968],
      hitPoint: [0, 0, -2.5],
      hitNormal: [0, 1, 0],
      hitKind: 'ground',
      hitObjectId: null,
      hitObjectName: null,
    },
    pin: null,
    controllers: {},
  };
}

function stateFilePath(project) {
  return path.join(project.dir, 'vr-state.json');
}

function cleanVec3(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [Number(x.toFixed(4)), Number(y.toFixed(4)), Number(z.toFixed(4))];
    }
  }
  return fallback;
}

export function getVrState(project) {
  const file = stateFilePath(project);
  let state = MEMORY.get(project.dir);
  try {
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (!state || (stat.mtimeMs > ( state._mtimeMs ?? 0 ))) {
        const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
        state = { ...defaultVrState(), ...disk, _mtimeMs: stat.mtimeMs };
        MEMORY.set(project.dir, state);
      }
    }
  } catch {
    // ignore transient concurrent write
  }
  if (!state) {
    state = defaultVrState();
    MEMORY.set(project.dir, state);
  }
  const { _mtimeMs, ...clean } = state;
  void _mtimeMs;
  return clean;
}

export async function updateVrState(project, patch = {}, { immediate = false } = {}) {
  const prev = getVrState(project);
  const next = {
    ...prev,
    updatedAt: nowIso(),
    inVR: patch.inVR !== undefined ? Boolean(patch.inVR) : prev.inVR,
    device: patch.device ?? prev.device,
    head: patch.head
      ? {
          position: cleanVec3(patch.head.position, prev.head.position),
          forward: cleanVec3(patch.head.forward, prev.head.forward),
          up: cleanVec3(patch.head.up, prev.head.up),
        }
      : prev.head,
    pointer: patch.pointer
      ? {
          active: patch.pointer.active !== undefined ? Boolean(patch.pointer.active) : true,
          hand: patch.pointer.hand ?? prev.pointer.hand ?? 'right',
          origin: cleanVec3(patch.pointer.origin, prev.pointer.origin),
          direction: cleanVec3(patch.pointer.direction, prev.pointer.direction),
          hitPoint: patch.pointer.hitPoint ? cleanVec3(patch.pointer.hitPoint, prev.pointer.hitPoint) : prev.pointer.hitPoint,
          hitNormal: patch.pointer.hitNormal ? cleanVec3(patch.pointer.hitNormal, [0, 1, 0]) : prev.pointer.hitNormal,
          hitKind: patch.pointer.hitKind ?? prev.pointer.hitKind ?? 'ground',
          hitObjectId: patch.pointer.hitObjectId !== undefined ? patch.pointer.hitObjectId : prev.pointer.hitObjectId,
          hitObjectName: patch.pointer.hitObjectName !== undefined ? patch.pointer.hitObjectName : prev.pointer.hitObjectName,
        }
      : prev.pointer,
    controllers: patch.controllers ?? prev.controllers,
    pin: prev.pin,
  };

  if (patch.clearPin) {
    next.pin = null;
  } else if (patch.pin) {
    const point = cleanVec3(patch.pin.point ?? patch.pin, next.pointer.hitPoint);
    next.pin = {
      point,
      normal: cleanVec3(patch.pin.normal, next.pointer.hitNormal ?? [0, 1, 0]),
      objectId: patch.pin.objectId ?? next.pointer.hitObjectId ?? null,
      objectName: patch.pin.objectName ?? next.pointer.hitObjectName ?? null,
      pinnedAt: nowIso(),
    };
  } else if (patch.pinCurrent) {
    next.pin = {
      point: next.pointer.hitPoint,
      normal: next.pointer.hitNormal ?? [0, 1, 0],
      objectId: next.pointer.hitObjectId ?? null,
      objectName: next.pointer.hitObjectName ?? null,
      pinnedAt: nowIso(),
    };
  }

  const now = Date.now();
  const shouldFlush = immediate || Boolean(patch.pin || patch.pinCurrent || patch.clearPin) || now - (LAST_FLUSH.get(project.dir) ?? 0) >= FLUSH_INTERVAL_MS;
  MEMORY.set(project.dir, { ...next, _mtimeMs: now + 50 });

  if (shouldFlush) {
    LAST_FLUSH.set(project.dir, now);
    const file = stateFilePath(project);
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(next));
      await fsp.rename(tmp, file);
      const stat = await fsp.stat(file);
      MEMORY.set(project.dir, { ...next, _mtimeMs: stat.mtimeMs });
    } catch {
      // ignore if directory was concurrently deleted
    }
  }
  return next;
}

function horizontalForward(head) {
  const f = head?.forward ?? [0, 0, -1];
  let hx = f[0];
  let hz = f[2];
  const len = Math.hypot(hx, hz);
  if (len < 1e-4) return [0, -1];
  return [hx / len, hz / len];
}

/**
 * Resolve a spatial placement keyword (`pointer`, `pin`, `in-front`, `left`,
 * `right`, `behind`, `player`, or `[x,y,z]`) to a concrete `[x, y, z]` world
 * coordinate and facing yaw.
 */
export function resolveSpatialLocation(project, at = 'pointer', { distance = 7, snapToGround = true, overridePointer = null, overrideHead = null } = {}) {
  const vr = getVrState(project);
  const head = overrideHead ? { ...vr.head, ...overrideHead } : vr.head;
  const pointer = overridePointer ? { ...vr.pointer, ...overridePointer } : vr.pointer;
  const world = normalizeWorld(project.data.world);
  const [fx, fz] = horizontalForward(head);
  const rx = -fz;
  const rz = fx;
  const headPos = head?.position ?? [0, 1.68, 3.5];

  let point = null;
  let source = 'pointer';
  let explicitY = false;

  if (Array.isArray(at) && at.length >= 3) {
    point = [Number(at[0]) || 0, Number(at[1]) || 0, Number(at[2]) || 0];
    explicitY = true;
    source = 'coordinates';
  } else if (typeof at === 'string' && /^-?\d+(\.\d+)?\s*[,\s]\s*-?\d+/.test(at.trim())) {
    const parts = at.trim().split(/[\s,]+/).map(Number);
    point = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    explicitY = parts.length >= 3 && !snapToGround;
    source = 'coordinates';
  } else {
    const mode = String(at ?? 'pointer').toLowerCase().trim();
    if (mode === 'pin' && vr.pin?.point) {
      point = [...vr.pin.point];
      source = 'pin';
    } else if (mode === 'pointer' || mode === 'right-there' || mode === 'there' || mode === 'here') {
      if (overridePointer?.hitPoint) {
        point = [...overridePointer.hitPoint];
        source = 'pointer';
      } else if (vr.pin?.point) {
        point = [...vr.pin.point];
        source = 'pin';
      } else if (pointer?.hitPoint) {
        point = [...pointer.hitPoint];
        source = 'pointer';
      } else {
        point = [headPos[0] + fx * distance, 0, headPos[2] + fz * distance];
        source = 'gaze-fallback';
      }
    } else if (mode === 'in-front' || mode === 'front' || mode === 'ahead') {
      point = [headPos[0] + fx * distance, 0, headPos[2] + fz * distance];
      source = 'in-front';
    } else if (mode === 'left') {
      point = [headPos[0] - rx * distance, 0, headPos[2] - rz * distance];
      source = 'left';
    } else if (mode === 'right') {
      point = [headPos[0] + rx * distance, 0, headPos[2] + rz * distance];
      source = 'right';
    } else if (mode === 'behind' || mode === 'back') {
      point = [headPos[0] - fx * distance, 0, headPos[2] - fz * distance];
      source = 'behind';
    } else if (mode === 'player' || mode === 'me') {
      point = [headPos[0], 0, headPos[2]];
      source = 'player';
    } else if (mode === 'origin' || mode === 'center') {
      point = [0, 0, 0];
      source = 'origin';
    } else {
      point = pointer?.hitPoint ? [...pointer.hitPoint] : [headPos[0] + fx * distance, 0, headPos[2] + fz * distance];
      source = 'pointer';
    }
  }

  const groundY = terrainHeightAt(world, point[0], point[2]);
  const finalY = snapToGround && !explicitY ? groundY : point[1];
  const dx = headPos[0] - point[0];
  const dz = headPos[2] - point[2];
  const yawToPlayerDeg = (Math.atan2(dx, dz) * 180) / Math.PI;

  return {
    position: [Number(point[0].toFixed(3)), Number(finalY.toFixed(3)), Number(point[2].toFixed(3))],
    groundY: Number(groundY.toFixed(3)),
    yawToPlayerDeg: Number(yawToPlayerDeg.toFixed(2)),
    source,
    headPosition: headPos,
  };
}

/** Build a spatial briefing of the world from the VR user's point of view. */
export function buildVrContext(project) {
  const vr = getVrState(project);
  const world = normalizeWorld(project.data.world);
  const headPos = vr.head?.position ?? [0, 1.68, 3.5];
  const [fx, fz] = horizontalForward(vr.head);
  const rx = -fz;
  const rz = fx;

  const rightThere = vr.pin?.point ?? vr.pointer?.hitPoint ?? [
    Number((headPos[0] + fx * 7).toFixed(3)),
    Number(terrainHeightAt(world, headPos[0] + fx * 7, headPos[2] + fz * 7).toFixed(3)),
    Number((headPos[2] + fz * 7).toFixed(3)),
  ];

  const targetId = vr.pointer?.hitObjectId ?? vr.pin?.objectId ?? null;
  const targeted = targetId && project.data.objects[targetId] ? project.data.objects[targetId] : null;

  const nearbyObjects = Object.values(project.data.objects)
    .filter((o) => o.visible !== false)
    .map((o) => {
      const pos = o.transform?.translation ?? [0, 0, 0];
      const dx = pos[0] - headPos[0];
      const dz = pos[2] - headPos[2];
      const distance = Math.hypot(dx, dz);
      const forwardDot = distance > 1e-4 ? (dx * fx + dz * fz) / distance : 1;
      const rightDot = distance > 1e-4 ? (dx * rx + dz * rz) / distance : 0;
      let direction = 'here';
      if (distance >= 0.4) {
        if (forwardDot > 0.7) direction = Math.abs(rightDot) > 0.35 ? (rightDot > 0 ? 'ahead-right' : 'ahead-left') : 'ahead';
        else if (forwardDot < -0.7) direction = 'behind';
        else direction = rightDot > 0 ? 'right' : 'left';
      }
      return {
        id: o.id,
        name: o.name,
        archetype: o.metadata?.archetype ?? null,
        position: pos,
        scale: o.transform?.scale ?? [1, 1, 1],
        distanceMeters: Number(distance.toFixed(2)),
        relativeDirection: direction,
      };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return {
    project: project.data.name,
    revision: project.data.revision,
    vr: {
      inVR: vr.inVR,
      device: vr.device,
      updatedAt: vr.updatedAt,
      head: vr.head,
      pointer: vr.pointer,
      pin: vr.pin,
      rightThere,
      targetedObject: targeted
        ? { id: targeted.id, name: targeted.name, position: targeted.transform?.translation, archetype: targeted.metadata?.archetype ?? null }
        : null,
    },
    world: {
      biome: world.biome,
      timeOfDay: world.sky?.preset ?? 'day',
      hillHeight: world.ground?.hillHeight ?? 0,
      foliageLayers: world.foliage.map((f) => ({ id: f.id, kind: f.kind, count: f.count })),
      clearings: world.clearings.length,
    },
    objects: nearbyObjects,
  };
}
