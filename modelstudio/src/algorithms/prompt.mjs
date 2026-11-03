// Structured prompt registry: turns a text prompt into a signed-distance-field
// scene, which is then meshed locally. This is the self-hosted generator.
//
// Design: an archetype builder receives (params, rng) and returns
//   { shape, material, parts }
// Prompt modifiers (size/aspect/colour/style words) are parsed generically so
// new archetypes automatically respect them.
import {
  sdf,
  smin,
  smoothUnion,
  subtract,
  translate,
  union,
  scaleShape,
} from './sdf.mjs';
import { fail, makeRandom, hashString } from '../core/util.mjs';

const DEG = Math.PI / 180;

function capsuleBetween(a, b, r) {
  return sdf.capsule(a, b, r);
}

function limb(a, b, r0 = null, r1 = null) {
  // taper by unioning two capsules when radii differ
  if (r0 == null || r1 == null || Math.abs(r0 - r1) < 1e-4) return sdf.capsule(a, b, r0 ?? r1 ?? 0.05);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return smoothUnion([sdf.capsule(a, mid, (r0 + r1) / 2), sdf.capsule(mid, b, r1)], 0.02);
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

const ARCHETYPES = {
  chair: {
    label: 'chair',
    tags: ['chair', 'stool', 'seat', 'furniture'],
    build: () => {
      const seatY = 0.45;
      const legs = [];
      for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
        legs.push(sdf.capsule([x, 0, z], [x, seatY, z], 0.028));
      }
      const seat = sdf.box(0.27, 0.03, 0.27, 0.012);
      const seatShape = translate(seat, [0, seatY, 0]);
      const back = translate(sdf.box(0.25, 0.26, 0.025, 0.015), [0, seatY + 0.27, -0.24]);
      return {
        shape: smoothUnion([...legs, seatShape, back], 0.012),
        material: { name: 'Wood', baseColorFactor: [0.45, 0.29, 0.17, 1], roughnessFactor: 0.55, metallicFactor: 0.0 },
        parts: [{ name: 'seat', shape: seatShape }, ...legs.map((l, i) => ({ name: `leg_${i + 1}`, shape: l }))],
      };
    },
  },

  table: {
    label: 'table',
    tags: ['table', 'desk', 'furniture'],
    build: (p) => {
      const h = p.height ?? 0.72;
      const w = p.width ?? 0.7;
      const legs = [[-w / 2, -w / 2], [w / 2, -w / 2], [-w / 2, w / 2], [w / 2, w / 2]].map(([x, z]) =>
        sdf.capsule([x, 0, z], [x, h, z], 0.03),
      );
      const top = translate(sdf.box(w / 2 + 0.04, 0.02, w / 2 + 0.04, 0.01), [0, h, 0]);
      return {
        shape: smoothUnion([...legs, top], 0.01),
        material: { name: 'Wood', baseColorFactor: [0.5, 0.34, 0.2, 1], roughnessFactor: 0.5 },
        parts: [{ name: 'top', shape: top }],
      };
    },
  },

  lamp: {
    label: 'lamp',
    tags: ['lamp', 'light', 'lantern'],
    build: () => {
      const base = translate(sdf.cylinder?.() ?? sdf.box(0.13, 0.02, 0.13, 0.01), [0, 0.02, 0]);
      const pole = sdf.capsule([0, 0.02, 0], [0, 0.62, 0], 0.018);
      const shade = translate(sdf.cone(0.3, 0.22), [0, 0.72, 0]);
      return {
        shape: union(base, pole, shade),
        material: { name: 'LampShade', baseColorFactor: [0.95, 0.9, 0.78, 1], roughnessFactor: 0.8, emissiveFactor: [0.6, 0.5, 0.3] },
        parts: [{ name: 'shade', shape: shade }],
      };
    },
  },

  vase: {
    label: 'vase',
    tags: ['vase', 'pot', 'urn', 'bowl'],
    build: () => {
      const body = smoothUnion([
        translate(sdf.sphere(0.16), [0, 0.18, 0]),
        translate(sdf.sphere(0.12), [0, 0.4, 0]),
        translate(sdf.ellipsoid(0.1, 0.16, 0.1), [0, 0.3, 0]),
      ], 0.06);
      const hollow = translate(sdf.ellipsoid(0.085, 0.3, 0.085), [0, 0.42, 0]);
      return {
        shape: subtract(body, hollow),
        material: { name: 'Ceramic', baseColorFactor: [0.82, 0.84, 0.86, 1], roughnessFactor: 0.25, metallicFactor: 0.02 },
        parts: [],
      };
    },
  },

  mug: {
    label: 'mug',
    tags: ['mug', 'cup', 'coffee'],
    build: () => {
      const body = translate(sdf.box(0.09, 0.11, 0.09, 0.02), [0, 0.11, 0]);
      const inner = translate(sdf.box(0.075, 0.1, 0.075, 0.015), [0, 0.125, 0]);
      const handle = translate(sdf.torus(0.055, 0.016), [0.1, 0.12, 0]);
      return {
        shape: union(subtract(body, inner), handle),
        material: { name: 'Ceramic', baseColorFactor: [0.92, 0.92, 0.94, 1], roughnessFactor: 0.3 },
        parts: [],
      };
    },
  },

  sword: {
    label: 'sword',
    tags: ['sword', 'blade', 'weapon', 'katana'],
    build: () => {
      const blade = translate(sdf.box(0.025, 0.42, 0.006, 0.004), [0, 0.52, 0]);
      const tip = translate(sdf.cone(0.12, 0.025), [0, 0.98, 0]);
      const guard = translate(sdf.box(0.11, 0.012, 0.02, 0.005), [0, 0.1, 0]);
      const grip = translate(sdf.box(0.018, 0.09, 0.018, 0.008), [0, 0.0, 0]);
      return {
        shape: union(blade, tip, guard, grip),
        material: { name: 'Steel', baseColorFactor: [0.75, 0.77, 0.8, 1], metallicFactor: 0.9, roughnessFactor: 0.18 },
        parts: [{ name: 'blade', shape: union(blade, tip) }, { name: 'guard', shape: guard }, { name: 'grip', shape: grip }],
      };
    },
  },

  shield: {
    label: 'shield',
    tags: ['shield', 'armor', 'armour'],
    build: () => {
      const dome = translate(sdf.sphere(0.3), [0, 0, 0]);
      const cut = translate(sdf.box(0.5, 0.5, 0.5, 0), [0, 0, 0.34]);
      const boss = translate(sdf.sphere(0.08), [0, 0, -0.27]);
      return {
        shape: union(subtract(dome, cut), boss),
        material: { name: 'PaintedSteel', baseColorFactor: [0.16, 0.32, 0.62, 1], metallicFactor: 0.55, roughnessFactor: 0.35 },
        parts: [],
      };
    },
  },

  tree: {
    label: 'tree',
    tags: ['tree', 'plant', 'foliage', 'oak', 'pine'],
    build: (p) => {
      const rng = p.rng;
      const trunk = sdf.capsule([0, 0, 0], [0, 0.7, 0], 0.07);
      const blobs = [];
      const count = p.pine ? 3 : 5;
      for (let i = 0; i < count; i += 1) {
        const r = 0.22 + rng() * 0.1;
        const a = rng() * Math.PI * 2;
        const d = p.pine ? 0.02 : 0.13;
        const y = 0.72 + i * 0.12 + rng() * 0.05;
        blobs.push(translate(sdf.sphere(r), [Math.cos(a) * d, y, Math.sin(a) * d]));
      }
      return {
        shape: smoothUnion([trunk, ...blobs], 0.05),
        material: { name: 'Foliage', baseColorFactor: [0.16, 0.42, 0.2, 1], roughnessFactor: 0.85 },
        parts: [{ name: 'trunk', shape: trunk }],
      };
    },
  },

  house: {
    label: 'house',
    tags: ['house', 'home', 'cabin', 'building'],
    build: () => {
      const walls = translate(sdf.box(0.3, 0.2, 0.25, 0.01), [0, 0.2, 0]);
      const roof = translate(sdf.cone(0.24, 0.34), [0, 0.44, 0]);
      const door = translate(sdf.box(0.06, 0.11, 0.02, 0.005), [0, 0.11, 0.25]);
      const windowA = translate(sdf.box(0.05, 0.05, 0.02, 0.004), [-0.16, 0.24, 0.25]);
      const windowB = translate(sdf.box(0.05, 0.05, 0.02, 0.004), [0.16, 0.24, 0.25]);
      return {
        shape: subtract(union(walls, roof), door, windowA, windowB),
        material: { name: 'Plaster', baseColorFactor: [0.86, 0.84, 0.78, 1], roughnessFactor: 0.7 },
        parts: [{ name: 'walls', shape: walls }, { name: 'roof', shape: roof }],
      };
    },
  },

  tower: {
    label: 'tower',
    tags: ['tower', 'castle', 'turret', 'fortress'],
    build: () => {
      const shaft = translate(sdf.box(0.18, 0.4, 0.18, 0.02), [0, 0.4, 0]);
      const roof = translate(sdf.cone(0.34, 0.22), [0, 0.97, 0]);
      const crenel = [];
      for (const [x, z] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) {
        crenel.push(translate(sdf.box(0.04, 0.05, 0.04, 0.005), [x, 0.83, z]));
      }
      return {
        shape: union(shaft, roof, ...crenel),
        material: { name: 'Stone', baseColorFactor: [0.55, 0.55, 0.58, 1], roughnessFactor: 0.85 },
        parts: [],
      };
    },
  },

  car: {
    label: 'car',
    tags: ['car', 'vehicle', 'auto', 'truck'],
    build: () => {
      const body = translate(sdf.box(0.42, 0.1, 0.2, 0.05), [0, 0.16, 0]);
      const cabin = translate(sdf.box(0.2, 0.09, 0.16, 0.045), [-0.03, 0.29, 0]);
      const wheels = [];
      for (const [x, z] of [[-0.26, -0.18], [0.26, -0.18], [-0.26, 0.18], [0.26, 0.18]]) {
        wheels.push(scaleShape(translate(sdf.torus(0.055, 0.028), [x, 0.062, z]), [1, 1, 1]));
      }
      return {
        shape: union(smoothUnion([body, cabin], 0.02), ...wheels),
        material: { name: 'CarPaint', baseColorFactor: [0.75, 0.1, 0.12, 1], roughnessFactor: 0.22, metallicFactor: 0.5 },
        parts: [{ name: 'body', shape: body }],
      };
    },
  },

  robot: {
    label: 'robot',
    tags: ['robot', 'mech', 'android', 'droid'],
    build: () => {
      const torso = translate(sdf.box(0.17, 0.2, 0.11, 0.02), [0, 0.62, 0]);
      const head = translate(sdf.box(0.11, 0.09, 0.1, 0.025), [0, 0.94, 0]);
      const eyeL = translate(sdf.sphere(0.022), [-0.04, 0.96, 0.1]);
      const eyeR = translate(sdf.sphere(0.022), [0.04, 0.96, 0.1]);
      const arms = [
        limb([-0.17, 0.76, 0], [-0.3, 0.56, 0], 0.045, 0.03),
        limb([0.17, 0.76, 0], [0.3, 0.56, 0], 0.045, 0.03),
      ];
      const legs = [
        limb([-0.08, 0.44, 0], [-0.09, 0.05, 0], 0.05, 0.045),
        limb([0.08, 0.44, 0], [0.09, 0.05, 0], 0.05, 0.045),
      ];
      return {
        shape: union(torso, head, ...arms, ...legs, eyeL, eyeR),
        material: { name: 'Chrome', baseColorFactor: [0.68, 0.7, 0.74, 1], metallicFactor: 0.85, roughnessFactor: 0.25 },
        parts: [{ name: 'head', shape: head }, { name: 'torso', shape: torso }],
      };
    },
  },

  character: {
    label: 'humanoid character',
    tags: [
      'character', 'human', 'person', 'woman', 'man', 'girl', 'boy', 'female', 'male',
      'warrior', 'hero', 'figure', 'avatar', 'body', 'humanoid',
    ],
    build: (p) => humanoid(p),
  },

  bust: {
    label: 'bust / head',
    tags: ['bust', 'head', 'portrait', 'face', 'sculpt'],
    build: (p) => {
      const head = translate(sdf.ellipsoid(0.11, 0.135, 0.12), [0, 0.13, 0]);
      const jaw = translate(sdf.ellipsoid(0.085, 0.08, 0.095), [0, 0.045, 0.01]);
      const neck = sdf.capsule([0, -0.06, 0], [0, 0.02, 0], 0.045);
      const shoulders = translate(sdf.ellipsoid(0.22, 0.07, 0.11), [0, -0.1, 0]);
      const nose = translate(sdf.capsule([0, 0.12, 0.11], [0, 0.1, 0.135], 0.015), [0, 0, 0]);
      const hair = p.hair === 'none' ? null : translate(sdf.ellipsoid(0.125, 0.13, 0.13), [0, 0.16, -0.02]);
      const base = smoothUnion([head, jaw, neck, shoulders, nose], 0.02);
      return {
        shape: hair ? smoothUnion([base, subtract(hair, head)], 0.01) : base,
        material: { name: 'Skin', baseColorFactor: [0.86, 0.7, 0.61, 1], roughnessFactor: 0.55 },
        parts: [{ name: 'head', shape: base }],
      };
    },
  },

  creature: {
    label: 'creature',
    tags: ['creature', 'monster', 'beast', 'animal', 'cat', 'dog', 'dragon', 'fox'],
    build: (p) => {
      const rng = p.rng;
      const body = translate(sdf.ellipsoid(0.24, 0.15, 0.14), [0, 0.3, 0]);
      const head = translate(sdf.ellipsoid(0.12, 0.1, 0.11), [0.25, 0.38, 0]);
      const snout = translate(sdf.ellipsoid(0.05, 0.04, 0.045), [0.35, 0.35, 0]);
      const legs = [[0.14, 0.1], [-0.14, 0.1], [0.14, -0.1], [-0.14, -0.1]].map(([x, z]) =>
        sdf.capsule([x, 0.14, z], [x, 0, z], 0.035),
      );
      const tail = sdf.capsule([-0.22, 0.34, 0], [-0.36, 0.46 + rng() * 0.06, 0], 0.03);
      const ears = [
        translate(sdf.cone(0.07, 0.035), [0.24, 0.48, 0.06]),
        translate(sdf.cone(0.07, 0.035), [0.24, 0.48, -0.06]),
      ];
      return {
        shape: smoothUnion([body, head, snout, ...legs, tail, ...ears], 0.04),
        material: { name: 'Fur', baseColorFactor: [0.45, 0.32, 0.22, 1], roughnessFactor: 0.8 },
        parts: [{ name: 'head', shape: smoothUnion([head, snout], 0.02) }],
      };
    },
  },

  rock: {
    label: 'rock',
    tags: ['rock', 'stone', 'boulder', 'terrain'],
    build: (p) => {
      const rng = p.rng;
      const blobs = [];
      for (let i = 0; i < 6; i += 1) {
        const r = 0.12 + rng() * 0.14;
        blobs.push(
          translate(sdf.ellipsoid(r * (0.7 + rng() * 0.6), r * (0.5 + rng() * 0.5), r), [
            (rng() - 0.5) * 0.34,
            r * 0.6,
            (rng() - 0.5) * 0.34,
          ]),
        );
      }
      return {
        shape: smoothUnion(blobs, 0.07),
        material: { name: 'Rock', baseColorFactor: [0.42, 0.42, 0.44, 1], roughnessFactor: 0.92 },
        parts: [],
      };
    },
  },

  crystal: {
    label: 'crystal / gem',
    tags: ['crystal', 'gem', 'diamond', 'jewel'],
    build: () => {
      const core = sdf.ellipsoid(0.09, 0.26, 0.09);
      const spikes = [];
      for (let i = 0; i < 5; i += 1) {
        const a = (i / 5) * Math.PI * 2;
        const tilt = 0.12 + (i % 3) * 0.03;
        spikes.push(
          translate(sdf.cone(0.3 - i * 0.02, 0.05), [Math.cos(a) * 0.07, 0.05, Math.sin(a) * 0.07]),
        );
        spikes.push(
          limb([Math.cos(a) * 0.05, -0.08, Math.sin(a) * 0.05], [Math.cos(a) * tilt, 0.16, Math.sin(a) * tilt], 0.045, 0.012),
        );
      }
      return {
        shape: smoothUnion([core, ...spikes], 0.02),
        material: { name: 'Crystal', baseColorFactor: [0.4, 0.85, 0.95, 0.85], roughnessFactor: 0.05, metallicFactor: 0.0, alphaMode: 'BLEND' },
        parts: [],
      };
    },
  },

  spaceship: {
    label: 'spaceship',
    tags: ['spaceship', 'ship', 'rocket', 'spacecraft', 'spacer'],
    build: () => {
      const hull = scaleShape(sdf.sphere(0.18), [2.4, 0.55, 0.55]);
      const nose = translate(sdf.cone(0.22, 0.14), [0, 0, 0]);
      const noseRotated = scaleShape(translate(sdf.sphere(0.12), [0.46, 0, 0]), [1.4, 0.7, 0.7]);
      const cockpit = translate(sdf.ellipsoid(0.1, 0.07, 0.08), [0.14, 0.07, 0]);
      const wings = [
        translate(sdf.box(0.1, 0.015, 0.2, 0.01), [-0.14, -0.02, 0.2]),
        translate(sdf.box(0.1, 0.015, 0.2, 0.01), [-0.14, -0.02, -0.2]),
      ];
      const engines = [
        translate(sdf.cylinder?.() ?? sdf.sphere(0.06), [-0.34, 0, 0.1]),
        translate(sdf.sphere(0.06), [-0.34, 0, -0.1]),
      ];
      return {
        shape: smoothUnion([hull, noseRotated, cockpit, ...wings, ...engines], 0.03),
        material: { name: 'HullMetal', baseColorFactor: [0.62, 0.64, 0.7, 1], metallicFactor: 0.8, roughnessFactor: 0.3 },
        parts: [{ name: 'cockpit', shape: cockpit }],
      };
      void nose;
    },
  },

  bottle: {
    label: 'bottle',
    tags: ['bottle', 'flask', 'jar'],
    build: () => {
      const body = translate(sdf.ellipsoid(0.1, 0.16, 0.1), [0, 0.16, 0]);
      const neck = sdf.capsule([0, 0.3, 0], [0, 0.42, 0], 0.03);
      const mouth = translate(sdf.torus(0.034, 0.008), [0, 0.42, 0]);
      const hollow = translate(sdf.ellipsoid(0.082, 0.15, 0.082), [0, 0.17, 0]);
      return {
        shape: union(subtract(body, hollow), neck, mouth),
        material: { name: 'Glass', baseColorFactor: [0.75, 0.9, 0.85, 0.35], roughnessFactor: 0.05, alphaMode: 'BLEND' },
        parts: [],
      };
    },
  },
};
// Generic primitives are addressable by prompt too, so words like "sphere" or
// "box" produce an honest, predictable shape instead of the previous catch-all.
ARCHETYPES.sphere = {
  label: 'sphere primitive',
  tags: ['sphere', 'ball', 'orb', 'round'],
  build: () => ({
    shape: translate(sdf.sphere(0.5), [0, 0.5, 0]),
    material: { name: 'Sphere', baseColorFactor: [0.8, 0.8, 0.82, 1] },
    parts: [],
  }),
};
ARCHETYPES.cube = {
  label: 'box primitive',
  tags: ['cube', 'box', 'block'],
  build: () => ({
    shape: translate(sdf.box(0.5, 0.5, 0.5, 0.02), [0, 0.5, 0]),
    material: { name: 'Box', baseColorFactor: [0.8, 0.8, 0.82, 1] },
    parts: [],
  }),
};

