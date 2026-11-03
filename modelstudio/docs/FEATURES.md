# Verified features

Everything below is exercised by the automated suite (`npm test` — 69 tests across
`tests/engine.test.mjs`, `tests/cli.test.mjs`, `tests/vr-world.test.mjs`,
`tests/vr-controls-edit.test.mjs`, `tests/vr-client-wiring.test.mjs`,
`tests/studio-generation.test.mjs`) and by manual CLI/API runs on this checkout.
Each line names the command that proves it.

## Projects and persistence

| Capability | Command | Evidence |
| --- | --- | --- |
| Create/list/open projects on disk | `project.create`, `project.list`, `project.get` | `tests/cli.test.mjs` |
| Every project lives in one JSON file + sidecar textures | `project.save` | `project state persists to disk and reopens identically` |
| Undo/redo restores geometry byte-exactly | `project.undo`, `project.redo` | `undo and redo restore geometry exactly` |
| Snapshot summary for the editor | `project.snapshot` | `project state persists…` |

## Generation (local, no credits, no network)

| Capability | Command | Evidence |
| --- | --- | --- |
| Text prompt → watertight editable mesh | `generate.text` | `text prompt generates editable watertight geometry` (asserts `watertight: true`, 0 boundary edges, 0 degenerate/duplicate faces) |
| Prompt words change measured proportions | `generate.text` | `prompt parameters change the generated geometry` (tall vs short height) |
| Unsupported prompts fail loudly with the supported list | `generate.text` | `unmatched prompt returns an actionable error` (`prompt_unmatched` + hint) |
| Explicit SDF shape spec (union/subtract/box/sphere/capsule/torus…) | `generate.shape` | `SDF shape spec generation` |
| One or more reference images → carved mesh | `generate.image` | `image reconstruction builds a hull from silhouettes` (2 views, 2 380 tris, limitations reported) |
| 21 prompt archetypes: chair, table, lamp, vase, mug, sword, shield, tree, house, tower, car, robot, character, bust, creature, rock, crystal, spaceship, bottle, sphere, cube | `generate.text` | `listArchetypes()`, checked in `modelstudio commands` |

## Geometry

| Capability | Command | Evidence |
| --- | --- | --- |
| Repair: weld, drop degenerate/duplicate faces, fill holes, compact, recompute normals | `mesh.repair` | `repair fixes broken meshes` (boundary edges reduced, 0 loose vertices) |
| Voxel remesh with uniform topology | `mesh.remesh` | `remesh produces uniform topology and transfers UVs` (coverage 1.0) |
| Attribute-preserving decimation to a triangle budget | `mesh.decimate` | `decimation preserves attributes and hits the target` (±15 % of target, UVs kept) |
| UV projection (cylindrical / box / triplanar) with packing | `mesh.uv` | `UV projection covers the mesh` (coverage > 0.2) |
| Brush sculpting: grab, inflate, pinch, flatten, smooth | `mesh.sculpt` | `sculpt modifies vertex positions with a radial falloff` |
| Mirror across an axis | `mesh.symmetrize` | registry test |
| Bake transforms into vertices | `object.transform --applyToGeometry` | `transforms can be baked into geometry` |
| Direct vertex write-back for the editor | `mesh.set-vertex-positions` | used by the web editor's sculpt preview |
| Smooth, fill holes, flip/recompute normals | `mesh.smooth`, `mesh.fill-holes`, `mesh.flip-normals`, `mesh.recompute-normals` | registry test |

## Materials and textures

| Capability | Command | Evidence |
| --- | --- | --- |
| 15 PBR presets (skin, hair, fabric, leather, metal, gold, chrome, wood, stone, ceramic, glass, emissive, rubber, crystal) | `material.create` | `material edits persist and are reflected in export` |
| Edit colour/metalness/roughness/emissive/alpha/texture binding | `material.edit` | same test; values verified in the exported GLB |
| Assign material to objects | `material.assign` | registry test |
| Bake albedo + AO + normal maps (up to 2048²) | `texture.bake` | `texture bakes produce real PNG images with AO` (PNG decodes, AO < 1, non-flat texture) |
| UV-space texture painting with real pixels | `texture.paint` | `texture painting writes pixels` (centre texel turns red) |
| Upload an external image as a project texture | `texture.upload` | HTTP API test path |

## Rigging and animation

