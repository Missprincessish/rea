// three.js viewport: scene assembly from project state, object picking,
// transform gizmos, the sculpt brush and the texture-paint brush.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const ACCENT = 0x2ce8c4;

function decodeF32(b64) {
  if (!b64) return new Float32Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function decodeU16(b64) {
  if (!b64) return new Uint16Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Uint16Array(bytes.buffer);
}

function decodeU32(b64) {
  if (!b64) return new Uint32Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Uint32Array(bytes.buffer);
}

export function geometryFromPayload(payload) {
  const positions = decodeF32(payload.positions);
  const indices = decodeU32(payload.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const normals = decodeF32(payload.normals);
  if (normals.length === positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  const uvs = decodeF32(payload.uvs);
  if (uvs.length) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const joints = decodeU16(payload.joints);
  const weights = decodeF32(payload.weights);
  if (joints.length && weights.length) {
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  }
  if (indices.length) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!normals.length) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export class Viewport {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x07090b, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090b);
    this.scene.fog = new THREE.Fog(0x07090b, 6, 26);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.02, 200);
    this.camera.position.set(2.4, 1.9, 3.1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 0.9, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.setupLights();
    this.setupGrid();

    this.objectsGroup = new THREE.Group();
    this.scene.add(this.objectsGroup);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.85);
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !event.value;
      if (!event.value && this.onTransformCommit) {
        this.onTransformCommit(this.gizmo.object);
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.onTransformChange && this.gizmo.object) this.onTransformChange(this.gizmo.object);
    });
    this.scene.add(this.gizmo);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.meshes = new Map();
    this.skeletonHelpers = new THREE.Group();
    this.helpers.add(this.skeletonHelpers);
    this.brushHelper = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.brushHelper.visible = false;
    this.scene.add(this.brushHelper);
    this.paintMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xc07bff, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.paintMarker.visible = false;
    this.scene.add(this.paintMarker);

    this.mode = 'select';
    this.selection = null;
    this.onPointerDown = null;
    this.onPointerMove = null;
    this.onPointerUp = null;

    this.renderer.domElement.addEventListener('pointerdown', (e) => this.handlePointer('down', e));
    this.renderer.domElement.addEventListener('pointermove', (e) => this.handlePointer('move', e));
    window.addEventListener('pointerup', (e) => this.handlePointer('up', e));

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0x2ce8c4, 0x150b23, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(3.2, 5.4, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 22;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8a5cff, 1.35);
    rim.position.set(-3.4, 2.2, -3.6);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0x2ce8c4, 0.55);
    fill.position.set(-1.6, 0.9, 3.4);
    this.scene.add(fill);
  }

  setupGrid() {
    const grid = new THREE.GridHelper(20, 40, 0x1d3a3a, 0x14201f);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.position.y = 0.001;
    this.scene.add(grid);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3.4, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b1012, roughness: 0.95, metalness: 0 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.receiveShadow = true;
    disc.position.y = 0;
    this.scene.add(disc);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.updateBrushHelper();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  setMode(mode) {
    this.mode = mode;
    this.gizmo.enabled = mode === 'select' || mode === 'transform';
    if (mode !== 'select' && mode !== 'transform') this.gizmo.detach();
    this.brushHelper.visible = false;
    this.paintMarker.visible = false;
    if (mode === 'sculpt') this.controls.enablePan = false;
    else this.controls.enablePan = true;
  }

  setGizmoMode(mode) {
    if (['translate', 'rotate', 'scale'].includes(mode)) this.gizmo.setMode(mode);
  }

  attachGizmo(object) {
    if (!object) {
      this.gizmo.detach();
      return;
    }
    this.gizmo.attach(object);
  }

  select(mesh) {
    this.selection = mesh;
    this.highlight(mesh);
    if (mesh && (this.mode === 'select' || this.mode === 'transform')) this.attachGizmo(mesh);
    else this.gizmo.detach();
  }

  highlight(selected) {
    for (const [, mesh] of this.meshes) {
      const material = mesh.material;
      if (!material) continue;
      if (mesh === selected) {
        material.emissive?.setHex(0x0f5f52);
        material.emissiveIntensity = 0.55;
      } else {
        material.emissive?.setHex(material.userData.emissive ?? 0x000000);
        material.emissiveIntensity = 1;
      }
    }
  }

  /**
   * Rebuild the scene objects from a project snapshot.
   * Textures are loaded from the API.
   */
  async sync(state, projectRef, { api, keepSelection = true } = {}) {
    const previousSelection = this.selection?.userData?.id ?? null;
    for (const child of [...this.objectsGroup.children]) this.objectsGroup.remove(child);
    this.meshes.clear();
    this.gizmo.detach();

    for (const object of state.objects) {
      if (!object.geometry?.positions) continue;
      const geometry = geometryFromPayload(object.geometry);
      const materialRecord = state.materials.find((m) => m.id === object.materialId) ?? state.materials[0] ?? {};
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().fromArray(materialRecord.baseColorFactor?.slice(0, 3) ?? [0.8, 0.8, 0.8]),
        metalness: materialRecord.metallicFactor ?? 0.05,
        roughness: materialRecord.roughnessFactor ?? 0.6,
        flatShading: false,
        side: materialRecord.doubleSided === false ? THREE.FrontSide : THREE.DoubleSide,
        transparent: materialRecord.alphaMode === 'BLEND',
        opacity: materialRecord.baseColorFactor?.[3] ?? 1,
      });
      material.emissive = new THREE.Color().fromArray(materialRecord.emissiveFactor ?? [0, 0, 0]);
      material.userData.emissive = material.emissive.getHex();
      if (materialRecord.baseColorTexture) {
        const texture = await new THREE.TextureLoader().loadAsync(api.textureUrl(projectRef, materialRecord.baseColorTexture));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.anisotropy = 4;
        material.map = texture;
        material.needsUpdate = true;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { id: object.id, name: object.name, skeletonId: object.skeletonId, object };
      const transform = object.transform ?? {};
      mesh.position.fromArray(transform.translation ?? [0, 0, 0]);
      if (Array.isArray(transform.rotation)) {
        if (transform.rotation.length === 4) {
          mesh.quaternion.fromArray(transform.rotation);
        } else if (transform.rotation.length === 3) {
          const deg = Math.PI / 180;
          mesh.rotation.set(transform.rotation[0] * deg, transform.rotation[1] * deg, transform.rotation[2] * deg);
        }
      }
      mesh.scale.fromArray(transform.scale ?? [1, 1, 1]);
      this.objectsGroup.add(mesh);
      this.meshes.set(object.id, mesh);
    }

    if (keepSelection && previousSelection && this.meshes.has(previousSelection)) {
      this.select(this.meshes.get(previousSelection));
    } else {
      this.selection = null;
      this.gizmo.detach();
    }
    this.state = state;
    this.updateSkeletonHelpers();
  }

  updateSkeletonHelpers() {
    for (const child of [...this.skeletonHelpers.children]) this.skeletonHelpers.remove(child);
    if (!this.state?.skeletons?.length) return;
    for (const skeleton of this.state.skeletons) {
      const positions = skeletonPositions(skeleton);
      const points = [];
      for (const node of Object.values(skeleton.nodes)) {
        if (!node.parent) continue;
        const a = positions[node.id];
        const b = positions[node.parent];
        if (a && b) points.push(new THREE.Vector3(...a), new THREE.Vector3(...b));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xc07bff, transparent: true, opacity: 0.85 }));
      this.skeletonHelpers.add(lines);
      for (const node of Object.values(skeleton.nodes)) {
        const pos = positions[node.id];
        if (!pos) continue;
        const joint = new THREE.Mesh(
          new THREE.SphereGeometry(0.014, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x2ce8c4 }),
        );
        joint.position.set(...pos);
        this.skeletonHelpers.add(joint);
      }
    }
  }

  setSkeletonVisible(visible) {
    this.skeletonHelpers.visible = visible;
  }

  focusOn(object) {
    const target = object ?? this.objectsGroup.children[0];
    if (!target) return;
    const box = new THREE.Box3().setFromObject(target);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.4);
    this.controls.target.copy(center);
    const direction = new THREE.Vector3(0.72, 0.52, 1).normalize();
    this.camera.position.copy(center.clone().add(direction.multiplyScalar(radius * 2.5)));
    this.camera.near = radius * 0.01;
    this.camera.far = radius * 80;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  frameAll() {
    this.focusOn(null);
  }

  screenToNdc(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return this.pointer;
  }

  pick(event, { onlySelected = false } = {}) {
    this.screenToNdc(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = onlySelected && this.selection ? [this.selection] : this.objectsGroup.children;
    const hits = this.raycaster.intersectObjects(targets, false);
    return hits[0] ?? null;
  }

  /** World position of a pointer hit, used for the sculpt brush. */
  worldPoint(event) {
    const hit = this.pick(event);
    return hit ? hit.point : null;
  }

  updateBrushHelper() {
    if (this.mode !== 'sculpt' || !this.lastPointer) return;
    const point = this.worldPoint(this.lastPointer);
    if (!point) {
      this.brushHelper.visible = false;
      return;
    }
    const radius = this.brushRadius ?? 0.12;
    this.brushHelper.position.copy(point);
    this.brushHelper.scale.setScalar(radius);
    this.brushHelper.visible = true;
  }

  handlePointer(kind, event) {
    if (this.mode === 'sculpt' || this.mode === 'paint') {
      this.lastPointer = kind === 'up' ? this.lastPointer : event;
      if (kind === 'move') this.updateBrushHelper();
    }
    if (kind === 'down') {
      if (this.mode === 'select' || this.mode === 'transform') {
        if (event.button === 0 && !this.gizmo.dragging) {
          const hit = this.pick(event);
          this.select(hit ? hit.object : null);
          if (this.onSelect) this.onSelect(hit ? hit.object : null);
        }
      }
      if (this.onPointerDown) this.onPointerDown(event, this.pick(event, { onlySelected: true }));
    }
    if (kind === 'move' && this.onPointerMove) this.onPointerMove(event, this.pick(event, { onlySelected: true }));
    if (kind === 'up' && this.onPointerUp) this.onPointerUp(event);
    if (kind === 'up' && this.mode === 'sculpt') this.brushHelper.visible = false;
  }

  setPaintMarker(visible, position, radius) {
    this.paintMarker.visible = visible;
    if (position) this.paintMarker.position.copy(position);
    if (radius) this.paintMarker.scale.setScalar(radius * 0.25);
  }

  async exportGlb() {
    const exporter = new GLTFExporter();
    return exporter.parseAsync(this.objectsGroup, { binary: true });
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

export function skeletonPositions(skeleton) {
  const out = {};
  const walk = (id) => {
    if (out[id]) return out[id];
    const node = skeleton.nodes[id];
    if (!node) return [0, 0, 0];
    const parent = node.parent ? walk(node.parent) : [0, 0, 0];
    const t = node.translation ?? [0, 0, 0];
    out[id] = [parent[0] + t[0], parent[1] + t[1], parent[2] + t[2]];
    return out[id];
  };
  for (const id of Object.keys(skeleton.nodes)) walk(id);
  return out;
}