// World-building & architectural archetypes for immersive VR scenes.
ARCHETYPES.barn = {
  label: 'barn',
  tags: ['barn', 'farmhouse', 'stable', 'shed', 'granary'],
  build: () => {
    const walls = translate(sdf.box(0.42, 0.27, 0.52, 0.015), [0, 0.27, 0]);
    const gambrel = {
      type: 'gambrel-roof',
      distance: (x, y, z) => {
        const ax = Math.abs(x);
        // Two-slope gambrel roof envelope from y=0.50 up to ridge y=0.90
        const dBottom = 0.50 - y;
        const dLowerSlope = (ax - 0.46) * 0.832 + (y - 0.50) * 0.555;
        const dUpperSlope = (ax - 0.30) * 0.468 + (y - 0.74) * 0.884;
        const dProfile = Math.max(dBottom, dLowerSlope, dUpperSlope);
        const dz = Math.abs(z) - 0.56;
        const outside = Math.hypot(Math.max(dProfile, 0), Math.max(dz, 0));
        const inside = Math.min(Math.max(dProfile, dz), 0);
        return outside + inside - 0.012;
      },
      bounds: () => [-0.5, 0.46, -0.6, 0.5, 0.95, 0.6],
    };
    const shell = smoothUnion([walls, gambrel], 0.018);
    const interior = translate(sdf.box(0.34, 0.24, 0.43, 0.02), [0, 0.27, 0]);
    const doorway = translate(sdf.box(0.15, 0.21, 0.16, 0.01), [0, 0.20, 0.46]);
    const loftWindow = translate(sdf.box(0.085, 0.085, 0.15, 0.008), [0, 0.66, 0.48]);
    const sideWindowL = translate(sdf.box(0.14, 0.065, 0.07, 0.008), [-0.40, 0.32, 0]);
    const sideWindowR = translate(sdf.box(0.14, 0.065, 0.07, 0.008), [0.40, 0.32, 0]);
    const cupola = union(
      translate(sdf.box(0.07, 0.06, 0.07, 0.008), [0, 0.94, 0]),
      translate(sdf.cone(0.08, 0.095), [0, 1.03, 0]),
    );
    return {
      shape: union(subtract(shell, interior, doorway, loftWindow, sideWindowL, sideWindowR), cupola),
      material: { name: 'BarnWood', baseColorFactor: [0.68, 0.16, 0.14, 1], roughnessFactor: 0.72, metallicFactor: 0.02 },
      parts: [{ name: 'walls', shape: walls }, { name: 'roof', shape: gambrel }, { name: 'cupola', shape: cupola }],
    };
  },
};

