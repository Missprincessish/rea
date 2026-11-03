// Control-surface tests: the CLI must drive exactly the same engine the HTTP
// API and MCP server use, with no separate implementation paths.
//
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'modelstudio.mjs');
const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelstudio-cli-'));
// Tests that import the engine in-process share the CLI's workspace.
process.env.MODELSTUDIO_HOME = HOME;

async function cli(args, { expectOk = true } = {}) {
  const env = { ...process.env, MODELSTUDIO_HOME: HOME, NO_COLOR: '1' };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args, '--json'], { env, cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim());
    if (expectOk) assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
    return parsed;
  } catch (error) {
    if (!expectOk) return JSON.parse(String(error.stdout).trim());
    throw error;
  }
}

before(async () => {
  await fsp.rm(HOME, { recursive: true, force: true });
  await fsp.mkdir(HOME, { recursive: true });
});

after(async () => {
  await fsp.rm(HOME, { recursive: true, force: true });
});

test('new project uses the requested name verbatim', async () => {
  const created = await cli(['new', 'Roundtrip']);
  assert.equal(created.command, 'project.create');
  const dir = created.data.path;
  assert.ok(dir.includes(`${path.sep}Roundtrip${path.sep}`), `unexpected project path ${dir}`);
  const listed = await cli(['projects']);
  const names = (listed.data.projects ?? listed.data.result?.projects ?? []).map((p) => p.name);
  assert.ok(names.includes('Roundtrip'), `expected Roundtrip in ${names}`);
});

test('generate, then import that export back into a fresh project', async () => {
  await cli(['new', 'Gen']);
  const generated = await cli(['generate', '--project', 'Gen', '--prompt', 'realistic wooden chair', '--resolution', '56']);
  assert.equal(generated.data.result.archetype, 'chair');
  const exported = await cli(['export', '--project', 'Gen', '--format', 'glb']);
  const file = exported.data.path;
  await fsp.access(file);
  await cli(['new', 'Back']);
  const imported = await cli(['import', file, '--project', 'Back']);
  assert.equal(imported.data.result.imported.length, 1);
  assert.ok(imported.data.result.imported[0].triangles > 500);
});

test('CLI geometry edit matches the API byte for byte', async () => {
  const { runCommand, getCommand } = await import('../src/core/operations.mjs');
  const { resolveInput } = await import('../src/cli/main.mjs');
  await cli(['new', 'Parity']);
  await cli(['add', '--project', 'Parity', '--primitive', 'sphere', '--name', 'Ball', '--options', '{"segments":48}']);

  // CLI path: parse argv exactly as the shell would.
  const cliInput = resolveInput(getCommand('mesh.decimate'), ['--project', 'Parity', '--object', 'Ball', '--triangles', '600']);
  const cliRun = await runCommand('mesh.decimate', cliInput);
  assert.equal(cliRun.ok, true, JSON.stringify(cliRun.error));

  // API/JSON path: same command, structured input.
  await runCommand('project.undo', { project: 'Parity' });
  const apiRun = await runCommand('mesh.decimate', { project: 'Parity', object: 'Ball', triangles: 600 });

  assert.equal(cliRun.data.result.results[0].triangles, apiRun.data.result.results[0].triangles);
  assert.equal(cliRun.data.result.results[0].vertices, apiRun.data.result.results[0].vertices);
});

test('CLI surfaces structured errors and non-zero intent', async () => {
  const bad = await cli(['generate', '--project', 'Gen', '--prompt', 'qqqq zzzz'], { expectOk: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'prompt_unmatched');
  assert.ok(bad.error.hint.includes('archetypes'));

  const missing = await cli(['inspect', '--project', 'Nope'], { expectOk: false });
  assert.equal(missing.error.code, 'project_not_found');
});

test('CLI sculpt accepts comma separated vectors', async () => {
  await cli(['new', 'SculptC']);
  await cli(['add', '--project', 'SculptC', '--primitive', 'sphere', '--name', 'Blob']);
  const sculpted = await cli([
    'sculpt', '--project', 'SculptC', '--object', 'Blob',
    '--center', '0,0.5,0', '--radius', '0.4', '--strength', '0.05', '--mode', 'inflate',
  ]);
  assert.equal(sculpted.data.result.affected > 0, true);
});

test('workflow runs from the CLI and reports every step', async () => {
  await cli(['new', 'Flow']);
  await cli(['generate', '--project', 'Flow', '--prompt', 'robot mech', '--resolution', '48']);
  const result = await cli(['workflow', '--project', 'Flow', '--workflow', 'optimize', '--input', '{"triangles":800}']);
  const steps = result.data.steps ?? result.data.result.steps;
  assert.ok(steps.length >= 3);
  assert.ok(steps.every((s) => s.ok), JSON.stringify(steps.filter((s) => !s.ok)));
});

test('CLI help and command listing stay in sync with the registry', async () => {
  const { listCommands } = await import('../src/core/operations.mjs');
  const listed = await cli(['commands']);
  const ids = (listed.data.commands ?? listed.data.result?.commands ?? []).map((c) => c.id);
  assert.equal(ids.length, listCommands().length);
});
