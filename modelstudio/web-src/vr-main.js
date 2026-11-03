// Immersive WebXR 3D World + Live Spatial AI Client.
//
// Works on Meta Quest 3S / Quest 3 / Quest 2 / Pico / Vision Pro / PCVR (any
// WebXR `immersive-vr` or `immersive-ar` browser) AND on Desktop / Mobile via
// WASD + mouse look + click-to-pin.

import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { geometryFromPayload } from './viewport.js';
import { api } from './api.js';
import { defaultWorld, normalizeWorld, terrainHeightAt } from '../src/core/world.mjs';
import { createVrEditor } from './vr-editor.js';
import {
  DEFAULT_VR_SETTINGS,
  SPEED_PRESETS,
  computeFenceSnap,
  computeLocomotionStep,
  computeMenuSummonPose,
  computeObjectFootprint,
  computeStructureAlignment,
  evaluateMenuAction,
  extractYawDeg,
  localAxesFromYaw,
  normalizeAngleDeg,
  parseQuestGamepad,
  snapPoseToGrid,
  solveSmartPlacement,
} from '../src/core/vr-interaction.mjs';

const $ = (sel) => document.querySelector(sel);
const DEG = Math.PI / 180;

/** Persisted VR comfort/precision settings (per browser, restored on reload). */
function loadVrSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('modelstudio.vrSettings') || '{}');
    return { ...DEFAULT_VR_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_VR_SETTINGS };
  }
}

function saveVrSettings() {
  try {
    localStorage.setItem('modelstudio.vrSettings', JSON.stringify(state.settings));
  } catch {
    /* private mode */
  }
}

const state = {
  project: new URLSearchParams(location.search).get('project') || localStorage.getItem('modelstudio.project') || 'Demo',
  revision: -1,
  world: defaultWorld(),
  worldSignature: '',
  inVR: false,
  inAR: false,
  eyeHeight: 1.68,
  yaw: 0,
  pitch: -0.08,
  keys: new Set(),
  settings: loadVrSettings(),
  objects: [],
  selectedId: null,
  // Object being dragged/moved by hand (VR grab) or mouse drag (desktop)
  dragging: null,
  preview: null,
  pointerDownObjectId: null,
  pointerDownAt: 0,
  teleportPreview: null,
  menuGrab: null,
  boardhover: null,
  snapHint: '',
  pointer: {
    active: true,
    hand: 'screen',
    origin: [0, 1.68, 3.5],
    direction: [0, -0.2, -0.98],
    hitPoint: [0, 0, -4.5],
    hitNormal: [0, 1, 0],
    hitKind: 'ground',
    hitObjectId: null,
    hitObjectName: null,
  },
  pin: null,
  speechSnapshot: null,
  busy: false,
  recording: false,
  lastStatusText: 'Point anywhere & say: "make this a hayfield and put a green barn right there"',
  lastReplyText: '',
  ttsEnabled: true,
};

// --- Three.js Scene & WebXR Renderer --------------------------------------

const stage = $('#vr-stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070a0d);
scene.fog = new THREE.Fog(0x070a0d, 20, 110);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 360);
const playerRig = new THREE.Group();
playerRig.position.set(0, 0, 3.5);
camera.position.set(0, state.eyeHeight, 0);
playerRig.add(camera);
scene.add(playerRig);

// Lighting
const hemiLight = new THREE.HemisphereLight(0x9ecbff, 0x3b2f1e, 0.7);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff4dc, 2.6);
sunLight.position.set(24, 36, 18);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 140;
const shadowExtent = 38;
sunLight.shadow.camera.left = -shadowExtent;
sunLight.shadow.camera.right = shadowExtent;
sunLight.shadow.camera.top = shadowExtent;
sunLight.shadow.camera.bottom = -shadowExtent;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

// Groups
const skyGroup = new THREE.Group();
scene.add(skyGroup);
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);
const foliageGroup = new THREE.Group();
scene.add(foliageGroup);
const objectsGroup = new THREE.Group();
scene.add(objectsGroup);

let terrainMesh = null;
const objectMeshes = new Map();
const textureLoader = new THREE.TextureLoader();
const windUniforms = { uTime: { value: 0 } };

// --- Hover Reticle & Glowing "Right There" Spatial Pin Beacon -------------

const hoverReticle = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.23, 32),
  new THREE.MeshBasicMaterial({ color: 0x2ce8c4, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }),
);
hoverReticle.rotation.x = -Math.PI / 2;
scene.add(hoverReticle);

const pinBeacon = new THREE.Group();
const pinRing = new THREE.Mesh(
  new THREE.RingGeometry(0.24, 0.36, 36),
  new THREE.MeshBasicMaterial({ color: 0xf5b942, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
);
pinRing.rotation.x = -Math.PI / 2;
pinRing.position.y = 0.03;
const pinBeam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.035, 0.09, 3.2, 16, 1, true),
  new THREE.MeshBasicMaterial({ color: 0x2ce8c4, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
);
pinBeam.position.y = 1.6;
const pinOrb = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xf5b942 }),
);
pinOrb.position.y = 0.14;
pinBeacon.add(pinRing, pinBeam, pinOrb);
pinBeacon.visible = false;
scene.add(pinBeacon);

// --- WebXR Controllers & Quest Hand Tracking ------------------------------

function buildControllerWand(colorHex) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.018, 0.09, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x1b2228, roughness: 0.4, metalness: 0.3 }),
  );
  body.rotation.x = Math.PI / 2.4;
  body.position.set(0, -0.02, 0.03);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 12, 8),
    new THREE.MeshBasicMaterial({ color: colorHex }),
  );
  tip.position.set(0, 0, -0.04);
  g.add(body, tip);
  return g;
}

const controllers = [];
const handFactory = new XRHandModelFactory();
let activeControllerIdx = 0;

for (let i = 0; i < 2; i += 1) {
  const controller = renderer.xr.getController(i);
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const rayLine = new THREE.Line(
    rayGeom,
    new THREE.LineBasicMaterial({ color: i === 0 ? 0x2ce8c4 : 0xf5b942, transparent: true, opacity: 0.85 }),
  );
  rayLine.name = 'laser';
  rayLine.scale.z = 12;
  controller.add(rayLine);
  controller.add(buildControllerWand(i === 0 ? 0x2ce8c4 : 0xf5b942));

  controller.addEventListener('selectstart', () => {
    activeControllerIdx = i;
    onVrSelect(controller);
  });
  controller.addEventListener('selectend', () => {
    activeControllerIdx = i;
    if (state.menuGrab) {
      state.menuGrab = null;
      return;
    }
    if (state.dragging) editor.endGrab();
  });
  // Grip = summon-only (never dismisses) and grabs the selected object while held
  controller.addEventListener('squeezestart', () => {
    activeControllerIdx = i;
    if (!editor) return;
    editor.summonMenu();
    const hitId = state.pointer.hitObjectId;
    if (hitId) {
      editor.selectObject(hitId);
      editor.startGrab({ pointer: state.pointer.hitPoint });
    }
  });
  controller.addEventListener('squeezeend', () => {
    if (editor) editor.endGrab();
  });
  playerRig.add(controller);
  controllers.push({ controller, rayLine, index: i });

  const hand = renderer.xr.getHand(i);
  hand.add(handFactory.createHandModel(hand, 'spheres'));
  playerRig.add(hand);
}

// --- 3D Floating In-VR Command Board (interactive inside Quest 3S!) -------

const vrBoardCanvas = document.createElement('canvas');
vrBoardCanvas.width = 1024;
vrBoardCanvas.height = 640;
const vrBoardCtx = vrBoardCanvas.getContext('2d');
const vrBoardTex = new THREE.CanvasTexture(vrBoardCanvas);
vrBoardTex.colorSpace = THREE.SRGBColorSpace;

const vrBoardMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1.18, 0.74),
  new THREE.MeshBasicMaterial({ map: vrBoardTex, transparent: true, side: THREE.DoubleSide }),
);
vrBoardMesh.visible = false;
playerRig.add(vrBoardMesh);