ARCHETYPES.silo = {
  label: 'grain silo',
  tags: ['silo', 'grain-silo', 'water-tower'],
  build: () => {
    const body = sdf.capsule([0, 0.22, 0], [0, 0.88, 0], 0.22);
    const base = translate(sdf.box(0.22, 0.11, 0.22, 0.05), [0, 0.11, 0]);
    const chute = sdf.capsule([0, 0.12, 0.22], [0, 0.80, 0.22], 0.045);
    return {
      shape: smoothUnion([base, body, chute], 0.025),
      material: { name: 'GalvanizedSteel', baseColorFactor: [0.74, 0.76, 0.79, 1], metallicFactor: 0.78, roughnessFactor: 0.32 },
      parts: [{ name: 'tower', shape: body }, { name: 'chute', shape: chute }],
    };
  },
};

ARCHETYPES.windmill = {
  label: 'windmill',
  tags: ['windmill', 'mill', 'turbine'],
  build: () => {
    const base = limb([0, 0.12, 0], [0, 0.76, 0], 0.22, 0.13);
    const plinth = translate(sdf.box(0.24, 0.08, 0.24, 0.03), [0, 0.08, 0]);
    const hub = sdf.capsule([0, 0.76, 0.10], [0, 0.76, 0.25], 0.048);
    const blades = [
      sdf.capsule([0, 0.76, 0.23], [0.28, 1.04, 0.25], 0.028),
      sdf.capsule([0, 0.76, 0.23], [-0.28, 0.48, 0.25], 0.028),
      sdf.capsule([0, 0.76, 0.23], [-0.28, 1.04, 0.25], 0.028),
      sdf.capsule([0, 0.76, 0.23], [0.28, 0.48, 0.25], 0.028),
    ];
    return {
      shape: smoothUnion([plinth, base, hub, ...blades], 0.022),
      material: { name: 'TimberMill', baseColorFactor: [0.62, 0.48, 0.34, 1], roughnessFactor: 0.68 },
      parts: [{ name: 'tower', shape: base }, { name: 'blades', shape: union(...blades) }],
    };
  },
};

