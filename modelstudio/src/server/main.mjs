// HTTP API + Open MCP HTTP/SSE server + static hosting for the Studio & WebXR VR editor.
//
// Endpoints are thin wrappers over the command registry, so anything the API
// can do the CLI, MCP server, Studio UI, and WebXR VR world can do too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  COMMANDS,
  EXPORTS_ROOT,
  PROJECTS_ROOT,
  listCommands,
  runCommand,
  toErrorPayload,
} from '../core/operations.mjs';
import { Project } from '../core/project.mjs';
import { ModelStudioError, fail } from '../core/util.mjs';
import { openApiDocument } from './openapi.mjs';
import { listProviders } from '../providers/index.mjs';
import { listWorkflows } from '../core/workflows.mjs';
import { listMaterialPresets } from '../core/materials.mjs';
import { listBiomes, TIME_PRESETS } from '../core/world.mjs';
import { getAiConfig, openAiToolSchemas, setAiConfig } from '../core/world-agent.mjs';
import { renderPreview } from '../core/exporter.mjs';
import { createMcpServer } from '../mcp/server.mjs';
import { ensureWorkspaceTls, listLanAddresses } from './tls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '../../web');
const PUBLIC_ROOT = path.resolve(HERE, '../../public');
const MCP_MAIN = path.resolve(HERE, '../mcp/main.mjs');

function isInitMessage(body) {
  if (!body) return false;
  if (Array.isArray(body)) return body.some((item) => item?.method === 'initialize');
  return body.method === 'initialize';
}

