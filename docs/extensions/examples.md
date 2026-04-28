---
title: Examples
description: Curated extension patterns for common use cases -- cost guards, audit logging, prompt rewriting, model routing, and context injection.
sidebar_position: 11
---

# Extension Examples

Patterns for common extension use cases. Each example is self-contained and can be adapted to your needs.

## Cost guard

Enforce a per-session budget by tracking token usage and blocking tool calls when the budget is exceeded.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

let totalCost = 0
const MAX_BUDGET_USD = 5.0

ion.on('message_end', (ctx) => {
  const usage = ctx.model // check usage via status events
})

ion.on('tool_call', (ctx, payload) => {
  if (totalCost >= MAX_BUDGET_USD) {
    return {
      block: true,
      reason: `Session budget exhausted ($${totalCost.toFixed(2)} / $${MAX_BUDGET_USD.toFixed(2)})`
    }
  }
  return null
})
```

**Go equivalent:**

```go
var totalCost float64
const maxBudget = 5.0

sdk.On("tool_call", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    if totalCost >= maxBudget {
        return &extension.ToolCallResult{
            Block:  true,
            Reason: fmt.Sprintf("Budget exhausted ($%.2f / $%.2f)", totalCost, maxBudget),
        }, nil
    }
    return nil, nil
})
```

## Audit logger

Log all permission decisions and tool invocations to a file for compliance tracking.

```typescript
import { createIon } from './sdk/ion-sdk'
import * as fs from 'fs'

const ion = createIon()

function log(entry: Record<string, any>) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() })
  fs.appendFileSync('/var/log/ion-audit.jsonl', line + '\n')
}

ion.on('permission_request', (ctx, payload) => {
  log({
    event: 'permission_request',
    tool: payload.tool_name,
    decision: payload.decision,
    rule: payload.rule_name
  })
})

ion.on('permission_denied', (ctx, payload) => {
  log({
    event: 'permission_denied',
    tool: payload.tool_name,
    reason: payload.reason
  })
})

ion.on('tool_call', (ctx, payload) => {
  log({
    event: 'tool_call',
    tool: payload.toolName,
    toolId: payload.toolID
  })
  return null
})
```

## Prompt rewriter

Append project-specific instructions to every user prompt using the `before_prompt` hook.

```typescript
import { createIon } from './sdk/ion-sdk'
import * as fs from 'fs'
import * as path from 'path'

const ion = createIon()

ion.on('before_prompt', (ctx, prompt) => {
  // Load project rules if they exist
  const rulesPath = path.join(ctx.cwd, '.project-rules.md')
  if (fs.existsSync(rulesPath)) {
    const rules = fs.readFileSync(rulesPath, 'utf-8')
    return {
      systemPrompt: `\n\n## Project Rules\n${rules}`
    }
  }
  return null
})
```

The `before_prompt` hook can return either:

- `{ value: "rewritten prompt" }` -- replace the user's prompt entirely
- `{ systemPrompt: "additional context" }` -- append to the system prompt
- `{ prompt: "rewritten", systemPrompt: "additional" }` -- both

**Go equivalent:**

```go
sdk.On("before_prompt", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    rulesPath := filepath.Join(ctx.Cwd, ".project-rules.md")
    data, err := os.ReadFile(rulesPath)
    if err != nil {
        return nil, nil // no rules file, skip
    }
    return extension.BeforePromptResult{
        SystemPrompt: "\n\n## Project Rules\n" + string(data),
    }, nil
})
```

## Model router

Route requests to different models based on context window usage or task type using the `model_select` hook.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

ion.on('model_select', (ctx, payload) => {
  // Use a cheaper model for simple tasks
  if (payload.requestedModel === 'claude-sonnet-4-6') {
    // Check if we're in a sub-agent (use faster model)
    return { value: 'claude-haiku-4-5-20251001' }
  }
  return null
})
```

**Go equivalent:**

```go
sdk.On("model_select", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    info, ok := payload.(extension.ModelSelectInfo)
    if !ok {
        return nil, nil
    }
    if info.RequestedModel == "claude-sonnet-4-6" {
        return "claude-haiku-4-5-20251001", nil
    }
    return nil, nil
})
```

## Context injector

Inject additional context into the system prompt at session start using the `context_inject` hook. This is useful for loading project metadata, team conventions, or external configuration.

```typescript
import { createIon } from './sdk/ion-sdk'
import * as fs from 'fs'
import * as path from 'path'

const ion = createIon()

ion.on('context_inject', (ctx, payload) => {
  const entries = []

  // Inject package.json metadata
  const pkgPath = path.join(ctx.cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    entries.push({
      label: 'package.json',
      content: fs.readFileSync(pkgPath, 'utf-8')
    })
  }

  // Inject team conventions
  const conventionsPath = path.join(ctx.cwd, '.conventions.md')
  if (fs.existsSync(conventionsPath)) {
    entries.push({
      label: 'team-conventions',
      content: fs.readFileSync(conventionsPath, 'utf-8')
    })
  }

  return entries
})
```