ARCHETYPES.haybale = {
  label: 'hay bale',
  tags: ['haybale', 'bale', 'hay-bale', 'haystack', 'straw', 'hay'],
  build: () => {
    // Rolled cylindrical hay bale lying on its side with subtle twine grooves
    const roll = {
      type: 'hay-cylinder',
      distance: (x, y, z) => {
        const r = Math.hypot(y - 0.32, z) - 0.32;
        const dx = Math.abs(x) - 0.38;
        const outside = Math.hypot(Math.max(r, 0), Math.max(dx, 0));
        const inside = Math.min(Math.max(r, dx), 0);
        return outside + inside - 0.02;
      },
      bounds: () => [-0.44, -0.04, -0.38, 0.44, 0.68, 0.38],
    };
    return {
      shape: roll,
      material: { name: 'GoldenHay', baseColorFactor: [0.80, 0.66, 0.28, 1], roughnessFactor: 0.92, metallicFactor: 0 },
      parts: [],
    };
  },
};

ARCHETYPES.fence = {
  label: 'wooden fence',
  tags: ['fence', 'railing', 'gate', 'paddock', 'corral'],
  build: () => {
    const posts = [-0.46, 0, 0.46].map((x) => sdf.capsule([x, 0, 0], [x, 0.42, 0], 0.032));
    const railTop = sdf.capsule([-0.48, 0.33, 0], [0.48, 0.33, 0], 0.022);
    const railMid = sdf.capsule([-0.48, 0.19, 0], [0.48, 0.19, 0], 0.022);
    return {
      shape: smoothUnion([...posts, railTop, railMid], 0.012),
      material: { name: 'CedarWood', baseColorFactor: [0.48, 0.33, 0.20, 1], roughnessFactor: 0.78 },
      parts: [],
    };
  },
};

