# ModelStudio — research notes (Phase 1)

This document records what was observed about Meshy's publicly documented 3D
pipeline, what of it can be reproduced independently, and where this project
deliberately diverges. Everything here is based on public documentation and on
operations run locally against this repository; no proprietary weights, private
server code, credentials, or paid endpoints were used.

## 1. What Meshy publicly exposes

Evidence: the public API reference at `https://docs.meshy.ai/en/api/text-to-3d`
(read during this project) and Meshy's public documentation for image-to-3D,
remesh, rigging and animation.

Observable pipeline, in the order a user experiences it:

| Stage | Publicly documented behaviour | Reproducible locally? |
| --- | --- | --- |
| Text/image → geometry | Two-step job: `preview` produces untextured geometry, `refine` adds textures. Parameters: prompt ≤800 chars, `ai_model`, `geometry_resolution`, `should_remesh`, `topology` (triangle/quad), `target_polycount`, `pose_mode`, `target_formats`. | Partly. Local generation produces real geometry from a parsed prompt, but it is **not** a diffusion/generative model — see §2. |
| Image → 3D | One or more reference images, optional multi-view; silhouette-driven reconstruction. | Yes — silhouette extraction + multi-view visual-hull carving. |
| Remesh | Voxel/uniform topology rebuild with a target polycount (100–300 k). | Yes — voxel remesh with attribute transfer. |
| Decimation | Quadric edge collapse to a triangle budget, attribute aware. | Yes — meshoptimizer `simplify` with UV/weight preservation. |
| Texturing / painting | PBR texture generation, texture-paint brush, base-colour/AO/normal maps. | Yes — procedural albedo + geometric AO + tangent-space normal bake, plus a UV-space paint brush. |
| UV unwrapping | Automatic unwrap before texturing. | Yes — cylindrical/triplanar/box projection with island packing (hand-rolled; good for generated shapes, not production-quality for arbitrary scans). |
| Auto-rig | Humanoid skeleton fitted to the mesh, ≤4 influences per vertex. | Yes — parametric humanoid/quadruped skeleton fitted to bounds + distance-based weights, symmetry-aware cleanup. |
| Animation | Library of clips retargeted to the rig. | Yes — procedural clips (idle, walk, run, wave, punch, jump, spin) sampled onto the skeleton. |
| Import/export | glTF/GLB, OBJ, FBX, STL, USDZ; export presets. | GLB/glTF only (see limitations). |
| Jobs & progress | Async job ids with polling; per-stage progress. | Yes — SSE event stream plus revision polling; every command returns duration and structured errors. |

## 2. How generation actually works here (honest version)

`generate.text` is **not** an AI image/model generator and does not pretend to
be. The pipeline is:

```
prompt text
  → tokenise + score against a tagged archetype registry (21 archetypes)
  → per-archetype parametric SDF builder (humanoid proportions, furniture,
    robot, creature, architecture, prop shapes …)
  → optional generic modifiers (tall/short/wide/thin/stocky, colours,
    hair style, materials, stance)
  → signed distance field sampled on a grid
  → marching cubes → welded, degenerate-free, watertight triangle mesh
  → grounding at y=0, UV unwrap, material assignment
```

Consequences, stated plainly:

* Prompts outside the archetype vocabulary (e.g. "gothic cathedral with
  gargoyles") return `prompt_unmatched` with the list of supported archetypes
  instead of inventing a wrong model. Generic shape words (`sphere`, `box`,
  `rock`, `crystal`) do resolve.
* Geometry varies with prompt words, not with a learned model: `tall female
  character` and `short female character` differ in measured proportions
  (asserted in `tests/engine.test.mjs`).
* Because the surface is an SDF isosurface, generated meshes come out closed
  (`watertight: true`, zero boundary edges) unless the field is degenerate; that
  is what makes repair/remesh/rigging reliable downstream.

`generate.image` is a genuine reconstruction, not a lookup: each image is
masked (alpha or flood-fill), projected into a carving volume from its stated
yaw, intersected across views, then meshed. Two views give a plausible
silhouette-accurate hull; concavities between limbs cannot be recovered and the
command reports that as `limitations[]`.

## 3. Independent, reproducible capabilities

Verified in this repository by automated tests (`npm test`, 37 tests) and manual
CLI/API runs:

* Watertight mesh generation from text prompts and from explicit SDF specs.
* Multi-view silhouette reconstruction from supplied images (no network, no
  credits).
* Mesh repair: weld, degenerate/duplicate face removal, hole filling, loose
  vertex compaction, normal recomputation — before/after diagnostics returned.
* Voxel remesh with UV and skin-weight transfer, including coverage reporting.
* Attribute-preserving decimation to a triangle budget (meshoptimizer).
* UV projection (cylindrical/box/triplanar) with island packing and coverage
  metrics.
* PBR material creation/editing from 15 presets; per-object assignment.
* Texture bake (albedo + AO + tangent-space normal) at up to 2048², and UV-space
  texture painting that writes real pixels into the project texture.
* Humanoid auto-rig with ≤4 influences, symmetry-aware weight correction
  (unweighted vertices, normalisation error, pruned influences reported).
* Procedural animation clips, per-frame sampling, pose application.
* GLB export with `JOINTS_0`/`WEIGHTS_0`/`TEXCOORD_0`, skins, and animation
  channels; GLB re-import restoring geometry, skeletons, weights and clips.
* PNG preview rendering with a software rasteriser (no GPU/browser required).
* Undo/redo with byte-exact geometry restoration, and snapshot/state sync.

## 4. Deliberate divergences and non-goals

* **No diffusion model.** Training or shipping a text-to-3D diffusion model is
  out of scope: it needs weights and compute the project cannot ship, and the
  brief forbids pretending. Replaceability is built in: `src/providers/index.mjs`
  exposes a `meshy` REST adapter and an `auto` selector so a hosted provider can
  be dropped in without changing any command or UI code.
* **No Blender dependency.** The whole pipeline is Node + `three` (viewport
  only) + `@gltf-transform` + `meshoptimizer` + a vendored MIT marching-cubes
  implementation, so it installs and runs with `npm install` on an Apple Silicon
  Mac with no external 3D application.
* **No proprietary Meshy assets or endpoints.** The Meshy adapter is documented
  for completeness and is only used if the user supplies their own key.
* **GLB/glTF only.** OBJ/FBX/STL/USDZ export is not implemented; GLB is the
  format every target engine (three.js, Unity, Unreal, Godot) ingests.

## 5. Architectural conclusions taken from the research

1. One command registry is the product. Every capability is a schema-validated,
   JSON-in/JSON-out command; the HTTP API, CLI, MCP server and browser editor are
   thin adapters over `runCommand`. This mirrors Meshy's job-style API surface
   (a stable verb set with structured status) while keeping everything local.
2. Pipeline stages are explicit and reversible. Repair → remesh → decimate → UV →
   bake → rig → animate → export is a linear set of commands a caller (or an LLM
   operator) can compose, inspect and undo individually; the five reusable
   workflows are just recorded sequences of those commands.
3. Every operation reports diagnostics, not just success. Mesh operations return
   before/after watertightness, decimation error, weight-quality metrics and
   attribute-transfer coverage so an automated operator can verify results
   instead of trusting them.
