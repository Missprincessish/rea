# Live WebXR VR World + Spatial AI & Open MCP Guide

ModelStudio includes a live **WebXR 3D World** (`/vr`) synchronized in real time with its 61-command 3D modeling engine. You can put on a VR headset, point anywhere on the ground or at an existing 3D object, and speak or type natural spatial commands — or let **ChatGPT, Claude, Cursor, Ollama, or any MCP client** edit the world around you while you stand inside it.

---

## 1. Headset Support (Standard WebXR + Meta Quest 3S)

`/vr` is built on standard **W3C WebXR (`immersive-vr` and `immersive-ar`)** with offline Three.js controller & hand primitives (no external CDN fetches):

- **Meta Quest 3S / Quest 3 / Quest 2 / Quest Pro** (Meta Quest Browser — full Touch Plus controllers, Quest Hand Tracking pinch, and optional Color Passthrough AR)
- **Pico 4 / Pico 4 Ultra**, **Apple Vision Pro** (Safari WebXR enabled), **HTC Vive / Valve Index / SteamVR / PCVR** (Chrome / Edge WebXR)
- **Desktop / MacBook / iPad / Phone** (2D 3D-walkthrough fallback: `WASD` walk, drag to look, click anywhere to pin `"Right There"`)

---

## 2. Quick Start on MacBook + Meta Quest 3S (Same Wi-Fi)

WebXR and browser microphone APIs require a **secure context (`https://`)** whenever accessed over a local Wi-Fi IP (`192.168.x.x`). ModelStudio includes a built-in zero-dependency ECDSA-P256 TLS generator (`src/server/tls.mjs`) — no `openssl` or `mkcert` required.

### Step 1 — Start the server with `--https` on your Mac

```bash
cd modelstudio
npm install
npm run build
npm run start:vr
# (equivalent to: node src/server/main.mjs --https)
```

Terminal output will print both local HTTP and your Mac's LAN HTTPS URL:

```text
[modelstudio] Studio + VR + MCP listening on http://0.0.0.0:4317
[modelstudio] VR World: http://localhost:4317/vr  |  Open MCP: http://localhost:4317/mcp
[modelstudio] Meta Quest / WebXR HTTPS on https://192.168.1.42:4318/vr
```

### Step 2 — Open on your Meta Quest 3S

1. Connect your Meta Quest 3S to the same Wi-Fi network as your MacBook.
2. Open **Meta Quest Browser** inside the headset and visit `https://<your-mac-lan-ip>:4318/vr`.
3. On first visit, click **Advanced → Proceed** once to trust your MacBook's local self-signed certificate.
4. Tap **Enter VR (Quest / WebXR)** (or **Passthrough AR** to spawn 3D buildings onto your real room floor).

> **Alternative USB-C shortcut (no certificate prompt):** If your Quest 3S is plugged into your MacBook over USB-C with Developer Mode (`adb reverse tcp:4317 tcp:4317`), open `http://localhost:4317/vr` directly in Quest Browser — `localhost` is treated as a secure context automatically.

---

## 3. Controls Inside VR & Desktop

| Action | Meta Quest 3S / WebXR Controllers | Hand Tracking | Desktop Browser |
| --- | --- | --- | --- |
| **Aim spatial ray** | Point left or right controller | Aim hand ray | Move mouse cursor |
| **Pin `"Right There"` (`📍`)** | Pull **Trigger** (`select`) | Index-thumb **Pinch** | Click ground or object |
| **Speak spatial command (`🎤`)** | Press **A** or **X** button (or click `🎤 Speak` on 3D board) | Pinch `🎤 Speak` on 3D board | Click **🎤 Speak** |
| **Summon / hide 3D VR Menu** | Press **B** or **Y** button, or **Grip** squeeze | — | Always shown at bottom |
| **Walk over hills** | **Left thumbstick** (auto-follows terrain height) | — | `W A S D` / Arrow keys (`Shift` sprint) |
| **Snap-turn / Teleport** | **Right stick** left/right = 30° turn; push forward = teleport | — | Drag mouse to look |

### How `"Right There"` Spatial Pointing Works

1. Point your laser ray at a hillside 12 meters away and pull **Trigger** (or press **A/X** to start speaking — ModelStudio snapshots your exact ray hit point the instant you start talking so your arm can relax while speaking).
2. A golden-teal **`📍 Right There` beacon** pulses at that exact `[x, y, z]` coordinate.
3. Say or type:
   > *"ChatGPT, make this a hayfield and put a green barn right there"*
