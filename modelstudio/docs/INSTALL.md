# Installing ModelStudio (macOS / Apple Silicon first)

ModelStudio is a Node.js application with no native build step, no Blender, no
GPU requirement and no external services. It runs natively on Apple Silicon and
on Intel Macs.

## Requirements

* macOS 13+ (Ventura or newer) on Apple Silicon or Intel — also works on Linux.
* **Node.js 20 or newer** (`node --version`). Node 22 LTS recommended.
  * Apple Silicon: install the native arm64 build from
    <https://nodejs.org> or `brew install node` (Homebrew installs arm64 on M-series).
* ~250 MB free disk for `node_modules` plus whatever your projects use.
* No Python, no Xcode, no Blender. (Only needed if you later build extra tooling.)

## Install

```bash
cd modelstudio
npm install          # three, @gltf-transform, meshoptimizer, express, zod, MCP SDK, pngjs, jpeg-js
npm run build        # bundles the Studio editor + WebXR VR world into web/
npm test             # 40 end-to-end tests; ~50 s
```

`npm install` pulls prebuilt JavaScript only; nothing is compiled on your machine.

## First run

```bash
# start the API + Studio editor + WebXR VR world (/vr) + Open MCP (/mcp) on http://localhost:4317
npm start
# or, with automatic LAN HTTPS on :4318 for Meta Quest 3S / WebXR headsets over Wi-Fi:
npm run start:vr
```

Open <http://localhost:4317>. The workspace (projects, exports, previews) is
created at `~/ModelStudio` by default.

Change where models are stored:

```bash
export MODELSTUDIO_HOME="$HOME/Documents/ModelStudio"
export MODELSTUDIO_EXPORTS="$HOME/Desktop/models"   # optional, defaults to $MODELSTUDIO_HOME/exports
```

Persist those two lines in `~/.zshrc` if you want them every session.

## CLI without `npm link`

```bash
node bin/modelstudio.mjs --help
# optional: put it on PATH
npm link            # then: modelstudio generate --prompt "wooden chair"
```

## Remote Desktop Command Terminal

The server binds `0.0.0.0:4317`, so it is reachable from another machine on the
same network at `http://<mac-hostname>.local:4317`. The CLI and API need no
display and no GUI, which is what makes the whole workflow drivable from a
terminal session or from ChatGPT through the API/MCP endpoints.

```bash
modelstudio serve --port 4317          # serve
curl -s localhost:4317/api/health      # liveness probe for scripts
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE :4317` | Another instance is running: `lsof -i :4317`, or `modelstudio serve --port 4320`. |
| Editor loads but is blank | Run `npm run build` (the bundle in `web/` is generated, not committed stale). |
| `meshoptimizer` errors | Ensure Node ≥ 20 (WASM SIMD requires a modern V8). |
| Slow generation | Lower `--resolution` (default 96; 64 is ~3× faster, 128 much slower). |
| `project_not_found` | Use `modelstudio projects` to see exact names; names are sanitised to `[A-Za-z0-9-_ ]`. |
