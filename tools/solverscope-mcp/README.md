# solverscope-mcp

An [MCP](https://modelcontextprotocol.io) server that lets a Claude Code agent direct and render cinematic video of
SolversScope: set up camera shots, look at preview frames, revise them, then render the final clip at full quality.

```
Claude Code  --stdio-->  solverscope-mcp  --WebSocket (127.0.0.1)-->  SolversScope  -->  hidden GPU window  -->  ffmpeg  -->  .mp4
```

Renders are deterministic: frame `k` is drawn at exactly `start + k / fps`, regardless of window size or frame rate.
`preview_frame(t)` uses the same pipeline as the final render, so a preview matches the rendered frame at that time.

## Setup

1. **ffmpeg with libx264.** On PATH, or the copy SolversScope caches in its user-data folder, or `SOLVERS_FFMPEG=/path/to/ffmpeg`.
   If none is found, `render_clip` fails with a clear `ffmpeg_missing` error (previews still work).
2. **Build the bridge** (once):
   ```bash
   cd tools/solverscope-mcp && npm install && npm run build
   ```
3. **Register it** (from the repo root; this writes `.mcp.json`):
   ```bash
   claude mcp add --scope project --transport stdio solverscope -- node tools/solverscope-mcp/dist/index.js
   ```
4. **Start SolversScope with the command server enabled**, with a log open that has a 3D Field tab (BioBuzz sim logs
   add one automatically):
   ```bash
   npm run compile
   npx electron bundles/main.js --cinematic-server ~/path/to/AutoMax.rlog     # default port 8765
   npx electron bundles/main.js --cinematic-server=9000 <log>                   # another port
   ```
   (`SOLVERS_CINEMATIC_SERVER=1` or `SOLVERS_CINEMATIC_PORT=9000` do the same.) With the flag off, nothing listens and
   the app behaves exactly as before.

If the server isn't running, every tool returns: *"Start SolversScope with the command server enabled ..."*.

### Security

The server only listens on `127.0.0.1`. Any web page can open a WebSocket to localhost, so it also (a) refuses any
connection that carries a browser `Origin` header and (b) requires a random per-launch token, sent in an
`x-solverscope-token` header (browsers can't set that). The app writes the token to `<userData>/cinematic-token`
(mode 0600) and a pointer file `~/.solverscope/cinematic.json` (port + token file path, never the token); this bridge
reads both. Renders are written only to the renders directory (`<userData>/renders`, or `SOLVERS_RENDERS_DIR`) under a
validated name; callers cannot pass output paths. Environment overrides for the bridge: `SOLVERSCOPE_PORT`,
`SOLVERSCOPE_TOKEN_FILE`, `SOLVERSCOPE_TOKEN`, `SOLVERSCOPE_DISCOVERY`.

## Coordinates (read this before writing shots)

All shot inputs use the replay's field frame (`get_scene.frame` names the coordinate system the log uses and describes it):
right-handed, **+Z up**, **meters**, **seconds** on the **replay clock** (the log's own timestamps, not seconds from clip
start), degrees for vertical fov, radians for angular speed. Quaternions are **`[w, x, y, z]` (w first)**. A camera looks
along its local **+X**, with +Y left and +Z up (identity rotation looks along field +X).

## Tools

| Tool | What it does |
|---|---|
| `get_scene` | Replay start/end/duration, coordinate frame, field size/center, and every entity (`robot.0`, `piece.0.3`, ...) with type, name and pose at `t`. Call first. |
| `list_replays` | Log files available (absolute paths). |
| `load_replay` | Open a log and wait until it is renderable. |
| `record_start` / `record_stop` | Mark a window on the live timeline (same as the Telemetry tab's Record button). `record_stop` returns `{start, end}`; a later `render_clip` without start/end renders that window. |
| `set_shot` | Validate a shot or preset against the replay and store it as the current shot. |
| `preview_frame` | One frame at time `t` as an **image** (default 960x540 PNG; `format: "jpeg"` optional). |
| `preview_contact_sheet` | `n` evenly spaced frames tiled into one image (long edge capped at 1568 px) with a time per tile. |
| `render_clip` | Async. Returns a `jobId`; H.264 yuv420p CRF 18 BT.709 mp4 to the renders directory. Options: `fps`, `width`/`height` (even), `start`/`end`, `motion_blur_samples`, `shutter_degrees`, `crf`. |
| `render_status` | `state`, `framesDone/frames`, and when done the absolute `outputPath` plus a sidecar `.json` with the shot, params, GPU/ffmpeg versions and per-frame pixel hashes. |

### Shots

`mode` is one of: **static** (one keyframe), **dolly** (2+ keyframes: centripetal Catmull-Rom position, slerp or lookAt
blending, eased fov), **crane** (dolly with the whole move eased in/out), **orbit** (circle a point or entity), **follow**
(critically damped spring chasing an entity, `offsetFrame` `target-local` or `world`, pre-roll so frame 0 is settled).
A `lookAt` can be a point `[x,y,z]` or `{entity, offset}` to track a robot or game piece. Presets (pass `preset` +
`preset_params` `{target?, start?, duration?}`): `establishing_wide`, `follow_chase`, `low_angle_hero`, `top_down`,
`orbit_robot`, `crane_reveal`.

### Known limits

- Game pieces do not roll/spin in offline renders (that spin is renderer state tied to live playback and cannot be
  reproduced at an arbitrary time); they keep a fixed orientation. Positions are exact.
- Determinism means identical frames on the same machine/GPU/driver; the sidecar records those strings.
- Translucent surfaces (the field walls) can tint slightly differently from the live view.

## Example session

`node dist/exampleSession.js [outDir]` runs this against a live app (it is also the end-to-end test):

```
tools: get_scene, list_replays, load_replay, record_start, record_stop, set_shot, preview_frame, preview_contact_sheet, render_clip, render_status

> get_scene {}                      -> startTime 1.54, endTime 29.26, entities robot.0 (BioBuzz CAD), robot.1/2 (HIVEs), piece.0.* ...
> set_shot {"preset":"follow_chase","preset_params":{"target":"robot.0","start":8}}
                                    -> {"shot": {"mode":"follow", "startTime":8, "follow": {"offset":[-0.9,0,0.55], ...}}}
> preview_frame {"t":10}            -> (image/png, 960x540)
> preview_contact_sheet {"n":6,"start":8,"end":12}
                                    -> 1568x1323, tiles at t=8.0, 8.8, 9.6, 10.4, 11.2, 12.0   (the agent sees the camera
                                       too close in tile 4 and edits follow.offset before rendering)
> render_clip {"name":"example","fps":30,"width":1280,"height":720,"start":8,"end":10,"motion_blur_samples":4}
                                    -> {"jobId":"...","frames":60,"outputPath":".../renders/example_20261127-111509.mp4"}
> render_status {"jobId":"..."}     -> running 5/60 ... running 52/60 ... done, outputPath + sidecar json
> preview_frame {"t":129.26}        -> [t_out_of_range] t=129.26 is outside the replay [1.54, 29.26] seconds
```

## Tests

- `npm test` (here): contact-sheet layout/tiling and the "server not running" error; needs no app.
- `npm run test:cinematic` (repo root): replay interpolation, piece tracking, cameras, timing.
- `node test/cinematic/serverCheck.mjs` (repo root, with the app running with `--cinematic-server`): the whole command
  API, auth/Origin rejection, error codes, and a real render.
- Determinism and preview-equals-render: see `test/cinematic/selftest.example.json` (`hashes`, `preview-vs-render`).
