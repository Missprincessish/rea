// Shared 3D world state, biome presets, real-world VR scales, and deterministic
// terrain heightfield maths. Pure ES module (no Node-only APIs) so both the
// engine and the WebXR client evaluate the exact same ground heights.

export const TIME_PRESETS = {
  dawn: {
    preset: 'dawn',
    zenithColor: [0.16, 0.24, 0.46],
    horizonColor: [0.92, 0.58, 0.42],
    sunDirection: [0.78, 0.22, -0.58],
    sunColor: [1.0, 0.72, 0.48],
    sunIntensity: 2.1,
    ambientIntensity: 0.55,
    stars: false,
  },
  day: {
    preset: 'day',
    zenithColor: [0.18, 0.46, 0.84],
    horizonColor: [0.68, 0.84, 0.96],
    sunDirection: [0.42, 0.78, 0.46],
    sunColor: [1.0, 0.98, 0.92],
    sunIntensity: 2.8,
    ambientIntensity: 0.72,
    stars: false,
  },
  'golden-hour': {
    preset: 'golden-hour',
    zenithColor: [0.22, 0.40, 0.72],
    horizonColor: [0.96, 0.78, 0.48],
    sunDirection: [0.74, 0.34, 0.58],
    sunColor: [1.0, 0.84, 0.54],
    sunIntensity: 2.7,
    ambientIntensity: 0.65,
    stars: false,
  },
  sunset: {
    preset: 'sunset',
    zenithColor: [0.14, 0.16, 0.38],
    horizonColor: [0.95, 0.42, 0.24],
    sunDirection: [0.85, 0.14, -0.50],
    sunColor: [1.0, 0.55, 0.28],
    sunIntensity: 2.0,
    ambientIntensity: 0.48,
    stars: true,
  },
  night: {
    preset: 'night',
    zenithColor: [0.02, 0.03, 0.08],
    horizonColor: [0.06, 0.10, 0.20],
    sunDirection: [-0.35, 0.65, -0.66],
    sunColor: [0.56, 0.68, 0.95],
    sunIntensity: 0.75,
    ambientIntensity: 0.28,
    stars: true,
  },
  overcast: {
    preset: 'overcast',
    zenithColor: [0.52, 0.56, 0.62],
    horizonColor: [0.74, 0.77, 0.80],
    sunDirection: [0.3, 0.85, 0.4],
    sunColor: [0.92, 0.94, 0.96],
    sunIntensity: 1.4,
    ambientIntensity: 0.85,
    stars: false,
  },
  studio: {
    preset: 'studio',
    zenithColor: [0.04, 0.06, 0.08],
    horizonColor: [0.08, 0.12, 0.14],
    sunDirection: [0.5, 0.75, 0.45],
    sunColor: [1.0, 1.0, 1.0],
    sunIntensity: 2.4,
    ambientIntensity: 0.6,
    stars: false,
  },
};

