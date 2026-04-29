---
title: Desktop
description: Build, package, and install the Ion Desktop app for macOS.
sidebar_position: 5
---

# Desktop

Ion Desktop is an Electron overlay for macOS. It connects to the Ion Engine daemon over a Unix socket and renders conversations in a transparent, always-on-top window.

## Requirements

- macOS 13 (Ventura) or later
- Node.js 20+
- Ion Engine daemon running (`ion serve`)

## API Key Setup

Ion Desktop launches the engine daemon in the background, which needs API credentials to connect to LLM providers. macOS GUI applications don't inherit shell environment variables, so you must set them via `launchctl`.

### Set environment variable for GUI apps

```bash
# For Anthropic (default provider)
launchctl setenv ANTHROPIC_API_KEY "your-key-here"

# For OpenAI
launchctl setenv OPENAI_API_KEY "your-key-here"
```

Verify it's set:
```bash
launchctl getenv ANTHROPIC_API_KEY
```

This persists across reboots. To remove:
```bash
launchctl unsetenv ANTHROPIC_API_KEY
```

### Why this is needed

- Terminal-launched apps inherit environment from shell (.zshrc, .bash_profile, etc.)
- GUI-launched apps (Spotlight, Dock, Login Items) only inherit from LaunchServices
- `launchctl setenv` modifies the LaunchServices environment globally
- Without this, the engine spawned by Ion Desktop can't authenticate with API providers

**Note:** If you launch Ion Desktop from a terminal (e.g., `open /Applications/Ion.app`), it will inherit your shell environment and this step is not required. However, normal GUI launches (Spotlight, Dock, auto-start) require `launchctl setenv`.

## Build

```bash
cd desktop
npm install
npm run build       # compile TypeScript, verify no errors
npm run dist        # package into release/mac-arm64/Ion.app
```

### Install

```bash
# Full cycle: build, package, install to /Applications, relaunch
make desktop

# Or manually copy
cp -r desktop/release/mac-arm64/Ion.app /Applications/
```

`make desktop` handles the full lifecycle: build, package, copy to `/Applications`, and relaunch the app. It waits for any active agent sessions to finish before replacing the binary.

## How it works

Desktop is a client, not a host. It connects to the engine via Unix socket at `~/.ion/engine.sock` and renders whatever the engine sends.

```
Ion.app (Electron)
    │
    ├── Main Process
    │   ├── ControlPlane (tab registry, state machine)
    │   ├── RunManager (spawns engine connections)
    │   └── PermissionServer (HTTP on 127.0.0.1:19836)
    │
    ├── Preload (contextBridge, typed IPC)
    │
    └── Renderer (React + Zustand + Tailwind)
        ├── TabStrip
        ├── ConversationView
        ├── InputBar
        └── MarketplacePanel
```

The engine must be running before launching Desktop. If the socket is not available, Desktop will show a connection error.

## Troubleshooting

### Desktop shows connection error

The engine daemon is not running or the socket does not exist.

```bash
# Check if engine is running
ls -la ~/.ion/engine.sock
# If missing, start it
ion serve
```

### App does not appear on screen

Ion Desktop uses a transparent, always-on-top window with click-through on transparent regions. If the window is offscreen or behind another display:

1. Quit Ion Desktop
2. Delete `~/Library/Application Support/Ion/` preferences
3. Relaunch

### DevTools not accessible

DevTools (Cmd+Option+I) is not mapped in the packaged app. For debugging:

- Check `~/.ion/engine.log` for engine-side issues
- Add temporary UI elements (status text) to surface state
- Build and run in dev mode: `cd desktop && npm run dev`

### Build fails with Node version error

Ion Desktop requires Node.js 20+. Check your version:

```bash
node --version
```

Use `nvm` or `fnm` to switch to a supported version if needed.
