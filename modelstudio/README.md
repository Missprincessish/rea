# ModelStudio

A personal 3D modelling studio **and live WebXR VR world builder** that runs
entirely on your machine: text and image → geometry, repair, remesh, decimate,
UV, texture bake and paint, auto-rigging, skin-weight repair, procedural
animation, GLB export, a desktop browser editor, and a **live WebXR VR world**
(Meta Quest 3S, Quest 2/3/Pro, Pico, Vision Pro, PCVR, or desktop) — all driven
by one 63-command registry simultaneously available over HTTP, CLI, and an
**open MCP server** (stdio + Streamable HTTP `/mcp` + SSE) for ChatGPT, Claude,
Cursor, Ollama, or any AI agent.

No Blender. No GPU. No cloud account. No credits.

```
             ┌───────────────────────────────────────────────┐
             │  command registry (63 commands, JSON Schema)  │
             └───────┬───────────┬───────────┬───────────────┘
       HTTP API ─────┘           │           └───── Open MCP (stdio + /mcp)
   (OpenAPI 3.1)                CLI                  ChatGPT / Claude / any AI
                                 │
              desktop studio (/) + WebXR VR world (/vr)
```

Every surface dispatches into the same `runCommand`, so a change made by
ChatGPT or an MCP agent updates the world around you in VR in real time.

## Quick start

```bash
cd modelstudio
npm install
npm run build
npm start                 # → http://localhost:4317      (Studio + /vr + /mcp)
npm run start:vr          # → also starts HTTPS on :4318 for Meta Quest 3S over Wi-Fi
```

Put on a **Meta Quest 3S** (or any WebXR headset on the same Wi-Fi), open
`https://<your-mac-ip>:4318/vr`, point your controller at a spot on the ground,
and say or type:

> `"chatgpt make this a hayfield and put a green barn right there"`

Full VR headset + ChatGPT + Open MCP setup: **[docs/VR_AND_MCP.md](docs/VR_AND_MCP.md)**.

```bash
# same thing from the terminal
node bin/modelstudio.mjs new Demo
node bin/modelstudio.mjs generate --project Demo --prompt "realistic wooden chair" --resolution 96
node bin/modelstudio.mjs uv --project Demo
node bin/modelstudio.mjs bake --project Demo --size 1024 --pattern wood
node bin/modelstudio.mjs export --project Demo --format glb
```

Full install notes (macOS / Apple Silicon, workspace paths, remote-terminal use):
[docs/INSTALL.md](docs/INSTALL.md).

## What it can actually do

Verified, not aspirational — the list with the test that proves each item is in
[docs/FEATURES.md](docs/FEATURES.md); the honest gaps are in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md).

* **Generate** – 30 prompt archetypes (characters, furniture, robots, creatures,
  barns, windmills, silos, hay bales, fences, wells, bridges, campfires, vehicles,
  architecture, props) and explicit SDF shape specs → watertight triangle meshes;
  image → 3D by multi-view silhouette carving.
* **Live WebXR VR World (`/vr`)** – standard WebXR (`immersive-vr` + `immersive-ar`
  color passthrough) + desktop walkthrough, 11 biomes (including wind-swaying
  `hayfield`, `forest`, `snow`, `night-clearing`), live `"Right There"` controller
  & hand-pinch spatial pointing, voice/text AI commands, and real-time SSE sync.
* **Edit** – sculpt (grab/inflate/pinch/flatten/smooth), transform (including
  baking into vertices), mirror, direct vertex write-back.
* **Repair** – weld, remove degenerate/duplicate faces, fill holes, compact loose
  vertices, recompute normals, with before/after diagnostics.
* **Optimise** – voxel remesh with UV/weight transfer, attribute-preserving
  decimation to a triangle budget.
* **Texture** – UV projection, 15 PBR material presets, albedo/AO/normal bakes up
  to 2048², UV-space paint strokes.
* **Rig** – humanoid/quadruped auto-rig, ≤4 influences per vertex, symmetry-aware
  weight repair, manual bone edits, posing.
* **Animate** – 7 procedural clips (idle, walk, run, wave, punch, jump, spin),
  sampling and pose application.
* **Ship** – GLB with UVs, skins, weights and animation channels; previews;
  projects saved as plain JSON with undo/redo.

## Programmatic control

### CLI

```bash
modelstudio <alias|command> [positional] --flag value --json
```

Aliases exist for the common verbs (`new`, `generate`, `sculpt`, `repair`,
`decimate`, `uv`, `bake`, `rig`, `animate`, `export`, `import`, `preview`,
`workflow`, `undo`, `redo`). `--json` returns the exact envelope the API returns:
`{ ok, command, durationMs, data }` or `{ ok: false, error: { code, message, hint, details } }`.

### HTTP API

```bash
curl -s localhost:4317/api/health
curl -s localhost:4317/api/openapi.json | jq '.paths | keys'   # full contract
curl -s -X POST localhost:4317/api/projects/Demo/commands/generate.text \
  -H 'content-type: application/json' \
  -d '{"prompt":"robot mech","resolution":96}'
curl -s "localhost:4317/api/projects/Demo/preview?width=768" -o preview.png
curl -s -N localhost:4317/api/projects/Demo/events                    # SSE progress
```

