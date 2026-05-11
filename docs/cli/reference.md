---
title: CLI Reference
description: Complete reference for all Ion Engine CLI commands, flags, and output formats.
sidebar_position: 1
---

# CLI Reference

```
ion [command] [options]
```

If no command is specified, Ion defaults to `serve`.

## Commands

### `ion serve`

Start the engine daemon. Listens on a Unix domain socket (`~/.ion/engine.sock`) or TCP (`127.0.0.1:21017` on Windows).

```bash
ion serve
```

The daemon runs in the foreground, logging to `~/.ion/engine.log`. It stops on SIGINT, SIGTERM, or the `shutdown` IPC command.

On startup, the daemon:

1. Creates `~/.ion/` if it doesn't exist
2. Loads [layered configuration](../configuration/) (defaults < user < project < enterprise)
3. Initializes network settings (proxy, custom CA, TLS)
4. Loads model configuration and provider API keys
5. Acquires a PID lock at `~/.ion/engine.pid`
6. Starts the socket listener
7. Optionally connects to a relay server (if configured)

---

### `ion start`

Start a new persistent session.

```bash
ion start --profile NAME --dir PATH [--key KEY] [--extension PATH]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--profile` | Yes | -- | Session profile name |
| `--dir` | Yes | -- | Working directory for tool execution |
| `--key` | No | profile name | Unique session key |
| `--extension` | No | -- | Path to extension directory to load |

Returns the session creation result as JSON.

```bash
# Start a session named "backend" in a project directory
ion start --profile backend --dir /home/user/projects/api

# Start with a custom key and extension
ion start --profile backend --dir . --key api-session --extension ~/.ion/extensions/my-harness
```

---

### `ion prompt`

Send a prompt to the engine. If no daemon is running, one is auto-started. If no `--key` is provided, an ephemeral session is created, used, and cleaned up.

```bash
ion prompt "text" [--model M] [--max-turns N] [--max-budget USD] [--output FORMAT] [--key KEY] [--extension PATH] [--no-extensions] [--attach] [--timeout DURATION]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--model` | No | config default | Model override (e.g., `claude-sonnet-4-6`, `gpt-4.1-mini`) |
| `--max-turns` | No | 50 | Maximum LLM round-trips |
| `--max-budget` | No | unlimited | Cost ceiling in USD |
| `--output` | No | `text` | Output format: `text`, `json`, or `stream-json` |
| `--key` | No | (ephemeral) | Target session key |
| `--extension` | No | -- | Path to extension directory |
| `--no-extensions` | No | false | Skip all extensions for this prompt |
| `--attach` | No | false | Stream output until idle (non-ephemeral sessions) |
| `--timeout` | No | -- | Wall-clock deadline (e.g. `60s`, `5m`, `2h`). Applies to `text` and `stream-json` output modes. For ephemeral prompts, the engine aborts the in-progress run before cleanup. For keyed sessions, the CLI disconnects but the engine session continues. Exit code 124. Not applicable to `json` output (returns immediately). |

#### Output formats

**`text`** (default): Streams text deltas to stdout as the LLM generates them. Prints a final newline when the session goes idle. For ephemeral prompts, cleans up the session and daemon afterward.

**`json`**: Returns the raw command response as indented JSON. Does not stream.

**`stream-json`**: Streams all engine events as NDJSON to stdout. Includes text deltas, tool use, status changes, and errors. Continues until the connection closes or `--timeout` fires (exit 124).

#### Examples

```bash
# Simple one-shot
ion prompt "explain the builder pattern"

# With model override and cost limit
ion prompt "refactor this module" --model claude-haiku-4-5-20251001 --max-budget 0.25

# Target an existing session
ion prompt "now add tests" --key backend

# Full event stream for debugging
ion prompt "hello" --output stream-json

# Skip extensions
ion prompt "hello" --no-extensions

# CI/scripting: fail if not done in 5 minutes
ion prompt "run the test suite" --timeout 5m
```

---

### `ion attach`

Connect to the daemon and stream all events to stdout as NDJSON.

```bash
ion attach [--key KEY]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--key` | No | (all) | Filter events to a specific session |