export const BIOMES = {
  studio: {
    id: 'studio',
    label: 'Studio Grid',
    description: 'Clean dark modeling floor with reference grid.',
    timeOfDay: 'studio',
    ground: {
      enabled: true,
      size: 160,
      color: [0.09, 0.11, 0.13],
      secondaryColor: [0.13, 0.16, 0.18],
      roughness: 0.88,
      metallic: 0.05,
      hillHeight: 0,
      hillScale: 0.04,
      grid: true,
    },
    fog: { enabled: true, color: [0.05, 0.07, 0.09], near: 18, far: 95 },
    foliage: [],
    defaultScatter: [],
  },

  hayfield: {
    id: 'hayfield',
    label: 'Golden Hayfield',
    description: 'Warm sunlit farmland with rolling golden hay stalks swaying in the breeze.',
    timeOfDay: 'golden-hour',
    ground: {
      enabled: true,
      size: 200,
      color: [0.56, 0.45, 0.22],
      secondaryColor: [0.72, 0.58, 0.28],
      roughness: 0.95,
      metallic: 0.0,
      hillHeight: 1.15,
      hillScale: 0.035,
      grid: false,
    },
    fog: { enabled: true, color: [0.92, 0.80, 0.56], near: 28, far: 135 },
    foliage: [
      {
        id: 'hay-main',
        kind: 'hay',
        color: [0.86, 0.71, 0.30],
        tipColor: [0.96, 0.86, 0.48],
        count: 9000,
        radius: 65,
        height: 0.78,
        wind: 1.0,
      },
      {
        id: 'hay-under',
        kind: 'grass',
        color: [0.64, 0.54, 0.24],
        tipColor: [0.80, 0.68, 0.32],
        count: 4000,
        radius: 50,
        height: 0.36,
        wind: 0.7,
      },
    ],
    defaultScatter: [
      { prompt: 'golden haybale', count: 6, minRadius: 9, radius: 34 },
    ],
  },

  meadow: {
    id: 'meadow',
    label: 'Lush Meadow',
    description: 'Rolling green grass hills with wildflowers under a bright sky.',
    timeOfDay: 'day',
    ground: {
      enabled: true,
      size: 200,
      color: [0.22, 0.44, 0.18],
      secondaryColor: [0.34, 0.56, 0.24],
      roughness: 0.94,
      metallic: 0,
      hillHeight: 1.5,
      hillScale: 0.032,
      grid: false,
    },
    fog: { enabled: true, color: [0.72, 0.86, 0.96], near: 32, far: 145 },
    foliage: [
      {
        id: 'meadow-grass',
        kind: 'grass',
        color: [0.24, 0.54, 0.20],
        tipColor: [0.46, 0.76, 0.30],
        count: 9000,
        radius: 60,
        height: 0.45,
        wind: 0.85,
      },
      {
        id: 'meadow-flowers',
        kind: 'wildflowers',
        color: [0.94, 0.82, 0.28],
        tipColor: [0.98, 0.52, 0.66],
        count: 1400,
        radius: 48,
        height: 0.52,
        wind: 0.95,
      },
    ],
    defaultScatter: [
      { prompt: 'tree', count: 5, minRadius: 14, radius: 42 },
      { prompt: 'rock', count: 4, minRadius: 10, radius: 36 },
    ],
  },

  forest: {
    id: 'forest',
    label: 'Pine Forest',
    description: 'Woodland clearing with soft moss, tall grass and surrounding pines.',
    timeOfDay: 'day',
    ground: {
      enabled: true,
      size: 200,
      color: [0.18, 0.28, 0.15],
      secondaryColor: [0.28, 0.22, 0.14],
      roughness: 0.96,
      metallic: 0,
      hillHeight: 1.8,
      hillScale: 0.038,
      grid: false,
    },
    fog: { enabled: true, color: [0.58, 0.70, 0.68], near: 18, far: 95 },
    foliage: [
      {
        id: 'forest-grass',
        kind: 'grass',
        color: [0.18, 0.38, 0.16],
        tipColor: [0.30, 0.52, 0.24],
        count: 6500,
        radius: 52,
        height: 0.38,
        wind: 0.55,
      },
    ],
    defaultScatter: [
      { prompt: 'pine tree', count: 12, minRadius: 9, radius: 42 },
      { prompt: 'rock', count: 5, minRadius: 8, radius: 34 },
    ],
  },

  snow: {
    id: 'snow',
    label: 'Snowfield',
    description: 'Crisp winter snowdrifts with soft blue shadows.',
    timeOfDay: 'dawn',
    ground: {
      enabled: true,
      size: 200,
      color: [0.88, 0.92, 0.97],
      secondaryColor: [0.76, 0.83, 0.92],
      roughness: 0.72,
      metallic: 0.02,
      hillHeight: 1.9,
      hillScale: 0.034,
      grid: false,
    },
    fog: { enabled: true, color: [0.84, 0.88, 0.95], near: 22, far: 115 },
    foliage: [
      {
        id: 'snow-tufts',
        kind: 'snow-tufts',
        color: [0.68, 0.74, 0.82],
        tipColor: [0.95, 0.97, 1.0],
        count: 2500,
        radius: 50,
        height: 0.28,
        wind: 0.4,
      },
    ],
    defaultScatter: [
      { prompt: 'white pine tree', count: 7, minRadius: 11, radius: 40 },
      { prompt: 'grey rock', count: 4, minRadius: 9, radius: 32 },
    ],
  },

  desert: {
    id: 'desert',
    label: 'Sand Dunes',
    description: 'Sweeping warm desert dunes under a blazing sky.',
    timeOfDay: 'golden-hour',
    ground: {
      enabled: true,
      size: 220,
      color: [0.84, 0.68, 0.44],
      secondaryColor: [0.74, 0.54, 0.32],
      roughness: 0.92,
      metallic: 0,
      hillHeight: 2.6,
      hillScale: 0.028,
      grid: false,
    },
    fog: { enabled: true, color: [0.92, 0.78, 0.58], near: 28, far: 130 },
    foliage: [
      {
        id: 'desert-scrub',
        kind: 'grass',
        color: [0.52, 0.48, 0.26],
        tipColor: [0.68, 0.62, 0.36],
        count: 1400,
        radius: 55,
        height: 0.34,
        wind: 0.6,
      },
    ],
    defaultScatter: [
      { prompt: 'tan rock', count: 6, minRadius: 10, radius: 42 },
    ],
  },

  beach: {
    id: 'beach',
    label: 'Coastal Sandbar',
    description: 'Warm coastal sand with gentle dunes and sea haze.',
    timeOfDay: 'day',
    ground: {
      enabled: true,
      size: 200,
      color: [0.88, 0.82, 0.64],
      secondaryColor: [0.72, 0.68, 0.52],
      roughness: 0.88,
      metallic: 0,
      hillHeight: 0.7,
      hillScale: 0.03,
      grid: false,
    },
    fog: { enabled: true, color: [0.74, 0.88, 0.96], near: 35, far: 150 },
    foliage: [
      {
        id: 'dune-grass',
        kind: 'hay',
        color: [0.54, 0.64, 0.38],
        tipColor: [0.76, 0.80, 0.54],
        count: 2600,
        radius: 50,
        height: 0.55,
        wind: 1.2,
      },
    ],
    defaultScatter: [
      { prompt: 'rock', count: 4, minRadius: 10, radius: 35 },
    ],
  },

  mars: {
    id: 'mars',
    label: 'Red Planet',
    description: 'Rust-red dusty ridges under a butterscotch Martian sky.',
    timeOfDay: 'sunset',
    ground: {
      enabled: true,
      size: 220,
      color: [0.62, 0.28, 0.16],
      secondaryColor: [0.44, 0.20, 0.13],
      roughness: 0.95,
      metallic: 0.04,
      hillHeight: 2.4,
      hillScale: 0.032,
      grid: false,
    },
    fog: { enabled: true, color: [0.78, 0.48, 0.32], near: 20, far: 110 },
    foliage: [],
    defaultScatter: [
      { prompt: 'rust rock', count: 8, minRadius: 8, radius: 42 },
    ],
  },

  'night-clearing': {
    id: 'night-clearing',
    label: 'Starlit Clearing',
    description: 'Moonlit grass clearing with glowing drifting fireflies.',
    timeOfDay: 'night',
    ground: {
      enabled: true,
      size: 180,
      color: [0.10, 0.18, 0.12],
      secondaryColor: [0.14, 0.22, 0.16],
      roughness: 0.95,
      metallic: 0,
      hillHeight: 1.1,
      hillScale: 0.035,
      grid: false,
    },
    fog: { enabled: true, color: [0.05, 0.08, 0.16], near: 16, far: 85 },
    foliage: [
      {
        id: 'night-grass',
        kind: 'grass',
        color: [0.10, 0.24, 0.14],
        tipColor: [0.18, 0.38, 0.24],
        count: 6500,
        radius: 48,
        height: 0.42,
        wind: 0.5,
      },
      {
        id: 'fireflies',
        kind: 'fireflies',
        color: [0.78, 1.0, 0.38],
        tipColor: [1.0, 0.92, 0.45],
        count: 320,
        radius: 36,
        height: 1.8,
        wind: 1.0,
      },
    ],
    defaultScatter: [
      { prompt: 'pine tree', count: 7, minRadius: 12, radius: 38 },
    ],
  },

  cyberpunk: {
    id: 'cyberpunk',
    label: 'Neon Grid',
    description: 'Reflective dark plaza with neon horizon fog.',
    timeOfDay: 'night',
    ground: {
      enabled: true,
      size: 180,
      color: [0.05, 0.06, 0.10],
      secondaryColor: [0.10, 0.08, 0.18],
      roughness: 0.22,
      metallic: 0.65,
      hillHeight: 0,
      hillScale: 0.03,
      grid: true,
    },
    fog: { enabled: true, color: [0.12, 0.06, 0.22], near: 18, far: 90 },
    foliage: [
      {
        id: 'neon-motes',
        kind: 'fireflies',
        color: [0.18, 0.95, 0.82],
        tipColor: [0.85, 0.32, 1.0],
        count: 260,
        radius: 40,
        height: 2.4,
        wind: 0.8,
      },
    ],
    defaultScatter: [],
  },

  courtyard: {
    id: 'courtyard',
    label: 'Stone Courtyard',
    description: 'Flat Flagstone plaza suited for architecture and town layouts.',
    timeOfDay: 'day',
    ground: {
      enabled: true,
      size: 180,
      color: [0.46, 0.45, 0.42],
      secondaryColor: [0.38, 0.37, 0.35],
      roughness: 0.85,
      metallic: 0.02,
      hillHeight: 0,
      hillScale: 0.03,
      grid: true,
    },
    fog: { enabled: true, color: [0.74, 0.82, 0.90], near: 35, far: 140 },
    foliage: [],
    defaultScatter: [],
  },
};

