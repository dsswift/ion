---
title: Getting Started
description: Build your first Ion Engine extension in 5 minutes.
sidebar_position: 2
---

# Getting Started

This guide walks through creating a minimal extension that logs session events and registers a custom tool. By the end you will have a working extension running inside the Ion Engine.

## Prerequisites

- Ion Engine installed and running
- Node.js 18+
- esbuild (`npm i -g esbuild`)

## 1. Create the extension directory

Extensions live in `~/.ion/extensions/`. Create a directory for your extension:

```bash
mkdir -p ~/.ion/extensions/my-extension
cd ~/.ion/extensions/my-extension
```

## 2. Write the entry point

Create `index.ts` with the following content:

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

// Log when a session starts
ion.on('session_start', (ctx) => {
  process.stderr.write('[my-extension] session started\n')
})

// Register a tool that the LLM can invoke
ion.registerTool({
  name: 'greet',
  description: 'Returns a greeting for the given name',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' }
    },
    required: ['name']
  },
  execute: async (params, ctx) => {
    return { content: `Hello, ${params.name}!` }
  }
})
```

## 3. Copy the SDK

The TypeScript SDK is a single file. Copy it from the engine source:

```bash
mkdir -p sdk
cp ~/.ion/extensions/sdk/ion-sdk.ts sdk/ion-sdk.ts
```

If the SDK is not at that path, find it in the engine source tree at `engine/extensions/sdk/ion-sdk.ts`.

## 4. Configure the engine to load your extension

Add your extension to a profile's `extensions` array in `~/.ion/settings.json`:

```json
{
  "engineProfiles": [
    {
      "id": "default",
      "name": "Default",
      "extensions": ["~/.ion/extensions/my-extension"]
    }
  ]
}
```

The engine expands `~` to your home directory automatically.

## 5. Verify it works

Start a new Ion session. You should see in `~/.ion/engine.log`:

```
[extension] loaded extension from /Users/you/.ion/extensions/my-extension (pid 12345)
[extension] registered 1 tools, 0 commands from init
```

Ask the LLM to use your tool:

```
Greet me by name
```

The LLM will invoke the `greet` tool and return the greeting.

## 6. Add a slash command

Extend your `index.ts` to register a command:

```typescript
ion.registerCommand('hello', {
  description: 'Say hello from the extension',
  execute: async (args, ctx) => {
    ctx.sendMessage(`Hello from my-extension! Args: ${args}`)
  }
})
```

Users can now type `/hello world` to trigger the command directly.

## What's next

- [Extension Anatomy](anatomy.md) -- understand the directory layout and lifecycle
- [Tools Registration](tools-registration.md) -- tool definition schema and invocation flow
- [Commands Registration](commands-registration.md) -- slash command patterns
- [TypeScript SDK Reference](sdk-typescript.md) -- full API documentation