export function createServer({ root = PROJECTS_ROOT, exportsRoot = EXPORTS_ROOT, dev = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '256mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  const events = [];
  const sseClients = new Set();
  const seenRevisions = new Map();

  const broadcast = (event, eventName = 'change') => {
    const record = { ...event, at: new Date().toISOString() };
    events.push(record);
    if (events.length > 200) events.shift();
    if (event.project && event.revision != null) {
      seenRevisions.set(String(event.project), Number(event.revision));
    }
    for (const client of sseClients) {
      client.write(`event: ${eventName}\ndata: ${JSON.stringify(record)}\n\n`);
    }
  };

  // Detect mutations made by separate OS processes (stdio MCP server or CLI) so
  // connected VR headsets still hot-reload the world in real time.
  const externalWatcher = setInterval(async () => {
    if (sseClients.size === 0) return;
    try {
      const list = await Project.list(root);
      for (const item of list) {
        const prev = seenRevisions.get(item.name);
        if (prev === undefined) {
          seenRevisions.set(item.name, item.revision);
        } else if (item.revision !== prev) {
          seenRevisions.set(item.name, item.revision);
          broadcast({ command: 'external', project: item.name, revision: item.revision });
        }
      }
    } catch {
      /* ignore transient read races */
    }
  }, 650);
  externalWatcher.unref?.();

  const handle = async (res, req, command, input) => {
    const result = await runCommand(command, input);
    if (!result.ok) {
      const status = result.error?.status ?? (result.error?.code === 'unknown_command' ? 404 : 422);
      res.status(status).json({ ...result, requestId: req.id });
      return;
    }
    if (COMMANDS.find((c) => c.id === command)?.mutates) {
      const rev = result.data?.revision ?? result.data?.project?.revision ?? result.data?.context?.revision ?? null;
      broadcast({ command, project: input.project ?? null, revision: rev });
    }
    res.json({ ...result, requestId: req.id });
  };

  app.use((req, res, next) => {
    req.id = Math.random().toString(36).slice(2, 10);
    next();
  });

  // ---- Open MCP over HTTP (Streamable HTTP + Legacy SSE) ------------------

  const mcpSessions = new Map();
  const sseTransports = new Map();

  app.all('/mcp', async (req, res, next) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && mcpSessions.has(sessionId)) {
        const existing = mcpSessions.get(sessionId);
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'POST' && !sessionId && isInitMessage(req.body)) {
        const mcpServer = createMcpServer({ onMutate: (ev) => broadcast(ev) });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            mcpSessions.set(sid, { server: mcpServer, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) mcpSessions.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'POST' && !sessionId) {
        // Stateless one-shot MCP call
        const mcpServer = createMcpServer({ onMutate: (ev) => broadcast(ev) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close().catch(() => {});
          mcpServer.close().catch(() => {});
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'GET' && !sessionId) {
        res.json({
          ok: true,
          protocol: 'Model Context Protocol (MCP)',
          streamableHttpEndpoint: '/mcp',
          sseEndpoint: '/mcp/sse',
          stdioCommand: `node ${MCP_MAIN}`,
          note: 'Connect any MCP client (Claude, ChatGPT, Cursor, Cline, Goose, OpenAI Agents, LangChain, custom AI) to POST /mcp or GET /mcp/sse.',
        });
        return;
      }

      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found; send initialize first.' }, id: null });
    } catch (error) {
      next(error);
    }
  });

  app.get('/mcp/sse', async (req, res, next) => {
    try {
      const mcpServer = createMcpServer({ onMutate: (ev) => broadcast(ev) });
      const transport = new SSEServerTransport('/mcp/messages', res);
      sseTransports.set(transport.sessionId, { server: mcpServer, transport });
      res.on('close', () => {
        sseTransports.delete(transport.sessionId);
        mcpServer.close().catch(() => {});
      });
      await mcpServer.connect(transport);
    } catch (error) {
      next(error);
    }
  });

  app.post('/mcp/messages', async (req, res, next) => {
    try {
      const sessionId = String(req.query.sessionId ?? '');
      const entry = sseTransports.get(sessionId);
      if (!entry) {
        res.status(404).json({ error: 'Unknown MCP SSE sessionId' });
        return;
      }
      await entry.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  // ---- Core API -----------------------------------------------------------

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'modelstudio',
      version: '0.1.0',
      node: process.version,
      projectsRoot: root,
      exportsRoot,
      lanAddresses: listLanAddresses(),
      mcp: { http: '/mcp', sse: '/mcp/sse' },
      vr: { path: '/vr' },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/api/capabilities', (req, res) => {
    res.json({
      commands: listCommands(),
      providers: listProviders(),
      workflows: listWorkflows(),
      presets: listMaterialPresets(),
      biomes: listBiomes(),
      timePresets: Object.keys(TIME_PRESETS),
      ai: getAiConfig(),
      mcp: {
        streamableHttp: '/mcp',
        sse: '/mcp/sse',
        stdioArgs: [MCP_MAIN],
      },
      limits: {
        maxUploadBytes: 256 * 1024 * 1024,
        undoDepth: 40,
      },
    });
  });

  app.get('/api/ai/config', (req, res) => {
    res.json({ ok: true, config: getAiConfig(), lanAddresses: listLanAddresses() });
  });

  app.post('/api/ai/config', (req, res) => {
    const updated = setAiConfig(req.body ?? {});
    res.json({ ok: true, config: updated });
  });

  app.get('/api/ai/tools', (req, res) => {
    const host = req.headers.host ?? 'localhost:4317';
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    res.json({
      ok: true,
      openAiFunctions: openAiToolSchemas(),
      openApiUrl: `${proto}://${host}/api/openapi.json`,
      mcp: {
        streamableHttpUrl: `${proto}://${host}/mcp`,
        sseUrl: `${proto}://${host}/mcp/sse`,
        stdioConfig: {
          mcpServers: {
            modelstudio: {
              command: 'node',
              args: [MCP_MAIN],
              env: { MODELSTUDIO_HOME: root },
            },
          },
        },
      },
      vrUrl: `${proto}://${host}/vr`,
      lanAddresses: listLanAddresses(),
    });
  });

  app.get('/api/commands', (req, res) => {
    res.json({ count: COMMANDS.length, commands: listCommands() });
  });

  app.get('/api/openapi.json', (req, res) => {
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${proto}://${req.headers.host ?? '127.0.0.1:4317'}`;
    res.json(openApiDocument({ baseUrl }));
  });

  app.get('/api/docs', (req, res) => {
    res.type('html').send(swaggerHtml());
  });

  app.get('/api/projects', async (req, res, next) => {
    try {
      res.json({ root, projects: await Project.list(root) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects', async (req, res, next) => {
    try {
      await handle(res, req, 'project.create', { name: req.body?.name ?? 'Untitled', root });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:ref', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      res.json({ project: project.summary(), path: project.path, dir: project.dir });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:ref', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      await fsp.rm(project.dir, { recursive: true, force: true });
      res.json({ deleted: project.dir });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:ref/state', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      const since = Number(req.query.since ?? -1);
      if (since >= 0 && since === project.data.revision) {
        res.json({ unchanged: true, revision: project.data.revision });
        return;
      }
      await handle(res, req, 'project.snapshot', { project: project.data.name, geometry: req.query.geometry !== 'false' });
    } catch (error) {
      next(error);
    }
  });

  // ---- VR Spatial Routes --------------------------------------------------

  app.get('/api/projects/:ref/vr/context', async (req, res, next) => {
    try {
      await handle(res, req, 'vr.context', { project: req.params.ref });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:ref/vr/point', async (req, res, next) => {
    try {
      const result = await runCommand('vr.point', { ...(req.body ?? {}), project: req.params.ref });
      if (!result.ok) {
        res.status(result.error?.status ?? 422).json({ ...result, requestId: req.id });
        return;
      }
      if (req.body?.pin || req.body?.pinCurrent || req.body?.clearPin) {
        broadcast({ command: 'vr.point', project: req.params.ref, rightThere: result.data?.rightThere }, 'vr_pointer');
      }
      res.json({ ...result, requestId: req.id });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:ref/vr/prompt', async (req, res, next) => {
    try {
      await handle(res, req, 'world.prompt', { ...(req.body ?? {}), project: req.params.ref });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:ref/vr/transcribe', async (req, res, next) => {
    try {
      const audioBase64 = String(req.body?.audio ?? req.body?.audioBase64 ?? '').split(',').pop();
      if (!audioBase64) fail('invalid_argument', 'Pass audioBase64 payload to transcribe');
      const ai = getAiConfig();
      const apiKey = req.body?.apiKey ?? process.env.MODELSTUDIO_AI_KEY ?? process.env.OPENAI_API_KEY ?? '';
      if (!apiKey && ai.baseUrl.includes('api.openai.com')) {
        fail('transcription_unavailable', 'Browser Web Speech needs no key; server-side Whisper fallback requires OPENAI_API_KEY.', { status: 422 });
      }
      const bytes = Buffer.from(audioBase64, 'base64');
      const mimeType = req.body?.mimeType ?? 'audio/webm';
      const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'webm';
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mimeType }), `speech.${ext}`);
      form.append('model', req.body?.model ?? process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1');
      const headers = {};
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const upstream = await fetch(`${ai.baseUrl}/audio/transcriptions`, { method: 'POST', headers, body: form });
      if (!upstream.ok) {
        const text = await upstream.text();
        fail('transcription_failed', `Audio transcription HTTP ${upstream.status}: ${text.slice(0, 200)}`, { status: 502 });
      }
      const data = await upstream.json();
      res.json({ ok: true, text: data.text ?? '' });
    } catch (error) {
      next(error);
    }
  });

  // ---- Project Command & Asset Routes -------------------------------------

  app.post('/api/projects/:ref/commands/:command', async (req, res, next) => {
    try {
      await handle(res, req, req.params.command, { ...(req.body ?? {}), project: req.params.ref });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:ref/textures/:textureId', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      const tex = project.getTexture(req.params.textureId);
      if (!tex) fail('texture_not_found', `No texture ${req.params.textureId}`, { status: 404 });
      res.type(tex.mimeType ?? 'image/png').send(Buffer.from(tex.bytes));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:ref/textures', async (req, res, next) => {
    try {
      await handle(res, req, 'texture.upload', { ...(req.body ?? {}), project: req.params.ref });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:ref/preview', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      const objects = req.query.object ? project.resolveObjects(req.query.object) : Object.values(project.data.objects);
      const render = renderPreview(project, objects, {
        width: Math.min(2048, Number(req.query.width ?? 768)),
        height: Math.min(2048, Number(req.query.height ?? 768)),
        view: String(req.query.view ?? 'three-quarter'),
      });
      res.type('image/png').send(Buffer.from(render.png));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:ref/export/:file', async (req, res, next) => {
    try {
      const project = await Project.open(req.params.ref, { root });
      const candidates = [
        path.join(project.dir, 'exports', path.basename(req.params.file)),
        path.join(exportsRoot, path.basename(req.params.file)),
      ];
      const file = candidates.find((candidate) => fs.existsSync(candidate));
      if (!file) fail('file_not_found', 'Export not found', { status: 404 });
      res.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  // ---- Generic Command Surface --------------------------------------------

  app.post('/api/commands/:command', async (req, res, next) => {
    try {
      await handle(res, req, req.params.command, req.body ?? {});
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/batch', async (req, res, next) => {
    try {
      const steps = Array.isArray(req.body?.commands) ? req.body.commands : [];
      if (!steps.length) fail('invalid_argument', 'Body must contain { commands: [{command, input}] }');
      const results = [];
      for (const step of steps) {
        const result = await runCommand(step.command, { ...(step.input ?? {}), ...(req.body.project ? { project: req.body.project } : {}) });
        results.push(result);
        if (!result.ok && req.body.stopOnError !== false) break;
      }
      if (req.body.project) broadcast({ command: 'batch', project: req.body.project, revision: null });
      res.json({ ok: results.every((r) => r.ok), results, requestId: req.id });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/workflows/:workflow', async (req, res, next) => {
    try {
      await handle(res, req, 'workflow.run', {
        project: req.body?.project ?? req.params.project,
        workflow: req.params.workflow,
        input: req.body?.input ?? {},
        stopOnError: req.body?.stopOnError ?? true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: hello\ndata: {}\n\n');
    sseClients.add(res);
    const timer = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(timer);
      sseClients.delete(res);
    });
  });

  app.get('/api/files', async (req, res, next) => {
    try {
      const target = path.resolve(String(req.query.path ?? ''));
      const allowed = [root, exportsRoot].some((base) => target.startsWith(path.resolve(base)));
      if (!allowed) fail('forbidden', 'Path outside the ModelStudio workspace', { status: 403 });
      if (!fs.existsSync(target)) fail('file_not_found', 'File not found', { status: 404 });
      res.sendFile(target);
    } catch (error) {
      next(error);
    }
  });

  // ---- Static Editor & WebXR VR World -------------------------------------

  if (dev) {
    app.get('/', (req, res) => res.type('html').send('<p>ModelStudio API (dev mode). The editor is served by <code>npm run dev</code>.</p>'));
  } else {
    app.get(['/vr', '/vr/'], (req, res) => {
      const vrPage = path.join(WEB_ROOT, 'vr.html');
      if (fs.existsSync(vrPage)) return res.sendFile(vrPage);
      return res.status(404).type('html').send('<h1>VR World not built</h1><p>Run <code>npm run build</code> in modelstudio/.</p>');
    });
    app.use(express.static(WEB_ROOT, { extensions: ['html'] }));
    app.use(express.static(PUBLIC_ROOT, { extensions: ['html'] }));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/mcp')) return next();
      const index = path.join(WEB_ROOT, 'index.html');
      if (fs.existsSync(index)) return res.sendFile(index);
      return res.status(404).type('html').send('<h1>Editor not built</h1><p>Run <code>npm run build</code> in modelstudio/.</p>');
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const payload = toErrorPayload(error);
    const status = error instanceof ModelStudioError ? error.status : 500;
    if (status >= 500) console.error('[modelstudio]', error);
    res.status(status).json({ ok: false, command: req.params?.command ?? null, error: payload, requestId: req.id });
  });

  app.shutdown = () => {
    clearInterval(externalWatcher);
    for (const entry of mcpSessions.values()) {
      entry.transport.close().catch(() => {});
      entry.server.close().catch(() => {});
    }
    mcpSessions.clear();
    for (const entry of sseTransports.values()) {
      entry.server.close().catch(() => {});
    }
    sseTransports.clear();
  };

  return app;
}

function swaggerHtml() {
  // Self-contained API reference page: no CDN, no framework, works offline.
  const document = openApiDocument();
  const rows = Object.entries(document.paths).map(([route, methods]) => {
    const methodList = Object.keys(methods).map((m) => m.toUpperCase()).join(' ');
    const summary = Object.values(methods)[0]?.summary ?? '';
    return `<tr><td><code>${methodList}</code></td><td><code>${route}</code></td><td>${escapeHtml(summary)}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ModelStudio API &amp; MCP</title>
<style>
body{background:#07090a;color:#d9f7ef;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:32px}
h1{font-size:20px;letter-spacing:.08em;text-transform:uppercase;color:#5ef2c0}
a{color:#8f7dff}
table{border-collapse:collapse;width:100%;margin-top:16px}
td,th{border-bottom:1px solid #17231f;padding:6px 10px;text-align:left;vertical-align:top}
th{color:#5ef2c0;font-weight:600}
code{color:#b9ffe6}
p{color:#7d968f}
</style></head>
<body>
<h1>ModelStudio API &amp; Open MCP</h1>
<p>${document.info.description}</p>
<p>Machine-readable contract: <a href="/api/openapi.json">/api/openapi.json</a> &middot;
Open MCP (Streamable HTTP): <a href="/mcp">/mcp</a> &middot;
WebXR VR World: <a href="/vr">/vr</a> &middot;
health: <a href="/api/health">/api/health</a></p>
<table><thead><tr><th>Method</th><th>Route</th><th>Description</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.MODELSTUDIO_PORT ?? 4317);
  const host = options.host ?? '0.0.0.0';
  const app = createServer(options);

  const bound = await new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      resolve({ server, port: server.address().port, host });
    });
    server.on('close', () => app.shutdown?.());
  });

  const wantHttps = Boolean(options.https || options.httpsPort !== undefined || process.env.MODELSTUDIO_HTTPS_PORT);
  if (wantHttps) {
    const httpsPort = Number(options.httpsPort ?? process.env.MODELSTUDIO_HTTPS_PORT ?? (bound.port === 0 ? 0 : bound.port + 1));
    const tls = await ensureWorkspaceTls(options.root ?? PROJECTS_ROOT);
    const httpsBound = await new Promise((resolve) => {
      const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
      httpsServer.listen(httpsPort, host, () => {
        resolve({ httpsServer, httpsPort: httpsServer.address().port, ips: tls.ips, certFile: tls.certFile });
      });
    });
    return { ...bound, ...httpsBound };
  }

  return bound;
}

// Allow `node src/server/main.mjs` to run the server directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const useHttps = process.argv.includes('--https') || Boolean(process.env.MODELSTUDIO_HTTPS_PORT);
  const port = Number(process.env.MODELSTUDIO_PORT ?? process.env.PORT ?? 4317);
  startServer({ port, host: '0.0.0.0', dev, https: useHttps })
    .then(({ port: actual, httpsPort, ips }) => {
      process.stdout.write(`[modelstudio] Studio + VR + MCP listening on http://0.0.0.0:${actual}\n`);
      process.stdout.write(`[modelstudio] VR World: http://localhost:${actual}/vr  |  Open MCP: http://localhost:${actual}/mcp\n`);
      if (httpsPort) {
        const lan = (ips ?? []).find((ip) => ip !== '127.0.0.1') ?? 'localhost';
        process.stdout.write(`[modelstudio] Meta Quest / WebXR HTTPS on https://${lan}:${httpsPort}/vr\n`);
      }
      process.stdout.write(`[modelstudio] workspace: ${PROJECTS_ROOT}\n`);
    })
    .catch((error) => {
      process.stderr.write(`[modelstudio] failed to start: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
