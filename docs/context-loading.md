---
title: Context Loading Cascade
description: How Ion grounds every conversation — including dispatched sub-agents — with AGENTS.md/ION.md/CLAUDE.md via a four-level policy cascade.
---

# Context Loading Cascade

Ion injects context files (AGENTS.md, ION.md, CLAUDE.md under compat) into every
conversation — including dispatched sub-agents — via a four-level policy cascade.

## The four levels

| Level | Surface | Behavior |
|-------|---------|----------|
| 1. Built-in default | Engine code | Walk everything: global home roots + child's own project tree. Default-on. |
| 2. Engine config | `engine.json` `dispatchContext` section | Machine-wide override for dispatch defaults. |
| 3. Session policy | `ctx.setDispatchContextDefaults(policy)` | Extension sets once at `session_start`; applies to all subsequent dispatches. |
| 4. Per-dispatch override | `dispatchAgent({ contextPolicy })` | Per-dispatch override of all levels above. |

Resolution order: **per-dispatch > session default > engine.json > built-in
(all on)**. Each level overrides only the fields it explicitly sets; unset
fields inherit from the level below.

## ContextPolicy fields

All fields are tri-state (undefined/nil = inherit from the level above):

| Field | Default | Effect when false |
|-------|---------|-------------------|
| `includeGlobalContext` | true | Suppress home roots (~/.ion, ~/.claude) |
| `includeProjectContext` | true | Suppress cwd + ancestor walk |
| `claudeCompat` | inherit from engine | Override CLAUDE.md discovery |

## Child project layer

The project walk is rooted at the **child's** `projectPath`, not the parent's.
A dispatch working in `engine/` picks up `engine/AGENTS.md`. A cross-repo
dispatch gets that repo's tree. The global (home) layer is location-independent.

Grounding content is prepended **ahead of** the agent persona so it precedes the
role definition, mirroring how root sessions are grounded.

## Custom context composition

To fully control a dispatch's context, suppress engine injection and compose
your own in `before_agent_start`:

```typescript
ion.on('before_agent_start', async (ctx, info) => {
  const files = await ctx.walkContextFiles({ cwd: info.projectPath })
  const custom = files
    .filter(f => f.source === 'global')
    .map(f => `# From ${f.path}\n${f.content}`)
    .join('\n')
  return custom
})
```

Set `contextPolicy: { includeGlobalContext: false, includeProjectContext: false }`
on the dispatch to prevent engine injection so you have full control.

## Token cost note

Dispatches carry the full context tree by default. Extensions that fan out
heavily should use `setDispatchContextDefaults` or per-dispatch `contextPolicy`
to trim context layers when the grounding content is redundant for a specific
dispatch category.

## engine.json example

```json
{
  "dispatchContext": {
    "includeGlobalContext": true,
    "includeProjectContext": true
  }
}
```

## ClaudeCompat threading

The parent session's `claudeCompat` setting is threaded into each dispatched
child so the child's read-triggered nested-descent context loader applies the
same Ion-vs-Claude gate as the parent: Ion-native files (AGENTS.md, ION.md) load
regardless; Claude-compat files (CLAUDE.md, ~/.claude) load only when compat is
enabled. A per-dispatch or session `contextPolicy.claudeCompat` overrides the
inherited value for the eager dispatch walk.
