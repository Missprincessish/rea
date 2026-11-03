// glTF 2.0 / GLB import and export built on @gltf-transform.
//
// Import flattens the scene into ModelStudio project objects (geometry +
// material + transform), skeletons, rig bindings and animation clips.
// Export rebuilds a spec-compliant glTF with skins and animations.
import { Document, NodeIO, Accessor, ImageUtils } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength, KHRTextureTransform } from '@gltf-transform/extensions';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './util.mjs';
import { computeNormals, triangleCount, vertexCount, boundingBox, makeGeometry } from './geometry.mjs';
import { worldPositionsOf } from './rigging.mjs';

const IO_OPTIONS = [KHRMaterialsEmissiveStrength, KHRTextureTransform];

export function nodeIO() {
  const io = new NodeIO();
  // registerExtensions takes a rest parameter, not an options object.
  return IO_OPTIONS.length ? io.registerExtensions(IO_OPTIONS) : io;
}

function isGlb(bytes) {
  const view = new Uint8Array(bytes);
  return view.length >= 12 && String.fromCharCode(view[0], view[1], view[2], view[3]) === 'glTF';
}

// --- import -----------------------------------------------------------------

/**
 * Parse a glTF/GLB buffer into an intermediate scene description.
 * @returns {{objects: Array, skeletons: Array, animations: Array, diagnostics: object}}
 */