vrBoardMesh.renderOrder = 5;

// --- Persistent Wrist/HUD "☰ Menu" pill (always reachable in VR & desktop) --
//
// The floating board can end up anywhere after dragging, so this small pill is
// re-pinned 35cm in front of the user's left wrist (or bottom-left of the
// desktop viewport) every frame. It re-summons the board with one tap and never
// dismisses it.

function buildWristPillTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, 256, 128);
  c.fillStyle = 'rgba(9, 20, 22, 0.94)';
  roundRect(c, 4, 4, 248, 120, 26);
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = '#2ce8c4';
  c.stroke();
  c.fillStyle = '#2ce8c4';
  c.font = 'bold 62px sans-serif';
  c.fillText('☰', 30, 90);
  c.fillStyle = '#eafaf5';
  c.font = 'bold 34px sans-serif';
  c.fillText(text, 104, 84);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const wristPill = new THREE.Mesh(
  new THREE.PlaneGeometry(0.20, 0.10),
  new THREE.MeshBasicMaterial({ map: buildWristPillTexture('MENU'), transparent: true, side: THREE.DoubleSide, depthTest: false }),
);
wristPill.name = 'wrist-menu-pill';
wristPill.renderOrder = 999;
wristPill.visible = false;
scene.add(wristPill);

// --- Live editing engine (locomotion, selection, snapping, board actions) --
// Declared before the board helpers that reference it; assigned right after.

let editor = null;


/**
 * Floating VR Command Board layout.
 *
 * Everything is drawn into one 1024x640 canvas mapped onto a 1.18m x 0.74m
 * plane floating 1.25m in front of the headset, so each 72px row is a ~13cm
 * tall physical target that is easy to hit with a Quest 3S controller ray.
 *
 * `header` is the drag handle: grip/trigger-drag anywhere in that strip moves
 * the whole board around the world and it stays where you left it.
 */
const BOARD_W = 1024;
const BOARD_H = 640;

const BOARD_TABS = [
  { id: 'tab:world', label: '🌍 World & AI', x: 20, y: 122, w: 490, h: 60 },
  { id: 'tab:object', label: '✏️ Object Edit', x: 514, y: 122, w: 490, h: 60 },
];

const BOARD_ROWS_WORLD = [
  [
    { id: 'cmd:make this a hayfield and put a green barn right there', label: '🌾 Hayfield + Barn', w: 466 },
    { id: 'cmd:make this a pine forest at sunset', label: '🌲 Sunset Forest', w: 466 },
  ],
  [
    { id: 'place:green barn', label: '🏠 Place Barn', w: 224 },
    { id: 'place:tall windmill', label: '🗼 Place Windmill', w: 224 },
    { id: 'place:wooden fence', label: '🪵 Place Fence', w: 224 },
    { id: 'place:golden haybale', label: '🌾 Place Hay Bale', w: 232 },
  ],
  [
    { id: 'cmd:make this a snowfield', label: '❄️ Snowfield', w: 224 },
    { id: 'cmd:make this a starlit clearing with fireflies', label: '✨ Night Fireflies', w: 224 },
    { id: 'cmd:scatter 6 hay bales around me', label: '🌾 +Hay Bales', w: 224 },
    { id: 'cmd:extend that fence', label: '🧲 Extend Fence', w: 232 },
  ],
];

const BOARD_ROWS_OBJECT = [
  [
    { id: 'rotate-l', label: '↺ -45°', w: 150 },
    { id: 'rotate-r', label: '↻ +45°', w: 150 },
    { id: 'rotate-90', label: '↻ 90°', w: 150 },
    { id: 'bigger', label: '➕ Bigger', w: 158 },
    { id: 'smaller', label: '➖ Smaller', w: 166 },
  ],
  [
    { id: 'grab', label: '✋ Grab / Move', w: 200 },
    { id: 'snap', label: '🧲 Snap / Align', w: 210 },
    { id: 'duplicate', label: '📋 Duplicate', w: 200 },
    { id: 'delete', label: '🗑️ Delete', w: 160 },
    { id: 'deselect', label: '✖ Deselect', w: 174 },
  ],
];

const BOARD_BOTTOM = [
  { id: 'speak', label: '🎤 Speak', x: 20, y: 548, w: 300, h: 74, accent: true },
  { id: 'undo', label: '↩️ Undo', x: 332, y: 548, w: 210, h: 74 },
  { id: 'redo', label: '↪️ Redo', x: 554, y: 548, w: 210, h: 74 },
  { id: 'exit-vr', label: '🚪 Exit VR', x: 776, y: 548, w: 228, h: 74 },
];

let boardTab = 'tab:world';
let hoverId = null;

/**
 * Compute the current interactive layout: drag strip + tabs + rows (+ bottom
 * bar). Rows are laid out horizontally with generous gutters.
 */
function boardLayout() {
  const buttons = [];
  for (const tab of BOARD_TABS) buttons.push({ ...tab, kind: 'tab' });

  const rows = boardTab === 'tab:object' ? BOARD_ROWS_OBJECT : BOARD_ROWS_WORLD;
  let y = 196;
  for (const row of rows) {
    const gap = 12;
    const total = row.reduce((sum, b) => sum + b.w, 0) + gap * (row.length - 1);
    let x = 20 + Math.max(0, (BOARD_W - 40 - total) / 2);
    for (const b of row) {
      buttons.push({ ...b, x, y, h: 72, kind: 'row' });
      x += b.w + gap;
    }
    y += 84;
  }

  for (const b of BOARD_BOTTOM) buttons.push({ ...b, kind: 'bottom' });

  return {
    buttons,
    dragStrip: { id: 'drag', x: 16, y: 14, w: BOARD_W - 32, h: 96 },
  };
}

