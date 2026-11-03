# ModelStudio — Quest 3S quick start

One command on your MacBook, then open the printed `https://…:4318/vr` URL in the
Quest 3S browser (same Wi-Fi).

```bash
cd /path/to/modelstudio && npm install && npm run build && npm run start:vr
```

That serves:

| Surface | URL | What it is |
| --- | --- | --- |
| Studio editor | `http://localhost:4317/` | Meshy-style text/image → 3D, mesh ops, baking, rigging, export |
| VR world | `https://<your-mac-ip>:4318/vr` | Live WebXR world on the headset (self-signed cert — accept it once) |
| Open MCP | `http://localhost:4317/mcp` | Any AI agent (ChatGPT, Claude, Cursor, Ollama…) can drive the same project |

## Quest 3S controls (this build)

| Control | Action |
| --- | --- |
| **Left stick** | Walk / strafe where you are looking (world-space gaze) |
| **Right stick ← →** | Smooth turn (or snap turn — switch it in **⚙️ Controls**) |
| **Right stick ↑** | Optional parabolic teleport (off by default; aims, then drops on release) |
| **Trigger** | Select object / place the ghost / press board buttons / grab the board header |
| **Grip** | Summon the menu (never dismisses it) · hold over the selected object to drag it |
| **A / X** | Speak a command (or confirm the placement ghost) |
| **B / Y** | Toggle the floating board — snaps back in front of you if it drifted away |
| **☰ MENU wrist pill** | Always-visible re-summon button on your left wrist |
| **🎯 Recenter** (DOM overlay) | Back to spawn if you ever get lost |
| **Hand tracking** | Pinch to select; pinch + push/pull to walk |

### Editing in-world

- **Object Edit** tab → rotate ±45°/90°, resize, **Snap / Align**, **Duplicate**, **Delete**, **Deselect**
- Fences snap **end-to-end**, including exact **90° paddock corners**; other
  objects magnetically align to nearby buildings; optional 0.5 m / 1.0 m grid
- A translucent **ghost preview** shows the snapped result before you confirm
- **Undo / Redo** work from the board, the top bar, `Cmd/Ctrl+Z`, or by voice

### Things to say

> "move that fence closer" · "rotate this windmill to 90 degrees" ·
> "snap that fence" · "duplicate that fence" · "make this a hayfield and put a
> green barn right there" · "scatter 6 hay bales around me" · "undo"

Nothing is sent to a cloud service: the offline spatial planner understands these
phrases with **no API key**. Add an OpenAI-compatible key/models in **AI & MCP**
only if you want free-form language.

## Controls & comfort settings (persisted)

Open **⚙️ Controls** on the desktop UI (or the same drawer via the dom-overlay in
the headset): walk speed 1.5–9 m/s, smooth/snap turning with 30°/45° steps and
40–180°/s turn rate, teleport on/off, magnetic snapping on/off, ghost preview
on/off, grid snap off/0.5 m/1.0 m. Locomotion is automatically locked while you
are dragging the menu or an object.

## If something looks off in the headset

- **Black screen / no VR button** — the page must be `https://` on a LAN IP.
  `npm run start:vr` generates a self-signed cert; accept it once in the Quest
  browser.
- **Controllers not tracked** — press any button; hands and controllers can both
  be active, controllers take priority.
- **You drifted into a hill** — press **🎯 Recenter**.
- **Menu out of reach** — press **B/Y** or tap the **☰ MENU** wrist pill; the
  board re-summons in front of your current gaze.
- **Voice does nothing** — Web Speech needs HTTPS and microphone permission;
  typing in the command bar (with the Quest keyboard) always works.
