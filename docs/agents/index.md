---
title: Agents
description: Sub-agent system for delegated task execution with independent tool loops.
sidebar_position: 1
---

# Agents

Agents are delegated tasks that run their own tool loops. When the primary session encounters a problem that benefits from isolated context or a different model, it spawns a child agent via the `Agent` tool. The child runs to completion and returns its text output to the parent.

## How agents work

1. The LLM calls the `Agent` tool with a prompt and working directory.
2. The engine creates a child `ApiBackend` with its own run loop.
3. The child streams LLM calls, executes tools, and iterates until done.
4. The `Agent` call returns a dispatch ID immediately; parent continues work or ends turn.
5. The parent uses `AgentStatus` with that dispatch ID for a read-only live-state check. Calling `Agent` again always creates a new dispatch.
6. Engine delivers terminal child result back to parent as machine-authored completion input.
7. Parent may steer running child by dispatch ID; `wait_for_completion: true` is explicit blocking escape hatch.

Parent and child share the same event bus. Events from child agents are forwarded to connected clients so UIs can show agent activity in real time.

## Agent types

### Inline agents (Agent tool)

The `Agent` tool spawns a child session on the fly. No agent definition file needed. The parent provides the prompt and working directory directly in the tool call. This is the most common pattern.

### Disk agents (definition files)

Agents defined as markdown files with YAML frontmatter. These are discovered at startup and available by name. Disk agents let you define reusable specialists with specific models, tool allowlists, and system prompts.

### Extension-dispatched agents

Extensions can dispatch agents programmatically via `DispatchAgent` on the extension context. This supports the same options as disk agents but is triggered from extension code rather than the LLM.

## Agent state tracking

The engine tracks agent lifecycle through `engine_agent_state` events. Each agent gets a name, status (`running`, `done`, `error`, `cancelled`, `idle`), and metadata including elapsed time and a summary of its output. Clients use these events to render agent panels.

The model can query the same active dispatch registry with `AgentStatus`. With no input it lists all active dispatches. With `dispatch_id`, it returns that exact active dispatch. The tool never creates, steers, stops, or waits for an agent. Terminal agents are absent because the engine already delivered their completion to the parent.

Each event is a **complete snapshot** — consumers replace their local view rather than merging incremental updates. See [Agent State Contract](../architecture/agent-state.md) for the normative semantics.

## Key files

| File | Purpose |
|------|---------|
| `engine/internal/agentdiscovery/` | Agent file discovery and graph building |
| `engine/internal/session/manager.go` | Agent spawner wiring (SetAgentSpawner) |
| `engine/internal/extension/sdk.go` | DispatchAgent for extension-triggered agents |

## Further reading

- [Definition format](definition-format.md) -- how to write agent files
- [Discovery](discovery.md) -- where the engine looks for agents
- [Hierarchies](hierarchies.md) -- parent-child relationships and cycle detection
- [Multi-model routing](multi-model.md) -- cost optimization with per-agent models