function redrawVrBoard(hover = hoverId) {
  hoverId = hover ?? null;
  const ctx = vrBoardCtx;
  const layout = boardLayout();
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);

  // Panel background
  ctx.fillStyle = 'rgba(8, 14, 18, 0.94)';
  roundRect(ctx, 8, 8, BOARD_W - 16, BOARD_H - 16, 28);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2ce8c4';
  ctx.stroke();

  // Drag-handle strip: subtle dots + instruction, so users know they can move it
  ctx.fillStyle = 'rgba(44, 232, 196, 0.10)';
  roundRect(ctx, 16, 14, BOARD_W - 32, 96, 18);
  ctx.fill();

  ctx.fillStyle = '#2ce8c4';
  ctx.font = 'bold 26px sans-serif';
  const selected = state.selectedId ? state.objects.find((o) => o.id === state.selectedId) : null;
  ctx.fillText(`MODELSTUDIO VR · ${state.project.toUpperCase()} · ${state.world.biome}`, 36, 50);

  const pt = state.pin?.point ?? state.pointer.hitPoint;
  ctx.fillStyle = '#f5b942';
  ctx.font = '20px monospace';
  ctx.fillText(
    `📍 ${pt.map((n) => Number(n).toFixed(1)).join(', ')}   🎯 ${state.pointer.hitObjectName ?? 'ground'}   ${selected ? `✏️ ${selected.name}` : ''}`,
    36,
    84,
  );

  ctx.fillStyle = 'rgba(220, 245, 238, 0.55)';
  ctx.font = '17px sans-serif';
  ctx.fillText('⠿ drag this bar to move the board', BOARD_W - 300, 50);

  ctx.fillStyle = state.recording ? '#ff7b7b' : '#b8ded4';
  ctx.font = '19px sans-serif';
  const statusMsg = state.recording
    ? '🔴 Listening… speak now'
    : state.busy
      ? '⏳ Building in 3D world…'
      : (state.snapHint || state.lastStatusText);
  ctx.fillText(statusMsg.slice(0, 84), 36, 112);

  for (const btn of layout.buttons) {
    const isHover = hover === btn.id;
    const isRec = btn.id === 'speak' && state.recording;
    const activeTab = btn.kind === 'tab' && boardTab === btn.id;
    ctx.fillStyle = isRec
      ? '#c93838'
      : btn.accent
        ? (isHover ? '#48ffdc' : '#2ce8c4')
        : activeTab
          ? 'rgba(44, 232, 196, 0.34)'
          : (isHover ? 'rgba(44, 232, 196, 0.30)' : 'rgba(255, 255, 255, 0.09)');
    roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 14);
    ctx.fill();
    ctx.strokeStyle = isHover || activeTab ? '#ffffff' : 'rgba(44, 232, 196, 0.38)';
    ctx.lineWidth = isHover || activeTab ? 3 : 2;
    ctx.stroke();

    ctx.fillStyle = btn.accent && !isRec ? '#041411' : '#eefcf8';
    ctx.font = `bold ${btn.h >= 70 ? 23 : 21}px sans-serif`;
    const label = btn.id === 'speak' && state.recording ? '⏹ Stop & Run' : btn.label;
    ctx.fillText(label, btn.x + 16, btn.y + btn.h / 2 + 8);
  }

  // Object tab with nothing selected: friendly guidance instead of dead buttons
  if (boardTab === 'tab:object' && !selected) {
    ctx.fillStyle = 'rgba(245, 185, 66, 0.14)';
    roundRect(ctx, 20, 372, BOARD_W - 40, 130, 14);
    ctx.fill();
    ctx.fillStyle = '#ffe6a8';
    ctx.font = '20px sans-serif';
    ctx.fillText('Point at any object and pull the Trigger to select it.', 44, 420);
    ctx.fillText('Then rotate, resize, snap, duplicate or delete it here — or grab it with Grip.', 44, 456);
  }

  if (state.lastReplyText) {
    ctx.fillStyle = 'rgba(44, 232, 196, 0.14)';
    roundRect(ctx, 20, 470, BOARD_W - 40, 66, 12);
    ctx.fill();
    ctx.fillStyle = '#d9fff5';
    ctx.font = '19px sans-serif';
    ctx.fillText(`AI: ${state.lastReplyText.slice(0, 88)}`, 38, 510);
  }

  vrBoardTex.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Hit-test the board canvas UV against tabs / rows / drag strip. */
function hitTestBoard(uv) {
  if (!uv) return { kind: 'none', id: null };
  const px = uv.x * BOARD_W;
  const py = (1 - uv.y) * BOARD_H;
  const { buttons, dragStrip } = boardLayout();
  const btn = buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
  if (btn) return { kind: 'button', id: btn.id };
  const strip = dragStrip;
  if (px >= strip.x && px <= strip.x + strip.w && py >= strip.y && py <= strip.y + strip.h) {
    return { kind: 'drag', id: 'drag' };
  }
  return { kind: 'panel', id: null };
}

/**
 * Place the board ~1.25m in front of the user's current WORLD-SPACE gaze using
 * the shared `computeMenuSummonPose` helper (which correctly accounts for the
 * `playerRig.rotation.y` yaw after smooth/snap turning).
 */
function placeBoard() {
  const head = editor.headArrays();
  const pose = computeMenuSummonPose({
    headWorldPos: head.position,
    headWorldForward: head.forward,
    distance: 1.28,
    verticalOffset: -0.14,
    minHeightAboveFloor: 0.95,
  });
  playerRig.worldToLocal(vrBoardMesh.position.set(...pose.position));
  vrBoardMesh.rotation.set(0, pose.yawRad - playerRig.rotation.y, 0);
  vrBoardMesh.visible = true;
}

function summonVrHudInFront() {
  placeBoard();
  redrawVrBoard();
}

// --- World Environment Builder (Sky, Rolling Terrain, Swaying Hayfield) ---

function rebuildWorldEnvironment(world) {
  const sig = JSON.stringify(world);
  if (sig === state.worldSignature) return;
  state.worldSignature = sig;
  state.world = normalizeWorld(world);
  $('#vr-biome-badge').textContent = state.world.biome;

  // 1. Sky & Lighting
  clearGroup(skyGroup);
  const sky = state.world.sky;
  const zenith = new THREE.Color().fromArray(sky.zenithColor ?? [0.18, 0.46, 0.84]);
  const horizon = new THREE.Color().fromArray(sky.horizonColor ?? [0.68, 0.84, 0.96]);

  if (!state.inAR) {
    scene.background = horizon.clone();
    if (state.world.fog?.enabled) {
      const fogCol = new THREE.Color().fromArray(state.world.fog.color ?? sky.horizonColor);
      scene.fog = new THREE.Fog(fogCol, state.world.fog.near ?? 24, state.world.fog.far ?? 130);
    } else {
      scene.fog = null;
    }

    const domeGeo = new THREE.SphereGeometry(220, 32, 20);
    const domePos = domeGeo.attributes.position;
    const domeColors = new Float32Array(domePos.count * 3);
    const tmpCol = new THREE.Color();
    for (let i = 0; i < domePos.count; i += 1) {
      const t = Math.max(0, Math.min(1, domePos.getY(i) / 220));
      tmpCol.copy(horizon).lerp(zenith, Math.pow(t, 0.6));
      domeColors[i * 3] = tmpCol.r;
      domeColors[i * 3 + 1] = tmpCol.g;
      domeColors[i * 3 + 2] = tmpCol.b;
    }
    domeGeo.setAttribute('color', new THREE.BufferAttribute(domeColors, 3));
    const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
    skyGroup.add(dome);

    const sunDir = new THREE.Vector3().fromArray(sky.sunDirection ?? [0.5, 0.7, 0.4]).normalize();
    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(6.5, 20, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().fromArray(sky.sunColor ?? [1, 0.92, 0.75]), fog: false }),
    );
    sunDisc.position.copy(sunDir).multiplyScalar(195);
    skyGroup.add(sunDisc);

    if (sky.stars) {
      const starPositions = new Float32Array(750 * 3);
      let s = 42;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      for (let i = 0; i < 750; i += 1) {
        const theta = rand() * Math.PI * 2;
        const phi = Math.acos(0.12 + rand() * 0.88);
        const r = 205;
        starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPositions[i * 3 + 1] = r * Math.cos(phi);
        starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      skyGroup.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, fog: false })));
    }
  } else {
    scene.background = null;
    scene.fog = null;
  }

  const sunVec = new THREE.Vector3().fromArray(sky.sunDirection ?? [0.5, 0.7, 0.4]).normalize();
  sunLight.position.copy(sunVec).multiplyScalar(48);
  sunLight.color.fromArray(sky.sunColor ?? [1, 0.96, 0.9]);
  sunLight.intensity = Number(sky.sunIntensity ?? 2.4);
  hemiLight.color.copy(zenith).lerp(new THREE.Color(0xffffff), 0.5);
  hemiLight.groundColor.fromArray(state.world.ground.color ?? [0.3, 0.25, 0.15]);
  hemiLight.intensity = Number(sky.ambientIntensity ?? 0.65);

  // 2. Terrain Mesh (shared heightfield with server!)
  clearGroup(terrainGroup);
  terrainMesh = null;
  const g = state.world.ground;
  if (g.enabled && !state.inAR) {
    const size = Number(g.size ?? 180);
    const segs = 128;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color().fromArray(g.color ?? [0.4, 0.35, 0.2]);
    const c2 = new THREE.Color().fromArray(g.secondaryColor ?? g.color ?? [0.5, 0.45, 0.25]);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrainHeightAt(state.world, x, z);
      pos.setY(i, y);
      const blend = 0.5 + 0.5 * Math.sin(x * 0.09 + z * 0.07);
      tmp.copy(c1).lerp(c2, blend);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    terrainMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: Number(g.roughness ?? 0.92),
        metalness: Number(g.metallic ?? 0.0),
      }),
    );
    terrainMesh.receiveShadow = true;
    terrainMesh.name = '__terrain';
    terrainGroup.add(terrainMesh);

    if (g.grid) {
      const grid = new THREE.GridHelper(size, Math.round(size / 2), 0x2ce8c4, 0x1a2830);
      grid.position.y = 0.015;
      grid.material.opacity = 0.35;
      grid.material.transparent = true;
      terrainGroup.add(grid);
    }
  } else if (state.inAR) {
    // Invisible ground plane in AR passthrough so pointing at the floor still works!
    const arFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    arFloor.rotation.x = -Math.PI / 2;
    terrainMesh = arFloor;
    terrainGroup.add(arFloor);
  }

  // 3. GPU-Instanced Wind-Animated Foliage (Hayfield / Grass / Wildflowers / Fireflies)
  clearGroup(foliageGroup);
  if (!state.inAR) {
    for (const layer of state.world.foliage ?? []) {
      const mesh = buildFoliageLayer(layer, state.world);
      if (mesh) foliageGroup.add(mesh);
    }
  }

  // Keep player rig grounded on the updated terrain
  playerRig.position.y = terrainHeightAt(state.world, playerRig.position.x, playerRig.position.z);
  redrawVrBoard();
}