export async function readGltf(bytes, { sourceName = 'import' } = {}) {
  const io = nodeIO();
  let doc;
  try {
    doc = isGlb(bytes) ? await io.readBinary(new Uint8Array(bytes)) : await io.readJSON({ json: JSON.parse(Buffer.from(bytes).toString('utf8')), resources: {} });
  } catch (error) {
    fail('import_failed', `Could not parse glTF: ${error.message}`, { status: 422 });
  }
  const root = doc.getRoot();
  const textures = new Map();
  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const mime = texture.getMimeType() ?? 'image/png';
    textures.set(texture, { mimeType: mime, data: Buffer.from(image) });
  }
  const materials = new Map();
  for (const material of root.listMaterials()) {
    const baseTextureProperty = material.getBaseColorTexture();
    const textureEntry = baseTextureProperty ? textures.get(baseTextureProperty) : null;
    materials.set(material, {
      name: material.getName() || 'Material',
      baseColorFactor: material.getBaseColorFactor(),
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      emissiveFactor: material.getEmissiveFactor(),
      alphaMode: material.getAlphaMode(),
      doubleSided: material.getDoubleSided(),
      texture: textureEntry ?? null,
    });
  }

  const objects = [];
  const skeletons = [];
  const diagnostics = { flatScene: true, nodes: root.listNodes().length, meshes: root.listMeshes().length };

  // world matrices
  const worldMatrix = new Map();
  const computeWorld = (node, parentMatrix) => {
    const local = node.getMatrix();
    const m = parentMatrix ? multiply(parentMatrix, local) : local.slice();
    worldMatrix.set(node, m);
    for (const child of node.listChildren()) computeWorld(child, m);
  };
  for (const node of root.listNodes()) {
    if (!node.getParentNode()) computeWorld(node, null);
  }

  const skeletonForSkin = new Map();
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints();
    const nodeMap = {};
    const jointOrder = [];
    joints.forEach((joint, index) => {
      const id = `b${index}`;
      nodeMap[id] = {
        id,
        name: joint.getName() || `joint_${index}`,
        parent: null,
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        _source: joint,
      };
      jointOrder.push(id);
    });
    joints.forEach((joint, index) => {
      const parentJoint = joints.find((j) => j.listChildren().includes(joint));
      if (parentJoint) {
        const parentIndex = joints.indexOf(parentJoint);
        nodeMap[`b${index}`].parent = `b${parentIndex}`;
        const worldM = worldMatrix.get(joint) ?? joint.getMatrix();
        const parentM = worldMatrix.get(parentJoint) ?? parentJoint.getMatrix();
        const local = multiply(invert(parentM), worldM);
        const decomposed = decompose(local);
        nodeMap[`b${index}`].translation = decomposed.translation;
        nodeMap[`b${index}`].rotation = decomposed.rotation;
        nodeMap[`b${index}`].scale = decomposed.scale;
      } else {
        nodeMap[`b${index}`].translation = joint.getTranslation();
        nodeMap[`b${index}`].rotation = joint.getRotation();
      }
    });
    const cleanNodes = {};
    for (const [key, value] of Object.entries(nodeMap)) {
      const { _source, ...rest } = value;
      void _source;
      cleanNodes[key] = rest;
    }
    const skeleton = {
      name: skin.getName() || `Skeleton_${skeletons.length + 1}`,
      nodes: cleanNodes,
      jointOrder,
      sourceSkin: skin,
      sourceJoints: joints,
      kind: joints.length > 8 ? 'humanoid' : 'custom',
    };
    skeletons.push(skeleton);
    skeletonForSkin.set(skin, skeleton);
  }

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const indicesAttr = primitive.getIndices();
      const positions = new Float32Array(position.getCount() * 3);
      const vector = [];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, vector);
        positions[i * 3] = vector[0];
        positions[i * 3 + 1] = vector[1];
        positions[i * 3 + 2] = vector[2];
      }
      const indices = indicesAttr
        ? Uint32Array.from(indicesAttr.getArray() ?? flattenIndexAccessor(indicesAttr))
        : new Uint32Array(Array.from({ length: position.getCount() }, (_, i) => i));
      const uvAttr = primitive.getAttribute('TEXCOORD_0');
      const uvs = new Float32Array(position.getCount() * 2);
      if (uvAttr) {
        for (let i = 0; i < uvAttr.getCount(); i += 1) {
          uvAttr.getElement(i, vector);
          uvs[i * 2] = vector[0];
          uvs[i * 2 + 1] = vector[1];
        }
      }
      const jointsAttr = primitive.getAttribute('JOINTS_0');
      const weightsAttr = primitive.getAttribute('WEIGHTS_0');
      const joints = new Uint16Array(position.getCount() * 4);
      const weights = new Float32Array(position.getCount() * 4);
      if (jointsAttr && weightsAttr) {
        for (let i = 0; i < position.getCount(); i += 1) {
          jointsAttr.getElement(i, vector);
          for (let k = 0; k < 4; k += 1) joints[i * 4 + k] = vector[k];
          weightsAttr.getElement(i, vector);
          for (let k = 0; k < 4; k += 1) weights[i * 4 + k] = vector[k];
        }
      }
      let normals = new Float32Array(0);
      const normalAttr = primitive.getAttribute('NORMAL');
      if (normalAttr) {
        normals = new Float32Array(position.getCount() * 3);
        for (let i = 0; i < normalAttr.getCount(); i += 1) {
          normalAttr.getElement(i, vector);
          normals[i * 3] = vector[0];
          normals[i * 3 + 1] = vector[1];
          normals[i * 3 + 2] = vector[2];
        }
      } else {
        normals = computeNormals(positions, indices);
      }
      const geometry = {
        positions,
        indices,
        normals,
        uvs,
        joints: jointsAttr && weightsAttr ? joints : new Uint16Array(0),
        weights: jointsAttr && weightsAttr ? weights : new Float32Array(0),
      };
      const material = materials.get(primitive.getMaterial()) ?? null;
      const world = worldMatrix.get(node) ?? node.getMatrix();
      const decomposed = decompose(world);
      const skin = node.getSkin();
      objects.push({
        name: node.getName() || primitive.getMaterial()?.getName() || mesh.getName() || `object_${objects.length + 1}`,
        geometry,
        transform: {
          translation: decomposed.translation,
          rotation: decomposed.rotation,
          scale: decomposed.scale,
        },
        material,
        skinIndex: skin ? skeletons.indexOf(skeletonForSkin.get(skin)) : null,
        sourceNodeName: node.getName(),
      });
    }
  }

  // animations
  const animations = [];
  for (const animation of root.listAnimations()) {
    const channels = [];
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler();
      if (!sampler) continue;
      const target = channel.getTargetNode();
      const input = sampler.getInput();
      const output = sampler.getOutput();
      if (!target || !input || !output) continue;
      const times = [];
      const vec = [];
      for (let i = 0; i < input.getCount(); i += 1) {
        input.getElement(i, vec);
        times.push(vec[0]);
      }
      const values = [];
      for (let i = 0; i < output.getCount(); i += 1) {
        output.getElement(i, vec);
        values.push(vec.slice());
      }
      const skeleton = skeletons.find((s) => s.sourceJoints?.includes(target));
      const jointIndex = skeleton ? skeleton.sourceJoints.indexOf(target) : -1;
      channels.push({
        track: {
          bone: target.getName() || 'unknown',
          jointId: jointIndex >= 0 ? skeleton.jointOrder[jointIndex] : null,
          path: channel.getTargetPath(),
          keys: times.map((time, i) => ({ time, value: values[i] })),
        },
        skeletonIndex: skeleton ? skeletons.indexOf(skeleton) : null,
      });
    }
    if (!channels.length) continue;
    const durations = channels.flatMap((c) => c.track.keys.map((k) => k.time));
    animations.push({
      name: animation.getName() || `clip_${animations.length + 1}`,
      duration: Math.max(...durations, 0),
      loop: true,
      tracks: channels.map((c) => c.track),
      skeletonIndex: channels[0].skeletonIndex,
    });
  }

  if (objects.length === 0) {
    fail('import_empty', 'The file contains no mesh primitives with positions', { status: 422 });
  }
  diagnostics.triangles = objects.reduce((s, o) => s + triangleCount(o.geometry), 0);
  for (const skeleton of skeletons) {
    delete skeleton.sourceSkin;
    delete skeleton.sourceJoints;
  }
  return { objects, skeletons, animations, diagnostics, sourceName };
}

