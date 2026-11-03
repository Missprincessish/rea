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

const $ = (sel) => document.querySelector(sel);
const DEG = Math.PI / 180;

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
  controller.addEventListener('squeezestart', () => {
    activeControllerIdx = i;
    summonVrHudInFront();
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

const VR_BOARD_BUTTONS = [
  { id: 'speak', label: '🎤 Speak Command', x: 36, y: 170, w: 300, h: 72, accent: true },
  { id: 'pin', label: '📍 Pin Spot', x: 356, y: 170, w: 300, h: 72 },
  { id: 'undo', label: '↩️ Undo', x: 676, y: 170, w: 312, h: 72 },

  { id: 'cmd:make this a hayfield and put a green barn right there', label: '🌾 Hayfield + Green Barn', x: 36, y: 268, w: 466, h: 68 },
  { id: 'cmd:make this a pine forest at sunset', label: '🌲 Sunset Pine Forest', x: 522, y: 268, w: 466, h: 68 },

  { id: 'cmd:put a green barn right there', label: '🏠 Barn Here', x: 36, y: 356, w: 224, h: 66 },
  { id: 'cmd:put a windmill right there', label: '🗼 Windmill', x: 276, y: 356, w: 224, h: 66 },
  { id: 'cmd:put a wooden fence right there', label: '🪵 Fence Here', x: 516, y: 356, w: 224, h: 66 },
  { id: 'cmd:scatter 6 hay bales around me', label: '🌾 +Hay Bales', x: 756, y: 356, w: 232, h: 66 },

  { id: 'cmd:make this a snowfield', label: '❄️ Snowfield', x: 36, y: 442, w: 224, h: 66 },
  { id: 'cmd:make this a starlit clearing with fireflies', label: '✨ Night Fireflies', x: 276, y: 442, w: 224, h: 66 },
  { id: 'cmd:delete that', label: '🗑️ Delete Target', x: 516, y: 442, w: 224, h: 66 },
  { id: 'exit-vr', label: '🚪 Exit VR', x: 756, y: 442, w: 232, h: 66 },
];

function redrawVrBoard(hoverId = null) {
  const ctx = vrBoardCtx;
  ctx.clearRect(0, 0, 1024, 640);

  // Panel background
  ctx.fillStyle = 'rgba(8, 14, 18, 0.92)';
  roundRect(ctx, 8, 8, 1008, 624, 28);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2ce8c4';
  ctx.stroke();

  // Header
  ctx.fillStyle = '#2ce8c4';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`MODELSTUDIO VR · ${state.project.toUpperCase()} (${state.world.biome})`, 36, 58);

  const pt = state.pin?.point ?? state.pointer.hitPoint;
  ctx.fillStyle = '#f5b942';
  ctx.font = '22px monospace';
  ctx.fillText(
    `📍 Right There: (${pt.map((n) => Number(n).toFixed(1)).join(', ')})   🎯 Target: ${state.pointer.hitObjectName ?? 'ground'}`,
    36,
    102,
  );

  ctx.fillStyle = state.recording ? '#ff7b7b' : '#b8ded4';
  ctx.font = '21px sans-serif';
  const statusMsg = state.recording
    ? '🔴 Listening… speak now (e.g. "make this a hayfield and put a green barn right there")'
    : state.busy
      ? '⏳ Building in 3D world…'
      : state.lastStatusText;
  ctx.fillText(statusMsg.slice(0, 78), 36, 142);

  for (const btn of VR_BOARD_BUTTONS) {
    const isHover = hoverId === btn.id;
    const isRec = btn.id === 'speak' && state.recording;
    ctx.fillStyle = isRec
      ? '#c93838'
      : btn.accent
        ? (isHover ? '#48ffdc' : '#2ce8c4')
        : (isHover ? 'rgba(44, 232, 196, 0.32)' : 'rgba(255, 255, 255, 0.09)');
    roundRect(ctx, btn.x, btn.y, btn.w, btn.h, 14);
    ctx.fill();
    ctx.strokeStyle = isHover ? '#ffffff' : 'rgba(44, 232, 196, 0.38)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = btn.accent && !isRec ? '#041411' : '#eefcf8';
    ctx.font = 'bold 23px sans-serif';
    ctx.fillText(btn.id === 'speak' && state.recording ? '⏹ Stop & Run' : btn.label, btn.x + 18, btn.y + 44);
  }

  if (state.lastReplyText) {
    ctx.fillStyle = 'rgba(44, 232, 196, 0.14)';
    roundRect(ctx, 36, 530, 952, 76, 12);
    ctx.fill();
    ctx.fillStyle = '#d9fff5';
    ctx.font = '21px sans-serif';
    ctx.fillText(`AI: ${state.lastReplyText.slice(0, 82)}`, 54, 576);
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

function summonVrHudInFront() {
  const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const localPos = new THREE.Vector3();
  const localQuat = new THREE.Quaternion();
  xrCam.getWorldPosition(localPos);
  xrCam.getWorldQuaternion(localQuat);
  playerRig.worldToLocal(localPos);

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
  forward.normalize();

  vrBoardMesh.position.copy(localPos).addScaledVector(forward, 1.35);
  vrBoardMesh.position.y = Math.max(0.95, localPos.y - 0.18);
  vrBoardMesh.lookAt(playerRig.localToWorld(localPos.clone()));
  vrBoardMesh.visible = true;
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
    redrawVrBoard();
  } catch (err) {
    console.warn('[vr-sync]', err);
  }
}

// --- Raycasting & Spatial Pinning -----------------------------------------

const raycaster = new THREE.Raycaster();
const screenNdc = new THREE.Vector2(0, -0.1);
const tempMatrix = new THREE.Matrix4();

function raycastFromRay(originVec, dirVec, handLabel = 'right') {
  raycaster.set(originVec, dirVec);
  raycaster.far = 160;

  // Check 3D VR Board first when visible in VR
  if (vrBoardMesh.visible && renderer.xr.isPresenting) {
    const boardHit = raycaster.intersectObject(vrBoardMesh, false)[0];
    if (boardHit && boardHit.uv) {
      const px = boardHit.uv.x * 1024;
      const py = (1 - boardHit.uv.y) * 640;
      const hovered = VR_BOARD_BUTTONS.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      redrawVrBoard(hovered?.id ?? null);
      return { boardHit, hoveredButton: hovered ?? null, distance: boardHit.distance };
    }
  }

  const targets = [...objectsGroup.children];
  if (terrainMesh) targets.push(terrainMesh);
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const hit = hits[0];
    const isTerrain = hit.object === terrainMesh;
    const p = hit.point;
    const n = hit.face?.normal ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
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
    updatePointerHud();
    return { worldHit: hit, distance: hit.distance };
  }
  hoverReticle.visible = false;
  return null;
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

function onVrSelect(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
  const res = raycastFromRay(origin, dir, 'vr-controller');
  if (res?.boardHit && res.hoveredButton) {
    handleVrBoardAction(res.hoveredButton.id);
    return;
  }
  pinCurrentSpot();
}

async function handleVrBoardAction(id) {
  if (id === 'speak') {
    toggleVoiceCapture();
  } else if (id === 'pin') {
    pinCurrentSpot();
  } else if (id === 'undo') {
    await submitSpatialPrompt('undo');
  } else if (id === 'exit-vr') {
    renderer.xr.getSession()?.end();
  } else if (id.startsWith('cmd:')) {
    await submitSpatialPrompt(id.slice(4));
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

// --- Desktop Controls (Mouse Look + Click-to-Pin + WASD Walk) -------------

let draggingLook = false;
let pointerDownPos = [0, 0];

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting) return;
  draggingLook = true;
  pointerDownPos = [e.clientX, e.clientY];
});

window.addEventListener('pointermove', (e) => {
  if (renderer.xr.isPresenting) return;
  screenNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  screenNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;

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
  if (moved < 6 && e.target === renderer.domElement) {
    raycaster.setFromCamera(screenNdc, camera);
    raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
    pinCurrentSpot();
  }
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
  state.keys.add(e.code);
});
window.addEventListener('keyup', (e) => state.keys.delete(e.code));

// --- Quest Touch Plus Thumbstick Locomotion, Snap-Turn & Button Shortcuts -

let snapTurnCooldown = 0;
let teleportCooldown = 0;
const prevButtons = new Map();

function updateVrGamepads(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  snapTurnCooldown = Math.max(0, snapTurnCooldown - dt);
  teleportCooldown = Math.max(0, teleportCooldown - dt);

  for (const source of session.inputSources) {
    const gp = source.gamepad;
    if (!gp) continue;
    const hand = source.handedness || 'right';
    const axX = gp.axes[2] ?? gp.axes[0] ?? 0;
    const axY = gp.axes[3] ?? gp.axes[1] ?? 0;

    if (hand === 'left') {
      // Smooth locomotion along head horizontal yaw
      if (Math.hypot(axX, axY) > 0.16) {
        const xrCam = renderer.xr.getCamera();
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3(-forward.z, 0, forward.x);
        const speed = 4.6 * dt;
        playerRig.position.addScaledVector(forward, -axY * speed);
        playerRig.position.addScaledVector(right, axX * speed);
        playerRig.position.y = terrainHeightAt(state.world, playerRig.position.x, playerRig.position.z);
      }
    } else {
      // Right stick: snap turn (left/right) + push forward to teleport
      if (Math.abs(axX) > 0.68 && snapTurnCooldown <= 0) {
        playerRig.rotation.y -= Math.sign(axX) * (30 * DEG);
        snapTurnCooldown = 0.32;
      }
      if (axY < -0.78 && teleportCooldown <= 0 && state.pointer.hitKind === 'ground') {
        const [tx, ty, tz] = state.pointer.hitPoint;
        playerRig.position.set(tx, ty, tz);
        teleportCooldown = 0.48;
      }
    }

    // Button edge detection: button[4] = A/X (Voice), button[5] = B/Y (VR Menu)
    gp.buttons.forEach((btn, idx) => {
      const key = `${hand}:${idx}`;
      const wasPressed = prevButtons.get(key) || false;
      if (btn.pressed && !wasPressed) {
        if (idx === 4) toggleVoiceCapture();
        if (idx === 5) {
          if (vrBoardMesh.visible) vrBoardMesh.visible = false;
          else summonVrHudInFront();
        }
      }
      prevButtons.set(key, btn.pressed);
    });
  }
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
    const speed = 5.4 * sprint * dt;
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
  const session = await navigator.xr.requestSession(mode, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
  });
  state.inVR = true;
  state.inAR = mode === 'immersive-ar';
  state.worldSignature = ''; // refresh sky/floor visibility for VR vs AR passthrough
  rebuildWorldEnvironment(state.world);

  session.addEventListener('end', () => {
    state.inVR = false;
    state.inAR = false;
    vrBoardMesh.visible = false;
    state.worldSignature = '';
    rebuildWorldEnvironment(state.world);
    $('#btn-enter-vr').textContent = 'Enter VR (Quest / WebXR)';
  });

  await renderer.xr.setSession(session);
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
    const active = controllers[activeControllerIdx] ?? controllers[0];
    if (active) {
      tempMatrix.identity().extractRotation(active.controller.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(active.controller.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
      const hit = raycastFromRay(origin, dir, activeControllerIdx === 0 ? 'right' : 'left');
      active.rayLine.scale.z = hit?.distance ?? 20;
    }
    pushVrTelemetry();
  } else {
    updateDesktopMovement(dt);
    raycaster.setFromCamera(screenNdc, camera);
    raycastFromRay(raycaster.ray.origin, raycaster.ray.direction, 'screen');
    pushVrTelemetry();
  }

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
  const btn = e.target.closest('button[data-say]');
  if (!btn) return;
  submitSpatialPrompt(btn.dataset.say);
});

$('#btn-ai-drawer').addEventListener('click', () => $('#ai-drawer').classList.toggle('hidden'));
$('#btn-close-drawer').addEventListener('click', () => $('#ai-drawer').classList.add('hidden'));
$('#chk-tts').addEventListener('change', (e) => { state.ttsEnabled = e.target.checked; });

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

await setupWebXrButtons();
await populateProjectsAndAi();
await syncWorld({ force: true });
redrawVrBoard();