function buildFoliageLayer(layer, world) {
  const count = Math.min(12000, Math.max(0, Number(layer.count ?? 0)));
  if (!count) return null;
  const radius = Number(layer.radius ?? 55);
  const h = Number(layer.height ?? 0.65);

  if (layer.kind === 'fireflies') {
    const geo = new THREE.SphereGeometry(0.038, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().fromArray(layer.color ?? [0.85, 1, 0.4]) });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = windUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float seed = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
         transformed.y += sin(uTime * 1.4 + seed) * 0.35;
         transformed.x += cos(uTime * 0.9 + seed * 1.3) * 0.25;`,
      );
    };
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    let seed = 9187;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < count; i += 1) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * radius;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeightAt(world, x, z) + 0.5 + rand() * h;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(0.6 + rand() * 0.8);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.frustumCulled = false;
    return inst;
  }

  // Tapered 2-segment blade with base-to-tip vertex colour gradient
  const bladeW = layer.kind === 'hay' ? 0.042 : 0.034;
  const bladeGeo = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -bladeW, 0, 0,
     bladeW, 0, 0,
    -bladeW * 0.65, h * 0.55, 0.02,
     bladeW * 0.65, h * 0.55, 0.02,
     0, h, 0.06,
  ]);
  const indices = [0, 1, 2, 1, 3, 2, 2, 3, 4];
  const baseCol = new THREE.Color().fromArray(layer.color ?? [0.84, 0.68, 0.28]);
  const tipCol = new THREE.Color().fromArray(layer.tipColor ?? [0.96, 0.86, 0.48]);
  const cols = new Float32Array([
    baseCol.r * 0.72, baseCol.g * 0.72, baseCol.b * 0.72,
    baseCol.r * 0.72, baseCol.g * 0.72, baseCol.b * 0.72,
    baseCol.r, baseCol.g, baseCol.b,
    baseCol.r, baseCol.g, baseCol.b,
    tipCol.r, tipCol.g, tipCol.b,
  ]);
  bladeGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  bladeGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  bladeGeo.setIndex(indices);
  bladeGeo.computeVertexNormals();

  const swayStrength = 0.14 * Number(layer.wind ?? 1.0);
  const bladeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  bladeMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float phase = uTime * 2.1 + instanceMatrix[3][0] * 0.45 + instanceMatrix[3][2] * 0.38;
       float bend = clamp(position.y / ${h.toFixed(3)}, 0.0, 1.0);
       transformed.x += sin(phase) * ${swayStrength.toFixed(4)} * bend * bend;
       transformed.z += cos(phase * 0.8) * ${(swayStrength * 0.6).toFixed(4)} * bend * bend;`,
    );
  };

  const inst = new THREE.InstancedMesh(bladeGeo, bladeMat, count);
  const dummy = new THREE.Object3D();
  const clearings = world.clearings ?? [];
  let seed = 1337 + count;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 3) {
    attempts += 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (clearings.some((c) => Math.hypot(x - c.x, z - c.z) < c.radius)) continue;
    const y = terrainHeightAt(world, x, z);
    dummy.position.set(x, y, z);
    dummy.rotation.set((rand() - 0.5) * 0.16, rand() * Math.PI * 2, (rand() - 0.5) * 0.16);
    const s = 0.72 + rand() * 0.62;
    dummy.scale.set(s, s * (0.8 + rand() * 0.45), s);
    dummy.updateMatrix();
    inst.setMatrixAt(placed, dummy.matrix);
    placed += 1;
  }
  inst.count = placed;
  inst.frustumCulled = false;
  return inst;
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
    else child.material?.dispose?.();
  }
}

// --- Sync Project Snapshot (World + 3D Objects) ---------------------------

async function syncWorld({ force = false } = {}) {
  try {
    const res = await api.state(state.project, force ? -1 : state.revision);
    if (!res || res.unchanged) return;
    const data = res.data ?? res;
    if (!data?.project) return;
    state.revision = data.project.revision;

    rebuildWorldEnvironment(data.world ?? data.project.world ?? defaultWorld());

    // Rebuild 3D objects
    clearGroup(objectsGroup);
    objectMeshes.clear();
    const materialsById = new Map((data.materials ?? []).map((m) => [m.id, m]));

    for (const obj of data.objects ?? []) {
      if (obj.visible === false || !obj.geometry) continue;
      const geometry = geometryFromPayload(obj.geometry);
      const matDef = materialsById.get(obj.materialId) ?? {};
      const base = matDef.baseColorFactor ?? [0.8, 0.8, 0.82, 1];
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(base[0], base[1], base[2]),
        roughness: matDef.roughnessFactor ?? 0.65,
        metalness: matDef.metallicFactor ?? 0.05,
        emissive: new THREE.Color(...(matDef.emissiveFactor ?? [0, 0, 0])),
        transparent: matDef.alphaMode === 'BLEND' || (base[3] ?? 1) < 0.99,
        opacity: base[3] ?? 1,
        side: THREE.DoubleSide,
      });
      if (matDef.baseColorTexture) {
        const tex = textureLoader.load(api.textureUrl(state.project, matDef.baseColorTexture));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        mat.map = tex;
        mat.color.setHex(0xffffff);
      }

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const tr = obj.transform ?? {};
      mesh.position.fromArray(tr.translation ?? [0, 0, 0]);
      if (Array.isArray(tr.rotation)) {
        if (tr.rotation.length === 4) mesh.quaternion.fromArray(tr.rotation);
        else if (tr.rotation.length === 3) {
          mesh.rotation.set(tr.rotation[0] * DEG, tr.rotation[1] * DEG, tr.rotation[2] * DEG);
        }
      }
      mesh.scale.fromArray(tr.scale ?? [1, 1, 1]);
      mesh.userData = { objectId: obj.id, objectName: obj.name };
      objectsGroup.add(mesh);
      objectMeshes.set(obj.id, mesh);
    }

    state.objects = Array.isArray(data.objects) ? data.objects : [];
    redrawVrBoard();
    if (state.selectedId && !state.objects.some((o) => o.id === state.selectedId)) {
      state.selectedId = null;
    }
    if (editor) {
      editor.refreshSelectionVisual();
      editor.renderSelectionUi();
    }
    redrawVrBoard();
  } catch (err) {
    console.warn('[vr-sync]', err);
  }
}

// --- Instantiate the shared VR/desktop editing engine ----------------------

editor = createVrEditor({
  THREE,
  renderer,
  camera,
  playerRig,
  scene,
  objectsGroup,
  api,
  state,
  $,
  terrainHeightAt: (world, x, z) => terrainHeightAt(world, x, z),
  showReply,
  submitSpatialPrompt,
  refresh: () => syncWorld({ force: true }),
  pinCurrentSpot: () => pinCurrentSpot(),
  boardMesh: () => vrBoardMesh,
  placeBoard: () => placeBoard(),
  redrawBoard: () => redrawVrBoard(),
});