ARCHETYPES.well = {
  label: 'stone well',
  tags: ['well', 'fountain', 'cistern'],
  build: () => {
    const outer = translate(sdf.box(0.26, 0.18, 0.26, 0.12), [0, 0.18, 0]);
    const inner = translate(sdf.box(0.17, 0.18, 0.17, 0.08), [0, 0.23, 0]);
    const postL = sdf.capsule([-0.22, 0.30, 0], [-0.22, 0.76, 0], 0.028);
    const postR = sdf.capsule([0.22, 0.30, 0], [0.22, 0.76, 0], 0.028);
    const roof = translate(sdf.box(0.30, 0.08, 0.28, 0.03), [0, 0.80, 0]);
    const ridge = sdf.capsule([-0.28, 0.88, 0], [0.28, 0.88, 0], 0.045);
    return {
      shape: smoothUnion([subtract(outer, inner), postL, postR, roof, ridge], 0.015),
      material: { name: 'Cobblestone', baseColorFactor: [0.52, 0.53, 0.55, 1], roughnessFactor: 0.88 },
      parts: [],
    };
  },
};

ARCHETYPES.bench = {
  label: 'wooden bench',
  tags: ['bench', 'pew', 'couch', 'sofa'],
  build: () => {
    const seat = translate(sdf.box(0.44, 0.028, 0.16, 0.012), [0, 0.22, 0]);
    const back = translate(sdf.box(0.44, 0.16, 0.025, 0.012), [0, 0.38, -0.14]);
    const legs = [[-0.36, -0.12], [0.36, -0.12], [-0.36, 0.12], [0.36, 0.12]].map(([x, z]) =>
      sdf.capsule([x, 0, z], [x, 0.22, z], 0.026),
    );
    return {
      shape: smoothUnion([seat, back, ...legs], 0.012),
      material: { name: 'BenchWood', baseColorFactor: [0.46, 0.31, 0.18, 1], roughnessFactor: 0.65 },
      parts: [],
    };
  },
};

ARCHETYPES.campfire = {
  label: 'campfire',
  tags: ['campfire', 'bonfire', 'firepit', 'brazier'],
  build: () => {
    const stones = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      stones.push(translate(sdf.sphere(0.068), [Math.cos(a) * 0.24, 0.068, Math.sin(a) * 0.24]));
    }
    const logA = sdf.capsule([-0.16, 0.06, -0.12], [0.16, 0.14, 0.12], 0.036);
    const logB = sdf.capsule([-0.16, 0.06, 0.12], [0.16, 0.14, -0.12], 0.036);
    const flame = limb([0, 0.10, 0], [0, 0.32, 0], 0.095, 0.03);
    return {
      shape: smoothUnion([...stones, logA, logB, flame], 0.022),
      material: { name: 'Ember', baseColorFactor: [0.88, 0.42, 0.12, 1], roughnessFactor: 0.65, emissiveFactor: [0.55, 0.22, 0.04] },
      parts: [],
    };
  },
};

