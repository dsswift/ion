# Ion Desktop

Electron overlay for macOS. Transparent, always-on-top window with click-through on non-UI regions. Connects to Ion Engine over a Unix socket for agent sessions.

## Requirements

- macOS 13+
- Node.js 20+ (LTS)
- [Ion Engine](../engine/) running as a daemon

Ion Desktop is a UI layer. It does not run agents directly. It connects to the engine daemon over `~/.ion/engine.sock` via the EngineBridge. Start the engine first with `ion serve`.

## Build

```bash
npm install
npm run build       # compile to dist/ (verify only)
npm run dist        # compile + package into release/mac-arm64/Ion.app
```

## Install

From the monorepo root:

```bash
make desktop
# -- or --
bash commands/install-bg.command
```

The installer runs as a detached background process. It handles graceful shutdown (waits for active agents to finish), builds, copies to `/Applications`, and relaunches. Output logs to `/tmp/ion-install.log`.

Never kill Ion processes directly or copy the app bundle manually. Always use the installer so active agents drain before the binary is replaced.

## Architecture

```
Renderer (React) --[IPC]--> Main process --[Unix socket]--> Engine daemon
                              |
                          EngineBridge
                              |
                      window.ion API (preload)
```

- **Main process** (`src/main/index.ts`): window management, IPC handlers, tray, engine bridge
- **Preload** (`src/preload/index.ts`): secure IPC bridge exposing `window.ion` API
- **Renderer** (`src/renderer/`): React + Zustand + Framer Motion
- **Shared types** (`src/shared/types.ts`): IPC channel constants and type definitions
- **Engine bridge** (`src/main/engine-bridge.ts`): connects to engine daemon socket, translates IPC calls to socket commands

### Click-through

The window uses `setIgnoreMouseEvents` with `{ forward: true }` for OS-level click-through on transparent regions. The renderer toggles this on `mousemove` by checking if the cursor is over a `[data-ion-ui]` element. All interactive UI must be inside a `data-ion-ui` container.

### IPC Pattern

Renderer calls `window.ion.method()` -> preload bridges via `ipcRenderer.invoke(IPC.CHANNEL, args)` -> main process handles via `ipcMain.handle(IPC.CHANNEL, handler)`.

## Features

- **Floating overlay:** toggle with `Option + Space` (fallback: `Cmd+Shift+K`)
- **Multi-tab sessions:** each tab is an independent engine session
- **Permission approval UI:** review and approve/deny tool calls
- **Conversation history:** browse and resume past sessions
- **Voice input:** local speech-to-text via Whisper
- **File and screenshot attachments:** paste images or attach files
- **Dark/light theme:** system-follow option

## Development

```bash
npm install
npm run dev         # hot-reload renderer, restart for main process changes
```

Renderer changes update instantly. Main process changes require restarting `npm run dev`.

## Developer Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Production build (no packaging) |
| `npm run dist` | Package as macOS `.app` into `release/` |
| `npm run dev` | Development mode with hot reload |
| `npm run doctor` | Environment diagnostic |

## License

[MIT](LICENSE)
