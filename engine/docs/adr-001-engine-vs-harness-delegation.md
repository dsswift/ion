# ADR-001: Engine vs Harness Delegation Mechanics

## Status

Accepted

## Date

2026-04-17

## Context

Ion's multi-agent orchestration needs a clear boundary between engine primitives and harness policy. Without this boundary, either the engine becomes opinionated (limiting harness flexibility) or the harness must reimplement mechanical concerns (disk walking, graph building, format parsing).

The TypeScript engine bundled `agent-loader.ts` (391 lines) that handled discovery, loading, and team composition in one monolithic module. This coupled discovery policy to the runtime, making it impossible for different harness implementations to use different orchestration strategies with the same agent definitions.

## Decision

**Engine provides mechanics. Harness owns orchestration.**

### Engine responsibilities

| Concern | Package | Rationale |
|---------|---------|-----------|
| Agent file discovery | `agentdiscovery` | Format parsing and recursive walking are mechanical, shared across all harness implementations |
| Graph construction | `agentdiscovery` | Tree assembly from flat candidates is mechanical; cycle detection is safety-critical |
| Agent definition parsing | `agentdiscovery` | YAML frontmatter schema is engine-defined; one parser prevents drift |
| Agent spawning | `session` | `StartRun` with agent context already exists |
| Agent registration hooks | `extension` | `RegisterAgent`/`DeregisterAgent` hooks exist in SDK |

### Harness responsibilities

| Concern | Rationale |
|---------|-----------|
| Which agents to load | Policy decision: blocklists, feature flags, user preferences |
| Delegation routing | Which agent handles which task is an orchestration strategy |
| Hierarchy enforcement | Permissions, escalation rules, access control |
| Workflow patterns | Sequential, parallel, consensus, voting are harness-level decisions |
| Team composition | Dynamic membership, runtime scaling, load balancing |
| Agent lifecycle management | When to spin up/down agents based on workload |

### Child-declares-parent model

Agents declare `parent: <name>` in their frontmatter. Engine builds the parent-children graph from these declarations. This inverts the traditional parent-declares-children model.

**Why child-declares-parent:**
- Adding a new specialist never requires editing the parent agent definition
- Teams scale without coordination overhead on the parent file
- Multiple harness implementations can reorganize the same agents differently by filtering the graph
- Orphaned children (parent not found) become roots with a warning, not errors

**Engine builds the graph. Harness decides what to do with it.** The engine's `BuildGraph()` function assembles the adjacency map, detects cycles, and identifies roots. The harness receives this graph and applies its own routing, filtering, and orchestration logic.

### Discovery API

```go
// Engine helper: walk + parse + graph
func Discover(opts WalkOptions) (*AgentGraph, error)

// Engine helper: single file
func LoadAgent(path string) (*AgentDef, error)

// Engine helper: graph from parsed defs
func BuildGraph(agents []*AgentDef) (*AgentGraph, error)
```

The harness controls search paths via `WalkOptions`:
- `IncludeUserDir`: scan `~/.ion/agents/`
- `IncludeProjectDir`: scan `.ion/agents/` relative to working directory
- `ExtraDirs`: custom paths for enterprise or development agent directories
- `Recursive`: walk subdirectories (default behavior)

Project directory entries take precedence over user directory entries with the same filename stem, allowing project-specific agent overrides.

### Interaction with existing extension system

The `extension.Host` already provides `RegisterAgent` and `DeregisterAgent` hooks. Discovery feeds into registration:

```
Discover() -> harness filters -> RegisterAgent() for accepted agents
```

The harness calls `RegisterAgent` for each agent it accepts from the discovery results. The engine's extension system handles the rest: hook dispatch, lifecycle events, and cleanup.

## Consequences

### Positive

- Harness engineers get tested primitives (walking, parsing, cycle detection) without opinions
- Different harness implementations can use the same agent files with different orchestration strategies
- Child-declares-parent scales: new agents join teams without touching existing definitions
- Cycle detection prevents infinite delegation loops at the engine level
- Project-level agent overrides via directory precedence

### Negative

- Harness must implement delegation routing (engine provides no default)
- Team workflow patterns are not reusable across harness implementations
- Graph structure is static at discovery time; dynamic team changes require re-discovery or manual registration

### Future considerations

- Watch mode (`WatchAgents` with `fsnotify`) for runtime agent discovery without restart
- Shared orchestration patterns as an optional library (not engine-level)
- Agent capability negotiation (agent declares what it can do, harness matches tasks to capabilities)
