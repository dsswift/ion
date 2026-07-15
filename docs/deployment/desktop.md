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

Ion Desktop connects to the engine daemon, which needs API credentials to connect to LLM providers. The engine runs as a launchd LaunchAgent, and macOS GUI/agent processes don't inherit shell environment variables, so you must set them via `launchctl`.

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
- Without this, the engine daemon can't authenticate with API providers

**Note:** The engine daemon inherits its environment from launchd, not from your shell. `launchctl setenv` is the way to make credentials visible to a GUI/agent-launched engine.

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
    │   ├── RunManager (manages engine socket connections)
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

## Engine lifecycle (persistent daemon)

The engine is a **persistent launchd LaunchAgent** (`com.ion.engine`, plist at `~/Library/LaunchAgents/com.ion.engine.plist`), not a subprocess the desktop spawns. It is configured `RunAtLoad` + `KeepAlive` (restart on non-zero exit), so it starts at login and outlives the desktop. Background schedules and iOS/relay connectivity depend on the engine surviving a desktop close.

The desktop **manages** the daemon; it does not host it:

- **On launch**, the desktop bootstraps the LaunchAgent (`launchctl bootstrap`) and kickstarts it. It force-restarts (`launchctl kickstart -k`) **only** when the bundled engine binary or the plist changed; otherwise it uses a non-destructive kickstart that leaves a healthy running daemon (and its in-flight work) alone.
- **Quit Desktop** closes the window but **leaves the engine running** — sessions, schedules, and mobile connectivity continue.
- **Quit All** stops the engine: the desktop sends a graceful `shutdown`, then `launchctl bootout` removes the agent from the launchd namespace so `KeepAlive` does not respawn it. The next desktop launch re-bootstraps a **fresh** daemon.

**The engine reads `~/.ion/engine.json` exactly once, at process start.** A config change (backend, model, logging/egress, providers) therefore does not take effect until the daemon restarts. To pick up a config change without a full Quit All + reopen, use the tray **Restart Engine** item (it runs `launchctl kickstart -k com.ion.engine`, recycling the daemon in place so it re-reads config without quitting the desktop or losing the launchd namespace registration). The equivalent manual command is:

```bash
launchctl kickstart -k gui/$(id -u)/com.ion.engine
```

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

- Check `~/.ion/engine.jsonl` for engine-side issues
- Add temporary UI elements (status text) to surface state
- Build and run in dev mode: `cd desktop && npm run dev`

### Build fails with Node version error

Ion Desktop requires Node.js 20+. Check your version:

```bash
node --version
```

Use `nvm` or `fnm` to switch to a supported version if needed.