ARCHETYPES.bridge = {
  label: 'arched bridge',
  tags: ['bridge', 'arch', 'walkway', 'overpass'],
  build: () => {
    const deck = translate(sdf.box(0.52, 0.06, 0.22, 0.015), [0, 0.24, 0]);
    const archCut = translate(sdf.ellipsoid(0.34, 0.19, 0.30), [0, 0.02, 0]);
    const railF = sdf.capsule([-0.48, 0.36, 0.19], [0.48, 0.36, 0.19], 0.022);
    const railB = sdf.capsule([-0.48, 0.36, -0.19], [0.48, 0.36, -0.19], 0.022);
    const posts = [-0.46, 0, 0.46].flatMap((x) => [
      sdf.capsule([x, 0.24, 0.19], [x, 0.38, 0.19], 0.022),
      sdf.capsule([x, 0.24, -0.19], [x, 0.38, -0.19], 0.022),
    ]);
    return {
      shape: smoothUnion([subtract(deck, archCut), railF, railB, ...posts], 0.014),
      material: { name: 'BridgeStone', baseColorFactor: [0.54, 0.50, 0.45, 1], roughnessFactor: 0.82 },
      parts: [],
    };
  },
};


// ---------------------------------------------------------------------------
// Humanoid builder
// ---------------------------------------------------------------------------

/**
 * Parametric humanoid. Proportions are driven by prompt-derived parameters so
 * "tall realistic female character" and "short stocky warrior" differ
 * geometrically, not cosmetically.
 */
export function humanoid(params = {}) {
  const {
    height = 1.72,
    rng = makeRandom(7),
    female = false,
    hair = 'medium',
    bulk = 1,
    pose = 'a-pose',
  } = params;
  const s = height / 1.72;
  const hipY = 0.92 * s;
  const shoulderY = 1.42 * s;
  const headY = 1.58 * s;
  const shoulderW = (female ? 0.17 : 0.2) * bulk * s;
  const hipW = (female ? 0.16 : 0.145) * bulk * s;
  const chestR = (female ? 0.135 : 0.15) * bulk * s;
  const waistR = (female ? 0.1 : 0.115) * bulk * s;

  const pelvis = translate(sdf.ellipsoid(hipW, 0.11 * s, 0.12 * s), [0, hipY, 0]);
  const waist = translate(sdf.ellipsoid(waistR, 0.1 * s, 0.095 * s), [0, hipY + 0.12 * s, 0]);
  const chest = translate(sdf.ellipsoid(chestR, 0.16 * s, 0.1 * s), [0, shoulderY - 0.06 * s, 0]);
  const shoulders = translate(sdf.ellipsoid(shoulderW + 0.03 * s, 0.055 * s, 0.08 * s), [0, shoulderY, 0]);
  const neck = sdf.capsule([0, shoulderY, 0], [0, shoulderY + 0.08 * s, 0], 0.038 * s);
  const head = translate(sdf.ellipsoid(0.082 * s, 0.105 * s, 0.09 * s), [0, headY, 0]);
  const jaw = translate(sdf.ellipsoid(0.06 * s, 0.055 * s, 0.07 * s), [0, headY - 0.075 * s, 0.01 * s]);

  const torso = smoothUnion([pelvis, waist, chest, shoulders, neck], 0.045 * s);

  const armAngle = pose === 't-pose' ? 0 : 32 * DEG;
  const upperArmLen = 0.3 * s;
  const foreArmLen = 0.27 * s;
  const shoulderL = [-(shoulderW + 0.02 * s), shoulderY - 0.02 * s, 0];
  const shoulderR = [shoulderW + 0.02 * s, shoulderY - 0.02 * s, 0];
  const elbowL = [shoulderL[0] - Math.cos(armAngle) * upperArmLen, shoulderY - 0.02 * s - Math.sin(armAngle) * upperArmLen * 1.1, 0];
  const elbowR = [shoulderR[0] + Math.cos(armAngle) * upperArmLen, shoulderY - 0.02 * s - Math.sin(armAngle) * upperArmLen * 1.1, 0];
  const wristL = [elbowL[0] - Math.cos(armAngle * 0.6) * foreArmLen, elbowL[1] - foreArmLen * 0.95, 0];
  const wristR = [elbowR[0] + Math.cos(armAngle * 0.6) * foreArmLen, elbowR[1] - foreArmLen * 0.95, 0];
  const armR0 = 0.048 * bulk * s;
  const armR1 = 0.032 * bulk * s;
  const arms = [
    limb(shoulderL, elbowL, armR0, armR0 * 0.85),
    limb(elbowL, wristL, armR0 * 0.85, armR1),
    limb(shoulderR, elbowR, armR0, armR0 * 0.85),
    limb(elbowR, wristR, armR0 * 0.85, armR1),
  ];
  const hands = [
    translate(sdf.ellipsoid(0.032 * s, 0.055 * s, 0.018 * s), [wristL[0] - 0.01 * s, wristL[1] - 0.05 * s, 0]),
    translate(sdf.ellipsoid(0.032 * s, 0.055 * s, 0.018 * s), [wristR[0] + 0.01 * s, wristR[1] - 0.05 * s, 0]),
  ];

  const legR0 = (female ? 0.075 : 0.08) * bulk * s;
  const legR1 = 0.045 * bulk * s;
  const hipL = [-hipW * 0.55, hipY - 0.02 * s, 0];
  const hipR = [hipW * 0.55, hipY - 0.02 * s, 0];
  const kneeL = [hipL[0] - 0.01 * s, 0.5 * s, 0];
  const kneeR = [hipR[0] + 0.01 * s, 0.5 * s, 0];
  const ankleL = [kneeL[0], 0.1 * s, 0.01 * s];
  const ankleR = [kneeR[0], 0.1 * s, 0.01 * s];
  const legs = [
    limb(hipL, kneeL, legR0, legR0 * 0.7),
    limb(kneeL, ankleL, legR0 * 0.7, legR1),
    limb(hipR, kneeR, legR0, legR0 * 0.7),
    limb(kneeR, ankleR, legR0 * 0.7, legR1),
  ];
  const feet = [
    translate(sdf.ellipsoid(0.045 * s, 0.03 * s, 0.1 * s), [ankleL[0], 0.03 * s, 0.045 * s]),
    translate(sdf.ellipsoid(0.045 * s, 0.03 * s, 0.1 * s), [ankleR[0], 0.03 * s, 0.045 * s]),
  ];

  let hairShape = null;
  if (hair !== 'none') {
    const cap = translate(sdf.ellipsoid(0.09 * s, 0.085 * s, 0.095 * s), [0, headY + 0.035 * s, -0.012 * s]);
    const long = translate(sdf.ellipsoid(0.085 * s, 0.22 * s, 0.06 * s), [0, headY - 0.09 * s, -0.075 * s]);
    const bun = translate(sdf.sphere(0.05 * s), [0, headY + 0.11 * s, -0.05 * s]);
    const pony = limb([0, headY + 0.02 * s, -0.1 * s], [0, headY - 0.25 * s, -0.26 * s], 0.04 * s, 0.02 * s);
    if (hair === 'long') hairShape = smoothUnion([cap, long], 0.02);
    else if (hair === 'bun') hairShape = smoothUnion([cap, bun], 0.02);
    else if (hair === 'ponytail') hairShape = smoothUnion([cap, pony], 0.02);
    else if (hair === 'short') hairShape = cap;
    else hairShape = smoothUnion([cap, translate(sdf.ellipsoid(0.085 * s, 0.13 * s, 0.06 * s), [0, headY - 0.04 * s, -0.07 * s])], 0.02);
    hairShape = subtract(hairShape, translate(sdf.ellipsoid(0.06 * s, 0.05 * s, 0.06 * s), [0, headY - 0.03 * s, 0.06 * s]));
  }

  const body = smoothUnion([torso, head, jaw, ...arms, ...hands, ...legs, ...feet], 0.03 * s);
  const shape = hairShape ? union(body, hairShape) : body;

  return {
    shape,
    material: { name: 'Skin', baseColorFactor: [0.84, 0.68, 0.58, 1], roughnessFactor: 0.6, metallicFactor: 0.0 },
    parts: [
      { name: 'head', shape: smoothUnion([head, jaw], 0.02) },
      { name: 'torso', shape: torso },
      { name: 'hair', shape: hairShape },
      { name: 'arm_L', shape: smoothUnion([arms[0], arms[1], hands[0]], 0.02) },
      { name: 'arm_R', shape: smoothUnion([arms[2], arms[3], hands[1]], 0.02) },
      { name: 'leg_L', shape: smoothUnion([legs[0], legs[1], feet[0]], 0.02) },
      { name: 'leg_R', shape: smoothUnion([legs[2], legs[3], feet[1]], 0.02) },
    ].filter((p) => p.shape),
    rigHints: { shoulderW, hipW, headY, shoulderY, hipY, kneeY: 0.5 * s, height: s },
    void: rng,
  };
}

