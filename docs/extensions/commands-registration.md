---
title: Commands Registration
description: How to register slash commands in Ion Engine extensions.
sidebar_position: 6
---

# Commands Registration

Commands are slash commands that users invoke directly. Unlike tools (which the LLM decides to use), commands are triggered explicitly by the user typing `/<command-name>` in the conversation.

## Registering a command

### TypeScript

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

ion.registerCommand('deploy', {
  description: 'Deploy the current project to staging',
  execute: async (args, ctx) => {
    ctx.emit({ type: 'engine_working_message', message: 'Deploying...' })

    // Run deployment logic
    const result = await deploy(ctx.cwd, args)

    ctx.sendMessage(`Deployment complete: ${result}`)
  }
})
```

### Go

```go
sdk.RegisterCommand("deploy", extension.CommandDefinition{
    Description: "Deploy the current project to staging",
    Execute: func(args string, ctx *extension.Context) error {
        ctx.Emit(types.EngineEvent{
            Type:         "engine_working_message",
            EventMessage: "Deploying...",
        })

        result, err := deploy(ctx.Cwd, args)
        if err != nil {
            return err
        }

        // Commands don't return values directly.
        // Use ctx.Emit to communicate results.
        ctx.Emit(types.EngineEvent{
            Type:         "engine_notify",
            EventMessage: fmt.Sprintf("Deployment complete: %s", result),
            Level:        "info",
        })
        return nil
    },
})
```

## CommandDef schema

### TypeScript

```typescript
interface CommandDef {
  description: string
  execute: (args: string, ctx: IonContext) => Promise<void>
}
```

### Go

```go
type CommandDefinition struct {
    Description string
    Execute     func(args string, ctx *Context) error
}
```

## Invocation

Users type the command in the conversation input:

```
/deploy production --force
```

The engine extracts the command name (`deploy`) and passes the remaining text as the `args` string (`production --force`). The extension is responsible for parsing arguments.

## Communicating results

Commands return void. To send output back to the conversation, use the context methods:

**`ctx.sendMessage(text)`** -- sends text as assistant content. The engine treats this as a follow-up prompt, so the LLM will see it and may respond.

```typescript
execute: async (args, ctx) => {
  ctx.sendMessage('Build succeeded. 3 tests passed, 0 failed.')
}
```

**`ctx.emit(event)`** -- sends an engine event to all socket clients. Use this for UI updates, notifications, and status changes.

```typescript
execute: async (args, ctx) => {
  ctx.emit({ type: 'engine_notify', message: 'Build started', level: 'info' })
  // ... do work ...
  ctx.emit({ type: 'engine_notify', message: 'Build complete', level: 'info' })
}
```

## Wire format

When the engine invokes a command, it sends a `command/{name}` RPC request:

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "command/deploy",
  "params": {
    "_ctx": { "cwd": "/Users/you/project" },
    "args": "production --force"
  }
}
```

The extension responds with null:

```json
{ "jsonrpc": "2.0", "id": 15, "result": null }
```

## Naming conventions

- Use lowercase kebab-case for command names (e.g., `deploy`, `run-tests`, `ion-meta`)
- Keep names short. Users type them manually.
- The description is shown in command listings and help text.
