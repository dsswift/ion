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

## This Mac and other Environments

A desktop install carries its own Studio Server, so every Mac running Ion is
an Environment, and one desktop can work in several at once. Settings →
Environments lists this Mac first and every other Environment you have
added. Their conversations share one Inbox; nothing is switched.

To use another Mac's Ion from this one, pair with it. On the other Mac,
Settings → Servers → This Mac → Access & pairing:

- **Pairing link**, then paste the link here under Settings → All servers →
  Add server → Pairing link. Works anywhere the two can reach each other.
- **Discovery → make it discoverable** for 15 minutes or an hour, then find
  it here under All servers → Add server → **Nearby** and type the code it shows.
  Works on the same local network, and an organization can turn it off.

A headless host is added the same ways, or directly over SSH (Add
server → SSH installs the server there). To install Ion itself on
another Mac without walking over to it, see
[Pushing the desktop to another Mac](studio-server.md#pushing-the-desktop-to-another-mac).
The full guide is [Ion Studio Server](studio-server.md), and
[Three machines, start to finish](multi-machine-walkthrough.md) walks one
laptop through pairing with a headless host and with a second laptop.

A device that pairs with this Mac acts as you: it sees this Mac's
conversations and can administer its Environment page. Pairing is one way,
so this Mac gains no access to the device that paired with it.

## Build

```bash
cd desktop
npm install
npm run build       # compile TypeScript, verify no errors
npm run dist        # package into release/mac-arm64/Ion.app
```

### Install

```bash
# Full cycle: build a development-stamped .pkg, wait for active Ion work,
# then open macOS Installer after Ion exits
make desktop

# Build the package without opening Installer
cd desktop && npm run dist && npm run pkg
```

`make desktop` builds a development-stamped package, asks Ion to finish active
agent work and quit, then opens macOS Installer. The package is the only
component that replaces `/Applications/Ion.app` and launches Ion for the
active macOS user after a successful install.

**Do not copy a new `Ion.app` into `/Applications`.** Install the `.pkg`.
If Ion is running, the package stops before changing the bundle. Quit Ion, then
retry the package.

## Updating

**Self-service: let the app update itself.** Release builds ship a built-in auto-updater that checks GitHub Releases on launch and every four hours, downloads a newer signed build in the background, stages a detached installer, and prompts you to restart. This is the supported update path.

**Do not hand-drag a new `Ion.app` into `/Applications` while Ion is running.** Use the release `.pkg` for manual installation instead.

**The engine daemon is swapped by content hash, not version string.** On every launch, the desktop compares the bundled engine binary against the installed daemon binary (`~/.ion/bin/ion`) by sha256 hash. If they differ it installs the new binary and force-restarts the daemon (`launchctl kickstart -k`), so a new engine reliably becomes the running daemon. Earlier builds compared `ion version` output; because no build stamped a version, every binary reported `ion-engine dev` and an update over a prior install was silently skipped — the old daemon kept running and API-key auth appeared to break (routing fell back to the Claude CLI login). If you are recovering a machine stuck on an old daemon, install a current build and relaunch; the hash check swaps it. Manual unblock:

```bash
launchctl kickstart -k gui/$(id -u)/com.ion.engine
```

**Enterprise-managed machines** pin the version through MDM and disable the auto-updater; updates arrive as a pushed `.pkg`. See [enterprise/mdm.md](../enterprise/mdm.md#desktop-app-distribution-signed-pkg).

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
        ├── Inbox
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

### Studio actions time out, settling or sending does nothing for a minute

Check whether more than one Studio server is running:

```bash
ps -axo pid,ppid,lstart,command | grep 'dist/server/main.js' | grep -v grep
lsof -U | grep studio.sock
```

The desktop reaches its LOCAL environment through `~/.ion/studio.sock`, so
whichever server bound it first is the one the desktop talks to. A server
whose parent pid is `1` is an orphan of an earlier desktop: it is running
that earlier build, it still adopts every tab against the engine, and the
current desktop's own server child (`server.jsonl` line `another Studio
server owns the local socket; refusing to run a second instance`) exited
rather than run beside it. Quit Ion, stop the orphan, relaunch:

```bash
pkill -f 'dist/server/main.js'
```

Three layers keep this from recurring: every desktop exit path stops its
server child (`app.exit()` skips `will-quit`, which is where the only stop
used to live), the server exits on its own when the desktop pid it was
given in `ION_SUPERVISOR_PID` is gone, and a second server refuses to start
against an owned socket instead of running half-bound. Every `server.jsonl`
line carries `fields.pid`, so two processes writing one file are
distinguishable.

### Terminal opens to a blinking cursor and no shell

The PTY never started. Since the terminal surfaces a start failure, the
terminal itself prints `terminal failed to start: ...` with the reason and
shows a `failed to start — type to retry` banner; typing retries the spawn.
The same text is in `~/.ion/server.jsonl` as `terminal pty failed to start`,
with the `spawn_helper_*` fields that name the usual cause: node-pty's
prebuilt `spawn-helper` without its execute bit. npm extracts that file 0644,
so a build has to set the bit explicitly. Three layers do:

- the repo's root `postinstall` (`scripts/node-pty-spawn-helper.js`) fixes
  the dev tree's copy under `node_modules`;
- `desktop/scripts/afterPack.js` fixes the copy electron-builder places in
  `app.asar.unpacked`, and `check-packaged-requires.js` fails the build if
  the packed helper is still not executable (pkgbuild preserves the mode it
  finds, so this is what fixes `/Applications`);
- the server repairs the bit itself before each spawn when it can. It cannot
  under the root-owned `/Applications` bundle, which is why the build step is
  the fix and the runtime repair is only the backstop.

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
