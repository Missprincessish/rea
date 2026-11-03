#!/usr/bin/env node
// Bundle the Studio browser editor and the WebXR VR World client with esbuild.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'web');

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'assets'), { recursive: true });

await build({
  entryPoints: {
    app: path.join(ROOT, 'web-src/main.js'),
    vr: path.join(ROOT, 'web-src/vr-main.js'),
  },
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  splitting: true,
  outdir: path.join(OUT, 'assets'),
  loader: { '.css': 'css' },
  logLevel: 'warning',
});

// Content-hash entrypoints while keeping shared chunks intact.
const appBytes = await fs.readFile(path.join(OUT, 'assets/app.js'));
const appHash = crypto.createHash('sha256').update(appBytes).digest('hex').slice(0, 10);
await fs.rename(path.join(OUT, 'assets/app.js'), path.join(OUT, `assets/app.${appHash}.js`));

const vrBytes = await fs.readFile(path.join(OUT, 'assets/vr.js'));
const vrHash = crypto.createHash('sha256').update(vrBytes).digest('hex').slice(0, 10);
await fs.rename(path.join(OUT, 'assets/vr.js'), path.join(OUT, `assets/vr.${vrHash}.js`));

let indexHtml = await fs.readFile(path.join(ROOT, 'web-src/index.html'), 'utf8');
indexHtml = indexHtml
  .replace('./main.js', `/assets/app.${appHash}.js`)
  .replace('./styles.css', '/styles.css');
await fs.writeFile(path.join(OUT, 'index.html'), indexHtml);
await fs.copyFile(path.join(ROOT, 'web-src/styles.css'), path.join(OUT, 'styles.css'));

let vrHtml = await fs.readFile(path.join(ROOT, 'web-src/vr.html'), 'utf8');
vrHtml = vrHtml
  .replace('./vr-main.js', `/assets/vr.${vrHash}.js`)
  .replace('./vr.css', '/vr.css');
await fs.writeFile(path.join(OUT, 'vr.html'), vrHtml);
await fs.copyFile(path.join(ROOT, 'web-src/vr.css'), path.join(OUT, 'vr.css'));

process.stdout.write(`built web/index.html (app.${appHash}.js) + web/vr.html (vr.${vrHash}.js)\n`);