// --- Raycasting & Spatial Pinning -----------------------------------------

const raycaster = new THREE.Raycaster();
const screenNdc = new THREE.Vector2(0, -0.1);
const tempMatrix = new THREE.Matrix4();


/**
 * Single ray gather used by VR controllers, hand rays and the desktop mouse.
 *
 * Priority order (so nothing ever blocks a world edit):
 *   1. The wrist "☰ MENU" pill (tiny, always-on, never hides the world)
 *   2. The floating command board (with generous hit rectangles)
 *   3. The selected object's grab handle / world objects
 *   4. Terrain
 */
function raycastFromRay(originVec, dirVec, handLabel = 'right') {
  raycaster.set(originVec, dirVec);
  raycaster.far = 160;

  // 1. Wrist pill
  if (wristPill.visible) {
    const pillHit = raycaster.intersectObject(wristPill, false)[0];
    if (pillHit && pillHit.distance < 3.2) {
      return { kind: 'wrist', hit: pillHit, distance: pillHit.distance };
    }
  }

  // 2. Floating board
  if (vrBoardMesh.visible) {
    const boardHit = raycaster.intersectObject(vrBoardMesh, false)[0];
    if (boardHit && boardHit.uv) {
      const zone = hitTestBoard(boardHit.uv);
      redrawVrBoard(zone.kind === 'button' ? zone.id : null);
      return { kind: 'board', boardHit, zone, uv: boardHit.uv, distance: boardHit.distance };
    }
    redrawVrBoard(null);
  }

  // 3. World objects & terrain
  const targets = [...objectsGroup.children];
  if (terrainMesh) targets.push(terrainMesh);
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const hit = hits[0];
    const isTerrain = hit.object === terrainMesh;
    const p = hit.point;
    const n = hit.face?.normal
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    state.pointer = {
      active: true,
      hand: handLabel,
      origin: [originVec.x, originVec.y, originVec.z],
      direction: [dirVec.x, dirVec.y, dirVec.z],
      hitPoint: [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), Number(p.z.toFixed(3))],
      hitNormal: [Number(n.x.toFixed(3)), Number(n.y.toFixed(3)), Number(n.z.toFixed(3))],
      hitKind: isTerrain ? 'ground' : 'object',
      hitObjectId: isTerrain ? null : hit.object.userData?.objectId ?? null,
      hitObjectName: isTerrain ? null : hit.object.userData?.objectName ?? null,
    };
    hoverReticle.visible = true;
    hoverReticle.position.copy(p).addScaledVector(n, 0.025);
    hoverReticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    // Highlight a hovered object so users can tell what the trigger will select
    hoverReticle.material.color.setHex(state.pointer.hitObjectId ? 0xf5b942 : 0x2ce8c4);
    updatePointerHud();
    return {
      kind: 'world',
      worldHit: hit,
      objectId: state.pointer.hitObjectId,
      objectName: state.pointer.hitObjectName,
      point: state.pointer.hitPoint,
      distance: hit.distance,
    };
  }
  hoverReticle.visible = false;
  return { kind: 'none' };
}

function pinCurrentSpot() {
  state.pin = {
    point: [...state.pointer.hitPoint],
    normal: [...state.pointer.hitNormal],
    objectId: state.pointer.hitObjectId,
    objectName: state.pointer.hitObjectName,
  };
  pinBeacon.position.set(state.pin.point[0], state.pin.point[1], state.pin.point[2]);
  pinBeacon.visible = true;
  updatePointerHud();
  pushVrTelemetry({ immediatePin: true });
  redrawVrBoard();
}

function updatePointerHud() {
  const shown = state.pin?.point ?? state.pointer.hitPoint;
  $('#vr-coord-text').textContent = shown.map((n) => Number(n).toFixed(1)).join(', ');
  const targetName = state.pointer.hitObjectName ?? state.pin?.objectName;
  const targetPill = $('#vr-target-pill');
  if (targetName) {
    targetPill.classList.remove('hidden');
    $('#vr-target-text').textContent = targetName;
  } else {
    targetPill.classList.add('hidden');
  }
}

/**
 * Trigger / A-button press in VR. Selects objects, confirms ghost placement,
 * handles board taps and can drag the board from its header strip.
 */
function onVrSelect(controller, { long = false } = {}) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
  const res = raycastFromRay(origin, dir, 'vr-controller');

  if (res.kind === 'wrist') {
    editor.ensureMenuVisible();
    return;
  }
  if (res.kind === 'board') {
    if (res.zone.kind === 'drag') {
      editor.beginBoardDrag(res.uv);
      state.menuGrab = {
        planeY: vrBoardMesh.getWorldPosition(new THREE.Vector3()).y,
        lastUv: res.uv,
      };
      return;
    }
    if (res.zone.kind === 'button') {
      if (res.zone.id.startsWith('tab:')) {
        boardTab = res.zone.id;
        redrawVrBoard();
        return;
      }
      editor.runBoardAction(res.zone.id);
      return;
    }
    return;
  }

  // Ghost placement: the first trigger press drops the preview right there.
  if (state.preview) {
    editor.confirmPreview();
    return;
  }

  if (res.kind === 'world' && res.objectId) {
    editor.selectObject(res.objectId, { announce: true });
    return;
  }

  // Ground click: move the selected object there, otherwise pin "right there"
  if (res.kind === 'world') {
    if (state.selectedId) {
      editor.moveSelectedTo(res.point);
    } else {
      pinCurrentSpot();
    }
  }
}

// --- Telemetry Sync to Server (so external MCP / CLI knows "Right There") -

let lastTelemetryMs = 0;
async function pushVrTelemetry({ immediatePin = false } = {}) {
  const now = performance.now();
  if (!immediatePin && now - lastTelemetryMs < 240) return;
  lastTelemetryMs = now;

  const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const headPos = new THREE.Vector3();
  const headQuat = new THREE.Quaternion();
  xrCam.getWorldPosition(headPos);
  xrCam.getWorldQuaternion(headQuat);
  const headForward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat).normalize();

  try {
    await fetch(`/api/projects/${encodeURIComponent(state.project)}/vr/point`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inVR: renderer.xr.isPresenting,
        device: renderer.xr.isPresenting ? 'WebXR Headset' : 'Desktop Pointer',
        head: {
          position: [headPos.x, headPos.y, headPos.z],
          forward: [headForward.x, headForward.y, headForward.z],
        },
        pointer: state.pointer,
        ...(immediatePin && state.pin ? { pin: state.pin } : {}),
      }),
    });
  } catch {
    /* ignore transient network hiccup */
  }
}

// --- Submit Natural-Language Spatial Prompt -------------------------------

async function submitSpatialPrompt(instruction) {
  const text = String(instruction ?? '').trim();
  if (!text || state.busy) return;
  state.busy = true;
  $('#btn-send-prompt').disabled = true;
  state.lastStatusText = `"${text}"`;
  showReply('Building in 3D World…', `Running: "${text}"`);
  redrawVrBoard();

  const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const headPos = new THREE.Vector3();
  const headQuat = new THREE.Quaternion();
  xrCam.getWorldPosition(headPos);
  xrCam.getWorldQuaternion(headQuat);
  const headForward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat).normalize();

  // Prefer the pointer captured when speech started, then pinned spot, then live pointer!
  const effectivePointer = state.speechSnapshot ?? (state.pin
    ? { ...state.pointer, hitPoint: state.pin.point, hitObjectId: state.pin.objectId, hitObjectName: state.pin.objectName }
    : state.pointer);
  state.speechSnapshot = null;

  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(state.project)}/vr/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: text,
        inVR: renderer.xr.isPresenting,
        head: {
          position: [headPos.x, headPos.y, headPos.z],
          forward: [headForward.x, headForward.y, headForward.z],
        },
        pointer: effectivePointer,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const msg = payload.error?.message ?? 'Command could not be completed';
      state.lastReplyText = `Error: ${msg}`;
      showReply('Could not complete command', msg);
      speakReply(msg);
    } else {
      const reply = payload.data?.reply ?? 'Done.';
      const mode = payload.data?.mode === 'openai-compatible' ? `AI (${payload.data.model})` : 'Spatial Engine';
      state.lastReplyText = reply;
      showReply(mode, reply);
      speakReply(reply);
      await syncWorld({ force: true });
    }
  } catch (error) {
    state.lastReplyText = error.message;
    showReply('Network Error', error.message);
  } finally {
    state.busy = false;
    $('#btn-send-prompt').disabled = false;
    state.lastStatusText = 'Ready — point & speak or type any world change';
    redrawVrBoard();
  }
}