/**
 * Default target height (meters) for archetypes when spawned into a 1:1 VR world.
 * Tabletop `generate.text` keeps its unit scale; `world.spawn` scales models to
 * human VR proportions so a barn is a walk-in building and a chair is seat-height.
 */
export const WORLD_TARGET_HEIGHTS = {
  barn: 6.4,
  silo: 8.6,
  windmill: 9.2,
  house: 5.2,
  tower: 10.5,
  bridge: 2.5,
  tree: 4.8,
  well: 2.2,
  fence: 1.25,
  haybale: 1.25,
  car: 1.65,
  spaceship: 3.4,
  character: 1.72,
  robot: 1.95,
  creature: 1.45,
  bust: 0.65,
  lamp: 1.65,
  table: 0.78,
  chair: 0.88,
  bench: 0.86,
  campfire: 0.62,
  rock: 1.15,
  crystal: 1.35,
  shield: 0.95,
  sword: 1.05,
  vase: 0.48,
  bottle: 0.32,
  mug: 0.14,
  sphere: 1.0,
  cube: 1.0,
};

export function defaultWorld() {
  const base = BIOMES.studio;
  const sky = TIME_PRESETS[base.timeOfDay];
  return {
    biome: base.id,
    ground: { ...base.ground, seed: 101 },
    sky: { ...sky },
    fog: { ...base.fog },
    foliage: [],
    clearings: [],
    spawn: { position: [0, 0, 3.5], yaw: 0 },
  };
}