// ---------------------------------------------------------------------------
// Prompt parsing
// ---------------------------------------------------------------------------

const COLOR_WORDS = {
  red: [0.72, 0.14, 0.14],
  crimson: [0.6, 0.08, 0.12],
  orange: [0.9, 0.45, 0.12],
  yellow: [0.9, 0.82, 0.2],
  gold: [0.83, 0.68, 0.22],
  green: [0.25, 0.6, 0.3],
  emerald: [0.1, 0.6, 0.4],
  teal: [0.1, 0.6, 0.62],
  cyan: [0.2, 0.75, 0.8],
  blue: [0.2, 0.35, 0.72],
  navy: [0.1, 0.15, 0.35],
  purple: [0.42, 0.22, 0.65],
  violet: [0.5, 0.3, 0.7],
  magenta: [0.7, 0.2, 0.6],
  pink: [0.85, 0.45, 0.6],
  white: [0.92, 0.92, 0.94],
  black: [0.08, 0.08, 0.1],
  grey: [0.5, 0.5, 0.52],
  gray: [0.5, 0.5, 0.52],
  silver: [0.75, 0.76, 0.78],
  brown: [0.45, 0.3, 0.18],
  wooden: [0.5, 0.34, 0.2],
  wood: [0.5, 0.34, 0.2],
  copper: [0.72, 0.45, 0.2],
  bronze: [0.65, 0.45, 0.2],
  steel: [0.7, 0.72, 0.75],
  chrome: [0.8, 0.82, 0.85],
  olive: [0.34, 0.42, 0.2],
  sage: [0.46, 0.58, 0.44],
  lime: [0.45, 0.8, 0.2],
  tan: [0.76, 0.64, 0.46],
  beige: [0.84, 0.78, 0.65],
  sand: [0.82, 0.74, 0.54],
  cream: [0.94, 0.91, 0.82],
  rust: [0.62, 0.24, 0.14],
  amber: [0.9, 0.62, 0.14],
  golden: [0.85, 0.68, 0.24],
  charcoal: [0.16, 0.17, 0.19],
  maroon: [0.44, 0.1, 0.14],
};

const MATERIAL_WORDS = {
  metal: { metallicFactor: 0.9, roughnessFactor: 0.25 },
  metallic: { metallicFactor: 0.9, roughnessFactor: 0.25 },
  glossy: { roughnessFactor: 0.1 },
  shiny: { roughnessFactor: 0.12 },
  matte: { roughnessFactor: 0.9 },
  rubber: { roughnessFactor: 0.95, metallicFactor: 0 },
  glass: { alphaMode: 'BLEND', roughnessFactor: 0.05, metallicFactor: 0 },
  ceramic: { roughnessFactor: 0.2, metallicFactor: 0 },
  fabric: { roughnessFactor: 0.9, metallicFactor: 0 },
  skin: { roughnessFactor: 0.55, metallicFactor: 0 },
  marble: { roughnessFactor: 0.3, metallicFactor: 0 },
  stone: { roughnessFactor: 0.86, metallicFactor: 0 },
  emissive: { emissiveFactor: [0.4, 0.8, 0.7] },
};