Events stream until the connection is closed (Ctrl+C). Every connected client receives all broadcast events from the engine.

---

### `ion status`

List all active sessions.

```bash
ion status
```

Output:

```
KEY              PROFILE          DIRECTORY        STATE
----------------------------------------------------------------
backend          backend          /home/user/api   running
frontend         frontend         /home/user/web   idle
```

Returns "No active sessions" if no sessions are running.

---

### `ion stop`

Stop a session.

```bash
ion stop [--key KEY]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--key` | No | -- | Session to stop |

Returns the stop result as JSON.

---

### `ion shutdown`

Stop the engine daemon. All active sessions are terminated.

```bash
ion shutdown
```

Returns the shutdown acknowledgment as JSON, then the daemon exits.

---

### `ion health`

Probe daemon liveness.

```bash
ion health
```

Returns a JSON health report with version, uptime, and session count. Exits 0 if the daemon is healthy, 1 if it's down or unhealthy.

```bash
# Use in scripts or monitoring
ion health && echo "Engine is running"

# Pretty-print the health report
ion health | jq .
```

---

### `ion upgrade`

Upgrade the engine to the latest release.

```bash
ion upgrade
```

Downloads the latest release from GitHub, verifies the SHA-256 checksum, and atomically replaces the running binary. Development builds (`version = "dev"`) cannot be upgraded — install a release build first.

```bash
# Check and upgrade
ion upgrade
# Checking for updates...
# Update available: 0.1.0 → 0.2.0
# Downloading ion-darwin-arm64...
# Checksum verified.
# Upgraded: 0.1.0 → 0.2.0
```

If already on the latest version:

```
Already up to date: 0.2.0
```

---

### `ion record`

Record session events to an NDJSON file.

```bash
ion record --output PATH [--key KEY]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--output` | Yes | -- | Output file path |
| `--key` | No | (all) | Filter to a specific session |

Records until interrupted with Ctrl+C. Prints the number of captured messages on exit.

```bash
# Record everything
ion record --output full-session.ndjson

# Record a single session
ion record --output debug.ndjson --key backend
```

---

### `ion rpc`

Enter JSON-RPC mode. Bidirectional pipe: stdin commands go to the engine, engine events come back on stdout.

```bash
ion rpc
```

This is the raw pipe interface. It connects to the engine socket and forwards traffic in both directions. Useful for building custom clients or debugging the protocol.

Diagnostic output goes to stderr. The process exits when the socket connection closes.

---

### `ion version`

Print the engine version.

```bash
ion version
```

```
ion-engine v0.1.0
```

## Global options

These flags are recognized by `ion prompt`. Other commands accept subsets as documented above.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--model` | string | config default (`claude-sonnet-4-6`) | LLM model identifier |
| `--max-turns` | int | 50 (server default) | Maximum agent loop iterations. Applied server-side; if not specified, the engine uses its built-in default of 50. |
| `--max-budget` | float | unlimited | Maximum spend in USD |
| `--output` | string | `text` | Output format (`text`, `json`, `stream-json`) |
| `--key` | string | -- | Session key |
| `--extension` | string | -- | Extension directory path (supports `~` expansion) |
| `--no-extensions` | bool | false | Skip all extensions |
| `--timeout` | duration | -- | Wall-clock deadline for `ion prompt` (e.g. `60s`, `5m`). Applies to `text` and `stream-json` modes. Exit 124 on timeout. |
| `--attach` | bool | false | Stream output until idle (keyed sessions) |

## Daemon auto-start

When you run `ion prompt` without a daemon running, Ion:

1. Spawns `ion serve` as a background process
2. Waits up to 5 seconds for the socket to become available
3. Creates an ephemeral session
4. Sends the prompt and streams the response
5. Stops the ephemeral session
6. Shuts down the daemon it started

This makes `ion prompt` fully self-contained for one-shot use. For persistent sessions, start the daemon explicitly with `ion serve`.

## Socket path

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.ion/engine.sock` (Unix domain socket) |
| Windows | `127.0.0.1:21017` (TCP) |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (connection failed, invalid arguments, engine error) |
| 124 | Timeout (prompt exceeded `--timeout` deadline) |