let replyTimer = null;
function showReply(label, message) {
  const box = $('#vr-reply-box');
  $('#vr-reply-mode').textContent = label;
  $('#vr-reply-text').textContent = message;
  box.classList.remove('hidden');
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => box.classList.add('hidden'), 9000);
}

function speakReply(text) {
  if (!state.ttsEnabled || !('speechSynthesis' in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.04;
    window.speechSynthesis.speak(utter);
  } catch {
    /* ignore TTS restrictions */
  }
}

// --- Voice Input (Web Speech API + MediaRecorder Whisper Fallback) --------

let recognition = null;
let mediaRecorder = null;
let recordedChunks = [];

function toggleVoiceCapture() {
  if (state.recording) {
    stopVoiceCapture();
    return;
  }
  // Snapshot exact pointer spot at the moment the user starts speaking!
  pinCurrentSpot();
  state.speechSnapshot = {
    ...state.pointer,
    hitPoint: [...(state.pin?.point ?? state.pointer.hitPoint)],
    hitObjectId: state.pin?.objectId ?? state.pointer.hitObjectId,
    hitObjectName: state.pin?.objectName ?? state.pointer.hitObjectName,
  };

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec) {
    recognition = new SpeechRec();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalTranscript = '';

    recognition.onstart = () => setRecordingState(true);
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += chunk;
        else interim += chunk;
      }
      $('#vr-prompt-input').value = (finalTranscript || interim).trim();
    };
    recognition.onerror = () => setRecordingState(false);
    recognition.onend = () => {
      setRecordingState(false);
      const spoken = ($('#vr-prompt-input').value || finalTranscript).trim();
      if (spoken) submitSpatialPrompt(spoken);
    };
    recognition.start();
    return;
  }

  // Fallback: record audio & send to /api/projects/:ref/vr/transcribe
  if (!navigator.mediaDevices?.getUserMedia) {
    showReply('Voice Unavailable', 'Use HTTPS (`npm run start:vr`) for microphone access, or type below.');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecordingState(false);
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const res = await fetch(`/api/projects/${encodeURIComponent(state.project)}/vr/transcribe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64: reader.result, mimeType: blob.type }),
        });
        const data = await res.json();
        if (data.ok && data.text) {
          $('#vr-prompt-input').value = data.text;
          submitSpatialPrompt(data.text);
        } else {
          showReply('Voice Note', data.error?.message ?? 'Could not transcribe audio');
        }
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    setRecordingState(true);
  }).catch((err) => showReply('Microphone Blocked', err.message));
}

function stopVoiceCapture() {
  if (recognition) {
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  setRecordingState(false);
}

function setRecordingState(active) {
  state.recording = active;
  $('#btn-voice').classList.toggle('recording', active);
  $('#voice-label').textContent = active ? 'Listening…' : 'Speak';
  redrawVrBoard();
}

// --- Desktop Controls (Mouse Look + Click-to-Select/Drag + WASD Walk) -----

let draggingLook = false;
let pointerDownPos = [0, 0];
let pointerDragObject = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting) return;
  draggingLook = true;
  pointerDownPos = [e.clientX, e.clientY];
  screenNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  screenNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(screenNdc, camera);
  const hit = raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
  // Click-drag an existing object to move it (Phase 3 desktop parity)
  if (hit.kind === 'world' && hit.objectId) {
    pointerDragObject = hit.objectId;
    editor.selectObject(hit.objectId);
    editor.startGrab({ pointer: hit.point });
  } else {
    pointerDragObject = null;
  }
});

window.addEventListener('pointermove', (e) => {
  if (renderer.xr.isPresenting) return;
  screenNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  screenNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;

  // Dragging an object with the mouse: follow the cursor across the terrain
  if (pointerDragObject) {
    raycaster.setFromCamera(screenNdc, camera);
    const hit = raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
    if (hit.kind === 'world') {
      editor.moveSelectedTo(hit.point, { silent: true });
    }
    return;
  }

  if (draggingLook) {
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    state.yaw -= dx * 0.0042;
    state.pitch = Math.max(-1.35, Math.min(1.25, state.pitch - dy * 0.0042));
  }
});

window.addEventListener('pointerup', (e) => {
  if (renderer.xr.isPresenting) return;
  const moved = Math.hypot(e.clientX - pointerDownPos[0], e.clientY - pointerDownPos[1]);
  draggingLook = false;

  if (pointerDragObject) {
    const id = pointerDragObject;
    pointerDragObject = null;
    if (editor.endGrab()) return;
    editor.selectObject(id);
    return;
  }

  if (moved < 6 && e.target === renderer.domElement) {
    raycaster.setFromCamera(screenNdc, camera);
    const hit = raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
    if (hit.kind === 'world') {
      if (state.preview) {
        editor.confirmPreview();
      } else if (hit.objectId) {
        editor.selectObject(hit.objectId, { announce: true });
      } else if (state.selectedId) {
        editor.moveSelectedTo(hit.point);
      } else {
        pinCurrentSpot();
      }
    }
  }
});

window.addEventListener('keydown', (e) => {
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
  if (typing) return;
  state.keys.add(e.code);

  const meta = e.metaKey || e.ctrlKey;
  // Undo / redo
  if (meta && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (meta && e.code === 'KeyY') { e.preventDefault(); editor.redo(); return; }

  if (e.code === 'Escape') {
    if (state.preview) editor.clearPreview();
    else if (state.dragging) editor.cancelDrag();
    else editor.deselect();
    return;
  }
  if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); editor.deleteSelected(); return; }
  if (e.code === 'KeyR') {
    if (state.preview) editor.rotatePreview(45); else editor.rotateSelected(45);
    return;
  }
  if (e.code === 'KeyQ') {
    if (state.preview) editor.rotatePreview(-45); else editor.rotateSelected(-45);
    return;
  }
  if (e.code === 'KeyE') { editor.rotatePreview(90); return; }
  if (e.code === 'KeyD') { editor.duplicateSelected(); return; }
  if (e.code === 'KeyF') { editor.snapSelected(); return; }
  if (e.code === 'BracketLeft') { editor.resizeSelected(0.88); return; }
  if (e.code === 'BracketRight') { editor.resizeSelected(1.14); return; }
  if (e.code === 'KeyM' || e.code === 'Tab') { e.preventDefault(); toggleBoardFromUi(); return; }
});
window.addEventListener('keyup', (e) => state.keys.delete(e.code));

// --- Quest Touch Plus input contract (see src/core/vr-interaction.mjs) ----

function uiLocomotionBlocked() {
  // Never walk/turn while the user is grabbing the menu board or an object.
  return Boolean(state.menuGrab || state.dragging);
}

/**
 * While the user holds the trigger on the board's drag strip, slide the board
 * along a horizontal plane at the height it was grabbed, keeping it within
 * comfortable reach (0.9m – 2.6m from the head).
 */
const boardDragRay = new THREE.Ray();
const boardDragPlane = new THREE.Plane();
const boardDragPoint = new THREE.Vector3();

function updateBoardDrag(origin, dir) {
  if (!state.menuGrab) return;
  boardDragRay.set(origin, dir);
  boardDragPlane.set(new THREE.Vector3(0, 1, 0), -state.menuGrab.planeY);
  const hit = boardDragRay.intersectPlane(boardDragPlane, boardDragPoint);
  if (!hit) return;

  const head = editor.headArrays();
  const dx = hit.x - head.position[0];
  const dz = hit.z - head.position[2];
  const dist = Math.hypot(dx, dz);
  const clamped = Math.max(0.9, Math.min(2.6, dist));
  const k = dist > 1e-4 ? clamped / dist : 1;
  const world = new THREE.Vector3(head.position[0] + dx * k, state.menuGrab.planeY, head.position[2] + dz * k);

  playerRig.worldToLocal(world);
  vrBoardMesh.position.copy(world);
  vrBoardMesh.lookAt(playerRig.localToWorld(editor.headPose().pos.clone()));
  vrBoardMesh.visible = true;
}

function updateVrGamepads(dt) {
  if (!editor) return;
  editor.updateVrInput(dt, { uiBlocked: uiLocomotionBlocked() });
  updateWristPill();
}

/** Keep the ☰ MENU pill visually attached to the left wrist (or desktop corner). */
const tempQ = new THREE.Quaternion();
function updateWristPill() {
  if (renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    const left = session?.inputSources?.find((s) => s.handedness === 'left') ?? session?.inputSources?.[0];
    if (left) {
      const space = left.gripSpace ?? left.targetRaySpace;
      const pose = space ? renderer.xr.getPose(left, space) : null;
      if (pose) {
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const worldMatrix = new THREE.Matrix4().multiplyMatrices(playerRig.matrixWorld, m);
        const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrix);
        tempQ.setFromRotationMatrix(worldMatrix);
        const offset = new THREE.Vector3(0, 0.085, -0.035).applyQuaternion(tempQ);
        wristPill.position.copy(pos).add(offset);
        wristPill.quaternion.copy(tempQ);
        wristPill.rotateY(Math.PI * 0.15);
        wristPill.visible = true;
        return;
      }
    }
  }
  wristPill.visible = false;
}

function updateDesktopMovement(dt) {
  playerRig.rotation.y = state.yaw;
  camera.rotation.set(state.pitch, 0, 0);

  let moveZ = 0;
  let moveX = 0;
  if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) moveZ -= 1;
  if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) moveZ += 1;
  if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) moveX -= 1;
  if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) moveX += 1;

  if (moveX || moveZ) {
    const sprint = state.keys.has('ShiftLeft') || state.keys.has('ShiftRight') ? 2.1 : 1.0;
    const speed = Number(state.settings.moveSpeed ?? 4.5) * sprint * dt;
    const forward = new THREE.Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    const right = new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
    playerRig.position.addScaledVector(forward, -moveZ * speed);
    playerRig.position.addScaledVector(right, moveX * speed);
    playerRig.position.y = terrainHeightAt(state.world, playerRig.position.x, playerRig.position.z);
  }
}

// --- WebXR Session Entry (Meta Quest 3S `immersive-vr` & `immersive-ar`) --

async function setupWebXrButtons() {
  const vrBtn = $('#btn-enter-vr');
  const arBtn = $('#btn-enter-ar');

  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    $('#vr-https-warning').classList.remove('hidden');
  }

  if (!('xr' in navigator)) {
    vrBtn.textContent = 'WebXR Not Available (Desktop Mode Active)';
    vrBtn.disabled = true;
    return;
  }

  try {
    const vrOk = await navigator.xr.isSessionSupported('immersive-vr');
    if (vrOk) {
      vrBtn.textContent = 'Enter VR (Quest / WebXR)';
      vrBtn.onclick = () => startXrSession('immersive-vr');
    } else {
      vrBtn.textContent = 'No VR Headset Detected (Desktop Mode)';
      vrBtn.disabled = true;
    }
  } catch {
    vrBtn.disabled = true;
  }

  try {
    const arOk = await navigator.xr.isSessionSupported('immersive-ar');
    if (arOk) {
      arBtn.classList.remove('hidden');
      arBtn.onclick = () => startXrSession('immersive-ar');
    }
  } catch {
    /* optional AR passthrough */
  }
}

async function startXrSession(mode) {
  const current = renderer.xr.getSession();
  if (current) {
    await current.end();
    return;
  }
  // `dom-overlay` lets Quest Browser show the normal HTML HUD (including the
  // OS keyboard for text prompts) on top of the immersive scene.
  const sessionInit = {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers', 'dom-overlay'],
  };
  if (mode === 'immersive-ar' || 'domOverlay' in (window.XRSession?.prototype ?? {})) {
    sessionInit.domOverlay = { root: document.body };
  }
  const session = await navigator.xr.requestSession(mode, sessionInit);
  state.domOverlay = Boolean(session.domOverlayState);
  document.body.classList.toggle('xr-overlay', state.domOverlay);
  state.inVR = true;
  state.inAR = mode === 'immersive-ar';
  state.worldSignature = ''; // refresh sky/floor visibility for VR vs AR passthrough
  rebuildWorldEnvironment(state.world);

  session.addEventListener('end', () => {
    state.inVR = false;
    state.inAR = false;
    state.domOverlay = false;
    document.body.classList.remove('xr-overlay');
    vrBoardMesh.visible = false;
    wristPill.visible = false;
    state.menuGrab = null;
    if (editor) editor.cancelDrag({ silent: true });
    state.worldSignature = '';
    rebuildWorldEnvironment(state.world);
    $('#btn-enter-vr').textContent = 'Enter VR (Quest / WebXR)';
  });

  await renderer.xr.setSession(session);
  // Fixed foveated rendering keeps the Quest 3S at frame rate; harmless elsewhere.
  try {
    renderer.xr.setFoveation(0.6);
  } catch {
    /* not supported by this runtime */
  }
  $('#btn-enter-vr').textContent = 'Exit VR';
  summonVrHudInFront();
}

// --- Render Loop ----------------------------------------------------------

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  const elapsed = clock.elapsedTime;
  windUniforms.uTime.value = elapsed;

  if (pinBeacon.visible) {
    const pulse = 1 + Math.sin(elapsed * 3.4) * 0.12;
    pinRing.scale.setScalar(pulse);
    pinOrb.position.y = 0.16 + Math.sin(elapsed * 2.8) * 0.05;
  }

  if (renderer.xr.isPresenting) {
    updateVrGamepads(dt);

    // Ray from the active controller drives the pointer/telemetry/hover reticle
    const active = controllers[activeControllerIdx] ?? controllers[0];
    if (active) {
      tempMatrix.identity().extractRotation(active.controller.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(active.controller.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
      const hit = raycastFromRay(origin, dir, 'vr-controller');
      active.rayLine.scale.z = hit?.distance ?? 20;
      updateBoardDrag(origin, dir);
      if (!hit || hit.kind === 'none') hoverReticle.visible = false;
    }
    editor.updatePreviewSnap();
    pushVrTelemetry();
  } else {
    updateDesktopMovement(dt);
    raycaster.setFromCamera(screenNdc, camera);
    raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
    editor.updatePreviewSnap();
    pushVrTelemetry();
  }

  editor.refreshSelectionVisual();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- UI Wiring & Boot -----------------------------------------------------

async function populateProjectsAndAi() {
  const listRes = await api.projects();
  let projects = listRes?.projects ?? [];
  if (!projects.length) {
    await api.createProject(state.project);
    projects = (await api.projects())?.projects ?? [];
  }
  if (!projects.some((p) => p.name === state.project)) {
    state.project = projects[0]?.name ?? 'Demo';
  }
  localStorage.setItem('modelstudio.project', state.project);
  $('#link-studio').href = `/?project=${encodeURIComponent(state.project)}`;

  const sel = $('#vr-project-select');
  sel.innerHTML = projects.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
  sel.value = state.project;
  sel.onchange = async () => {
    state.project = sel.value;
    localStorage.setItem('modelstudio.project', state.project);
    state.revision = -1;
    state.worldSignature = '';
    await syncWorld({ force: true });
  };

  try {
    const [cfgRes, toolsRes] = await Promise.all([
      fetch('/api/ai/config').then((r) => r.json()),
      fetch('/api/ai/tools').then((r) => r.json()),
    ]);
    if (cfgRes?.config) {
      $('#ai-provider-select').value = cfgRes.config.provider ?? 'auto';
      $('#ai-base-url').value = cfgRes.config.baseUrl ?? 'https://api.openai.com/v1';
      $('#ai-model').value = cfgRes.config.model ?? 'gpt-4o-mini';
      if (cfgRes.config.hasApiKey) $('#ai-api-key').placeholder = '•••••••• (configured in memory)';
    }
    if (toolsRes?.mcp) {
      $('#mcp-http-url').value = toolsRes.mcp.streamableHttpUrl;
      $('#mcp-stdio-json').value = JSON.stringify(toolsRes.mcp.stdioConfig, null, 2);
      $('#quest-lan-urls').value = (toolsRes.lanAddresses ?? []).map((ip) => `https://${ip}:4318/vr`).join('  |  ');
    }
  } catch {
    /* ignore */
  }
}

