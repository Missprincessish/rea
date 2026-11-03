// Small shared helpers for adapters (MCP, scripts, tests).
import { Project } from '../core/project.mjs';
import { writeGltf } from '../core/gltf.mjs';
import { fail } from '../core/util.mjs';
import { vertexCount } from '../core/geometry.mjs';

/** Export project objects to GLB and return base64. */
export async function trianglesToGlbBase64(projectRef, { object = 'all', includeAnimations = true } = {}) {
  const project = await Project.open(projectRef);
  const objects = project.resolveObjects(object);
  const writable = objects
    .map((record) => {
      const geometry = project.getGeometry(record);
      if (!vertexCount(geometry)) return null;
      return {
        id: record.id,
        name: record.name,
        geometry: {
          ...geometry,
          indices: geometry.indices.length
            ? geometry.indices
            : new Uint32Array(Array.from({ length: vertexCount(geometry) }, (_, i) => i)),
        },
        materialId: record.materialId,
        transform: record.transform,
      };
    })
    .filter(Boolean);
  if (!writable.length) fail('empty_geometry', 'Nothing to export', { status: 409 });
  const { buffer } = await writeGltf(project, writable, { includeAnimations });
  return Buffer.from(buffer).toString('base64');
}
