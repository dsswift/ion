---
title: Quickstart
description: Send your first prompt, run the daemon, manage sessions, and load extensions.
sidebar_position: 2
---

# Quickstart

This guide gets you from zero to a working agent loop in under five minutes.

## Set an API key

Ion needs at least one LLM provider key. The fastest path is an environment variable:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Alternatively, configure providers in `~/.ion/engine.json`:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    }
  }
}
```

When the `apiKey` value looks like an environment variable name (all uppercase, digits, underscores, 3+ characters), Ion resolves it from the environment automatically. This keeps secrets out of config files.

## One-shot prompt

The simplest usage. No daemon required -- Ion auto-starts one, runs the prompt, and cleans up:

```bash
ion prompt "What is the capital of France?"
```

Ion starts an ephemeral daemon, creates a temporary session, streams the response to stdout, then shuts everything down.

### Output formats

Control the output with `--output`:

| Format | Behavior |
|--------|----------|
| `text` (default) | Streams text deltas to stdout, prints final newline on completion |
| `json` | Returns the raw command response as indented JSON |
| `stream-json` | Streams all NDJSON events to stdout (full event stream) |

```bash
# JSON response
ion prompt "hello" --output json

# Full NDJSON event stream
ion prompt "hello" --output stream-json
```

### Model override

```bash
ion prompt "explain quantum computing" --model claude-haiku-4-5-20251001
```

### Limits

```bash
ion prompt "refactor this codebase" --max-turns 10 --max-budget 0.50
```

- `--max-turns` caps LLM round-trips (default: 50)
- `--max-budget` sets a cost ceiling in USD (default: $10.00)

## Daemon mode

For persistent sessions and multi-client access, run the daemon explicitly:

```bash
ion serve
```

```
Ion Engine v0.1.0 started (pid 12345)
Socket: /Users/you/.ion/engine.sock
Backend: api
```

The daemon stays running until you call `ion shutdown` or send SIGINT/SIGTERM.

### Start a named session

```bash
ion start --profile myproject --dir /path/to/project
```

- `--profile` (required): session profile name
- `--dir` (required): working directory for tool execution
- `--key`: session key (defaults to profile name)
- `--extension`: path to an extension directory to load

### Send prompts to a session

```bash
ion prompt "list the files in this directory" --key myproject
```

When `--key` is provided, the prompt targets that specific session. Without `--key`, Ion creates an ephemeral session.

### Check running sessions

```bash
ion status
```

```
KEY              PROFILE          DIRECTORY        STATE
----------------------------------------------------------------
myproject        myproject        /path/to/project running
```

### Stream events

Connect to the daemon and stream all events as NDJSON:

```bash
ion attach
```

Filter to a specific session:

```bash
ion attach --key myproject
```

### Stop a session

```bash
ion stop --key myproject
```

### Shut down the daemon

```bash
ion shutdown
```

## Multi-session workflow

Run multiple independent agent sessions against different projects:

```bash
ion serve &

ion start --profile frontend --dir ~/projects/frontend --key fe
ion start --profile backend --dir ~/projects/backend --key be

ion prompt "find all unused imports" --key fe
ion prompt "add error handling to the API routes" --key be

ion status
```

Each session has its own conversation history, working directory, and extension context.

## Loading an extension

Extensions add hooks, tools, and custom behavior to the engine. Point to an extension directory:

```bash
# At session start
ion start --profile myproject --dir . --extension ~/.ion/extensions/my-harness

# With a one-shot prompt
ion prompt "hello" --extension ~/.ion/extensions/my-harness
```

Skip all extensions for a single prompt:

```bash
ion prompt "hello" --no-extensions
```

## Recording sessions

Capture all events to an NDJSON file for debugging or replay:

```bash
ion record --output session.ndjson
ion record --output session.ndjson --key myproject
```

Press Ctrl+C to stop recording.

## Next steps

- [Core concepts](concepts.md) -- understand sessions, hooks, and the engine/harness split
- [CLI reference](../cli/reference.md) -- all commands, flags, and defaults
- [Configuration](../configuration/) -- engine.json schema and provider setup
- [Extensions](../extensions/) -- build your own hooks and tools
