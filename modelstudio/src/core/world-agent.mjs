// Natural-language spatial world director.
//
// Two execution engines share the exact same VR context and registry commands:
//   1. `openai` — any OpenAI-compatible Chat Completions endpoint with tool
//      calling (OpenAI ChatGPT, Ollama, LM Studio, OpenRouter, vLLM, Groq, …).
//   2. `local`  — deterministic multi-clause spatial planner that runs offline
//      with zero API keys and zero network dependencies.
//
// Default `provider: "auto"` uses the configured OpenAI-compatible endpoint if
// an API key or custom local baseUrl (e.g. Ollama) is configured, and falls back
// cleanly to `local`.

import { matchArchetype } from '../algorithms/prompt.mjs';
import { fail } from './util.mjs';
import { buildVrContext, resolveSpatialLocation, updateVrState } from './vr-state.mjs';
import { BIOMES, TIME_PRESETS } from './world.mjs';

const runtimeConfig = {
  apiKey: process.env.MODELSTUDIO_AI_KEY ?? process.env.OPENAI_API_KEY ?? '',
  baseUrl: (process.env.MODELSTUDIO_AI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: process.env.MODELSTUDIO_AI_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  provider: process.env.MODELSTUDIO_AI_PROVIDER ?? 'auto',
};

export function getAiConfig() {
  return {
    provider: runtimeConfig.provider,
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
    hasApiKey: Boolean(runtimeConfig.apiKey),
  };
}

export function setAiConfig(patch = {}) {
  if (patch.apiKey !== undefined) runtimeConfig.apiKey = String(patch.apiKey ?? '').trim();
  if (patch.baseUrl !== undefined && String(patch.baseUrl).trim()) {
    runtimeConfig.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
  }
  if (patch.model !== undefined && String(patch.model).trim()) {
    runtimeConfig.model = String(patch.model).trim();
  }
  if (patch.provider !== undefined) {
    runtimeConfig.provider = String(patch.provider).trim() || 'auto';
  }
  return getAiConfig();
}

export function openAiToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'set_world_environment',
        description:
          'Transform the surrounding 3D VR world: set biome (hayfield, meadow, forest, snow, desert, beach, mars, night-clearing, cyberpunk, courtyard, studio), time of day (dawn, day, golden-hour, sunset, night, overcast), hills, and swaying foliage.',
        parameters: {
          type: 'object',
          properties: {
            biome: { type: 'string', enum: Object.keys(BIOMES) },
            timeOfDay: { type: 'string', enum: Object.keys(TIME_PRESETS) },
            hillHeight: { type: 'number', description: 'Terrain hill amplitude in meters (0 = flat, 1.2 = gentle hills, 2.5 = tall dunes/hills)' },
            scatterProps: { type: 'boolean', description: 'Also scatter default biome props such as haybales or trees around the horizon' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spawn_world_object',
        description:
          'Generate and place a real-scale 3D object or building into the VR world. Use at="pointer" whenever the user says "right there", "over there", "there", "here", or points.',
        parameters: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: {
              type: 'string',
              description: 'Object description including colour/size adjectives, e.g. "green barn", "wooden fence", "tall windmill", "golden haybale", "pine tree", "stone tower", "red car", "female character"',
            },
            at: {
              type: 'string',
              description: '"pointer" ("right there" where the VR controller points), "in-front", "left", "right", "behind", "origin", or "x,y,z"',
            },
            scale: { type: 'number', description: 'Optional multiplier on real-world scale (1 = life-size)' },
            yaw: { type: 'number', description: 'Optional yaw angle in degrees; omit to face the player automatically' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'scatter_world_objects',
        description: 'Scatter multiple 3D props/trees/rocks/haybales across an area grounded on the terrain.',
        parameters: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', description: 'e.g. "golden haybale", "pine tree", "grey rock"' },
            count: { type: 'number', description: 'How many instances to place (2..30)' },
            at: { type: 'string', description: '"around-player" or "pointer"' },
            radius: { type: 'number', description: 'Outer scatter radius in meters' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modify_object',
        description: 'Move, scale, rotate, recolor, or delete an existing object (use selector="targeted" when the user says "that" or "this" while pointing at an object).',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            selector: { type: 'string', description: '"targeted" (object under VR ray) or object name' },
            action: { type: 'string', enum: ['move', 'scale', 'rotate', 'color', 'delete'] },
            at: { type: 'string', description: 'Destination for move, e.g. "pointer"' },
            factor: { type: 'number', description: 'Scale multiplier for scale, e.g. 1.5 or 0.6' },
            yawDelta: { type: 'number', description: 'Yaw rotation delta in degrees' },
            color: { type: 'string', description: 'Color name or #hex for color action, e.g. "green", "red", "#2e7d32"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clear_world',
        description: 'Clear spawned objects from the world or reset the environment.',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional name substring to remove (omit or "all" to clear all objects)' },
            resetEnvironment: { type: 'boolean' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'undo_last',
        description: 'Undo the previous world or object change.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeWorldPrompt({
  project,
  runCommand,
  instruction,
  pointer = null,
  head = null,
  inVR = undefined,
  provider = null,
  apiKey = null,
  baseUrl = null,
  model = null,
}) {
  const rawText = String(instruction ?? '').trim();
  if (!rawText) fail('invalid_argument', 'instruction must be a non-empty string');

  // Persist incoming VR pose/pointer snapshot first so downstream commands see exact "right there".
  if (pointer || head || inVR !== undefined) {
    await updateVrState(project, { pointer, head, inVR }, { immediate: true });
  }

  const chosenProvider = provider ?? runtimeConfig.provider ?? 'auto';
  const effectiveKey = apiKey ?? runtimeConfig.apiKey;
  const effectiveBase = (baseUrl ?? runtimeConfig.baseUrl).replace(/\/+$/, '');
  const effectiveModel = model ?? runtimeConfig.model;
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(effectiveBase);

  const shouldUseRemoteLlm =
    chosenProvider === 'openai' ||
    (chosenProvider === 'auto' && (Boolean(effectiveKey) || (Boolean(process.env.MODELSTUDIO_AI_BASE_URL || process.env.OPENAI_BASE_URL) && isLocalEndpoint)));

  if (shouldUseRemoteLlm) {
    try {
      return await runOpenAiWorldAgent({
        project,
        runCommand,
        instruction: rawText,
        apiKey: effectiveKey,
        baseUrl: effectiveBase,
        model: effectiveModel,
      });
    } catch (error) {
      if (chosenProvider === 'openai') throw error;
      // In `auto` mode, fall back gracefully to the local spatial planner if the remote endpoint is unreachable.
      const fallback = await runLocalWorldPlanner({ project, runCommand, instruction: rawText });
      return { ...fallback, fallbackReason: error.message };
    }
  }

  return runLocalWorldPlanner({ project, runCommand, instruction: rawText });
}

// ---------------------------------------------------------------------------
// 1. OpenAI-compatible tool-calling agent (ChatGPT / Ollama / OpenRouter / …)
// ---------------------------------------------------------------------------

async function runOpenAiWorldAgent({ project, runCommand, instruction, apiKey, baseUrl, model }) {
  const { Project } = await import('./project.mjs');
  const liveProject = await Project.open(project.data.name);
  const context = buildVrContext(liveProject);
  const actions = [];

  const messages = [
    {
      role: 'system',
      content: [
        'You are the live spatial AI world builder inside a WebXR VR headset (ModelStudio VR).',
        'The user is standing inside the 3D world right now and pointing with their VR controller or hand.',
        'Whenever the user says "right there", "there", "over there", "here", or "where I point", pass at="pointer" to spawn_world_object.',
        'Whenever the user says "that" or "this" referring to an object they are pointing at, pass selector="targeted" to modify_object.',
        'Execute ALL parts of compound requests (for example: change the environment AND spawn an object at the pointer).',
        'Keep your final spoken confirmation concise (1-2 short sentences).',
        `Live VR spatial context:\n${JSON.stringify(context)}`,
      ].join('\n'),
    },
    { role: 'user', content: instruction },
  ];

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let finalReply = '';
  for (let turn = 0; turn < 4; turn += 1) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        tools: openAiToolSchemas(),
        tool_choice: 'auto',
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      fail('ai_provider_failed', `LLM endpoint ${baseUrl} returned HTTP ${response.status}: ${body.slice(0, 240)}`, { status: 502 });
    }
    const payload = await response.json();
    const message = payload.choices?.[0]?.message;
    if (!message) fail('ai_provider_failed', 'LLM response contained no choices', { status: 502 });
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (!toolCalls.length) {
      finalReply = String(message.content ?? '').trim();
      break;
    }

    for (const call of toolCalls) {
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: call.function?.name,
        args,
      });
      actions.push({ tool: call.function?.name, args, ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(outcome),
      });
    }
  }

  const refreshed = await Project.open(project.data.name);
  return {
    mode: 'openai-compatible',
    model,
    instruction,
    reply: finalReply || summarizeActions(actions),
    actions,
    world: refreshed.data.world,
    context: buildVrContext(refreshed),
  };
}

async function dispatchAgentTool({ projectName, runCommand, name, args }) {
  const { Project } = await import('./project.mjs');
  switch (name) {
    case 'set_world_environment': {
      const res = await runCommand('world.environment', {
        project: projectName,
        biome: args.biome,
        timeOfDay: args.timeOfDay,
        hillHeight: args.hillHeight,
        scatterProps: args.scatterProps ?? Boolean(args.biome),
      });
      return {
        ok: res.ok,
        summary: res.ok ? `Set world environment to ${res.data?.result?.world?.biome ?? args.biome ?? 'custom'}` : res.error?.message,
        data: res.data,
        error: res.error,
      };
    }
    case 'spawn_world_object': {
      const res = await runCommand('world.spawn', {
        project: projectName,
        prompt: args.prompt,
        at: args.at ?? 'pointer',
        scale: args.scale,
        yaw: args.yaw,
      });
      const obj = res.data?.result?.object;
      return {
        ok: res.ok,
        summary: res.ok
          ? `Placed ${obj?.name ?? args.prompt} at (${(obj?.position ?? []).map((n) => Number(n).toFixed(1)).join(', ')})`
          : res.error?.message,
        data: res.data,
        error: res.error,
      };
    }
    case 'scatter_world_objects': {
      const res = await runCommand('world.scatter', {
        project: projectName,
        prompt: args.prompt,
        count: args.count ?? 6,
        at: args.at ?? 'around-player',
        radius: args.radius ?? 28,
      });
      return {
        ok: res.ok,
        summary: res.ok ? `Scattered ${res.data?.result?.created?.length ?? args.count} "${args.prompt}" objects` : res.error?.message,
        data: res.data,
        error: res.error,
      };
    }
    case 'modify_object': {
      const live = await Project.open(projectName);
      const ctx = buildVrContext(live);
      const targetName =
        !args.selector || args.selector === 'targeted' || args.selector === 'that'
          ? ctx.vr.targetedObject?.name ?? Object.values(live.data.objects).slice(-1)[0]?.name
          : args.selector;
      if (!targetName) {
        return { ok: false, error: { code: 'no_target_object', message: 'Point at an object first or name the object to modify.' } };
      }
      if (args.action === 'delete') {
        const res = await runCommand('object.delete', { project: projectName, object: targetName });
        return { ok: res.ok, summary: res.ok ? `Deleted ${targetName}` : res.error?.message, data: res.data, error: res.error };
      }
      if (args.action === 'move') {
        const loc = resolveSpatialLocation(live, args.at ?? 'pointer');
        const res = await runCommand('object.transform', { project: projectName, object: targetName, translation: loc.position });
        return { ok: res.ok, summary: res.ok ? `Moved ${targetName} to (${loc.position.join(', ')})` : res.error?.message, data: res.data, error: res.error };
      }
      if (args.action === 'scale') {
        const obj = live.resolveObjects(targetName)[0];
        const cur = obj?.transform?.scale ?? [1, 1, 1];
        const f = Number(args.factor ?? 1.4);
        const res = await runCommand('object.transform', { project: projectName, object: targetName, scale: cur.map((v) => Number((v * f).toFixed(4))) });
        return { ok: res.ok, summary: res.ok ? `Scaled ${targetName} by ${f}x` : res.error?.message, data: res.data, error: res.error };
      }
      if (args.action === 'rotate') {
        const obj = live.resolveObjects(targetName)[0];
        const cur = obj?.transform?.rotation ?? [0, 0, 0];
        const res = await runCommand('object.transform', { project: projectName, object: targetName, rotation: [cur[0], cur[1] + Number(args.yawDelta ?? 45), cur[2]] });
        return { ok: res.ok, summary: res.ok ? `Rotated ${targetName}` : res.error?.message, data: res.data, error: res.error };
      }
      if (args.action === 'color') {
        const rgb = parseColorSpec(args.color);
        if (!rgb) return { ok: false, error: { code: 'unknown_color', message: `Unknown color "${args.color}"` } };
        const res = await runCommand('material.create', {
          project: projectName,
          name: `${targetName}_${args.color}`,
          baseColorFactor: [...rgb, 1],
          assignTo: targetName,
        });
        return { ok: res.ok, summary: res.ok ? `Recolored ${targetName} to ${args.color}` : res.error?.message, data: res.data, error: res.error };
      }
      return { ok: false, error: { code: 'unknown_action', message: `Unsupported modify_object action "${args.action}"` } };
    }
    case 'clear_world': {
      const res = await runCommand('world.clear', {
        project: projectName,
        filter: args.filter,
        resetEnvironment: Boolean(args.resetEnvironment),
      });
      return { ok: res.ok, summary: res.ok ? 'Cleared world objects' : res.error?.message, data: res.data, error: res.error };
    }
    case 'undo_last': {
      const res = await runCommand('project.undo', { project: projectName });
      return { ok: res.ok, summary: res.ok ? 'Undid last change' : res.error?.message, data: res.data, error: res.error };
    }
    default:
      return { ok: false, error: { code: 'unknown_tool', message: `Unknown tool "${name}"` } };
  }
}

// ---------------------------------------------------------------------------
// 2. Local deterministic spatial natural-language planner (zero API key!)
// ---------------------------------------------------------------------------

const BIOME_PATTERNS = [
  { biome: 'hayfield', re: /\b(hay\s*field|hayfield|wheat\s*field|wheatfield|farmland|farm\s*field|barley\s*field|corn\s*field|harvest\s*field)\b/i },
  { biome: 'night-clearing', re: /\b(firefl(?:y|ies)|starlit\s*clearing|night\s*clearing)\b/i },
  { biome: 'meadow', re: /\b(meadow|grassland|pasture|grassy\s*field|green\s*field|prairie|wildflower\s*field)\b/i },
  { biome: 'forest', re: /\b(pine\s*forest|forest|woods|woodland|jungle)\b/i },
  { biome: 'snow', re: /\b(snow\s*field|snowfield|snowy|winter\s*world|winter|tundra|arctic|blizzard)\b/i },
  { biome: 'desert', re: /\b(desert|sand\s*dunes?|dunes|sahara|arid|badlands)\b/i },
  { biome: 'beach', re: /\b(beach|coastal|coast|seaside|shore|sandbar|island)\b/i },
  { biome: 'mars', re: /\b(mars|martian|red\s*planet|alien\s*planet)\b/i },
  { biome: 'cyberpunk', re: /\b(cyberpunk|neon\s*grid|synthwave|tron|neon\s*city)\b/i },
  { biome: 'courtyard', re: /\b(courtyard|plaza|town\s*square|cobblestone)\b/i },
  { biome: 'studio', re: /\b(studio\s*grid|empty\s*studio|studio|blank\s*grid|void)\b/i },
];

const TIME_PATTERNS = [
  { timeOfDay: 'golden-hour', re: /\b(golden\s*hour|late\s*afternoon|magic\s*hour)\b/i },
  { timeOfDay: 'sunset', re: /\b(sunset|dusk|twilight|evening)\b/i },
  { timeOfDay: 'dawn', re: /\b(dawn|sunrise|early\s*morning)\b/i },
  { timeOfDay: 'night', re: /\b(night\s*time|nighttime|midnight|moonlit|moonlight|starry|at\s+night|\bnight\b)\b/i },
  { timeOfDay: 'overcast', re: /\b(overcast|cloudy|foggy|misty)\b/i },
  { timeOfDay: 'day', re: /\b(midday|noon|sunny|daylight|daytime|bright\s+day)\b/i },
];

const COLOR_MAP = {
  red: [0.72, 0.14, 0.14],
  crimson: [0.6, 0.08, 0.12],
  maroon: [0.44, 0.1, 0.14],
  orange: [0.9, 0.45, 0.12],
  amber: [0.9, 0.62, 0.14],
  yellow: [0.9, 0.82, 0.2],
  gold: [0.83, 0.68, 0.22],
  golden: [0.85, 0.68, 0.24],
  green: [0.22, 0.56, 0.26],
  'dark green': [0.13, 0.36, 0.17],
  'forest green': [0.14, 0.38, 0.18],
  olive: [0.34, 0.42, 0.2],
  sage: [0.46, 0.58, 0.44],
  emerald: [0.1, 0.6, 0.4],
  teal: [0.1, 0.6, 0.62],
  cyan: [0.2, 0.75, 0.8],
  blue: [0.2, 0.35, 0.72],
  navy: [0.1, 0.15, 0.35],
  purple: [0.42, 0.22, 0.65],
  pink: [0.85, 0.45, 0.6],
  white: [0.92, 0.92, 0.94],
  cream: [0.94, 0.91, 0.82],
  beige: [0.84, 0.78, 0.65],
  tan: [0.76, 0.64, 0.46],
  brown: [0.45, 0.3, 0.18],
  rust: [0.62, 0.24, 0.14],
  grey: [0.5, 0.5, 0.52],
  gray: [0.5, 0.5, 0.52],
  silver: [0.75, 0.76, 0.78],
  charcoal: [0.16, 0.17, 0.19],
  black: [0.08, 0.08, 0.1],
};

const NUMBER_WORDS = {
  two: 2, a_couple: 2, couple: 2, few: 4, several: 5, some: 5,
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

function stripWakeWords(input) {
  return String(input ?? '')
    .replace(/^[\s,.:;—-]+/, '')
    .replace(/^(?:hey|ok|okay|yo|hi)\s+(?:chat\s*gpt|claude|assistant|ai|computer|model\s*studio)[\s,.:;!-]*/i, '')
    .replace(/^(?:chat\s*gpt|claude|assistant|computer|model\s*studio)[\s,.:;!-]+/i, '')
    .replace(/^(?:can\s+you|could\s+you|would\s+you|please)\s+/i, '')
    .replace(/[\s—-]+$/g, '')
    .replace(/--+$/g, '')
    .trim();
}

function splitClauses(cleaned) {
  // Split compound commands while keeping noun modifiers intact.
  const normalized = cleaned
    .replace(/\s*;\s*/g, ' |SPLIT| ')
    .replace(/\b(?:and\s+then|then\s+also|and\s+also|then)\b/gi, ' |SPLIT| ')
    .replace(
      /,?\s+\band\s+(?=(?:make|turn|set|change|put|place|add|spawn|create|build|drop|scatter|plant|move|relocate|delete|remove|destroy|clear|paint|color|recolor|scale|resize|shrink|grow|rotate|spin|undo)\b)/gi,
      ' |SPLIT| ',
    )
    .replace(
      /,\s*(?=(?:make|turn|set|change|put|place|add|spawn|create|build|drop|scatter|plant|move|delete|remove|clear|paint|color|scale|rotate|undo)\b)/gi,
      ' |SPLIT| ',
    );
  return normalized.split('|SPLIT|').map((part) => part.trim()).filter(Boolean);
}

function extractSpatialAt(clause) {
  const lower = clause.toLowerCase();
  const coordMatch = lower.match(/\bat\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)?/);
  if (coordMatch) {
    const a = Number(coordMatch[1]);
    const b = Number(coordMatch[2]);
    const c = coordMatch[3] !== undefined ? Number(coordMatch[3]) : null;
    return c !== null ? [a, b, c] : [a, 0, b];
  }
  if (/\b(right\s+there|over\s+there|right\s+here|over\s+here|where\s+i(?:'m|\s+am)?\s+pointing|where\s+i\s+point|at\s+(?:my\s+)?pointer|at\s+the\s+cursor|at\s+the\s+pin|\bthere\b|\bhere\b)\b/i.test(lower)) {
    return 'pointer';
  }
  if (/\b(in\s+front\s+of\s+me|ahead\s+of\s+me|straight\s+ahead|in\s+front)\b/i.test(lower)) return 'in-front';
  if (/\b(to\s+my\s+left|on\s+my\s+left|on\s+the\s+left)\b/i.test(lower)) return 'left';
  if (/\b(to\s+my\s+right|on\s+my\s+right|on\s+the\s+right)\b/i.test(lower)) return 'right';
  if (/\b(behind\s+me|in\s+back\s+of\s+me)\b/i.test(lower)) return 'behind';
  if (/\b(at\s+(?:the\s+)?center|at\s+origin|in\s+the\s+middle)\b/i.test(lower)) return 'origin';
  return 'pointer';
}

function stripLocationPhrases(text) {
  return text
    .replace(/\b(right\s+there|over\s+there|right\s+here|over\s+here|where\s+i(?:'m|\s+am)?\s+pointing|where\s+i\s+point|at\s+(?:my\s+)?pointer|at\s+the\s+cursor|at\s+the\s+pin|in\s+front\s+of\s+me|ahead\s+of\s+me|straight\s+ahead|to\s+my\s+left|on\s+my\s+left|to\s+my\s+right|on\s+my\s+right|behind\s+me|around\s+me|around\s+the\s+field|around\s+here|in\s+the\s+field|across\s+the\s+field|at\s+(?:the\s+)?center|at\s+origin|in\s+the\s+middle)\b/gi, ' ')
    .replace(/\s+\b(there|here)\b\s*$/i, ' ')
    .replace(/--+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseColorSpec(spec) {
  if (!spec) return null;
  const s = String(spec).trim().toLowerCase();
  if (s.startsWith('#') && (s.length === 7 || s.length === 4)) {
    const hex = s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
    return [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];
  }
  for (const [name, rgb] of Object.entries(COLOR_MAP)) {
    if (s === name || s.includes(name)) return rgb;
  }
  return null;
}

function normalizePromptSynonyms(text) {
  return text
    .replace(/\bhay\s+bales?\b/gi, 'haybale')
    .replace(/\bstraw\s+bales?\b/gi, 'haybale')
    .replace(/\bgrain\s+silos?\b/gi, 'silo')
    .replace(/\bwater\s+towers?\b/gi, 'silo')
    .replace(/\bfire\s+pits?\b/gi, 'campfire')
    .replace(/\bpicket\s+fences?\b/gi, 'fence')
    .replace(/\bwooden\s+fences?\b/gi, 'wooden fence');
}

async function runLocalWorldPlanner({ project, runCommand, instruction }) {
  const { Project } = await import('./project.mjs');
  const cleaned = stripWakeWords(instruction);
  const clauses = splitClauses(cleaned);
  const actions = [];

  for (const rawClause of clauses) {
    const clause = rawClause.replace(/^[,\s]+|[,\s—-]+$/g, '').trim();
    if (!clause) continue;
    const lower = clause.toLowerCase();

    // 1. Undo
    if (/^(?:please\s+)?undo\b/i.test(lower)) {
      const outcome = await dispatchAgentTool({ projectName: project.data.name, runCommand, name: 'undo_last', args: {} });
      actions.push({ clause, tool: 'undo_last', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 2. Clear world / remove all
    if (/^(?:clear|reset|wipe)\s+(?:the\s+)?(?:world|scene|everything|all\s+objects)\b/i.test(lower)) {
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'clear_world',
        args: { resetEnvironment: /\breset\b/i.test(lower) },
      });
      actions.push({ clause, tool: 'clear_world', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 3. Delete targeted or named object
    const deleteMatch = lower.match(/^(?:delete|remove|destroy|erase)\s+(?:the\s+)?(.+)$/i);
    if (deleteMatch) {
      const what = stripLocationPhrases(deleteMatch[1]).trim();
      const selector = /^(?:that|this|it|that\s+one|that\s+object)$/i.test(what) ? 'targeted' : what;
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'modify_object',
        args: { selector, action: 'delete' },
      });
      actions.push({ clause, tool: 'modify_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 4. Environment / biome / time-of-day / terrain hills
    const matchedBiome = BIOME_PATTERNS.find((b) => b.re.test(lower));
    const matchedTime = TIME_PATTERNS.find((t) => t.re.test(lower));
    const wantsFlat = /\b(flat\s+ground|flatten\s+(?:the\s+)?(?:ground|terrain|hills)|no\s+hills)\b/i.test(lower);
    const wantsHills = /\b(rolling\s+hills|add\s+hills|make\s+it\s+hilly|tall\s+hills|mountains)\b/i.test(lower);

    const looksLikeEnv =
      Boolean(matchedBiome) ||
      (Boolean(matchedTime) && !/\b(put|place|spawn|add|create|build|drop|scatter)\b/i.test(lower)) ||
      wantsFlat ||
      wantsHills;

    if (looksLikeEnv && !/^(?:put|place|spawn|drop|scatter)\b/i.test(lower)) {
      const envArgs = {};
      if (matchedBiome) envArgs.biome = matchedBiome.biome;
      if (matchedTime) envArgs.timeOfDay = matchedTime.timeOfDay;
      if (wantsFlat) envArgs.hillHeight = 0;
      else if (wantsHills) envArgs.hillHeight = 2.2;
      envArgs.scatterProps = Boolean(matchedBiome) && !/\b(?:empty|bare|no\s+props)\b/i.test(lower);
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'set_world_environment',
        args: envArgs,
      });
      actions.push({ clause, tool: 'set_world_environment', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 5. Move existing object ("move that right there", "move the barn over here")
    const moveMatch = lower.match(/^(?:move|relocate|shift|bring)\s+(?:the\s+)?(.+?)\s+(?:to\s+)?(right\s+there|over\s+there|there|here|right\s+here|in\s+front\s+of\s+me|to\s+my\s+left|to\s+my\s+right|behind\s+me|where\s+i(?:'m|\s+am)?\s+pointing)$/i);
    if (moveMatch) {
      const what = moveMatch[1].trim();
      const selector = /^(?:that|this|it)$/i.test(what) ? 'targeted' : what;
      const at = extractSpatialAt(moveMatch[2]);
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'modify_object',
        args: { selector, action: 'move', at },
      });
      actions.push({ clause, tool: 'modify_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 6. Scale existing object ("make that bigger", "make the barn huge", "shrink it")
    const scaleMatch = lower.match(/^(?:make|scale|resize)\s+(?:the\s+)?(.+?)\s+(bigger|larger|huge|giant|massive|smaller|tinier|tiny|twice\s+as\s+big|half\s+the\s+size|\d+(?:\.\d+)?x)$/i)
      ?? lower.match(/^(shrink|enlarge|double)\s+(?:the\s+)?(.+)$/i);
    if (scaleMatch) {
      let what;
      let word;
      if (/^(shrink|enlarge|double)$/i.test(scaleMatch[1])) {
        word = scaleMatch[1].toLowerCase();
        what = scaleMatch[2].trim();
      } else {
        what = scaleMatch[1].trim();
        word = scaleMatch[2].toLowerCase();
      }
      const selector = /^(?:that|this|it)$/i.test(what) ? 'targeted' : what;
      let factor = 1.45;
      if (word.endsWith('x')) factor = Number(word.slice(0, -1)) || 1.5;
      else if (word === 'huge' || word === 'giant' || word === 'massive' || word === 'twice as big' || word === 'double') factor = 2.0;
      else if (word === 'smaller' || word === 'shrink') factor = 0.68;
      else if (word === 'tiny' || word === 'tinier' || word === 'half the size') factor = 0.5;
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'modify_object',
        args: { selector, action: 'scale', factor },
      });
      actions.push({ clause, tool: 'modify_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 7. Rotate existing object ("rotate that 90 degrees", "turn the barn around")
    const rotateMatch = lower.match(/^(?:rotate|turn|spin)\s+(?:the\s+)?(.+?)(?:\s+(?:by\s+)?(-?\d+)\s*(?:deg(?:rees)?)?|\s+(around))?$/i);
    if (rotateMatch && (rotateMatch[2] || rotateMatch[3] || /^(?:that|this|it)$/i.test(rotateMatch[1]))) {
      const what = rotateMatch[1].trim();
      const selector = /^(?:that|this|it)$/i.test(what) ? 'targeted' : what;
      const yawDelta = rotateMatch[3] ? 180 : Number(rotateMatch[2] ?? 45);
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'modify_object',
        args: { selector, action: 'rotate', yawDelta },
      });
      actions.push({ clause, tool: 'modify_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 8. Recolor existing object ("paint that green", "make the barn red", "color it gold")
    const colorMatch = lower.match(/^(?:paint|recolor|colour|color|make|turn)\s+(?:the\s+)?(.+?)\s+(dark\s+green|forest\s+green|red|crimson|maroon|orange|amber|yellow|gold|golden|green|olive|sage|emerald|teal|cyan|blue|navy|purple|pink|white|cream|beige|tan|brown|rust|grey|gray|silver|charcoal|black|#[0-9a-f]{3,6})$/i);
    if (colorMatch) {
      const what = colorMatch[1].trim();
      const colorWord = colorMatch[2].trim();
      // Make sure "make this a hayfield" was already caught above and "what" isn't an article like "a"
      if (!/^(?:this|the\s+world|it\s+a)\b/i.test(what)) {
        const selector = /^(?:that|this|it)$/i.test(what) ? 'targeted' : what;
        const outcome = await dispatchAgentTool({
          projectName: project.data.name,
          runCommand,
          name: 'modify_object',
          args: { selector, action: 'color', color: colorWord },
        });
        actions.push({ clause, tool: 'modify_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
        continue;
      }
    }

    // 9. Scatter multiple objects ("scatter 8 hay bales", "put 5 pine trees around me")
    const withoutVerbs = normalizePromptSynonyms(
      stripLocationPhrases(clause)
        .replace(/^(?:please\s+)?(?:scatter|plant|sprinkle|put|place|add|spawn|create|build|drop|make)\s+/i, '')
        .trim(),
    );
    const qtyMatch = withoutVerbs.match(/^(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|some|several|few|a\s+few|a\s+couple(?:\s+of)?)\s+(.+)$/i);
    const explicitScatter = /^(?:scatter|sprinkle|plant)\b/i.test(lower) || /\b(around\s+me|around\s+the\s+field|across\s+the\s+field|everywhere)\b/i.test(lower);
    if (qtyMatch || explicitScatter) {
      const rawQty = qtyMatch ? qtyMatch[1].toLowerCase().replace(/\s+/g, '_').replace(/^a_/, '') : '6';
      const count = Math.max(2, Math.min(24, Number(rawQty) || NUMBER_WORDS[rawQty] || 6));
      const nounPhrase = (qtyMatch ? qtyMatch[2] : withoutVerbs).replace(/\b(?:of)\s+/i, '').trim();
      const scatterAt = /\b(there|here|pointer|pointing)\b/i.test(lower) && !/\baround\s+me\b/i.test(lower) ? 'pointer' : 'around-player';
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'scatter_world_objects',
        args: { prompt: nounPhrase, count, at: scatterAt, radius: scatterAt === 'pointer' ? 14 : 28 },
      });
      actions.push({ clause, tool: 'scatter_world_objects', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 10. Spawn a single object at the resolved spatial target ("put a green barn right there")
    const spawnPhrase = normalizePromptSynonyms(
      stripLocationPhrases(clause)
        .replace(/^(?:please\s+)?(?:put|place|add|spawn|create|build|drop|summon|generate|make\s+me|make)\s+/i, '')
        .replace(/^(?:a|an|one)\s+/i, '')
        .trim(),
    );
    const probe = matchArchetype(spawnPhrase);
    if (probe.key || /\b(sphere|ball|orb|cube|box|block)\b/i.test(spawnPhrase)) {
      const at = extractSpatialAt(clause);
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'spawn_world_object',
        args: { prompt: spawnPhrase, at },
      });
      actions.push({ clause, tool: 'spawn_world_object', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    // 11. Time-of-day standalone fallback (e.g. "sunset" or "make it sunset")
    if (matchedTime) {
      const outcome = await dispatchAgentTool({
        projectName: project.data.name,
        runCommand,
        name: 'set_world_environment',
        args: { timeOfDay: matchedTime.timeOfDay, scatterProps: false },
      });
      actions.push({ clause, tool: 'set_world_environment', ok: outcome.ok, summary: outcome.summary, data: outcome.data, error: outcome.error });
      continue;
    }

    actions.push({
      clause,
      tool: null,
      ok: false,
      error: {
        code: 'unrecognized_instruction',
        message: `Could not map "${clause}" to a world environment or 3D archetype.`,
      },
    });
  }

  if (actions.length === 0 || actions.every((a) => !a.ok)) {
    fail('instruction_unmatched', `Could not understand world command: "${instruction}"`, {
      status: 422,
      hint: 'Try e.g. "make this a hayfield and put a green barn right there", "scatter 6 hay bales around me", "paint that red", or configure an OpenAI-compatible LLM endpoint.',
      details: { actions },
    });
  }

  const refreshed = await Project.open(project.data.name);
  return {
    mode: 'local-spatial-planner',
    instruction,
    reply: summarizeActions(actions),
    actions,
    world: refreshed.data.world,
    context: buildVrContext(refreshed),
  };
}

function summarizeActions(actions) {
  const succeeded = actions.filter((a) => a.ok && a.summary).map((a) => a.summary);
  if (!succeeded.length) return 'Done.';
  return `${succeeded.join(', and ')}.`;
}