**Go equivalent:**

```go
sdk.On("context_inject", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    var entries []extension.ContextEntry

    pkgPath := filepath.Join(ctx.Cwd, "package.json")
    if data, err := os.ReadFile(pkgPath); err == nil {
        entries = append(entries, extension.ContextEntry{
            Label:   "package.json",
            Content: string(data),
        })
    }

    if len(entries) == 0 {
        return nil, nil
    }
    return entries, nil
})
```

## Bash command guard

Block dangerous bash commands using the per-tool call hook `bash_tool_call`.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\{.*\}/,  // fork bomb
]

ion.on('bash_tool_call', (ctx, payload) => {
  const command = payload?.command || ''
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        block: true,
        reason: `Blocked dangerous command: ${command}`
      }
    }
  }
  return null
})
```

## Context file filter

Reject specific context files from being loaded using `context_discover` and `context_load`.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

// Skip large generated files from context discovery
ion.on('context_discover', (ctx, payload) => {
  const path = payload?.path || ''
  if (path.includes('node_modules') || path.endsWith('.min.js')) {
    return true // reject this file
  }
  return false
})

// Redact secrets from loaded context files
ion.on('context_load', (ctx, payload) => {
  let content = payload?.content || ''
  // Redact API keys
  content = content.replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
  return { content }
})
```

## Agent dispatch

Spawn child agents from an extension to parallelize work.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

ion.registerTool({
  name: 'parallel_review',
  description: 'Review multiple files in parallel using sub-agents',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths to review'
      }
    },
    required: ['files']
  },
  execute: async (params, ctx) => {
    const results = await Promise.all(
      params.files.map((file: string) =>
        ctx.dispatchAgent({
          name: `reviewer-${file}`,
          task: `Review ${file} for bugs and style issues`,
          model: 'claude-haiku-4-5-20251001',
          projectPath: ctx.cwd
        })
      )
    )

    const summary = results.map((r, i) =>
      `## ${params.files[i]}\n${r.output}`
    ).join('\n\n')

    return { content: summary }
  }
})
```

## Slash command that dispatches a tool directly

Use `ctx.callTool` when a slash command should run a registered tool without an LLM round trip. This is the "side-channel" pattern: the user types `/recall <q>` and the extension immediately fetches results from a memory tool and surfaces them via `ctx.sendMessage`.

```typescript
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

ion.registerCommand('recall', {
  description: '/recall <query> — fetch up to 5 memories matching the query',
  execute: async (args, ctx) => {
    if (!args.trim()) {
      ctx.sendMessage('Usage: /recall <query>')
      return
    }
    const r = await ctx.callTool('memory_recall', {
      query: args,
      topK: 5,
    })
    ctx.sendMessage(r.isError ? `recall failed: ${r.content}` : r.content)
  },
})
```

`callTool` honors the session permission policy — a `deny` rule on `memory_recall` returns `{ content, isError: true }` and the slash command surfaces the reason verbatim. Per-tool hooks (`bash_tool_call`, etc.) do not fire on extension-initiated calls; if you need them, run the equivalent policy inline before calling.

## Slash command that drives a fresh LLM turn

`/cloud <message>` forces a remote model and re-prompts the agent so the user can flip from a local default to a stronger model on demand. `ctx.sendPrompt` is the entry point — it queues a new run on the session and returns once accepted.

```typescript
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

ion.registerCommand('cloud', {
  description: '/cloud <message> — re-prompt with claude-sonnet-4-6',
  execute: async (args, ctx) => {
    if (!args.trim()) {
      ctx.sendMessage('Usage: /cloud <message>')
      return
    }
    await ctx.sendPrompt(args, { model: 'claude-sonnet-4-6' })
  },
})
```

`sendPrompt` does not wait for the LLM to finish — the slash command resolves immediately after the engine queues the run. Use a `session_end` cleanup if you allocate per-prompt state.

**Don't call `sendPrompt` from inside `before_prompt`** without a guard. The new run triggers `before_prompt` again, which can recurse without bound. Store an in-flight flag on a `sessionKey`-keyed Set if you do need that pattern.

## Custom event types for harness-specific UI

Out of the five engine-recognised event types, the most common harness need is "tell the desktop something application-specific happened so it can update a custom panel." The `EngineEvent` union accepts arbitrary `type` values for that case — the engine and desktop bridge pass them through verbatim.

```typescript
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

ion.registerCommand('inbox-refresh', {
  description: '/inbox-refresh — pull latest items and notify the UI',
  execute: async (_, ctx) => {
    const items = await fetchInbox()
    ctx.emit({
      type: 'jarvis_inbox_update',
      count: items.length,
      source: 'mail',
      previewIds: items.slice(0, 5).map(i => i.id),
    })
  },
})
```

The desktop renderer subscribes to the event by `type` string and updates its custom Inbox panel. Renderers that don't subscribe to `jarvis_inbox_update` simply ignore it.

Pick a unique prefix for your custom types (`jarvis_*`, `ion-meta_*`) so future engine event names don't collide with yours.
