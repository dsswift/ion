---
title: Graph Queries
description: How to query the graphify knowledge graph effectively — subcommands, budgets, edge confidence, and worked examples on this codebase.
sidebar_position: 6
---

# Graph Queries

Ion keeps a graphify knowledge graph of the codebase at `graphify-out/`. Agents query it instead of grepping when the question is about structure, flow, or relationships.

This page is the depth reference: worked examples, the failure modes, and the reasoning behind the rules. The operational instruction lives in root [`AGENTS.md`](../../AGENTS.md) § "Codebase questions" — read that first if you just need the rules.

Graphify is optional. Nothing in Ion requires it, and a clone without it is fully supported. See [Branch Lifecycle](branch-lifecycle.md#the-graph-is-a-local-cache-and-optional).

## The three subcommands

| Command | Answers |
|---|---|
| `graphify query "<identifier>"` | Where does this live, what is near it |
| `graphify explain "<symbol>"` | What exactly does this touch, with `file:line` |
| `graphify path "<A>" "<B>"` | How do these two things connect |

### query — the locator

```bash
graphify query "complete worktree"
```

```
Traversal: BFS depth=2 | Start: ['worktree.ts', 'worktree-slice.ts', 'WorktreeInfo', '.complete()'] | 193 nodes found

NODE worktree.ts [src=desktop/src/main/ipc/worktree.ts loc=L1 ...]
NODE worktree-slice.ts [src=desktop/src/renderer/stores/slices/worktree-slice.ts loc=L1 ...]
NODE WorktreeInfo [src=desktop/src/shared/types-session.ts loc=L673 ...]
NODE .complete() [src=engine/internal/session/run_once.go loc=L75 ...]
```

Three files and a type, with line numbers, from one call. That is the job: **the graph tells you where to look, the source file tells you what it does.**

### explain — the edge list

```bash
graphify explain "clearSessionSkills"
```

```
Node: clearSessionSkills()
  Source:    engine/internal/session/session_skills.go L26
  Community: Community 149
  Degree:    4

Connections (4):
  --> LogWithFields() [calls] [INFERRED] engine/internal/session/session_skills.go:L28
  <-- .StopSession() [calls] [INFERRED] engine/internal/session/manager.go:L402
  --> ClearSkillsFor() [calls] [INFERRED] engine/internal/session/session_skills.go:L27
  <-- session_skills.go [contains] [EXTRACTED] engine/internal/session/session_skills.go:L26
```

Arrows show direction: `<--` is an inbound caller, `-->` is something this node calls.

This is the fastest way to satisfy root `AGENTS.md` § "Dead code is not load-bearing until proven otherwise", which requires a **cited** live caller rather than an assumption. Here the citation is `.StopSession()` at `manager.go:L402`.

### path — the wiring

```bash
graphify path "createWorktreeSlice" "registerWorktreeIpc"
```

```
Shortest path (4 hops):
  createWorktreeSlice() --indirect_call [INFERRED]--> err() <--indirect_call [INFERRED]--
  .computeSnapshot() --calls [EXTRACTED]--> runGit() <--calls [EXTRACTED]-- registerWorktreeIpc()
```

Use it when a change crosses layers and you need the connection rather than the endpoints.

## Edge confidence: `EXTRACTED` vs `INFERRED`

Every edge is tagged:

- **`EXTRACTED`** — read directly from the source. High confidence.
- **`INFERRED`** — resolved by graphify's symbol resolution. A strong hint, not a fact.

**Call edges are frequently `INFERRED`.** In the `clearSessionSkills` output above, *every* call edge is inferred; only the structural `contains` edge is extracted. The `path` example is mixed — two `indirect_call [INFERRED]` hops and two `calls [EXTRACTED]` hops.

The practical rule: treat a caller list as **the set of places to check in source**, not as proof. This is the concrete reason the graph locates and the source file confirms.

## Budgets

**Never pass `--budget` below 400.** Omit it to take the 2000 default.

### The `--budget 40` post-mortem

A real session opened with this call and then spent ~24 `Grep`/`Read` calls answering the question by hand:

```bash
graphify query "complete worktree" --budget 40
```

```
Traversal: BFS depth=2 | Start: ['worktree.ts', 'worktree-slice.ts', 'WorktreeInfo', '.complete()'] | 193 nodes found

[!] TRUNCATED: showing 4 of 193 nodes (~40-token budget). The answer may be among the 189 cut nodes
```

The graph was not at fault. The seeding was correct, 193 nodes were found, and the four shown include three of the four files the session went on to rediscover the slow way — including `types-session.ts`, whose line range it later read with `sed`.

The budget threw the answer away, the truncated output read as "the graph doesn't know," and the agent fell back to sweeping. **A tiny budget does not give you a smaller answer; it gives you a misleading one.**

## Why results drift into noise

Past roughly rank 15-20, results tend toward infrastructure — loggers, preference stores, type barrels. This is structural.

The graph is a **power-law network**. Median node degree is 3, but a handful of nodes run into the hundreds:

| Hub | Why it connects to everything |
|---|---|
| `LogWithFields()` | Every engine package logs |
| `NewManager()` | Session construction, referenced across tests and callers |
| `Context` | The SDK context type, threaded everywhere |
| `newMockBackend()` | Test helper used by most session tests |
| `useColors()` | Every themed renderer component |
| `shared/types.ts` | Type barrel imported across the desktop |

A depth-2 traversal reaches one of these within a hop or two of almost any seed, and the hub's hundreds of neighbours then crowd out the remaining budget.

**This gets worse as a codebase grows, not better.** More code means more logger callers; the hubs grow faster than any relevant neighbourhood does.

### The fix: `--context`, not a bigger budget

```bash
graphify query "createWorktreeSlice" --context call
```

Valid values: `call`, `import`, `field`, `parameter_type`, `return_type`, `generic_arg`. (`param` and `params` alias to `parameter_type`.)

Filtering to `call` on a function seed drops the preferences/theme/logger cluster and returns actual callers and callees.

It is a heuristic, not a cure. `LogWithFields()` is reached *by* call edges, so it survives a call filter. The honest expectation is "this improves the top of the result," not "this removes the noise."

## What is not a node

Nodes are functions, methods, types, and files. **Package-level variables and constants are not extracted.**

A query for one returns `No matching nodes found`. That means "not a node," **not** "not in the codebase." Query the function that reads it, or grep for it directly.

## Maintenance

The graph is a gitignored local cache. The git hooks keep it current automatically — see [Branch Lifecycle](branch-lifecycle.md#the-graph-is-a-local-cache-and-optional).

| Command | When |
|---|---|
| `make graph` | Full rebuild from scratch |
| `make graph-refresh` | Incremental update on demand |

**Incremental updates accumulate stale nodes.** When a file leaves the scan corpus, its nodes linger; only a full extraction purges them. This is normal, not a defect — a recent `make graph` on this repo went from 25,101 nodes to 24,096, clearing roughly a thousand stale entries. Run one occasionally, or whenever query results cite files that no longer exist.

Both are offline and need no API key.

## Why MCP is not used

Graphify ships an MCP server (`python -m graphify.serve`) that would expose the graph as native tools rather than shell commands. Ion does not use it.

It requires an optional extra that is not part of the base install:

```
ModuleNotFoundError: No module named 'mcp'
```

PyPI metadata confirms it: `mcp; extra == "mcp"`, so it needs `graphifyy[mcp]`. Registering the server in the tracked `.ion/engine.json` would point every clone at a server that cannot start unless each developer separately installs the extra — which contradicts graphify being optional, and would add a failed connection to every session start.

The CLI path needs no extra install and is what this page documents. If MCP moves into graphify's base install, this is worth revisiting.
