# Limitations — what this does *not* do

Stated plainly, because the alternative is a demo that lies.

## Generation

* **`generate.text` is not an AI model.** It parses prompts into a tagged
  archetype registry and meshes a signed distance field. Anything outside the 21
  archetypes returns `prompt_unmatched` rather than a guess. It cannot invent
  novel designs the way Meshy's diffusion pipeline can; it makes clean, editable
  base meshes for the archetypes it knows.
* Generated detail is bounded by SDF resolution. At `--resolution 96` a humanoid
  is ~9 k triangles with smooth, blobby features — good for prototyping, rigging
  and game LODs, not for hero-closeup sculpts. Resolution 160+ is slow (tens of
  seconds per model).
* `generate.image` is a **visual hull**: silhouette-accurate but convex-ish. It
  cannot recover concavities between limbs, hollows, or overhangs, and projects
  colour from the first view only (reported as `limitations[]`). Side/back views
  without masks carve more than they should. `visualHull()` itself emits a
  closed, watertight 3D mesh; `generate.image` then applies cylindrical UV
  projection so textures can be baked, which splits vertices along the `u=0/1`
  seam (so index-based `object.inspect` reports seam boundary edges after UV
  unwrap even though the 3D surface is geometrically closed).
* At medium SDF resolutions, sharp-faceted prompts such as `crystal` can leave
  1–2 non-manifold/boundary edges along facet ridges; run `mesh.repair` or
  `mesh.remesh` if downstream tools require strict index-manifold topology.
* No image *texture* reconstruction from photos beyond the projected first view.
* AI generation (`provider: "auto" | "meshy"`) requires you to supply your own
  Meshy API key; without one, only the local provider runs. No key is bundled.

## Geometry

* UV unwrapping is cylindrical/box/triplanar projection with island packing — it
  gives usable seams and coverage for generated shapes, **not** production-quality
  unwraps for arbitrary scanned meshes (no chart-based unwrap like xatlas).
* Decimation is triangle-budget quadric simplification. It preserves UVs and
  weights but can distort silhouette detail under ~1 000 triangles.
* Voxel remesh at high resolution takes tens of seconds (35 s at res 72 on the
  test character). It also closes small features thinner than the voxel size.
* Hole filling fans boundary loops to their centroid: fine for small holes, it
  will not reconstruct a complex missing region. Loops with more than 64
  vertices are left alone (reported).
* There is no boolean modelling, subdivision surface, or sculpting brush other
  than the six radial brushes.

## Rigging / animation

* Rigging fits a **parametric humanoid/quadruped skeleton** to the mesh bounds.
  It works well on upright character-shaped meshes and poorly on non-humanoid
  shapes (a chair gets a humanoid skeleton if you ask for one).
* Weights are distance/falloff based, not geodesic: fast and stable, but shoulders,
  hips and long hair need manual correction (`rig.edit-bone`,
  `rig.correct-weights`).
* No automatic bone *placement* from an arbitrary mesh topology, no IK solving,
  no retargeting from an existing rig.
* Animation clips are procedural (sine-based joint curves). They read as
  stylised game motion, not mocap.

## Materials / textures

* Baking uses geometric AO sampling and procedural albedo patterns — no
  photorealistic texture synthesis, no image-to-texture projection from photos.
* Texture painting writes into a per-object paint layer at the requested size;
  undo granularity is one stroke batch.
* Glass/emissive presets export correct PBR factors, but there is no refraction
  or transmission rendering in the built-in preview.

## Import / export

* **GLB/glTF only.** No OBJ, FBX, STL, USDZ, 3MF export or import. GLB covers
  three.js/Unity/Unreal/Godot, which was the deciding trade-off.
* No Draco or meshopt compression on export (file sizes are plain).
* glTF import reads geometry, UVs, materials, skins and animation channels;
  morph targets, KHR extensions beyond the registered set, and sparse accessors
  are not guaranteed.

## Editor / preview

* The built-in preview is a CPU rasteriser: flat-ish shading, no PBR, no
  shadows beyond a simple depth term. It is for verification and thumbnails; the
  browser editor (three.js) is the visual truth.
* The browser editor needs a modern browser with WebGL2; it has no touch-specific
  sculpting UX and no multi-object boolean tools.
* Server is single-user and unauthenticated — bind it to localhost if your
  machine is on an untrusted network (default binding is `0.0.0.0` for the
  preview proxy / remote-terminal workflow).

## Performance envelope measured in this environment

Approximate, Apple-silicon-class CPU, GPU unused:

| Operation | Time |
| --- | --- |
| `generate.text` at res 96 | 1–5 s |
| `mesh.uv` | ~120 ms |
| `texture.bake` 1024² all maps | ~3 s |
| `rig.create` + `rig.correct-weights` | ~250 ms |
| `preview.render` 768² | ~0.7 s |
| `mesh.remesh` res 72 | ~35 s |
| GLB export (10 k tris + textures) | ~50 ms |
