---
title: Deep Links (ion://)
description: Open a terminal pane or start a conversation in Ion Desktop from a link, a script, or another application.
sidebar_position: 7
---

# Deep Links (`ion://`)

Ion Desktop registers the `ion://` URL scheme. Anything that can open a URI — a
shell script, a Makefile, a build tool, an intranet page — can ask Ion to open a
terminal pane or start a conversation.

Opening an `ion://` link launches Ion if it is not already running, then performs
the request.

:::info Desktop only
This is a desktop surface. The engine has no PTYs and no conversation panes, so
there is no `ion://` handler on iOS or in the engine daemon.
:::

## Actions

### `ion://terminal`

Open a terminal pane inside a conversation. In the Desktop client this targets the shared **Conversation Terminal Panel**: Overlay and Studio show the same terminal tabs and attach to the same main-owned PTYs. Studio Surface terminals use separate conversation-scoped Surface keys and are never created by `ion://terminal`.

| Parameter | Required | Description |
|---|---|---|
| `tabId` | yes (see below) | The conversation to open the pane in. |
| `title` | no | Pane label. Falls back to Ion's `Shell N` numbering. |
| `cmd` | no | A single-line command to run in the new pane. |
| `dir` | no | Working directory for the new process. Defaults to the conversation's directory. **Pass the service/project directory when the command resolves files relative to itself** (`func start`, `dotnet watch --project file.csproj`, `npm run dev`). |
| `token` | no | Capability token. See [Trust](#trust). |

```bash
open 'ion://terminal?tabId=<id>&title=api&dir=/Users/me/src/app/services/api&cmd=npm%20run%20dev'
```

**`tabId` is resolved strictly.** There are exactly three outcomes:

- It names a live conversation → the pane opens there.
- It names a conversation that has since been closed → the request is **refused**.
- It is absent → a trusted request is **refused**; an untrusted request asks you to choose a live conversation before it can proceed.

Ion never falls back to "whichever conversation is in front". A pane opening in a
background conversation does not pull you out of the one you are reading.

#### Getting a `tabId`

Every terminal Ion opens carries its own identity in the environment:

| Variable | Meaning |
|---|---|
| `ION_DESKTOP_TAB_ID` | The conversation this terminal belongs to. |
| `ION_DESKTOP_TERMINAL_INSTANCE_ID` | This specific pane. |
| `ION_DESKTOP_DEEPLINK_TOKEN` | The capability token. |

Child processes inherit them, so a tool running in an Ion pane can target its own
conversation with no configuration:

```bash
open "ion://terminal?tabId=$ION_DESKTOP_TAB_ID&token=$ION_DESKTOP_DEEPLINK_TOKEN&title=api&cmd=npm%20run%20dev"
```

Because each new pane gets its own ids, this works at any depth — a tool launched
by a tool still lands in the right conversation.

### `ion://prompt`

Open a conversation in a directory and put a prompt in it.

| Parameter | Required | Description |
|---|---|---|
| `dir` | yes | Directory the conversation opens in. |
| `text` | yes | The prompt body. |
| `submit` | no | `false` leaves the prompt in the composer instead of sending it. Defaults to sending. |
| `token` | no | Capability token. See [Trust](#trust). |

```bash
open 'ion://prompt?dir=/Users/me/src/app&text=Summarise%20the%20test%20failures'
```

This is the shareable-prompt path: an internal wiki or chat message can publish a
link that opens the right repository and asks the right question. Links from those
places carry no token, so the recipient sees the prompt and approves it before
anything runs.

## Transports

The parameters can travel two ways. Both produce the same request.

### Inline

Parameters in the query string, as shown above. Use this for anything short.

### Handoff file

For a payload too large for a URL (a multi-paragraph prompt), or one you would
rather keep out of the operating system's opened-URL logging, write the request to
a file and pass only its id.

1. Generate a UUID.
2. Write `~/.ion/deeplink-requests/<uuid>.json` with mode `600`.
3. Open `ion://<action>?req=<uuid>`.

```bash
id=$(uuidgen | tr 'A-Z' 'a-z')
umask 077
cat > "$HOME/.ion/deeplink-requests/$id.json" <<JSON
{
  "action": "prompt",
  "dir": "/Users/me/src/app",
  "text": "First paragraph.\n\nSecond paragraph.",
  "submit": false,
  "token": "$ION_DESKTOP_DEEPLINK_TOKEN"
}
JSON
open "ion://prompt?req=$id"
```

The file's keys are the action's parameters, plus an optional `token`. Ion creates
the directory at startup with mode `700`.

Rules the file must satisfy:

| Rule | Reason |
|---|---|
| Read exactly once, then deleted | A request is an instruction, not a document. It cannot be replayed by a second click. |
| Written within the last 60 seconds | An old file is not a request anyone is waiting on. |
| Mode `600` | A group- or world-writable file could have been altered after you wrote it. |
| Under 1 MB | Bounds what a single request can occupy. |
| Multi-line `text` allowed; `cmd` must stay single-line | Prose is the point; a multi-line shell command is not, on either transport. |

A file that breaks any of these is refused and deleted.

## Trust

Ion decides how to handle a request by whether it carries a valid **capability
token** from `~/.ion/deeplink.token` (mode `600`, created on first run).

| | Behaviour |
|---|---|
| **Valid token** | Runs immediately. |
| **No or wrong token** | Ion describes the request and waits for your explicit approval. |

The distinction is what the caller could read. A process on your machine can read
a `600` file in your home directory — and could already run any command as you, so
the token grants it nothing it did not have. A web page cannot read a local file
at all, so a link published anywhere carries no token and always asks first.

The confirmation dialog shows the real command or the real prompt text, the
directory, and whether the prompt would send immediately. Approve only links whose
origin you recognise. Escape or clicking outside declines.

## Logging

Every request is logged to `~/.ion/desktop.jsonl` with its action, transport, trust
tier, target conversation, and outcome:

```bash
jq -c 'select(.tag=="deeplink")' ~/.ion/desktop.jsonl
```

A refused request logs the reason, so a link that appears to do nothing can be
diagnosed from the log alone.

## Using this from `dev`

The [`dev`](https://github.com/dsswift/dev.yaml) orchestrator has an `ion` terminal
mode that uses this surface. Set it once:

```yaml
# ~/.config/devtools/settings.yaml
terminal: ion
```

`dev run` then launches each host-tier service into its own Ion pane, named after
the service, in the conversation you ran `dev` from. Run it from a terminal
outside Ion and there is no conversation to target, so Ion asks.