function flattenIndexAccessor(accessor) {
  const out = new Uint32Array(accessor.getCount());
  const vec = [];
  for (let i = 0; i < accessor.getCount(); i += 1) {
    accessor.getElement(i, vec);
    out[i] = vec[0];
  }
  return out;
}

// --- export -----------------------------------------------------------------

/**
 * Build a glTF document from project objects.
 * @returns {Promise<{document: Document, buffer: Uint8Array}>}
 */
export async function writeGltf(project, objects, {
  binary = true,
  includeAnimations = true,
  embedTextures = true,
  yUp = true,
  draco = false,
} = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const root = doc.getRoot();
  const scene = doc.createScene('Scene');
  root.setDefaultScene(scene);

  const textureCache = new Map();
  const textureFor = (textureId) => {
    if (!textureId) return null;
    if (textureCache.has(textureId)) return textureCache.get(textureId);
    const record = project.data.textures[textureId];
    if (!record || !embedTextures) return null;
    const bytes = Buffer.from(record.data, 'base64');
    const texture = doc.createTexture(record.name).setImage(bytes).setMimeType(record.mimeType);
    textureCache.set(textureId, texture);
    return texture;
  };
  const materialCache = new Map();
  const materialFor = (materialId) => {
    const record = project.data.materials[materialId] ?? Object.values(project.data.materials)[0];
    if (!record) return null;
    if (materialCache.has(record.id)) return materialCache.get(record.id);
    const material = doc.createMaterial(record.name)
      .setBaseColorFactor(record.baseColorFactor ?? [1, 1, 1, 1])
      .setMetallicFactor(record.metallicFactor ?? 0)
      .setRoughnessFactor(record.roughnessFactor ?? 1)
      .setEmissiveFactor(record.emissiveFactor ?? [0, 0, 0])
      .setAlphaMode(record.alphaMode ?? 'OPAQUE')
      .setDoubleSided(record.doubleSided ?? true);
    const texture = textureFor(record.baseColorTexture);
    if (texture) material.setBaseColorTexture(texture);
    if (record.emissiveStrength && record.emissiveStrength !== 1) {
      const ext = doc.createExtension(KHRMaterialsEmissiveStrength).setRequired(false);
      const strength = ext.createEmissiveStrength().setEmissiveStrength(record.emissiveStrength);
      material.setExtension('KHR_materials_emissive_strength', strength);
    }
    materialCache.set(record.id, material);
    return material;
  };

  const nodeForSkeleton = new Map();
  for (const skeleton of Object.values(project.data.skeletons ?? {})) {
    const world = worldPositionsOf(skeleton.nodes, skeleton.jointOrder);
    const created = new Map();
    const build = (id) => {
      if (created.has(id)) return created.get(id);
      const record = skeleton.nodes[id];
      const parentWorld = record.parent ? world[record.parent] : [0, 0, 0];
      const node = doc.createNode(record.name)
        .setTranslation([
          world[id][0] - parentWorld[0],
          world[id][1] - parentWorld[1],
          world[id][2] - parentWorld[2],
        ]);
      if (record.rotation && record.rotation[3] !== 1) node.setRotation(record.rotation);
      created.set(id, node);
      if (record.parent) build(record.parent).addChild(node);
      return node;
    };
    const parentId = skeleton.rootParentId ?? null;
    for (const id of skeleton.jointOrder) build(id);
    const roots = skeleton.jointOrder.filter((id) => !skeleton.nodes[id].parent).map((id) => created.get(id));
    for (const r of roots) scene.addChild(r);
    nodeForSkeleton.set(skeleton.id, { created, roots, world, skeleton, parentId });
  }

  const skinCache = new Map();
  for (const object of objects) {
    const geometry = object.geometry ?? project.getGeometry(object);
    const vc = vertexCount(geometry);
    if (vc === 0) continue;
    const accessor = (array, type) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const attributes = {
      POSITION: accessor(new Float32Array(geometry.positions), 'VEC3'),
    };
    if (geometry.normals?.length === vc * 3) attributes.NORMAL = accessor(new Float32Array(geometry.normals), 'VEC3');
    if (geometry.uvs?.length === vc * 2) attributes.TEXCOORD_0 = accessor(new Float32Array(geometry.uvs), 'VEC2');
    const skeletonId = project.data.rigBindings?.[object.id] ?? object.skeletonId ?? null;
    const skeletonInfo = skeletonId ? nodeForSkeleton.get(skeletonId) : null;
    const hasWeights = geometry.weights?.length === vc * 4 && geometry.weights.some((w) => w > 0);
    if (skeletonInfo && hasWeights) {
      attributes.JOINTS_0 = doc.createAccessor().setType('VEC4').setArray(new Uint16Array(geometry.joints)).setBuffer(buffer);
      attributes.WEIGHTS_0 = doc.createAccessor().setType('VEC4').setArray(new Float32Array(geometry.weights)).setBuffer(buffer);
    }
    const indices = geometry.indices.length
      ? doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geometry.indices)).setBuffer(buffer)
      : null;
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', attributes.POSITION)
      .setIndices(indices);
    if (attributes.NORMAL) primitive.setAttribute('NORMAL', attributes.NORMAL);
    if (attributes.TEXCOORD_0) primitive.setAttribute('TEXCOORD_0', attributes.TEXCOORD_0);
    if (attributes.JOINTS_0) {
      primitive.setAttribute('JOINTS_0', attributes.JOINTS_0);
      primitive.setAttribute('WEIGHTS_0', attributes.WEIGHTS_0);
    }
    const material = materialFor(object.materialId);
    if (material) primitive.setMaterial(material);
    const mesh = doc.createMesh(object.name ?? 'mesh').addPrimitive(primitive);
    const node = doc.createNode(object.name ?? 'object').setMesh(mesh);
    const transform = object.transform ?? {};
    node.setTranslation(transform.translation ?? [0, 0, 0]);
    if (Array.isArray(transform.rotation)) {
      if (transform.rotation.length === 4 && transform.rotation[3] !== 1) {
        node.setRotation(transform.rotation);
      } else if (transform.rotation.length === 3 && (transform.rotation[0] || transform.rotation[1] || transform.rotation[2])) {
        const half = Math.PI / 360;
        const cx = Math.cos(transform.rotation[0] * half), sx = Math.sin(transform.rotation[0] * half);
        const cy = Math.cos(transform.rotation[1] * half), sy = Math.sin(transform.rotation[1] * half);
        const cz = Math.cos(transform.rotation[2] * half), sz = Math.sin(transform.rotation[2] * half);
        node.setRotation([
          sx * cy * cz - cx * sy * sz,
          cx * sy * cz + sx * cy * sz,
          cx * cy * sz - sx * sy * cz,
          cx * cy * cz + sx * sy * sz,
        ]);
      }
    }
    node.setScale(transform.scale ?? [1, 1, 1]);
    if (skeletonInfo && hasWeights) {
      let skin = skinCache.get(skeletonId);
      if (!skin) {
        skin = doc.createSkin(skeletonInfo.skeleton.name);
        for (const id of skeletonInfo.skeleton.jointOrder) skin.addJoint(skeletonInfo.created.get(id));
        const inverseBind = new Float32Array(skeletonInfo.skeleton.jointOrder.length * 16);
        skeletonInfo.skeleton.jointOrder.forEach((id, index) => {
          const p = skeletonInfo.world[id];
          inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], index * 16);
        });
        const ibm = doc.createAccessor().setType('MAT4').setArray(inverseBind).setBuffer(buffer);
        skin.setInverseBindMatrices(ibm);
        const rootId = skeletonInfo.skeleton.jointOrder.find((id) => !skeletonInfo.skeleton.nodes[id].parent);
        if (rootId) skin.setSkeleton(skeletonInfo.created.get(rootId));
        skinCache.set(skeletonId, skin);
      }
      node.setSkin(skin);
    }
    scene.addChild(node);
  }

  if (includeAnimations) {
    for (const animation of Object.values(project.data.animations ?? {})) {
      const skeletonId = animation.skeletonId ?? Object.keys(project.data.skeletons ?? {})[0];
      const skeletonInfo = nodeForSkeleton.get(skeletonId);
      if (!skeletonInfo) continue;
      const gltfAnimation = doc.createAnimation(animation.name ?? 'clip');
      for (const track of animation.tracks) {
        const target = skeletonInfo.created.get(track.jointId);
        if (!target) continue;
        const times = track.keys.map((k) => k.time);
        const flat = track.keys.flatMap((k) => k.value);
        const input = doc.createAccessor()
          .setType('SCALAR')
          .setArray(new Float32Array(times))
          .setBuffer(buffer);
        const output = doc.createAccessor()
          .setType(track.path === 'rotation' ? 'VEC4' : 'VEC3')
          .setArray(new Float32Array(flat))
          .setBuffer(buffer);
        const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
        gltfAnimation.addSampler(sampler).addChannel(
          doc.createAnimationChannel().setTargetNode(target).setTargetPath(track.path).setSampler(sampler),
        );
      }
    }
  }

  const io = nodeIO();
  const glb = await io.writeBinary(doc);
  return { document: doc, buffer: glb, nodes: scene.listChildren().length };
}

