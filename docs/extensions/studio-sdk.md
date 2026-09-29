---
title: Ion Studio SDK
description: Extend Ion Studio from an extension, without teaching the engine about user interfaces.
sidebar_position: 11
---

# Ion Studio SDK

The Ion Studio SDK lets an extension extend **Ion Studio**, the desktop client.
Today it offers one thing: adding rows to the `+` menu in the composer.

It is a **separate SDK from the engine SDK**, on purpose.

## Why it is separate

The Ion Engine is headless. It has no concept of a window, a menu, or a button,
and it is built on the assumption that there may be no user interface at all.
That has to stay true of the engine SDK too. If the engine SDK grew a
`registerMenuItem` call, the engine would be carrying one client's opinions, and
every other client (a CLI, a web app, an automation pipeline) would inherit
vocabulary that means nothing to it.

So Studio vocabulary lives here instead:

- An extension that wants to extend Studio imports this SDK **alongside** the
  engine SDK.
- An extension that never runs under Studio never needs it.
- Nothing under `engine/` knows this SDK exists.

**The rule:** anything that names a Studio surface (a menu, a panel, a button)
belongs in the Studio SDK, never in the engine SDK.

## How a request reaches Studio

The SDK uses one generic engine mechanism, the
[resource subsystem](../architecture/resource-subsystem.md). A request to Studio is a
resource whose kind starts with `ion-studio.`:

1. The extension publishes the resource. The engine treats its content as an
   opaque blob and forwards it to subscribers, exactly as it does for any other
   resource kind.
2. The Studio server recognises the `ion-studio.` prefix and acts on it. For a
   Composer Action it decides which conversations offer the row and sends each
   client that answer (`studio:composer-actions`, read through
   `studio.composerActions`). The raw resource is never forwarded to a client,
   so no client decides where an extension's actions apply.
3. Any other client ignores a kind it does not know. Ion's own mobile client is
   never sent these resources, so they do not show up as notifications.

The shapes are fixed by one file, `packages/studio-sdk/contract.json`. The
TypeScript flavor, the Go flavor, and Studio's own parser are each pinned to it
by a test.

## Composer Actions

A **Composer Action** is a row in the composer's `+` menu. Choosing it sends a
slash command, the same way typing the command would. The command must be one
your extension registered with the engine SDK.

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Unique within your extension. |
| `label` | Yes | The row's text. Up to 80 characters. |
| `command` | Yes | A slash command, such as `/briefing` or `/briefing weekly`. Up to 200 characters. Anything that is not a slash command is refused. |
| `icon` | No | A [Phosphor](https://phosphoricons.com) icon name. Studio uses a default for a name it does not have. |
| `conversationId` | No | Offer the action in one conversation only. Leave it out to offer it in every conversation that runs your extension. The Studio server offers the row only where the conversation's extension command registry owns `command`, so a conversation that never loaded the extension does not see it. |

Studio shows the name of the extension that contributed each row. The engine
assigns that name, so an extension cannot claim to be another one.

There are two ways to publish:

- **`register`** is for start-up. It records the actions and answers Studio's
  snapshot query with them. It publishes nothing, so it is safe before the
  engine handshake finishes.
- **`addAction` / `removeAction`** are for a running extension. They also push
  the change to every open Studio immediately.

### TypeScript

The desktop installs the SDK to `~/.ion/extensions/studio-sdk/`, beside the
engine SDK.

```ts
import { createIon } from '../sdk/ion-sdk'
import { studio } from '../studio-sdk'

const ion = createIon()

ion.registerCommand('briefing', {
  description: 'Produce the current briefing',
  execute: async (_args, ctx) => { ctx.sendMessage('...') },
})

studio(ion).composer.register([
  { id: 'briefing', label: 'Briefing', icon: 'Newspaper', command: '/briefing' },
])
```

A complete example is in `packages/studio-sdk/ts/examples/composer-action/`.

### Go

The Go flavor is its own module,
`github.com/dsswift/ion/packages/studio-sdk/go`. The desktop installs it to
`~/.ion/extensions/studio-sdk-go/`. Point at it with a relative `replace`, the
same way you point at the engine's Go SDK:

```go
// go.mod
replace github.com/dsswift/ion/sdk/go => ../../sdk-go
replace github.com/dsswift/ion/packages/studio-sdk/go => ../../studio-sdk-go
```

```go
import (
    studio "github.com/dsswift/ion/packages/studio-sdk/go"
    ion "github.com/dsswift/ion/sdk/go"
)

func registerStudioActions(sdk *ion.SDK) error {
    composer, err := studio.NewComposer(context.Background(), studio.FromSDK(sdk))
    if err != nil {
        return err
    }
    return composer.Register(
        studio.ComposerAction{ID: "briefing", Label: "Briefing", Icon: "Newspaper", Command: "/briefing"},
    )
}
```

Call it before `sdk.Run()`. Use `composer.AddAction` and `composer.RemoveAction`
once the extension is running.

## Who installs it

The **desktop** installs both flavors at start-up, and rewrites a file only when
its content changed. The engine's installer does not ship them, because they are
Studio's, not the engine's. A machine that runs the engine without the desktop
does not have this SDK, and has no Studio for it to talk to.
