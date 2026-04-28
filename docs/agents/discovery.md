---
title: Agent Discovery
description: How the engine finds and loads agent definition files.
sidebar_position: 3
---

# Agent Discovery

The engine discovers agents by walking directories in a defined order. Project-level agents override user-level agents with the same name.

## Discovery order

Directories are scanned in this order. The first directory wins for any given agent name.

| Priority | Directory | Description |
|----------|-----------|-------------|
| 1 | `.ion/agents/` | Project-specific agents, relative to working directory |
| 2 | `~/.ion/agents/` | User-level agents, shared across all projects |
| 3 | Extra directories | Additional paths specified via config |

## Walk options

Discovery behavior is controlled by `WalkOptions`:

```go
type WalkOptions struct {
    IncludeUserDir    bool     // scan ~/.ion/agents/
    IncludeProjectDir bool     // scan .ion/agents/ relative to cwd
    ExtraDirs         []string // additional directories
    Recursive         bool     // walk subdirectories
}
```

When `Recursive` is true (default for zero value), the walker descends into subdirectories. Only `.md` files are collected.

## Deduplication

Agents are deduplicated by filename stem. If both `.ion/agents/reviewer.md` and `~/.ion/agents/reviewer.md` exist, only the project-level file is loaded because project directories are scanned first.

This means project agents shadow user agents of the same name. Rename the project file if you need both.

## Discovery process

1. **Walk** -- Collect `.md` file paths from all configured directories.
2. **Parse** -- Load each file and parse the frontmatter into an `AgentDef`.
3. **Build graph** -- Assemble agent definitions into a parent-child graph with cycle detection.

Files that fail to parse (missing frontmatter fences, read errors) are logged and skipped. They do not block discovery of other agents.

```go
graph, err := agentdiscovery.Discover(WalkOptions{
    IncludeProjectDir: true,
    IncludeUserDir:    true,
})
```

## Directory structure examples

Simple flat layout:

```
~/.ion/agents/
  code-reviewer.md
  summarizer.md
  translator.md
```

Nested layout with subdirectories:

```
.ion/agents/
  frontend/
    css-specialist.md
    react-reviewer.md
  backend/
    api-designer.md
    db-optimizer.md
```

With recursive walking, all four agents are discovered. Their names are derived from the filename stem, not the directory path (`css-specialist`, `react-reviewer`, `api-designer`, `db-optimizer`).

## Missing directories

Missing directories are silently skipped. If `~/.ion/agents/` does not exist, the walker moves on to the next configured directory without error.
