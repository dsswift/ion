# ion-meta

Meta-extension for building Ion Engine extensions. Provides specialist agents and scaffolding tools to guide you through extension authoring, from directory layout to hook wiring to testing.

## Quick Start

```bash
# One-shot: ask the orchestrator naturally; output streams to stdout
ion prompt "Scaffold an extension named foo with a session_start hook" \
  --extension ~/.ion/extensions/ion-meta/index.ts

# Persistent session for ongoing work; --attach streams the response inline.
# The first --key invocation auto-creates the session with the extension loaded.
ion prompt --key meta --attach \
  --extension ~/.ion/extensions/ion-meta/index.ts \
  "What hooks fire when a tool runs?"
ion prompt --key meta --attach "Now scaffold a hook handler for tool_end"
ion stop --key meta
```

The orchestrator routes detailed work to the specialist sub-agents listed below and uses the registered tools to scaffold, validate, and explore hooks.

## Specialists

| Agent | Focus |
|-------|-------|
| extension-architect | Extension structure, entry points, JSON-RPC protocol |
| agent-designer | Agent .md files, hierarchy, parent-child model |
| skill-author | Skill .md authoring |
| hook-specialist | All 59 hooks, payloads, return types, patterns |
| testing-guide | Testing strategy, integration tests, mocks |

## Tools

| Tool | Purpose |
|------|---------|
| `ion_scaffold` | Scaffold a new extension directory with entry point and agent stubs |
| `ion_validate_agent` | Validate an agent .md file for correct frontmatter and structure |
| `ion_list_hooks` | List all 59 engine hooks with categories and payload shapes |

## Requirements

- Node.js 18+
- esbuild (`npm i -g esbuild`)

## Installation

Ships with Ion Engine. `make install` copies the extension to:

```
~/.ion/extensions/ion-meta/
```

Sessions load it explicitly via `--extension ~/.ion/extensions/ion-meta/index.ts` (the engine does not auto-discover the directory).

## SDK shape

`index.ts` uses the bundled SDK at `engine/extensions/sdk/ion-sdk.ts`:

```ts
import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

ion.on('session_start', () => log.info('extension active'))
ion.registerTool({ name: 'ion_scaffold', /* ... */ })
ion.registerCommand('/ion-meta', { description: '...', execute: async (args, ctx) => { /* ... */ } })
```

This is the canonical shape for new extensions. The engine auto-bundles `ion-sdk.ts` at transpile time — no `npm install`.
