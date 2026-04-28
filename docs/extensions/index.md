---
title: Extensions
description: Overview of the Ion Engine extension system -- hooks, tools, commands, and capabilities via subprocess JSON-RPC.
sidebar_position: 1
---

# Ion Engine Extensions

Extensions add custom behavior to the Ion Engine. They run as subprocesses that communicate with the engine over JSON-RPC 2.0 via stdin/stdout. Extensions can be written in any language, though the engine ships a TypeScript SDK and a Go SDK for convenience.

## What extensions can do

Extensions plug into four systems:

**Hooks** -- React to engine lifecycle events. There are 59 hooks across 16 categories covering session lifecycle, tool execution, context loading, permissions, extension crash recovery, and more. Hooks can observe events passively (logging, analytics) or actively modify behavior (rewrite prompts, block tool calls, inject context).

**Tools** -- Register custom tools that the LLM can invoke. Tools appear alongside the engine's built-in tools (Read, Write, Bash, etc.) and follow the same JSON Schema parameter definition. The LLM decides when to use them based on the tool description and the current task.

**Commands** -- Register slash commands that users invoke directly (e.g., `/deploy`, `/status`). Commands bypass the LLM and execute immediately.

**Capabilities** -- Register discoverable behaviors that can be surfaced as LLM tools, injected into the system prompt, or both. Capabilities flow through a discover-match-invoke pipeline that lets extensions coordinate complex behaviors.

## Subprocess model

Each extension runs as an isolated subprocess. The engine spawns the process at session start, communicates via NDJSON (one JSON object per line) on stdin/stdout, and kills the process when the session ends.

This design means:

- Extensions cannot crash the engine. A failed extension subprocess is logged and ignored.
- Extensions can be written in any language that can read stdin and write stdout.
- Each extension gets its own process memory. No shared state between extensions.
- stderr is forwarded to the engine's log for debugging.

## Crash recovery

When an extension subprocess dies unexpectedly, the engine auto-respawns it transparently — but only after the active run finishes. Mid-turn deaths defer the respawn to avoid mixed-instance hook firings within a single turn.

The strike budget is **3 respawns within a rolling 60-second window**. If the extension has been alive for over 2 minutes, the next death resets the counter. Exceeding the budget marks the host permanently dead until the user closes the tab; an `engine_extension_dead_permanent` event is emitted.

Extensions can react to recovery via four hooks:

- `extension_respawned` — fires on the new instance after init. Rebuild caches or re-read state from disk.
- `turn_aborted` — fires on the new instance when the prior subprocess died with a turn in flight. Reset per-turn state.
- `peer_extension_died` / `peer_extension_respawned` — fire on sibling extensions in the same group. Useful for multi-extension coordination.

See [hook reference](../hooks/reference.md#extension-lifecycle-4) for payload schemas.

## Language support

The engine resolves entry points in priority order:

1. `main` -- compiled binary (any language)
2. `extension.ts` -- TypeScript (transpiled via esbuild)
3. `index.ts` -- TypeScript (transpiled via esbuild)
4. `index.js` -- Node.js

TypeScript files are bundled automatically using esbuild before execution. The bundled output targets Node.js 20 in ESM format (`.mjs`) and includes inline source maps for readable stack traces in error events. Top-level `await` is supported.

If your extension declares npm dependencies via `package.json`, the engine runs `npm install --omit=dev` automatically before transpilation. Native modules (keytar, better-sqlite3, ...) need to be declared in [`extension.json`](extension-json.md) so esbuild leaves them external; the engine sets `NODE_PATH` so the runtime `import` resolves the user-installed copy.

For languages other than TypeScript/JavaScript, compile to a binary named `main` in the extension directory. The engine will execute it directly. See [Building extensions in any language](sdk-raw.md) for the wire protocol details.

## Communication protocol

All messages follow JSON-RPC 2.0 over NDJSON (newline-delimited JSON). The engine sends requests; the extension sends responses. Extensions can also send notifications and requests back to the engine for event emission and process management.

See [JSON-RPC Protocol](json-rpc-protocol.md) for the full wire format specification.

## Next steps

- [Getting Started](getting-started.md) -- build your first extension in 5 minutes
- [Extension Anatomy](anatomy.md) -- directory layout, entry point resolution, and agent bundling
- [JSON-RPC Protocol](json-rpc-protocol.md) -- wire format reference
- [`extension.json` Reference](extension-json.md) -- per-extension manifest (native deps, name, engine version)
- [TypeScript SDK](sdk-typescript.md) -- API reference for the TypeScript SDK (includes agent discovery)
- [Go SDK](sdk-go.md) -- API reference for the Go SDK
- [Raw Protocol](sdk-raw.md) -- build extensions in any language
