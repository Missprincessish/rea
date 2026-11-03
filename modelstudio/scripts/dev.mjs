#!/usr/bin/env node
// Development runner: API server on MODELSTUDIO_PORT plus an esbuild watcher that
// rebuilds the editor bundle. The API also serves the built editor, so one port
// is enough for the live preview.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server/main.mjs';
import { build } from 'esbuild';
import fs from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.MODELSTUDIO_PORT ?? process.env.PORT ?? 4317);
const host = '0.0.0.0';

async function bundle() {
  await fs.mkdir(path.join(ROOT, 'web/assets'), { recursive: true });
  await build({
    entryPoints: {
      app: path.join(ROOT, 'web-src/main.js'),
      vr: path.join(ROOT, 'web-src/vr-main.js'),
    },
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    splitting: true,
    sourcemap: true,
    outdir: path.join(ROOT, 'web/assets'),
    logLevel: 'info',
  });
  let html = await fs.readFile(path.join(ROOT, 'web-src/index.html'), 'utf8');
  html = html.replace('./main.js', '/assets/app.js').replace('./styles.css', '/styles.css');
  await fs.writeFile(path.join(ROOT, 'web/index.html'), html);
  await fs.copyFile(path.join(ROOT, 'web-src/styles.css'), path.join(ROOT, 'web/styles.css'));

  let vrHtml = await fs.readFile(path.join(ROOT, 'web-src/vr.html'), 'utf8');
  vrHtml = vrHtml.replace('./vr-main.js', '/assets/vr.js').replace('./vr.css', '/vr.css');
  await fs.writeFile(path.join(ROOT, 'web/vr.html'), vrHtml);
  await fs.copyFile(path.join(ROOT, 'web-src/vr.css'), path.join(ROOT, 'web/vr.css'));
}

await bundle();
const { port: actual } = await startServer({ port, host, dev: false });
process.stdout.write(`ModelStudio dev server on http://${host}:${actual} (editor + API)\n`);

// Rebuild on source changes without pulling in a watcher dependency.
let timer = null;
const targets = ['web-src'];
for (const dir of targets) {
  fsSyncWatch(path.join(ROOT, dir));
}
function fsSyncWatch(dir) {
  // eslint-disable-next-line global-require
  const fsSync = spawn('true');
  void fsSync;
  import('node:fs').then(async ({ watch }) => {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        bundle().catch((error) => process.stderr.write(`${error}\n`));
      }, 120);
    });
  });
}