$('#vr-command-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#vr-prompt-input');
  const val = input.value.trim();
  if (!val) return;
  submitSpatialPrompt(val);
  input.value = '';
});

$('#btn-voice').addEventListener('click', toggleVoiceCapture);

$('#vr-quick-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.say) submitSpatialPrompt(btn.dataset.say);
  else if (btn.dataset.place) editor.placeObject(btn.dataset.place);
});

// ---- Floating menu board controls (desktop mirrors of the in-VR board) ----

function toggleBoardFromUi() {
  editor.toggleMenu();
  redrawVrBoard();
}

$('#btn-locomotion-drawer').addEventListener('click', () => {
  $('#locomotion-drawer').classList.toggle('hidden');
  $('#ai-drawer').classList.add('hidden');
});
$('#btn-close-locomotion').addEventListener('click', () => $('#locomotion-drawer').classList.add('hidden'));

$('#btn-ai-drawer').addEventListener('click', () => {
  $('#ai-drawer').classList.toggle('hidden');
  $('#locomotion-drawer').classList.add('hidden');
});
$('#btn-close-drawer').addEventListener('click', () => $('#ai-drawer').classList.add('hidden'));
$('#chk-tts').addEventListener('change', (e) => { state.ttsEnabled = e.target.checked; });

// ---- Phase 1 settings (speeds, turning, teleport, snapping, preview) ------