const HAIR_WORDS = {
  'long hair': 'long',
  'short hair': 'short',
  'ponytail': 'ponytail',
  bun: 'bun',
  bald: 'none',
  hairstyle: 'medium',
};

export function tokenizePrompt(prompt) {
  return String(prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const MATERIAL_ADJ_TAGS = new Set(['stone', 'crystal', 'straw', 'hay']);

export function matchArchetype(prompt) {
  const tokens = tokenizePrompt(prompt);
  const joined = ` ${tokens.join(' ')} `;
  const scores = [];
  for (const [key, archetype] of Object.entries(ARCHETYPES)) {
    let score = 0;
    for (const tag of archetype.tags) {
      const exact = joined.includes(` ${tag} `);
      const plural = !exact && joined.includes(` ${tag}s `);
      if (exact || plural) {
        if (MATERIAL_ADJ_TAGS.has(tag)) score += 1.5;
        else score += exact && tag.length >= 5 ? 3 : 2.2;
      }
    }
    if (score > 0) scores.push({ key, score });
  }
  scores.sort((a, b) => b.score - a.score);
  if (scores.length === 0) return { key: null, tokens, confident: false };
  return { key: scores[0].key, tokens, confident: scores[0].score >= 1.5, alternatives: scores.slice(1, 4).map((s) => s.key) };
}

export function parsePrompt(prompt) {
  const tokens = tokenizePrompt(prompt);
  const joined = ` ${tokens.join(' ')} `;
  const params = {};
  let archetypeKey = null;
  const match = matchArchetype(prompt);
  if (match.key) archetypeKey = match.key;

  if (!archetypeKey) {
    // Only generic shape words get a guess; everything else is reported as an
    // unmatched prompt so callers (and ChatGPT) get an actionable error instead
    // of a silently wrong model.
    if (/(ball|sphere|orb)/.test(joined)) archetypeKey = 'sphere';
    else if (/(block|box|cube)/.test(joined)) archetypeKey = 'cube';
  }

  const sizeWords = {
    tiny: 0.4, small: 0.7, little: 0.8, medium: 1, large: 1.4, big: 1.4, huge: 2, giant: 2.2, massive: 2.2,
  };
  for (const [word, scale] of Object.entries(sizeWords)) {
    if (joined.includes(` ${word} `)) params.scale = scale;
  }
  if (/(tall|high)/.test(joined)) params.aspect = { y: 1.25 };
  if (/(short|squat)/.test(joined)) params.aspect = { y: 0.8 };
  if (/(wide|broad)/.test(joined)) params.aspect = { ...(params.aspect ?? {}), x: 1.2, z: 1.2 };
  if (/(thin|slim|slender|narrow)/.test(joined)) params.bulk = 0.82;
  if (/(stocky|bulky|muscular|heavy|strong)/.test(joined)) params.bulk = 1.22;
  if (/(spiky|jagged|crystal)/.test(joined)) params.spiky = true;
  if (/(female|woman|girl|lady|feminine)/.test(joined)) params.female = true;
  if (/(male|man|boy|masculine)/.test(joined)) params.female = false;
  if (/(pine|conifer)/.test(joined)) params.pine = true;
  if (/(t-pose|tpose)/.test(joined)) params.pose = 't-pose';
  if (/(a-pose|apose)/.test(joined)) params.pose = 'a-pose';
  for (const [phrase, mode] of Object.entries(HAIR_WORDS)) {
    if (joined.includes(` ${phrase} `)) params.hair = mode;
  }
  const color = Object.entries(COLOR_WORDS).find(([word]) => joined.includes(` ${word} `));
  if (color) params.color = color[1];
  const matWords = Object.entries(MATERIAL_WORDS)
    .filter(([word]) => joined.includes(` ${word} `))
    .map(([, v]) => v);
  if (matWords.length) params.materialOverrides = Object.assign({}, ...matWords);
  params.rng = makeRandom(hashString(prompt) || 1);
  params.tokens = tokens;

  return { archetypeKey, params, tokens, match };
}

/** Instantiate a prompt into an SDF scene, applying generic modifiers. */
export function sceneFromPrompt(prompt) {
  const parsed = parsePrompt(prompt);
  const archetype = ARCHETYPES[parsed.archetypeKey];
  if (!archetype) {
    fail('prompt_unmatched', `Could not map prompt to a shape: "${prompt}"`, {
      status: 422,
      hint: `Supported archetypes: ${Object.keys(ARCHETYPES).join(', ')}. You can also pass an explicit "shape" spec.`,
    });
  }
  const built = archetype.build(parsed.params);
  let shape = built.shape;
  const { scale = 1, aspect } = parsed.params;
  if (scale !== 1 || aspect) {
    shape = scaleShape(shape, [scale * (aspect?.x ?? 1), scale * (aspect?.y ?? 1), scale * (aspect?.z ?? 1)]);
  }
  // Ground the model at y=0 so exports sit on the floor.
  const bounds = shape.bounds();
  if (Math.abs(bounds[1]) > 1e-3) shape = translate(shape, [0, -bounds[1], 0]);
  const material = {
    ...built.material,
    ...(parsed.params.color ? { baseColorFactor: [...parsed.params.color, 1] } : {}),
    ...(parsed.params.materialOverrides ?? {}),
  };
  return {
    archetype: parsed.archetypeKey,
    shape,
    material,
    parts: built.parts ?? [],
    params: { ...parsed.params, rng: undefined, tokens: undefined },
    rigHints: built.rigHints ?? null,
    alternatives: parsed.match.alternatives ?? [],
    prompt,
  };
}

export function listArchetypes() {
  return Object.entries(ARCHETYPES).map(([key, value]) => ({
    key,
    label: value.label,
    tags: value.tags,
  }));
}

export function hasArchetype(key) {
  return Boolean(ARCHETYPES[key]);
}

export { ARCHETYPES };