/** Import a glTF/GLB file into an existing project (adds objects). */
export async function importIntoProject(project, bytes, { namePrefix = '', applyMaterials = true, sourceName = '' } = {}) {
  const parsed = await readGltf(bytes, { sourceName });
  const importId = `imp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const materialIdFor = new Map();
  for (const object of parsed.objects) {
    if (!applyMaterials || !object.material) continue;
    const record = object.material;
    let materialId = materialIdFor.get(record);
    if (!materialId) {
      const texture = record.texture
        ? project.addTexture({
          name: `${record.name}_baseColor`,
          mimeType: record.texture.mimeType,
          data: record.texture.data,
        })
        : null;
      const material = project.addMaterial({
        name: record.name,
        baseColorFactor: record.baseColorFactor,
        metallicFactor: record.metallicFactor,
        roughnessFactor: record.roughnessFactor,
        emissiveFactor: record.emissiveFactor,
        alphaMode: record.alphaMode,
        doubleSided: record.doubleSided,
        baseColorTexture: texture?.id ?? null,
      });
      materialId = material.id;
      materialIdFor.set(record, materialId);
    }
  }

  const skeletonIds = [];
  parsed.skeletons.forEach((skeleton, index) => {
    const record = project.addSkeleton({
      name: skeleton.name || `${namePrefix}Skeleton_${index + 1}`,
      nodes: skeleton.nodes,
      jointOrder: skeleton.jointOrder,
    });
    skeletonIds.push(record.id);
  });

  const created = [];
  for (const object of parsed.objects) {
    const geometry = makeGeometry(
      object.geometry.positions,
      object.geometry.indices,
      { uvs: object.geometry.uvs.length ? object.geometry.uvs : null, normals: object.geometry.normals.length ? object.geometry.normals : null },
    );
    if (object.geometry.joints.length && object.geometry.weights.length) {
      geometry.joints = new Uint16Array(object.geometry.joints);
      geometry.weights = new Float32Array(object.geometry.weights);
    }
    const record = project.addObject({
      name: `${namePrefix}${object.name}`,
      geometry,
      materialId: applyMaterials && object.material ? materialIdFor.get(object.material) : undefined,
      transform: object.transform,
      metadata: { importedFrom: parsed.sourceName || 'gltf', importId },
    });
    if (object.skinIndex !== null && object.skinIndex !== undefined && skeletonIds[object.skinIndex]) {
      project.data.rigBindings[record.id] = skeletonIds[object.skinIndex];
    }
    created.push({ object: record, geometry });
  }

  let animationCount = 0;
  for (const animation of parsed.animations) {
    const skeletonId = skeletonIds[animation.skeletonIndex ?? 0] ?? skeletonIds[0];
    if (!skeletonId) continue;
    const id = `anim_${Math.random().toString(36).slice(2, 10)}`;
    project.data.animations[id] = {
      id,
      name: animation.name,
      duration: animation.duration,
      loop: animation.loop,
      skeletonId,
      tracks: animation.tracks,
    };
    animationCount += 1;
  }

  return {
    objects: created.map((c) => project.data.objects[c.object.id]),
    skeletonIds,
    animationCount,
    diagnostics: parsed.diagnostics,
  };
}

// --- matrix helpers ---------------------------------------------------------

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function invert(m) {
  const out = new Array(16).fill(0);
  out[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  out[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  out[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  out[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  out[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  out[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  out[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  out[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  out[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  out[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  out[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  out[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  out[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  out[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  out[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  out[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * out[0] + m[1] * out[4] + m[2] * out[8] + m[3] * out[12];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return out.map((v) => v / det);
}

export function decompose(m) {
  // column-major 4x4
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = [
    m[0] / (sx || 1), m[1] / (sx || 1), m[2] / (sx || 1),
    m[4] / (sy || 1), m[5] / (sy || 1), m[6] / (sy || 1),
    m[8] / (sz || 1), m[9] / (sz || 1), m[10] / (sz || 1),
  ];
  const trace = r[0] + r[4] + r[8];
  let rotation;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    rotation = [(r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s, s / 4];
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    rotation = [s / 4, (r[1] + r[3]) / s, (r[2] + r[6]) / s, (r[7] - r[5]) / s];
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    rotation = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[2] - r[6]) / s];
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    rotation = [(r[2] + r[6]) / s, (r[5] + r[7]) / s, s / 4, (r[3] - r[1]) / s];
  }
  return {
    translation: [m[12], m[13], m[14]],
    rotation,
    scale: [sx, sy, sz],
  };
}

export async function readGltfFile(file) {
  const bytes = await fs.readFile(file);
  return readGltf(bytes, { sourceName: path.basename(file) });
}

export { boundingBox, Accessor, ImageUtils };