const outMove = $('#out-move-speed');
const outTurn = $('#out-turn-speed');

function syncSettingsUi() {
  const st = state.settings;
  $('#rng-move-speed').value = st.moveSpeed;
  outMove.textContent = Number(st.moveSpeed).toFixed(1);
  $('#sel-turn-mode').value = st.turnMode;
  $('#rng-turn-speed').value = st.turnSpeedDeg;
  outTurn.textContent = String(Math.round(st.turnSpeedDeg));
  $('#sel-snap-angle').value = String(st.snapAngleDeg);
  $('#chk-teleport').checked = Boolean(st.teleportEnabled);
  $('#chk-snap').checked = Boolean(st.snapEnabled);
  $('#chk-preview').checked = Boolean(st.previewPlacement);
  $('#sel-grid-snap').value = String(st.gridSnap ?? 0);
}

$('#rng-move-speed').addEventListener('input', (e) => {
  state.settings.moveSpeed = Number(e.target.value);
  outMove.textContent = Number(e.target.value).toFixed(1);
  saveVrSettings();
});
$('#sel-turn-mode').addEventListener('change', (e) => {
  state.settings.turnMode = e.target.value;
  saveVrSettings();
});
$('#rng-turn-speed').addEventListener('input', (e) => {
  state.settings.turnSpeedDeg = Number(e.target.value);
  outTurn.textContent = String(Math.round(e.target.value));
  saveVrSettings();
});
$('#sel-snap-angle').addEventListener('change', (e) => {
  state.settings.snapAngleDeg = Number(e.target.value);
  saveVrSettings();
});
$('#chk-teleport').addEventListener('change', (e) => {
  state.settings.teleportEnabled = e.target.checked;
  saveVrSettings();
});
$('#chk-snap').addEventListener('change', (e) => {
  state.settings.snapEnabled = e.target.checked;
  saveVrSettings();
});
$('#chk-preview').addEventListener('change', (e) => {
  state.settings.previewPlacement = e.target.checked;
  saveVrSettings();
});
$('#sel-grid-snap').addEventListener('change', (e) => {
  state.settings.gridSnap = Number(e.target.value);
  saveVrSettings();
});

// ---- Phase 3 object inspector buttons + preview banner -------------------

$('#vr-object-inspector').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-edit]');
  if (!btn) return;
  const action = btn.dataset.edit;
  if (action === 'drag-toggle') {
    if (state.dragging) editor.endGrab();
    else editor.startGrab({ pointer: state.pointer.hitPoint });
    return;
  }
  if (action === 'move-pin') return editor.moveSelectedTo(state.pin?.point ?? state.pointer.hitPoint);
  if (action === 'rot-left') return editor.rotateSelected(-45);
  if (action === 'rot-right') return editor.rotateSelected(45);
  if (action === 'rot-90') return editor.rotateSelected(90);
  if (action === 'scale-up') return editor.resizeSelected(1.18);
  if (action === 'scale-down') return editor.resizeSelected(0.85);
  if (action === 'snap') return editor.snapSelected();
  if (action === 'duplicate') return editor.duplicateSelected();
  if (action === 'delete') return editor.deleteSelected();
});
$('#btn-deselect').addEventListener('click', () => editor.deselect());

$('#btn-preview-rot-left').addEventListener('click', () => editor.rotatePreview(-45));
$('#btn-preview-rot-right').addEventListener('click', () => editor.rotatePreview(45));
$('#btn-preview-rot-90').addEventListener('click', () => editor.rotatePreview(90));
$('#btn-preview-confirm').addEventListener('click', () => editor.confirmPreview());
$('#btn-preview-cancel').addEventListener('click', () => editor.clearPreview());

$('#btn-recenter').addEventListener('click', () => {
  playerRig.position.set(0, terrainHeightAt(state.world, 0, 3.5), 3.5);
  playerRig.rotation.set(0, 0, 0);
  state.yaw = 0;
  state.pitch = -0.08;
  if (vrBoardMesh.visible) placeBoard();
  showReply('Recentred', 'You are back at the world spawn point facing forward.');
});

$('#btn-undo-top').addEventListener('click', () => editor.undo());
$('#btn-redo-top').addEventListener('click', () => editor.redo());

// ---- AI provider drawer --------------------------------------------------

$('#btn-save-ai').addEventListener('click', async () => {
  const body = {
    provider: $('#ai-provider-select').value,
    baseUrl: $('#ai-base-url').value.trim(),
    model: $('#ai-model').value.trim(),
  };
  const keyVal = $('#ai-api-key').value.trim();
  if (keyVal) body.apiKey = keyVal;
  const res = await fetch('/api/ai/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  if (res?.ok) {
    $('#ai-api-key').value = '';
    showReply('AI Settings Saved', `Mode: ${res.config.provider} · Model: ${res.config.model}`);
  }
});

// Live SSE updates (whenever MCP, CLI, HTTP, or VR mutates the world!)
const sse = api.events();
sse.addEventListener('change', (msg) => {
  try {
    const ev = JSON.parse(msg.data);
    if (!ev.project || ev.project === state.project) syncWorld({ force: true });
  } catch {
    /* ignore */
  }
});
setInterval(() => syncWorld(), 2500);

syncSettingsUi();
await setupWebXrButtons();
await populateProjectsAndAi();
await syncWorld({ force: true });
redrawVrBoard();
