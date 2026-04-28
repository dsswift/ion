---
title: Ion Meta Extension
description: Meta-extension for building Ion Engine extensions, with specialist agents and scaffolding tools.
sidebar_position: 10
---

# Ion Meta Extension

Ion Meta is a bundled extension that helps you build other extensions. It provides specialist agents for guided authoring, scaffolding tools, and validation utilities. It ships with the engine and is auto-installed to `~/.ion/extensions/ion-meta/`.

## Usage

Start an Ion session and invoke the command:

```
/ion-meta
```

The orchestrator routes your request to the appropriate specialist agent.

## Specialist agents

| Agent | Focus |
|-------|-------|
| extension-architect | Extension structure, entry points, JSON-RPC protocol |
| agent-designer | Agent .md files, hierarchy, parent-child model |
| skill-author | Skill .md authoring |
| hook-specialist | All 55 hooks, payloads, return types, patterns |
| testing-guide | Testing strategy, integration tests, mocks |

## Tools

### `ion_scaffold`

Generate scaffold structure for a new extension, agent, or skill.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Name of the item to scaffold |
| `type` | string | yes | One of: `extension`, `agent`, `skill` |

**Extension scaffold** returns a directory structure with entry point, README, and root agent.

**Agent scaffold** returns a markdown template with frontmatter (name, description, model, tools).

**Skill scaffold** returns a markdown template with frontmatter (name, description).

### `ion_validate_agent`

Validate an agent markdown file for correct frontmatter structure.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Full markdown content of the agent file |

Returns `{ valid, errors, warnings }`. Checks for required fields (`name`, `description`) and warns about missing optional fields (`model`, `tools`).

### `ion_list_hooks`

List available engine hooks, optionally filtered by category.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `category` | string | no | Filter by category |

Valid categories: `lifecycle`, `session`, `pre-action`, `content`, `per-tool-call`, `per-tool-result`, `context-discovery`, `permission`, `file`, `task`, `elicitation`, `context-injection`, `capability`.

Returns all hooks grouped by category when no filter is specified.

## Requirements

- Node.js 18+
- esbuild (`npm i -g esbuild`)

## Implementation note

Ion Meta is itself a subprocess extension written in TypeScript. It implements the raw JSON-RPC protocol directly (without the SDK) as a reference implementation. See `engine/extensions/ion-meta/index.ts` for the source.
