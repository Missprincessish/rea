#!/usr/bin/env node
// modelstudio CLI.
//
// Every subcommand dispatches to the shared command registry, so CLI behaviour
// and API/MCP behaviour are identical by construction.
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS, PROJECTS_ROOT, getCommand, listCommands, runCommand } from '../core/operations.mjs';
import { Project } from '../core/project.mjs';
import { listProviders } from '../providers/index.mjs';
import { listWorkflows } from '../core/workflows.mjs';
import { startServer } from '../server/main.mjs';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const TEAL = '\u001b[38;5;37m';
const GREEN = '\u001b[38;5;42m';
const PURPLE = '\u001b[38;5;141m';
const RED = '\u001b[38;5;203m';
const YELLOW = '\u001b[38;5;221m';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `${code}${text}${RESET}` : String(text));

// Friendly aliases -> registry command ids.
const ALIASES = {
  new: 'project.create',
  projects: 'project.list',
  commands: '__commands',
  ls: 'project.list',
  inspect: 'object.inspect',
  info: 'object.inspect',
  objects: 'object.list',
  add: 'object.add',
  generate: 'generate.text',
  repair: 'mesh.repair',
  remesh: 'mesh.remesh',
  decimate: 'mesh.decimate',
  smooth: 'mesh.smooth',
  uv: 'mesh.uv',
  sculpt: 'mesh.sculpt',
  materials: 'material.list',
  material: 'material.edit',
  paint: 'texture.paint',
  bake: 'texture.bake',
  rig: 'rig.create',
  pose: 'rig.pose',
  animate: 'animation.create',
  animations: 'animation.list',
  import: 'import.glb',
  export: 'export.glb',
  preview: 'preview.render',
  workflow: 'workflow.run',
  workflows: 'workflow.list',
  undo: 'project.undo',
  redo: 'project.redo',
  snapshot: 'project.snapshot',
  world: 'world.get',
  biome: 'world.environment',
  spawn: 'world.spawn',
  scatter: 'world.scatter',
  say: 'world.prompt',
  vr: 'vr.context',
  serve: '__serve',
  help: '__help',
  '--help': '__help',
  '-h': '__help',
  '--version': '__version',
};

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1];
        i += 1;
      }
      if (flags[key] !== undefined) {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function coerceValue(schema, key, value) {
  if (value === true || value === undefined) return value;
  const prop = schema?.properties?.[key];
  if (!prop) return value;
  if (prop.type === 'integer' || prop.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (prop.type === 'boolean') return value === 'true' || value === '1' || value === 'yes';
  if (prop.type === 'array') {
    const items = Array.isArray(value) ? value : String(value).split(',');
    if (prop.items?.type === 'object') return items.map((item) => parseJsonish(item));
    if (prop.items?.type === 'number' || prop.items?.type === 'integer') return items.map(Number);
    return items;
  }
  if (prop.type === 'object' || prop.type === undefined) return parseJsonish(value);
  return value;
}

function parseJsonish(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (trimmed.includes(',') && trimmed.split(',').every((part) => Number.isFinite(Number(part)))) {
    return trimmed.split(',').map(Number);
  }
  return value;
}

function buildInput(command, { flags, positional }) {
  const schema = command.inputSchema;
  const input = {};
  const positionalUsed = { project: false, main: false };
  for (const [key, raw] of Object.entries(flags)) {
    if (key === 'json' || key === 'help' || key === 'pretty' || key === 'quiet' || key === 'no-save') continue;
    if (key === 'mesh' || key === 'target') {
      input.object = raw;
      continue;
    }
    if (key === 'image' || key === 'ref') {
      const values = Array.isArray(raw) ? raw : [raw];
      input.images = values.map((entry) => {
        const [file, angle] = String(entry).split(/[:@]/);
        return angle !== undefined && Number.isFinite(Number(angle)) ? { path: file, angle: Number(angle) } : { path: file };
      });
      continue;
    }
    input[key] = coerceValue(schema, key, raw);
  }
  // Positional arguments, in order of preference:
  //   import.*      file first, then optional project
  //   generate.text prompt first (unflagged), then optional project
  //   workflow.run  workflow id, then project
  //   project.create name
  //   everything else project, then free text (e.g. a new name)
  const rest = [...positional];
  const take = () => (rest.length ? rest.shift() : undefined);
  const props = schema?.properties ?? {};
  const isNumeric = (value) => Number.isFinite(Number(value)) && String(value).trim() !== '';

  if (command.id.startsWith('import.') && props.path && input.path === undefined && rest.length) {
    input.path = take();
  }
  if (command.id === 'generate.text' && props.prompt && input.prompt === undefined && rest.length) {
    const chunks = [];
    while (rest.length && !(props.project && input.project === undefined && rest.length === 1)) chunks.push(take());
    input.prompt = chunks.join(' ').trim();
  }
  if (command.id === 'workflow.run' && props.workflow && input.workflow === undefined) {
    input.workflow = take();
  }
  if (props.project && input.project === undefined) {
    const candidate = rest[0];
    if (candidate !== undefined && !(props.prompt && input.prompt === undefined && !isNumeric(candidate) && rest.length > 1)) {
      input.project = take();
    }
  }
  if (rest.length) {
    if (props.name && input.name === undefined) input.name = rest.join(' ');
    else if (props.prompt && input.prompt === undefined) input.prompt = rest.join(' ');
    else if (props.path && input.path === undefined) input.path = rest.join(' ');
  }
  return input;
}

function formatValue(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'number') return `[${value.map((v) => formatValue(v)).join(', ')}]`;
    if (value.length > 6) return `${paint(DIM, `[${value.length} items]`)}`;
    return `[\n${value.map((v) => `${pad}  ${formatValue(v, indent + 2)}`).join('\n')}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    return `${paint(DIM, '{')}\n${entries
      .map(([k, v]) => `${pad}  ${paint(DIM, k)}: ${formatValue(v, indent + 2)}`)
      .join('\n')}\n${pad}${paint(DIM, '}')}`;
  }
  return String(value);
}

function printResult(result, { json, quiet }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (quiet) return;
  if (!result.ok) {
    const error = result.error ?? {};
    process.stderr.write(`${paint(RED, 'x')} ${paint(BOLD, error.code ?? 'error')}: ${error.message ?? 'unknown error'}\n`);
    if (error.details) process.stderr.write(`${paint(DIM, JSON.stringify(error.details, null, 2).slice(0, 2000))}\n`);
    if (error.hint) process.stderr.write(`${paint(YELLOW, 'hint:')} ${error.hint}\n`);
    return;
  }
  const data = result.data ?? {};
  process.stdout.write(`${paint(GREEN, 'OK')} ${paint(BOLD, result.command)} ${paint(DIM, `${result.durationMs}ms`)}\n`);
  const skip = new Set(['project', 'png', 'geometry']);
  const entries = Object.entries(data).filter(([k, v]) => !skip.has(k) && v !== undefined);
  for (const [key, value] of entries) {
    process.stdout.write(`  ${paint(TEAL, key)}: ${formatValue(value, 2).replace(/\n\s*$/, '')}\n`);
  }
  if (data.project?.stats) {
    const stats = data.project.stats;
    process.stdout.write(`  ${paint(DIM, `project ${data.project.name} rev ${data.project.revision} · ${stats.objects} objects · ${stats.triangles} tris · ${stats.textures} textures`)}\n`);
  }
  if (data.path) process.stdout.write(`  ${paint(PURPLE, 'output')} ${data.path}\n`);
}

function printHelp() {
  const categories = new Map();
  for (const command of COMMANDS) {
    if (!categories.has(command.category)) categories.set(command.category, []);
    categories.get(command.category).push(command);
  }
  process.stdout.write(`${paint(TEAL, paint(BOLD, 'modelstudio'))} - 3D creation studio with a programmatic core\n\n`);
  process.stdout.write(`${paint(BOLD, 'Usage')}  modelstudio <command|alias> [flags] [--json]\n\n`);
  process.stdout.write(`${paint(BOLD, 'Quick start')}\n`);
  process.stdout.write(`  modelstudio new "My Character"\n`);
  process.stdout.write(`  modelstudio generate --project "My Character" --prompt "realistic wooden chair"\n`);
  process.stdout.write(`  modelstudio rig --project "My Character" --object "realistic wooden chair"\n`);
  process.stdout.write(`  modelstudio export --project "My Character" --format glb\n`);
  process.stdout.write(`  modelstudio serve            # API + editor on :4317\n\n`);
  for (const [category, list] of categories) {
    process.stdout.write(`${paint(PURPLE, paint(BOLD, category))}\n`);
    for (const command of list) {
      const aliases = Object.entries(ALIASES).filter(([, id]) => id === command.id).map(([alias]) => alias);
      process.stdout.write(`  ${paint(TEAL, command.id.padEnd(24))} ${command.description.slice(0, 92)}${aliases.length ? paint(DIM, `  (${aliases.join(', ')})`) : ''}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`${paint(BOLD, 'Workflows')}  ${listWorkflows().map((w) => w.id).join(', ')}\n`);
  process.stdout.write(`${paint(BOLD, 'Providers')}  ${listProviders().map((p) => `${p.id}${p.available ? '' : ' (not configured)'}`).join(', ')}\n`);
  process.stdout.write(`${paint(BOLD, 'Workspace')}  ${PROJECTS_ROOT}\n`);
  process.stdout.write(`${paint(DIM, 'Add --json for machine-readable output. Geometry data is never printed to the terminal.')}\n`);
}

async function main(argv) {
  const parsed = parseFlags(argv);
  const { flags } = parsed;
  const raw = parsed.positional[0] ?? 'help';
  const commandId = ALIASES[raw] ?? raw;
  // Everything after the command token is that command's arguments.
  const commandArgv = argv.slice(argv.indexOf(raw) + 1);
  const json = Boolean(flags.json);

  if (commandId === '__help') {
    printHelp();
    return 0;
  }
  if (commandId === '__commands') {
    const commands = listCommands();
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, command: 'command.list', data: { commands } }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${paint(BOLD, `${commands.length} commands`)} ${paint(DIM, '(all are executable over CLI, HTTP and MCP)')}\n`);
    return 0;
  }
  if (commandId === '__version') {
    process.stdout.write('modelstudio 0.1.0\n');
    return 0;
  }
  if (commandId === '__serve') {
    const port = Number(flags.port ?? 4317);
    const useHttps = Boolean(flags.https || flags.httpsPort);
    const { port: actual, httpsPort, ips } = await startServer({
      port,
      dev: Boolean(flags.dev),
      host: flags.host ?? '0.0.0.0',
      https: useHttps,
      ...(flags.httpsPort ? { httpsPort: Number(flags.httpsPort) } : {}),
    });
    process.stdout.write(`${paint(GREEN, 'OK')} ModelStudio API + VR on ${paint(TEAL, `http://127.0.0.1:${actual}`)} ${paint(DIM, `(${PROJECTS_ROOT})`)}\n`);
    process.stdout.write(`  ${paint(DIM, `VR World: http://localhost:${actual}/vr  ·  Open MCP: http://localhost:${actual}/mcp`)}\n`);
    if (httpsPort) {
      const lan = (ips ?? []).find((ip) => ip !== '127.0.0.1') ?? '127.0.0.1';
      process.stdout.write(`  ${paint(TEAL, `Meta Quest / WebXR HTTPS: https://${lan}:${httpsPort}/vr`)}\n`);
    }
    return new Promise(() => {});
  }

  const command = getCommand(commandId);
  if (!command) {
    process.stderr.write(`${paint(RED, 'x')} Unknown command "${raw}"\n`);
    const similar = listCommands().map((c) => c.id).filter((id) => id.includes(raw) || raw.includes(id.split('.')[0]));
    if (similar.length) process.stderr.write(`  ${paint(DIM, `did you mean: ${similar.slice(0, 6).join(', ')}`)}\n`);
    process.stderr.write(`  ${paint(DIM, 'run `modelstudio help` for the command list')}\n`);
    return 1;
  }
  if (flags.help) {
    process.stdout.write(`${paint(BOLD, command.id)} — ${command.description}\n`);
    process.stdout.write(`${paint(DIM, JSON.stringify(command.inputSchema, null, 2))}\n`);
    if (command.examples.length) process.stdout.write(`\n${paint(BOLD, 'Examples')}\n${command.examples.map((e) => `  ${e}`).join('\n')}\n`);
    return 0;
  }

  // Resolve default project when a project ref is optional/absent.
  const parsedArgs = parseFlags(commandArgv);
  let input = buildInput(command, parsedArgs);
  if (command.inputSchema?.properties?.project && !input.project) {
    const projects = await Project.list(PROJECTS_ROOT);
    if (projects.length === 1) input.project = projects[0].name;
    else if (projects.length > 1) {
      process.stderr.write(`${paint(RED, 'x')} Multiple projects exist; pass --project <name>\n`);
      process.stderr.write(`  ${paint(DIM, projects.map((p) => p.name).join(', '))}\n`);
      return 1;
    }
  }

  const result = await runCommand(command.id, input);
  printResult(result, { json, quiet: Boolean(flags.quiet) });
  return result.ok ? 0 : 1;
}

export function resolveInput(command, argv) {
  const parsed = parseFlags(argv);
  return buildInput(command, parsed);
}

function invokedDirectly() {
  const entry = process.argv[1] ?? '';
  return /(^|\/)(modelstudio(\.mjs)?|main\.mjs)$/.test(entry) || entry.endsWith('bin/modelstudio.mjs');
}

if (invokedDirectly() && process.env.MODELSTUDIO_NO_AUTORUN !== '1') {
  const argv = process.argv.slice(2);
  if (argv.length && ALIASES[argv[0]]) argv[0] = ALIASES[argv[0]];
  main(argv)
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${paint(RED, 'x')} ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

export { main, parseFlags, buildInput };
void fs;
void path;
void paint(BOLD, '');
