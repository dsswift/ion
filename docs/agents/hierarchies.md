---
title: Agent Hierarchies
description: Parent-child relationships, graph building, and cycle detection.
sidebar_position: 4
---

# Agent Hierarchies

Agents form a directed graph through the `parent` frontmatter field. The engine builds this graph during discovery and validates it before any agent runs.

## Parent-child model

An agent declares its parent by name:

```yaml
---
name: css-specialist
parent: frontend-reviewer
---
```

This creates an edge from `frontend-reviewer` to `css-specialist`. The parent can delegate tasks to its children, and the children inherit context about the parent's domain.

## Graph structure

The `AgentGraph` holds all discovered agents and their relationships:

```go
type AgentGraph struct {
    Agents   map[string]*AgentDef // name -> definition
    Children map[string][]string  // parent name -> child names
    Roots    []string             // agents with no parent
}
```

- **Roots** are agents with no `parent` field (or an empty one). They appear at the top of any hierarchy listing.
- **Children** are sorted alphabetically for deterministic output.

## Unknown parents

If an agent references a parent that was not discovered, the engine treats it as a root agent and logs a warning:

```
agent "css-specialist" references parent "frontend-reviewer" which was not found
```

The agent still loads and functions normally. It just won't appear as a child in any hierarchy.

## Cycle detection

The engine uses DFS coloring (white/gray/black) to detect cycles before the graph is finalized. If a cycle exists, discovery returns an error and no agents from that graph are loaded.

Example cycle:

```
agent-a (parent: agent-c)
agent-b (parent: agent-a)
agent-c (parent: agent-b)
```

This produces:

```
cycle detected: agent-a -> agent-b -> agent-c -> agent-a
```

The cycle path is included in the error message to help you identify which `parent` field to fix.

## Runtime agent registry

During a session, spawned agents are tracked in an in-memory registry (`agentRegistry`). This is separate from the discovery graph. The registry tracks:

- Agent name
- Process ID
- Parent agent name (for subprocess trees)
- Stdin write function (for steering)

The `AbortAgent` command can target a single agent or an entire subtree by walking the `ParentAgent` chain.

## Agent abort and subtree termination

When aborting with `subtree: true`, the engine walks all registered agents and collects those whose parent chain includes the target agent name. All matching processes receive SIGTERM, with a SIGKILL escalation after 5 seconds.