export function normalizeWorld(world) {
  const base = defaultWorld();
  if (!world || typeof world !== 'object') return base;
  return {
    biome: world.biome ?? base.biome,
    ground: { ...base.ground, ...(world.ground ?? {}) },
    sky: { ...base.sky, ...(world.sky ?? {}) },
    fog: { ...base.fog, ...(world.fog ?? {}) },
    foliage: Array.isArray(world.foliage) ? world.foliage.map((f) => ({ ...f })) : [],
    clearings: Array.isArray(world.clearings) ? world.clearings.map((c) => ({ ...c })) : [],
    spawn: { ...base.spawn, ...(world.spawn ?? {}) },
  };
}

export function listBiomes() {
  return Object.values(BIOMES).map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    timeOfDay: b.timeOfDay,
  }));
}

/**
 * Deterministic smooth terrain height (in meters) at world `(x, z)`.
 * Keeps a gentle flattening near the origin spawn so the user never starts buried
 * inside a steep slope, while allowing natural rolling hills across the field.
 */
export function terrainHeightAt(world, x, z) {
  const ground = world?.ground;
  if (!ground || !ground.enabled || !ground.hillHeight) return 0;
  const amp = Number(ground.hillHeight) || 0;
  if (Math.abs(amp) < 1e-5) return 0;
  const scale = Number(ground.hillScale) || 0.035;
  const seed = Number(ground.seed) || 101;
  const sx = x * scale + seed * 0.13;
  const sz = z * scale - seed * 0.07;
  const h1 = Math.sin(sx * 1.0 + 0.4) * Math.cos(sz * 0.9 - 0.2);
  const h2 = 0.45 * Math.sin(sx * 2.1 - sz * 1.4 + 1.7);
  const h3 = 0.22 * Math.cos(sx * 3.3 + sz * 2.7 - 0.9);
  const distFromSpawn = Math.hypot(x - (world?.spawn?.position?.[0] ?? 0), z - (world?.spawn?.position?.[2] ?? 3.5));
  const spawnBlend = Math.min(1, Math.max(0, (distFromSpawn - 2.5) / 6.0));
  return (h1 + h2 + h3) * 0.58 * amp * (0.18 + 0.82 * spawnBlend);
}

