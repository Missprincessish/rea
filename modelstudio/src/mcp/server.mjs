// MCP server exposing the whole command registry as tools.
//
// Tool names are the command ids with dots replaced by underscores so they are
// valid MCP tool names. Each tool advertises the JSON Schema derived from the
// same zod definition the HTTP API and CLI use.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { COMMANDS, listCommands, runCommand } from '../core/operations.mjs';
import { listProviders } from '../providers/index.mjs';
import { listWorkflows } from '../core/workflows.mjs';
import { renderPreviewToFile } from '../core/exporter.mjs';
import { Project, PROJECTS_ROOT, EXPORTS_ROOT } from '../core/project.mjs';
import { BIOMES, TIME_PRESETS } from '../core/world.mjs';
import { trianglesToGlbBase64 } from './helpers.mjs';

const toolName = (id) => id.replace(/\./g, '_');

function jsonSchemaToZod(json) {
  // MCP wants zod validators; build a permissive passthrough object and let the
  // command registry do the real validation (single source of truth).
  void json;
  return z.record(z.string(), z.any()).optional();
}

export function createMcpServer({ onMutate = null } = {}) {
  const server = new McpServer({
    name: 'modelstudio',
    version: '0.1.0',
  });

  const execute = async (command, input = {}) => {
    const result = await runCommand(command, input);
    if (result.ok && onMutate && COMMANDS.find((c) => c.id === command)?.mutates) {
      onMutate({ command, project: input.project ?? null, revision: result.data?.revision ?? result.data?.project?.revision ?? null });
    }
    return result;
  };

  server.registerTool(
    'modelstudio_status',
    {
      title: 'Studio status',
      description:
        'Report workspace paths, available generation providers, workflows and the number of registered commands. Call this first to learn what the studio can do.',
      inputSchema: {},
    },
    async () => {
      const projects = await Project.list(PROJECTS_ROOT);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            service: 'modelstudio',
            workspace: PROJECTS_ROOT,
            exports: EXPORTS_ROOT,
            commands: COMMANDS.length,
            providers: listProviders(),
            workflows: listWorkflows().map((w) => ({ id: w.id, description: w.description })),
            projects,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'modelstudio_commands',
    {
      title: 'List modeling commands',
      description: 'Return every modeling command with its JSON input schema. Use this to discover the exact inputs accepted by modelstudio_run.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(listCommands(), null, 2) }],
    }),
  );

  server.registerTool(
    'modelstudio_run',
    {
      title: 'Run a modeling command',
      description:
        'Execute one modeling command against a project. Examples: {"command":"generate.text","input":{"project":"Body","prompt":"realistic female character","resolution":96}}, {"command":"mesh.decimate","input":{"project":"Body","object":"all","triangles":30000}}, {"command":"rig.create","input":{"project":"Body","object":"all"}}, {"command":"export.glb","input":{"project":"Body","format":"glb"}}. Returns JSON. Mutations save automatically to the project file.',
      inputSchema: {
        command: z.string().describe('Command id, e.g. generate.text, mesh.repair, rig.create, export.glb'),
        input: z.record(z.string(), z.any()).optional().describe('Command input object; see modelstudio_commands'),
      },
    },
    async ({ command, input }) => {
      const result = await execute(command, input ?? {});
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_batch',
    {
      title: 'Run a batch of commands',
      description:
        'Run several modeling commands in order against the same project. Stops at the first failure unless stopOnError is false. Use for multi-step requests such as generate -> repair -> rig -> export.',
      inputSchema: {
        project: z.string().optional().describe('Project name applied to every step that needs one'),
        stopOnError: z.boolean().optional(),
        commands: z.array(z.object({ command: z.string(), input: z.record(z.string(), z.any()).optional() })),
      },
    },
    async ({ project, stopOnError = true, commands }) => {
      const results = [];
      for (const step of commands) {
        const merged = { ...(step.input ?? {}), ...(project && !step.input?.project ? { project } : {}) };
        const result = await execute(step.command, merged);
        results.push(result);
        if (!result.ok && stopOnError) break;
      }
      return {
        isError: results.some((r) => !r.ok),
        content: [{ type: 'text', text: JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_workflow',
    {
      title: 'Run a modeling workflow',
      description:
        'Run a packaged workflow: character (references -> model -> texture -> rig -> export), repair, correct, optimize, material. Params mirror the workflow definitions from modelstudio_status.',
      inputSchema: {
        workflow: z.enum(['character', 'repair', 'correct', 'optimize', 'material']),
        project: z.string(),
        params: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ workflow, project, params }) => {
      const result = await execute('workflow.run', { workflow, project, input: params ?? {} });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_vr_context',
    {
      title: 'Read live VR headset & pointer context',
      description:
        'Return the live spatial context from the user\'s VR headset (Meta Quest / WebXR / desktop pointer): head pose, exact [x,y,z] world coordinate where the user is pointing ("rightThere"), targeted object under the ray ("targetedObject"), current biome, and nearby objects with distances and directions. Call this before placing or editing things "right there" or "that".',
      inputSchema: {
        project: z.string().describe('Project name'),
      },
    },
    async ({ project }) => {
      const result = await execute('vr.context', { project });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_world_environment',
    {
      title: 'Transform the 3D VR world environment',
      description:
        'Change the surrounding 3D world in real time while the user is inside VR: set biome (hayfield, meadow, forest, snow, desert, beach, mars, night-clearing, cyberpunk, courtyard, studio), time of day (dawn, day, golden-hour, sunset, night, overcast), rolling hill height, and instanced swaying foliage.',
      inputSchema: {
        project: z.string(),
        biome: z.enum(Object.keys(BIOMES)).optional(),
        timeOfDay: z.enum(Object.keys(TIME_PRESETS)).optional(),
        hillHeight: z.number().optional(),
        scatterProps: z.boolean().optional().describe('Also scatter default biome props such as hay bales or pine trees'),
      },
    },
    async ({ project, biome, timeOfDay, hillHeight, scatterProps = true }) => {
      const result = await execute('world.environment', { project, biome, timeOfDay, hillHeight, scatterProps });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_world_spawn',
    {
      title: 'Spawn a 1:1 VR-scale 3D object or building',
      description:
        'Generate and place a real-world-scale 3D building, prop, vehicle, or character (e.g. "green barn", "windmill", "grain silo", "wooden fence", "golden haybale", "pine tree", "stone well", "stone bridge", "campfire", "chair", "table", "female character") into the VR world. Pass at="pointer" whenever the user says "right there", "there", or points.',
      inputSchema: {
        project: z.string(),
        prompt: z.string().describe('Prompt with colour/size modifiers, e.g. "green barn", "tall stone tower", "wooden fence"'),
        at: z.any().optional().describe('"pointer" (default — where the VR user points), "in-front", "left", "right", "behind", "origin", or [x,y,z]'),
        scale: z.number().optional().describe('Multiplier on 1:1 real-world scale (default 1)'),
        yaw: z.number().optional().describe('Yaw in degrees; omit to rotate automatically toward the VR user'),
      },
    },
    async ({ project, prompt, at = 'pointer', scale = 1, yaw }) => {
      const result = await execute('world.spawn', { project, prompt, at, scale, ...(yaw !== undefined ? { yaw } : {}) });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_world_scatter',
    {
      title: 'Scatter multiple 3D objects across the VR terrain',
      description: 'Scatter multiple 1:1 VR-scale objects (e.g. hay bales, pine trees, boulders, fences) grounded on the terrain around the player or pointer.',
      inputSchema: {
        project: z.string(),
        prompt: z.string(),
        count: z.number().optional(),
        at: z.any().optional().describe('"around-player" (default) or "pointer"'),
        radius: z.number().optional(),
      },
    },
    async ({ project, prompt, count = 6, at = 'around-player', radius = 26 }) => {
      const result = await execute('world.scatter', { project, prompt, count, at, radius });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_world_prompt',
    {
      title: 'Run a natural-language spatial VR command',
      description:
        'Execute a natural-language world-building command (e.g. "make this a hayfield and put a green barn right there") using the live VR headset & controller pointer state.',
      inputSchema: {
        project: z.string(),
        instruction: z.string(),
        provider: z.enum(['auto', 'openai', 'local']).optional(),
      },
    },
    async ({ project, instruction, provider = 'auto' }) => {
      const result = await execute('world.prompt', { project, instruction, provider });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'modelstudio_preview',
    {
      title: 'Render a project preview',
      description: 'Render a PNG preview of a project with the headless software renderer and return the file path plus image.',
      inputSchema: {
        project: z.string(),
        object: z.string().optional().describe('Object selector, defaults to all'),
        view: z.enum(['three-quarter', 'front', 'side', 'top', 'back']).optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        path: z.string().optional().describe('Optional output path for the PNG'),
      },
    },
    async ({ project, object = 'all', view = 'three-quarter', width = 768, height = 768, path }) => {
      const record = await Project.open(project);
      const objects = record.resolveObjects(object);
      const render = await renderPreviewToFile(record, objects, { view, width, height, path });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ path: render.path, bytes: render.bytes, trianglesDrawn: render.trianglesDrawn }, null, 2) },
          { type: 'image', data: await fileToBase64(render.path), mimeType: 'image/png' },
        ],
      };
    },
  );

  server.registerTool(
    'modelstudio_export_base64',
    {
      title: 'Export GLB as base64',
      description: 'Export the project geometry to GLB and return the bytes inline as base64 (useful when the caller cannot read the filesystem).',
      inputSchema: {
        project: z.string(),
        object: z.string().optional(),
        includeAnimations: z.boolean().optional(),
      },
    },
    async ({ project, object = 'all', includeAnimations = true }) => {
      const base64 = await trianglesToGlbBase64(project, { object, includeAnimations });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ project, bytes: Buffer.from(base64, 'base64').length }, null, 2) },
          { type: 'text', text: base64 },
        ],
      };
    },
  );

  return server;
}

async function fileToBase64(file) {
  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile(file);
  return bytes.toString('base64');
}

export async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers must stay alive; stdio transport keeps the process running.
}

void jsonSchemaToZod;
void toolName;