Also: `GET /api/projects/:p/state?since=<rev>` for cheap diffing,
`POST /api/batch` for pipelines, `POST /api/projects/:p/workflows/:id` for the
five reusable workflows.

### Open MCP server (ChatGPT, Claude, Cursor, any AI)

Available over **Streamable HTTP** (`POST http://localhost:4317/mcp`), **SSE**
(`GET http://localhost:4317/mcp/sse`), and **stdio**:

```jsonc
// mcp.json / Claude Desktop / Cursor / ChatGPT MCP client
{
  "mcpServers": {
    "modelstudio": {
      "command": "node",
      "args": ["/absolute/path/to/modelstudio/src/mcp/main.mjs"],
      "env": { "MODELSTUDIO_HOME": "/Users/you/ModelStudio" }
    }
  }
}
```

Tools: `modelstudio_vr_context`, `modelstudio_world_environment`,
`modelstudio_world_spawn`, `modelstudio_world_scatter`,
`modelstudio_world_prompt`, `modelstudio_status`, `modelstudio_commands`,
`modelstudio_run`, `modelstudio_batch`, `modelstudio_workflow`,
`modelstudio_preview` (returns a PNG), `modelstudio_export_base64` (returns the GLB inline).

### External automation example

A complete, runnable script that creates a bandit character, rigs and animates
it, exports a GLB and a preview, and verifies the result over HTTP:
[`examples/automation/character-pipeline.mjs`](examples/automation/character-pipeline.mjs).

```bash
node examples/automation/character-pipeline.mjs --prompt "tall female warrior" --out ~/Desktop
```

## Workflows

`character`, `repair`, `correct`, `optimize`, `material` — each is a recorded
sequence of registry commands with per-step results, so a failure tells you
exactly which stage broke.

```bash
node bin/modelstudio.mjs workflow --project Demo --workflow character \
  --input '{"prompt":"female character","bakeSize":1024,"exportPath":"~/Desktop/hero.glb"}'
```

## VR editing (select · grab · snap · duplicate)

Inside the headset you can edit the world you are standing in, not just spawn into it:

* **Point & select** any object with the trigger; a teal ring + gold bounding box shows the selection.
* **Grab & move** with **Grip** (or drag with the mouse on desktop) — it live-snaps while you move.
* **Fences snap end-to-end**, including exact **90° paddock corners**, and objects magnetically
  align to nearby structures; an optional 0.5 m / 1.0 m **grid snap** is one dropdown away.
* **Rotate / resize / duplicate / delete / undo / redo** from the floating board's
  *Object Edit* tab, the on-screen inspector, the keyboard, or by voice.
* **Ghost preview** shows the snapped result in 3D before you confirm a placement.
* Every edit goes through the same registry commands an MCP client or ChatGPT uses, so
  **VR, desktop, CLI and AI stay on one project revision** (SSE pushes the update instantly).

All of the input math lives in [`src/core/vr-interaction.mjs`](src/core/vr-interaction.mjs) and is
covered by `tests/vr-controls-edit.test.mjs`, so controller behaviour is regression-tested without
a headset.

## Standalone repository

The same tree is also mirrored as a self-contained repo at
`/home/user/modelstudio` (`main` + `feat/vr-controls-and-live-editing`), ready to
publish to `Missprincessish/modelstudio`. Repository creation is currently
blocked by the GitHub installation token — the exact API error and a one-line
publish command are recorded in that repo's `PUBLISH.md`.

## Repository layout

```
bin/modelstudio.mjs        CLI entry point
src/core/                  project, geometry, materials, rigging, exporter, registry
src/algorithms/            SDF, prompt archetypes, repair, remesh, UV, bake,
                           reconstruct (visual hull), animation, primitives
src/vendor/                vendored MIT marching cubes
src/server/                express API + OpenAPI generator
src/cli/                   argument parsing, aliases, colour output
src/mcp/                   MCP server and helpers
src/core/vr-interaction.mjs shared VR input, locomotion, fence/structure snapping
web-src/                   browser editor source (three.js viewport, panels, /vr client)
web-src/vr-editor.js       VR/desktop live editing engine (select, grab, snap, ghost)
web/                       built editor bundle (npm run build)
tests/                     end-to-end engine + CLI tests (npm test)
docs/                      research, install, features, limitations
examples/automation/       external automation example
```

## Documentation

* [docs/VR_AND_MCP.md](docs/VR_AND_MCP.md) — Meta Quest 3S / WebXR VR setup, `"right there"` spatial voice commands, ChatGPT & Open MCP
* [docs/INSTALL.md](docs/INSTALL.md) — install, workspace paths, remote terminal
* [docs/FEATURES.md](docs/FEATURES.md) — every verified capability + the test
* [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — what is not implemented, honestly
* [docs/RESEARCH.md](docs/RESEARCH.md) — Phase 1 Meshy research, and what was
  reproduced independently vs. deliberately not attempted

## License

Part of this repository (REA), MIT. The vendored marching-cubes implementation is
MIT-licensed and self-contained in `src/vendor/marchingcubes.mjs`.
