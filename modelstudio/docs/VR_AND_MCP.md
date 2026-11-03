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

Everything below is implemented in one shared, isomorphic module —
[`src/core/vr-interaction.mjs`](../src/core/vr-interaction.mjs) — used by the WebXR
client, the desktop client, the CLI/MCP commands and the regression tests, so the
browser, the AI Director and the MCP server can never disagree about how a stick
or a fence snap behaves.

### Meta Quest 3S Touch Plus mapping (`xr-standard`)

| Input | Physical control | Behaviour |
| --- | --- | --- |
| `axes[2]` / `axes[3]` (left) | **Left thumbstick** | Smooth walk forward/back + strafe **relative to where your headset is looking** (world-space gaze, not the rig's local axis) |
| `axes[2]` / `axes[3]` (right) | **Right thumbstick ← →** | Smooth turning (default) or snap turning, adjustable speed |
| Right stick pushed forward | **Right thumbstick ↑** | Optional parabolic teleport (off by default) — it *aims*, it never teleports accidentally |
| `buttons[0]` | **Index trigger** | Select object / place ghost / tap board button / drag board header |
| `buttons[1]` | **Grip** | Summon the menu (never dismisses it) · hold over the selected object to grab and move it |
| `buttons[4]` | **A** (right) / **X** (left) | Voice command (`speak`), or **confirm** the placement ghost |
| `buttons[5]` | **B** (right) / **Y** (left) | Toggle the floating command board — and **re-summon it if it drifted out of view** |
| `buttons[3]` | Thumbstick click | Reserved (menu tab shortcut) |

### Desktop Browser

| Action | Desktop |
| --- | --- |
| Select an object | Click it (gold reticle = object, teal = ground) |
| Move an object | Drag it, or select it and click the ground / press **Move to Pin** |
| Orbit / look | Drag empty space (mouse look) |
| Walk | `W A S D` / arrows (`Shift` = sprint) |
| Rotate / resize | `R` `Q` `E` and `[` `]` |
| Snap / align | `F` |
| Duplicate / delete | `D` / `Delete` |
| Undo / redo | `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` |
| Toggle floating board | `M` or `Tab` |
| Cancel preview / deselect | `Esc` |

### Full action table

| Action | VR (Quest 3S) | Hand tracking | Desktop |
| --- | --- | --- | --- |
| **Recenter in the world** | `🎯 Recenter` in the DOM overlay (or on desktop) | same | top bar / `R` |
| **Text prompt inside VR** | Pull the DOM-overlay command bar and use the Quest keyboard | same | type in the bar |
| **Aim spatial ray** | Controller laser | Hand ray | Mouse cursor |
| **Select an object** | Pull **Trigger** while pointing at it | Pinch on it | Click it |
| **Pin `"Right There"`** | Trigger on the ground with nothing selected | Pinch ground | Click ground |
| **Grab / move** | Hold **Grip** on the selected object, then aim; it live-snaps to fences/structures/grid | Hold pinch | Drag the object |
| **Rotate** | Board → `↺ -45°` / `↻ +45°` / `↻ 90°`, or `R`/`Q` on desktop | Board buttons | `R` `Q` `E` |
| **Resize** | Board → `➕ Bigger` / `➖ Smaller` | Board buttons | `[` `]` |
| **Snap / align** | Board → `🧲 Snap / Align` (or just drop it near a fence) | Board buttons | `F` |
| **Duplicate** | Board → `📋 Duplicate` (fences extend end-to-end, including 90° corners) | Board buttons | `D` |
| **Delete** | Board → `🗑️ Delete` | Board buttons | `Delete` |
| **Undo / Redo** | Board → `↩️ Undo` / `↪️ Redo`, or **B/Y** menu | Board buttons | `Cmd/Ctrl+Z` |
| **Ghost placement preview** | `Place …` chips → aim → **Trigger** to confirm, **R/E** to rotate, **Esc** to cancel | Pinch to confirm | Click to confirm |
| **Floating board** | **B/Y** toggle, **Grip** summon-only, **☰ MENU** wrist pill, drag the header strip to re-position | Same | `M` / `Tab`, top-bar buttons |
| **Voice command** | **A/X**, or `🎤 Speak` on the board | Pinch `🎤 Speak` | `🎤 Speak` button |

### Hand tracking (controller-free)

Pinch your thumb and index finger to **select**, keep pinching and **pull/push** to
walk along your gaze (capped at ~0.45 m per gesture so you never fly), and pinch
again to place. Hands only take over when both controllers are asleep, so you can
pick up a controller at any time.

### Quest 3S specific fixes in this build

- **`dom-overlay`**: the HTML HUD, drawers, inspector and the Quest system
  keyboard are now visible *inside* the headset, so text prompts work in VR.
- **Fixed-foveated rendering** (`setFoveation(0.6)`) keeps the frame rate stable
  on Quest 3S without a visible quality loss.
- **World-space gaze**: walking/strafing/turning and menu placement all derive
  from `getWorldQuaternion()`, so they stay correct after snap turns.
- **No accidental teleports**: the right stick only *aims* a teleport preview;
  movement happens when you release, and only if teleport is enabled.
- **`🎯 Recenter`** puts you back at spawn if you drift into the terrain.

### Movement & snapping comfort settings

Open **⚙️ Controls** in the top bar (persisted per browser):

- **Walk speed** 1.5 – 9.0 m/s (slow 2.4 / normal 4.5 / fast 7.5 presets)
- **Turning**: smooth (40–180°/s) or snap (30° / 45° steps)
- **Optional parabolic teleport** on the right stick
- **Magnetic fence end-to-end + structure alignment** on/off
- **Ghost preview before placing** on/off
- **Grid snapping**: off / 0.5 m + 15° / 1.0 m + 15°

Locomotion is automatically locked whenever you are dragging the board or grabbing
an object, so you never fly backwards while reaching for a menu button.

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
- Point at any object and say:
  - *"move that fence closer"* / *"push this windmill further away"* / *"move that 2 m left"*
  - *"rotate this windmill to 90°"* / *"rotate that 45 degrees"* / *"turn the barn around"*
  - *"make that bigger"* / *"make this windmill smaller"* / *"paint that red"*
  - *"snap that fence"* / *"connect the fences"* / *"align this silo to the barn"*
  - *"duplicate that fence"* / *"extend that fence"* (grows the fence line end-to-end, 90° corners included)
  - *"delete that"* / *"undo"* / *"redo"*

These edits use the exact same commands as the VR board and the desktop editor
(`object.transform`, `world.snap`, `world.duplicate`, `object.delete`,
`project.undo`/`project.redo`), so an AI, an MCP client, your desktop and your
headset all mutate one shared project revision.

---

## 4. Connecting ChatGPT or Any Other AI

ModelStudio never locks you to a single AI vendor. Three open integration paths work simultaneously:

### A. In-Headset Voice/Text AI (`AI & MCP` Drawer or Env Vars)

- **Zero-Key Offline Spatial Planner (`local` / `auto` default):** Works out of the box offline with zero API keys — parses multi-clause biome, time-of-day, spawn, scatter, **relative move** (*closer / further / left / right*), rotate (relative *and* absolute), resize, **snap/align**, **duplicate/extend**, recolor, delete, undo and redo instructions deterministically.
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
- `modelstudio_world_snap` — snaps a fence end-to-end onto the nearest post (straight continuation *or* 90° corner), magnetically aligns an object to nearby structures, or snaps to a world grid.
- `modelstudio_world_duplicate` — duplicates an object grounded on the terrain; fences automatically extend the fence line end-to-end (`cornerDeg: 90` for a corner joint).
- `modelstudio_world_prompt` — runs a natural-language spatial command against the live VR pointer state, including *"move that fence closer"*, *"rotate this windmill to 90°"*, *"duplicate this fence"* and *"snap that fence"*.
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
