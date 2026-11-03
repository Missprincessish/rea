import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runCommand } from '../src/core/operations.mjs';
import { terrainHeightAt } from '../src/core/world.mjs';
import { setAiConfig } from '../src/core/world-agent.mjs';
import { startServer } from '../src/server/main.mjs';

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-vr-'));
  process.env.MODELSTUDIO_HOME = dir;
  return dir;
}

test('VR pointing + "chatgpt make this a hayfield and put a green barn right there" + undo', async () => {
  const home = await tempWorkspace();
  try {
    await runCommand('project.create', { name: 'RanchVR', root: home });

    // 1. User points VR controller ray at (7.5, 0, -11.2)
    const pt = await runCommand('vr.point', {
      project: 'RanchVR',
      inVR: true,
      device: 'Meta Quest 3S',
      head: { position: [0, 1.68, 2.0], forward: [0.48, -0.1, -0.87] },
      pointer: {
        active: true,
        hand: 'right',
        hitPoint: [7.5, 0, -11.2],
        hitKind: 'ground',
      },
      pinCurrent: true,
    });
    assert.equal(pt.ok, true);
    assert.deepEqual(pt.data.rightThere, [7.5, 0, -11.2]);

    // 2. Spoken multi-clause command
    const spoken = await runCommand('world.prompt', {
      project: 'RanchVR',
      instruction: 'chatgpt make this a hayfield and put a green barn right there',
    });
    assert.equal(spoken.ok, true);
    assert.equal(spoken.data.world.biome, 'hayfield');
    assert.ok(spoken.data.world.foliage.some((f) => f.kind === 'hay' && f.count >= 5000));

    const snap = await runCommand('project.snapshot', { project: 'RanchVR', geometry: false });
    assert.equal(snap.ok, true);
    const barn = snap.data.objects.find((o) => o.name.toLowerCase().includes('barn'));
    assert.ok(barn, 'expected green barn object in scene');
    assert.ok(Math.abs(barn.transform.translation[0] - 7.5) < 0.05);
    assert.ok(Math.abs(barn.transform.translation[2] - (-11.2)) < 0.05);

    const expectedGroundY = terrainHeightAt(snap.data.world, 7.5, -11.2);
    assert.ok(Math.abs(barn.transform.translation[1] - expectedGroundY) < 0.15, 'barn should rest on rolling hayfield terrain');

    const barnMat = snap.data.materials.find((m) => m.id === barn.materialId);
    assert.ok(barnMat.baseColorFactor[1] > barnMat.baseColorFactor[0], 'barn material should be green');

    // 3. Point at the barn and ask to scale it up, then undo
    await runCommand('vr.point', {
      project: 'RanchVR',
      pointer: {
        active: true,
        hitPoint: [7.5, 2.0, -11.2],
        hitKind: 'object',
        hitObjectId: barn.id,
        hitObjectName: barn.name,
      },
    });
    const prevScale = barn.transform.scale[0];
    const bigger = await runCommand('world.prompt', {
      project: 'RanchVR',
      instruction: 'make that bigger',
    });
    assert.equal(bigger.ok, true);

    const snap2 = await runCommand('project.snapshot', { project: 'RanchVR', geometry: false });
    const barn2 = snap2.data.objects.find((o) => o.id === barn.id);
    assert.ok(barn2.transform.scale[0] > prevScale);

    const undoRes = await runCommand('world.prompt', { project: 'RanchVR', instruction: 'undo' });
    assert.equal(undoRes.ok, true);
    const snap3 = await runCommand('project.snapshot', { project: 'RanchVR', geometry: false });
    const barn3 = snap3.data.objects.find((o) => o.id === barn.id);
    assert.ok(Math.abs(barn3.transform.scale[0] - prevScale) < 1e-4);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('OpenAI-compatible tool-calling LLM director drives VR world tools', async () => {
  const home = await tempWorkspace();
  let callCount = 0;

  const mockLlm = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    callCount += 1;
    res.setHeader('content-type', 'application/json');

    if (callCount === 1) {
      assert.ok(Array.isArray(parsed.tools) && parsed.tools.some((t) => t.function.name === 'spawn_world_object'));
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_env',
                type: 'function',
                function: { name: 'set_world_environment', arguments: JSON.stringify({ biome: 'hayfield', timeOfDay: 'golden-hour' }) },
              },
              {
                id: 'call_barn',
                type: 'function',
                function: { name: 'spawn_world_object', arguments: JSON.stringify({ prompt: 'green barn', at: 'pointer' }) },
              },
            ],
          },
        }],
      }));
    } else {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Your golden-hour hayfield and green barn are ready right where you pointed!',
          },
        }],
      }));
    }
  });

  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  const llmPort = mockLlm.address().port;

  try {
    await runCommand('project.create', { name: 'LlmWorld', root: home });
    await runCommand('vr.point', {
      project: 'LlmWorld',
      inVR: true,
      pointer: { active: true, hitPoint: [-4.0, 0, -9.0], hitKind: 'ground' },
      pinCurrent: true,
    });

    setAiConfig({ provider: 'openai', baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'test-key', model: 'mock-gpt-4o' });
    const out = await runCommand('world.prompt', {
      project: 'LlmWorld',
      instruction: 'make this a hayfield and put a green barn right there',
    });

    assert.equal(out.ok, true);
    assert.equal(out.data.mode, 'openai-compatible');
    assert.match(out.data.reply, /green barn/i);
    assert.equal(out.data.world.biome, 'hayfield');
    assert.equal(out.data.actions.length, 2);
  } finally {
    setAiConfig({ provider: 'auto', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    mockLlm.closeAllConnections?.();
    mockLlm.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('HTTP VR routes + Open Network MCP (/mcp) + Self-Signed Quest HTTPS', async () => {
  const home = await tempWorkspace();
  const { server, port, httpsServer, httpsPort } = await startServer({
    port: 0,
    httpsPort: 0,
    host: '127.0.0.1',
    root: home,
  });

  try {
    // 1. /vr page & self-signed Quest HTTPS endpoint
    const vrHtml = await fetch(`http://127.0.0.1:${port}/vr`).then((r) => r.text());
    assert.match(vrHtml, /MODEL<span>STUDIO<\/span> VR/);

    const tlsHealth = await new Promise((resolve, reject) => {
      https.get(`https://127.0.0.1:${httpsPort}/api/health`, { rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    assert.equal(tlsHealth.ok, true);

    // 2. Create project & update VR pointer via HTTP
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'OpenMcpVR' }),
    });
    await fetch(`http://127.0.0.1:${port}/api/projects/OpenMcpVR/vr/point`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inVR: true,
        device: 'Generic WebXR Headset',
        pointer: { active: true, hitPoint: [3.2, 0, -6.4], hitKind: 'ground' },
        pinCurrent: true,
      }),
    });

    // 3. Connect an external AI client over Open Streamable HTTP MCP (/mcp)!
    const mcpClient = new Client({ name: 'external-vr-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await mcpClient.connect(transport);

    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('modelstudio_vr_context'));
    assert.ok(names.includes('modelstudio_world_environment'));
    assert.ok(names.includes('modelstudio_world_spawn'));
    assert.ok(names.includes('modelstudio_world_prompt'));

    // External MCP agent inspects where the VR user is pointing:
    const ctxCall = await mcpClient.callTool({
      name: 'modelstudio_vr_context',
      arguments: { project: 'OpenMcpVR' },
    });
    const ctxJson = JSON.parse(ctxCall.content[0].text);
    assert.deepEqual(ctxJson.data.vr.rightThere, [3.2, 0, -6.4]);

    // External MCP agent spawns a windmill "right-there" while user is in VR:
    const spawnCall = await mcpClient.callTool({
      name: 'modelstudio_world_spawn',
      arguments: { project: 'OpenMcpVR', prompt: 'wooden windmill', at: 'pointer' },
    });
    const spawnJson = JSON.parse(spawnCall.content[0].text);
    assert.equal(spawnJson.ok, true);
    assert.equal(spawnJson.data.result.object.position[0], 3.2);
    assert.equal(spawnJson.data.result.object.position[2], -6.4);

    await mcpClient.close();
    await transport.close();
  } finally {
    server.closeAllConnections?.();
    server.close();
    httpsServer?.closeAllConnections?.();
    httpsServer?.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