export function terrainNormalAt(world, x, z) {
  const eps = 0.25;
  const hL = terrainHeightAt(world, x - eps, z);
  const hR = terrainHeightAt(world, x + eps, z);
  const hD = terrainHeightAt(world, x, z - eps);
  const hU = terrainHeightAt(world, x, z + eps);
  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Merge a biome preset and optional overrides onto an existing world state. */
export function applyWorldEnvironment(current, options = {}) {
  const next = normalizeWorld(current);
  if (options.biome) {
    const preset = BIOMES[options.biome];
    if (!preset) {
      const err = new Error(`Unknown biome "${options.biome}". Available: ${Object.keys(BIOMES).join(', ')}`);
      err.code = 'unknown_biome';
      throw err;
    }
    next.biome = preset.id;
    next.ground = { ...next.ground, ...preset.ground };
    next.sky = { ...(TIME_PRESETS[preset.timeOfDay] ?? TIME_PRESETS.day) };
    next.fog = { ...preset.fog };
    next.foliage = preset.foliage.map((layer) => ({ ...layer }));
  }
  if (options.timeOfDay) {
    const time = TIME_PRESETS[options.timeOfDay];
    if (!time) {
      const err = new Error(`Unknown timeOfDay "${options.timeOfDay}". Available: ${Object.keys(TIME_PRESETS).join(', ')}`);
      err.code = 'unknown_time_of_day';
      throw err;
    }
    next.sky = { ...next.sky, ...time };
    if (options.timeOfDay === 'night') {
      next.fog = { ...next.fog, color: [0.04, 0.07, 0.14] };
    } else if (options.timeOfDay === 'sunset') {
      next.fog = { ...next.fog, color: [0.85, 0.48, 0.32] };
    } else if (options.timeOfDay === 'golden-hour') {
      next.fog = { ...next.fog, color: [0.92, 0.78, 0.54] };
    }
  }
  if (options.ground && typeof options.ground === 'object') {
    next.ground = { ...next.ground, ...options.ground };
  }
  if (options.groundColor) next.ground.color = options.groundColor.slice(0, 3);
  if (options.hillHeight !== undefined) next.ground.hillHeight = Number(options.hillHeight);
  if (options.hillScale !== undefined) next.ground.hillScale = Number(options.hillScale);
  if (options.grid !== undefined) next.ground.grid = Boolean(options.grid);
  if (options.sky && typeof options.sky === 'object') {
    next.sky = { ...next.sky, ...options.sky };
  }
  if (options.fog && typeof options.fog === 'object') {
    next.fog = { ...next.fog, ...options.fog };
  }
  if (Array.isArray(options.foliage)) {
    next.foliage = options.foliage.map((layer, idx) => ({
      id: layer.id ?? `foliage_${idx + 1}`,
      kind: layer.kind ?? 'grass',
      color: layer.color ?? [0.3, 0.55, 0.22],
      tipColor: layer.tipColor ?? layer.color ?? [0.5, 0.75, 0.32],
      count: Math.max(0, Math.min(20000, Number(layer.count ?? 4000))),
      radius: Number(layer.radius ?? 50),
      height: Number(layer.height ?? 0.5),
      wind: Number(layer.wind ?? 0.8),
    }));
  }
  if (options.clearFoliage) next.foliage = [];
  if (options.resetClearings) next.clearings = [];
  return next;
}

export function addWorldClearing(world, x, z, radius) {
  if (!radius || radius < 0.4) return;
  const next = world.clearings ?? [];
  next.push({ x: Number(x.toFixed(3)), z: Number(z.toFixed(3)), radius: Number(radius.toFixed(3)) });
  if (next.length > 128) next.shift();
  world.clearings = next;
}
