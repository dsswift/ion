# ion-meta

Meta-extension for building Ion Engine extensions. Provides specialist agents and scaffolding tools to guide you through extension authoring, from directory layout to hook wiring to testing.

## Usage

Start an Ion session and invoke the command:

```
/ion-meta
```

The orchestrator will route your request to the right specialist.

## Specialists

| Agent | Focus |
|-------|-------|
| extension-architect | Extension structure, entry points, JSON-RPC protocol |
| agent-designer | Agent .md files, hierarchy, parent-child model |
| skill-author | Skill .md authoring |
| hook-specialist | All 50 hooks, payloads, return types, patterns |
| testing-guide | Testing strategy, integration tests, mocks |

## Tools

| Tool | Purpose |
|------|---------|
| `ion_scaffold` | Scaffold a new extension directory with entry point and agent stubs |
| `ion_validate_agent` | Validate an agent .md file for correct frontmatter and structure |
| `ion_list_hooks` | List all 50 engine hooks with categories and payload shapes |

## Requirements

- Node.js 18+
- esbuild (`npm i -g esbuild`)

## Installation

Ships with Ion Engine. Auto-installed to:

```
~/.ion/extensions/ion-meta/
```

No manual setup needed.
