// OpenAPI 3.1 document generated from the command registry, so the API docs can
// never drift from the implementation.
import { listCommands } from '../core/operations.mjs';
import { listWorkflows } from '../core/workflows.mjs';

export function openApiDocument({ baseUrl = 'http://127.0.0.1:4317' } = {}) {
  const commands = listCommands();
  const paths = {
    '/api/health': {
      get: {
        summary: 'Health check',
        responses: { 200: { description: 'Service metadata' } },
      },
    },
    '/api/capabilities': {
      get: {
        summary: 'List commands, generation providers and workflows',
        responses: { 200: { description: 'Capability document' } },
      },
    },
    '/api/projects': {
      get: {
        summary: 'List projects',
        responses: { 200: { description: 'Project list' } },
      },
      post: {
        summary: 'Create a project',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
        responses: { 200: { description: 'Created project' } },
      },
    },
    '/api/projects/{project}': {
      get: {
        summary: 'Project summary',
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Project summary' }, 404: { description: 'Not found' } },
      },
      delete: {
        summary: 'Delete a project directory',
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/projects/{project}/state': {
      get: {
        summary: 'Full project state for editor synchronisation (base64 geometry)',
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Return {unchanged:true} when the revision matches' },
        ],
        responses: { 200: { description: 'Snapshot' } },
      },
    },
    '/api/projects/{project}/preview': {
      get: {
        summary: 'Render a PNG preview of the project',
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['three-quarter', 'front', 'side', 'top', 'back'] } },
          { name: 'width', in: 'query', schema: { type: 'integer' } },
          { name: 'height', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'PNG image', content: { 'image/png': {} } } },
      },
    },
    '/api/projects/{project}/textures/{textureId}': {
      get: {
        summary: 'Fetch a texture as an image',
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textureId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Image bytes' } },
      },
    },
    '/api/projects/{project}/vr/context': {
      get: {
        summary: 'Read live VR headset pose, controller ray hit ("right there"), targeted object, and world summary',
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Spatial VR context' } },
      },
    },
    '/api/projects/{project}/vr/point': {
      post: {
        summary: 'Update live VR headset pose, controller ray hit, or "right there" spatial pin',
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated VR state' } },
      },
    },
    '/api/projects/{project}/vr/prompt': {
      post: {
        summary: 'Execute a natural-language spatial world command using the live VR pointer ("make this a hayfield and put a green barn right there")',
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['instruction'],
                properties: {
                  instruction: { type: 'string' },
                  provider: { type: 'string', enum: ['auto', 'openai', 'local'] },
                  pointer: { type: 'object' },
                  head: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Executed world actions and spoken reply' } },
      },
    },
    '/mcp': {
      post: {
        summary: 'Open Model Context Protocol (MCP) Streamable HTTP endpoint for any MCP-compatible AI client',
        responses: { 200: { description: 'MCP JSON-RPC response or stream' } },
      },
    },
    '/api/batch': {
      post: {
        summary: 'Run several commands in one request',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  project: { type: 'string' },
                  stopOnError: { type: 'boolean' },
                  commands: {
                    type: 'array',
                    items: { type: 'object', properties: { command: { type: 'string' }, input: { type: 'object' } }, required: ['command'] },
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Per-command results' } },
      },
    },
    '/api/events': {
      get: {
        summary: 'Server-sent events stream of project mutations',
        responses: { 200: { description: 'text/event-stream' } },
      },
    },
  };

  for (const command of commands) {
    const body = {
      required: true,
      content: { 'application/json': { schema: { ...command.inputSchema, description: command.description } } },
    };
    paths[`/api/commands/${command.id}`] = {
      post: {
        tags: [command.category],
        summary: command.description,
        operationId: command.id.replace(/[^a-zA-Z0-9]/g, '_'),
        requestBody: body,
        responses: {
          200: {
            description: 'Command result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' }, command: { type: 'string' }, data: { type: 'object' }, durationMs: { type: 'number' } },
                },
              },
            },
          },
          422: { description: 'Validation or operation failure' },
        },
      },
    };
    paths[`/api/projects/{project}/commands/${command.id}`] = {
      post: {
        tags: [command.category],
        summary: `${command.description} (project path form)`,
        operationId: `${command.id.replace(/[^a-zA-Z0-9]/g, '_')}_scoped`,
        parameters: [{ name: 'project', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: body,
        responses: { 200: { description: 'Command result' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ModelStudio API',
      version: '0.1.0',
      description:
        'Programmatic control surface for the ModelStudio 3D editor. Every capability exposed in the browser is available here, and every call mutates the same project files.',
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas: {
        Workflow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            params: { type: 'object' },
          },
        },
      },
    },
    'x-modelstudio-workflows': listWorkflows(),
  };
}
