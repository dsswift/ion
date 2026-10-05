---
title: Ion Studio SDK
description: Extend Ion Studio from an extension, without teaching the engine about user interfaces.
sidebar_position: 11
---

# Ion Studio SDK

The Ion Studio SDK lets an extension extend **Ion Studio**, the desktop client.
It offers two things: adding rows to the `+` menu in the composer
([Composer Actions](#composer-actions)), and naming deep-link routes that run a
command ([Link Routes](#link-routes)).

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
   so no client decides where an extension's actions apply. Link Routes stop
   at the server the same way.
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

## Link Routes

A **Link Route** gives one of your extension's slash commands a name that a
link can point at. A link of this form runs the route:

```text
ion://ext/<routeId>?args=<text>&conversation=<conversationId>&dir=<absolute dir>
```

| Part | Meaning |
|---|---|
| `<routeId>` | The route's `id`. |
| `args` | Optional. Text added after the route's command, the same as typing it after the command. |
| `conversation` | Optional. The conversation to run the command in. |
| `dir` | Optional. An absolute directory. With no `conversation`, the command runs in a new conversation in this directory. |

A route has these fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Unique within your extension. It is a path segment of the link, so it may use only letters, digits, `_` and `-`, up to 64 characters. |
| `label` | Yes | How Studio names the route to the operator. Up to 80 characters. |
| `command` | Yes | A slash command, such as `/briefing`. Up to 200 characters. Anything that is not a slash command is refused. |
| `conversationId` | No | Offer the route in one conversation only. Leave it out to offer it wherever a conversation's extension command registry owns `command`. |

Two rules keep a link from doing more than you meant:

- **The server checks ownership.** When the link names a conversation that is
  open, the Studio server runs a route only if that conversation's extension
  owns the route's command (or the route was registered for that
  conversation). A conversation that never loaded your extension cannot run
  your route. A link that names a saved but closed conversation, or opens a
  new one in `dir`, can only use a workspace-wide route; the command then goes
  through the conversation's normal slash-command resolution.
- **An untrusted link always asks first.** When a link comes from somewhere
  Studio does not trust, Studio shows the operator what it will run and waits
  for them to agree.

The API matches Composer Actions: `register` at start-up publishes nothing and
answers Studio's snapshot query; `addRoute` / `removeRoute` in a running
extension push the change at once.

```ts
studio(ion).links.register([
  { id: 'greet', label: 'Greet someone', command: '/greet' },
])
```

```go
links, err := studio.NewLinks(context.Background(), studio.FromSDK(sdk))
if err != nil {
    return err
}
return links.Register(studio.LinkRoute{ID: "greet", Label: "Greet someone", Command: "/greet"})
```

A complete example is in `packages/studio-sdk/ts/examples/link-route/`.

## Who installs it

The **desktop** installs both flavors at start-up, and rewrites a file only when
its content changed. The engine's installer does not ship them, because they are
Studio's, not the engine's. A machine that runs the engine without the desktop
does not have this SDK, and has no Studio for it to talk to.