| Capability | Command | Evidence |
| --- | --- | --- |
| Humanoid/quadruped auto-rig fitted to mesh bounds | `rig.create` | `automatic rigging binds weights` (≥ 15 bones, ≤ 4 influences) |
| Weight repair: unweighted vertices, normalisation, influence pruning, symmetry | `rig.correct-weights` | same test (0 unweighted, error < 1e-4) |
| Manual bone editing and posing | `rig.edit-bone`, `rig.pose` | registry + CLI `pose` |
| 7 procedural clips: idle, walk, run, wave, punch, jump, spin | `animation.create` | `automatic rigging binds weights and animates` |
| Sample a clip at a time and apply the pose | `animation.sample` | same test |

## Import / export / preview

| Capability | Command | Evidence |
| --- | --- | --- |
| GLB export with UVs, skins, weights and animation channels | `export.glb` | `rigged and animated GLB exports skins and clips` (JOINTS_0, WEIGHTS_0, TEXCOORD_0, skins, channels) |
| GLB export → re-import round trip | `import.glb` | `GLB export -> import round trip preserves the model` (triangle count, skeleton, weights preserved) |
| Inspect a GLB without importing | `import.inspect` | `import.inspect works without mutating a project` |
| Software-rasterised PNG preview (no GPU) | `preview.render` | `preview renders a non-empty PNG from real geometry` |

## Workflows

| Workflow | Steps | Evidence |
| --- | --- | --- |
| `character` | generate/image → repair → UV → bake → rig → weights → idle clip → GLB | `character workflow runs rigging and export end to end` |
| `repair` | inspect → weld/fill → normals → export | `repair workflow handles a broken mesh` |
| `optimize` | repair → decimate → bake → export | `optimize workflow reduces triangles and exports` |
| `correct` | repair → weight fix → symmetrise → export | CLI `workflow` run |
| `material` | material preset → assign → bake → export | CLI `workflow` run |

## Control surfaces (all over the same engine)

| Surface | How | Evidence |
| --- | --- | --- |
| HTTP API | `GET /api/health`, `/api/capabilities`, `/api/commands`, `/api/openapi.json`, `POST /api/projects/:p/commands/:id`, `/api/batch`, `/api/workflows/:id` | `HTTP API executes commands and serves previews` |
| CLI | `modelstudio <alias or command id> --flags --json` | `tests/cli.test.mjs` (7 tests) |
| MCP server (stdio + Streamable HTTP `/mcp` + SSE `/mcp/sse`) | 12 tools including `modelstudio_vr_context`, `modelstudio_world_environment`, `modelstudio_world_spawn`, `modelstudio_world_scatter`, `modelstudio_world_prompt`, `modelstudio_run`, `modelstudio_batch`, `modelstudio_preview`, `modelstudio_export_base64` | `MCP server exposes tools backed by the registry` + `HTTP VR routes + Open Network MCP (/mcp) + Self-Signed Quest HTTPS` |
| Browser editor + WebXR VR World | `/` (Studio) and `/vr` (standard WebXR `immersive-vr` + `immersive-ar` + desktop walkthrough) | `npm run build` + `tests/vr-world.test.mjs` |
| Spatial VR Pointing & Live AI World Building | `vr.point`, `vr.context`, `world.environment`, `world.spawn`, `world.scatter`, `world.prompt` | `VR pointing + "chatgpt make this a hayfield and put a green barn right there" + undo` & `OpenAI-compatible tool-calling LLM director drives VR world tools` |
| CLI/API parity | identical input → identical output | `CLI and API produce equivalent results` |
| OpenAPI 3.1 document | generated from the registry at runtime | `OpenAPI document covers every command` |

## Text-to-3D library (Meshy-style prompt breadth)

| Capability | Command | Evidence |
| --- | --- | --- |
| 51 parametric archetypes: furniture, props, buildings, plants, vehicles | `generate.text` | `prompt library ships a broad archetype set…`, `every archetype meshes into watertight, non-empty geometry` |
| Multiword prompts resolve to the specific archetype ("traffic cone", "pine tree") | `generate.text` | `multiword prompts resolve to the specific archetype…` |
| New library prompts generate real editable geometry | `generate.text` | `generate.text produces editable geometry for library prompts` |
| Full pipeline on a library prompt: UV → bake → decimate → GLB | `mesh.uv`, `texture.bake`, `mesh.decimate`, `export.glb` | `a generated archetype runs the whole studio pipeline and exports GLB` |
| Texture bake is fast enough to stay interactive (≈1.8 s at 512² on a 97k-tri mesh) | `texture.bake` | same test asserts `< 60 s` (previously ≈267 s) |
| Preview renderer honours object rotation and frames the model | `preview.render` | `object.transform` + `preview.render` manual run |