4. ModelStudio:
   - Transforms the world into the **`hayfield`** biome (warm golden sky, rolling terrain heightfield, **13,000 GPU-instanced wind-swaying hay stalks**, and scattered golden hay bales).
   - Generates a watertight 3D **green barn** mesh, scales it to life-size (~6.4 m tall), rotates its front gable doors to face you, grounds its foundation onto the exact hill elevation `terrainHeightAt(x, z)` where you pointed, and carves a foliage clearing around it so hay doesn't poke through the floor.
   - Streams a Server-Sent Event (`change`) so your VR headset hot-reloads the world around you without leaving WebXR.

Other spatial phrases you can say or type immediately:
- *"make this a pine forest at sunset"* / *"make this a snowfield"* / *"make this a starlit clearing with fireflies"*
- *"put a wooden windmill right there"* / *"put a grain silo to my left"* / *"put a campfire in front of me"*
- *"scatter 8 hay bales around me"* / *"scatter 12 pine trees over there"*
- Point at any object and say: *"make that bigger"*, *"paint that red"*, *"rotate that 45 degrees"*, *"delete that"*, or *"undo"*.

---

## 4. Connecting ChatGPT or Any Other AI

ModelStudio never locks you to a single AI vendor. Three open integration paths work simultaneously:

### A. In-Headset Voice/Text AI (`AI & MCP` Drawer or Env Vars)

- **Zero-Key Offline Spatial Planner (`local` / `auto` default):** Works out of the box offline with zero API keys — parses multi-clause biome, time-of-day, spawn, scatter, transform, color, delete, and undo instructions deterministically.
- **ChatGPT / OpenAI API:** Open **AI & MCP** in `/vr` and paste an OpenAI key (`gpt-4o-mini`, `gpt-4.1`, etc.), or start the server with:
  ```bash
  OPENAI_API_KEY="sk-..." npm run start:vr
  ```
- **Local Ollama / LM Studio / OpenRouter (any OpenAI-compatible LLM):**
  Set Base URL to `http://localhost:11434/v1` (Ollama) or `https://openrouter.ai/api/v1` and pick any tool-calling model (`llama3.2`, `qwen2.5`, `claude-3.7-sonnet`, etc.).

### B. Open MCP Server (Network HTTP + SSE + Stdio)

Every running ModelStudio server exposes an **open Model Context Protocol (MCP)** endpoint with live VR context and full 3D mesh/material/rigging tools:

- **Streamable HTTP MCP:** `http://<mac-ip>:4317/mcp` (or `https://<mac-ip>:4318/mcp`)
- **SSE MCP:** `http://<mac-ip>:4317/mcp/sse`
- **Stdio MCP:** `node /path/to/modelstudio/src/mcp/main.mjs`

#### Dedicated VR Spatial MCP Tools
- `modelstudio_vr_context` — reads the user's live VR headset position, gaze direction, `"Right There"` pointer/pin `[x, y, z]`, targeted object (`"that"`), current biome, and nearby objects with relative bearings (`ahead-left`, `8.4m`).
- `modelstudio_world_environment` — changes biome (`hayfield`, `meadow`, `forest`, `snow`, `desert`, `beach`, `mars`, `night-clearing`, `cyberpunk`, `courtyard`, `studio`), `timeOfDay`, `hillHeight`, and swaying foliage.
- `modelstudio_world_spawn` — generates and places a 1:1 VR-scale 3D building, prop, vehicle, or character at `"pointer"` (`"right there"`), `"in-front"`, `"left"`, `"right"`, `"behind"`, or `[x, y, z]`.
- `modelstudio_world_scatter` — scatters grounded 3D props across the terrain.
- `modelstudio_world_prompt` — runs a natural-language spatial command against the live VR pointer state.
- Plus `modelstudio_run`, `modelstudio_batch`, `modelstudio_workflow`, `modelstudio_preview` for full sculpting, remeshing, UV baking, rigging, animation, and GLB export!

#### Example `mcp.json` (Claude Desktop, Cursor, Cline, Windsurf, Goose, ChatGPT Desktop MCP)

```json
{
  "mcpServers": {
    "modelstudio": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/modelstudio/src/mcp/main.mjs"]
    }
  }
}
```

Or connect any remote/cloud MCP client (including ChatGPT Connectors / OpenAI Responses API MCP tools via `ngrok` / Cloudflare Tunnel) directly to `https://<tunnel-host>/mcp`.

### C. OpenAPI 3.1 / Custom GPT Actions / Scripts

- Full OpenAPI 3.1 schema: `GET /api/openapi.json`
- OpenAI function schemas & MCP snippets: `GET /api/ai/tools`
- Direct REST endpoints:
  - `GET /api/projects/:project/vr/context`
  - `POST /api/projects/:project/vr/point`
  - `POST /api/projects/:project/vr/prompt`
