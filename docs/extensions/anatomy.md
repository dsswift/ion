---
title: Extension Anatomy
description: Directory layout, entry point resolution, and esbuild transpilation for Ion Engine extensions.
sidebar_position: 3
---

# Extension Anatomy

## Directory layout

A minimal extension is a single file in a directory. A full-featured extension might look like this:

```
my-extension/
  index.ts            # entry point (TypeScript, transpiled by engine)
  extension.json      # optional manifest -- name, external native deps
  package.json        # optional npm deps (engine runs `npm install`)
  agents/             # bundled agent definitions (optional)
    researcher.md
    writer.md
  docs/               # reference docs for agents (optional)
    api-spec.md
  .ion-build/         # build artifacts written by the engine; gitignored
```

The only requirement is a valid entry point file. `extension.json`, `package.json`, and `.ion-build/` are optional. The engine creates `.ion-build/.gitignore` automatically the first time it transpiles a TypeScript extension.

The `agents/` directory is the extension-tier source for agent discovery. Agents placed here are discoverable via `ctx.discoverAgents()` with the `"extension"` source. See the [TypeScript SDK reference](sdk-typescript.md) for the discovery API.

## Entry point resolution

The engine resolves entry points in strict priority order:

| Priority | File | Runtime |
|----------|------|---------|
| 1 | `main` | Direct execution (compiled binary) |
| 2 | `extension.ts` | esbuild bundle, then Node.js |
| 3 | `index.ts` | esbuild bundle, then Node.js |
| 4 | `index.js` | Node.js |

The engine checks each file in order and uses the first one found. If none exist, the extension fails to load with an error.

## TypeScript transpilation

When the engine finds a `.ts` entry point, it bundles it using esbuild before execution:

```
esbuild extension.ts --bundle --format=esm --target=node20 --platform=node --outfile=<extDir>/.ion-build/ext-<timestamp>.mjs
```

The esbuild configuration:

- **Format**: ESM (`esm`) — required so extensions can use top-level `await` and standard `import` syntax for Node built-ins.
- **Target**: Node.js 20 (LTS).
- **Platform**: Node.js.
- **Bundling**: all imports are bundled into a single file.
- **Source maps**: inline (`--sourcemap=inline`) for readable stack traces in error events.
- **Externals**: Node built-in modules (`child_process`, `fs`, `path`, `os`, `net`, `crypto`, `events`, `readline`, `stream`, `util`, plus everything under the `node:*` prefix). Bare external packages can be declared in `extension.json`.

The bundled `.mjs` file is written to `<extDir>/.ion-build/` and cleaned up when the extension subprocess exits. The bundle lives inside the extension directory (not /tmp) so Node's ESM resolver naturally finds the extension's own `node_modules` when `import`-ing externally declared deps. The `.mjs` extension means Node treats the bundle as ESM regardless of any `package.json` `type` field nearby. The engine auto-creates `.ion-build/.gitignore` so build artifacts stay out of version control.

### Top-level `await` is supported

Because the bundle is ESM, you can use `await` at module scope:

```ts
import { readFile } from 'node:fs/promises'
import { createIon } from '../sdk/ion-sdk'

const config = JSON.parse(await readFile('./config.json', 'utf8'))
const ion = createIon()

ion.on('session_start', () => log.info(`loaded ${Object.keys(config).length} keys`))
```

The SDK begins reading stdin on `process.nextTick()`, so module-scope async work runs before any hook fires.

**esbuild must be installed** for TypeScript extensions. The engine searches for it in `PATH`, then falls back to `/opt/homebrew/bin/esbuild` and `/usr/local/bin/esbuild`. Install with:

```bash
npm i -g esbuild
```

## Binary extensions

For extensions compiled to a native binary, place the executable at `main` in the extension directory:

```
my-extension/
  main              # compiled binary (any language)
```

The engine executes the binary directly. It must read JSON-RPC 2.0 from stdin and write responses to stdout. See [Building extensions in any language](sdk-raw.md) for protocol details.

## Extension lifecycle

1. **Discovery** -- the engine receives an extension directory path from the session configuration.
2. **Manifest load** -- if `<extDir>/extension.json` exists, the engine parses it. Unknown top-level keys fail the load. See [`extension.json` Reference](extension-json.md).
3. **npm install** -- if `<extDir>/package.json` exists and `node_modules` is missing or older than `package.json`, the engine runs `npm install --omit=dev --no-fund --no-audit` with a 120 s timeout. Idempotent on subsequent loads.
4. **Entry point resolution** -- the engine checks for `main`, `extension.ts`, `index.ts`, `index.js` in that order.
5. **Transpilation** (TypeScript only) -- esbuild bundles the `.ts` file to `<extDir>/.ion-build/ext-<timestamp>.mjs`. ESM format, Node 20 target. Manifest `external` entries become additional `--external:<name>` flags.
6. **Subprocess spawn** -- the engine starts the extension process. For `.js`/`.mjs`/`.cjs` files, it runs `node --enable-source-maps <path>`. For binaries, it executes directly. Working directory is the extension dir; `NODE_PATH=<extDir>/node_modules` is added to the env when `node_modules` exists.
7. **Init handshake** -- the engine sends an `init` JSON-RPC request with `ExtensionConfig`. The extension responds with its tool and command registrations.
8. **Hook forwarding** -- the engine registers internal handlers that forward every hook event to the subprocess via `hook/<name>` RPC calls.
9. **Runtime** -- the engine invokes hooks, tools, and commands as RPC calls throughout the session.
10. **Shutdown** -- the engine kills the subprocess when the session ends. Temporary transpiled files are cleaned up.

## Extension configuration

The engine passes an `ExtensionConfig` object during the init handshake:

```typescript
interface ExtensionConfig {
  extensionDir: string        // absolute path to extension directory
  workingDirectory: string    // project working directory
  mcpConfigPath?: string      // path to MCP config (if any)
}
```

## stderr output

Extension stderr is forwarded to the engine's stderr. Use `process.stderr.write()` (or equivalent in your language) for debug logging. Do not write non-JSON content to stdout -- it will break the JSON-RPC protocol.

## Stateful coordination across hooks

A single extension subprocess is shared across every session in its loaded extension group. That means module-level state (e.g. a top-level `Map` or `Set`) is visible to every hook firing for every session served by the process. To keep per-session state, partition by the session key the engine threads into every `IonContext`:

```typescript
const intentBySession = new Map<string, string>()

ion.on('before_prompt', (ctx, prompt) => {
  intentBySession.set(ctx.sessionKey, classify(prompt))
})

ion.on('model_select', (ctx, info) => {
  if (intentBySession.get(ctx.sessionKey) === 'cloud') {
    return 'claude-sonnet-4-6'
  }
  return info.requestedModel
})

ion.on('session_end', (ctx) => {
  intentBySession.delete(ctx.sessionKey)
})
```

Two rules of thumb:

- **Always include `session_end` cleanup.** Long-lived extension processes will leak entries forever otherwise.
- **Never assume cross-session sharing is what you want.** Two prompts from two different keyed sessions both hit your hooks; without the `sessionKey` key the second overwrites the first.

`ctx.sessionKey` is the same key clients pass on `start_session` / `send_prompt`. It is empty when the context does not originate from a live session — for example, during the init handshake before any session is bound.

The SDK does not provide a built-in `ctx.session.set/get` API. Module-level Maps keyed on `sessionKey` are the canonical pattern; the engine team chose this over a JSON-RPC-backed key/value store because it keeps state in-process (zero round-trip cost) and lets the extension pick its own data structures (LRU, weak refs, TTL maps, etc.) without an SDK design constraint.

## Calling tools from extension code

`ctx.callTool(name, input)` lets a hook handler, tool, or slash command dispatch a tool call without an LLM round trip. The call routes to the same registry the LLM uses, so it covers built-in tools, MCP-registered tools (`mcp__server__tool` form), and any tool registered by extensions in the loaded group.

```typescript
ion.registerCommand('recall', {
  description: '/recall <query>',
  execute: async (args, ctx) => {
    const r = await ctx.callTool('memory_recall', { query: args, topK: 5 })
    ctx.sendMessage(r.content)
  },
})
```

Three things to know:

1. **Permissions still apply.** The session's permission policy gates the call. `deny` rules return `{ content, isError: true }` with a reason string; `ask` rules also return `isError: true` because extension calls cannot block on user elicitation. If you need a tool reachable from extension code under an `ask`-mode policy, configure an explicit allow rule for the specific tool/extension combination.
2. **Per-tool hooks do not fire.** `bash_tool_call`, `read_tool_call`, etc. are skipped on extension-initiated calls -- otherwise the calling extension's own per-tool hook would fire on its own dispatch, creating unwanted recursion. If you need policy for an extension-initiated call, write it inline before invoking `callTool`.
3. **Unknown tool name throws.** A non-registered tool name surfaces as a Promise rejection -- treated as a programming error in the calling extension. Tool-internal failures (file not found, etc.) resolve normally with `isError: true`.

See [`docs/extensions/sandboxing.md`](sandboxing.md) for the permission flow details, and [`docs/extensions/json-rpc-protocol.md`](json-rpc-protocol.md#extcall_tool) for the wire format if you're writing an extension in a non-TypeScript language.

## Driving the agent loop from extension code

`ctx.sendPrompt(text, opts?)` queues a fresh prompt on the session, returning when the engine has accepted (or rejected) it. The LLM runs the prompt asynchronously; the extension does not wait for completion.

Two common shapes:

**Slash commands that talk to the LLM.** A slash command runs synchronously and can't directly produce assistant content via the agent loop. Use `sendPrompt` to inject the assistant turn:

```typescript
ion.registerCommand('cloud', {
  description: '/cloud <message>',
  execute: async (args, ctx) => {
    await ctx.sendPrompt(args, { model: 'claude-sonnet-4-6' })
  },
})
```

**Session priming.** A `session_start` hook can kick off the conversation with a bootstrap prompt:

```typescript
ion.on('session_start', async (ctx) => {
  await ctx.sendPrompt('Summarize the project README and propose a next step.')
})
```

**Recursion hazard.** Calling `sendPrompt` from inside `before_prompt` (or any pre-prompt hook) triggers a new run, which fires the same hook again. The engine's prompt queue depth is the only outer bound. Use a per-session in-flight flag (keyed on `ctx.sessionKey`) to avoid runaway loops:

```typescript
const inFlight = new Set<string>()

ion.on('before_prompt', async (ctx, prompt) => {
  if (inFlight.has(ctx.sessionKey)) return
  inFlight.add(ctx.sessionKey)
  try {
    if (shouldRoute(prompt)) {
      await ctx.sendPrompt(`Routing to specialist: ${prompt}`, { model: 'claude-haiku-4-5-20251001' })
    }
  } finally {
    inFlight.delete(ctx.sessionKey)
  }
})
```
