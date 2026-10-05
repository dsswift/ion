---
title: Deep Links (ion://)
description: Open a conversation, a setting, a file, or a terminal pane, or start a conversation, from a link on the desktop, a phone, or a browser.
sidebar_position: 7
---

# Deep Links (`ion://`)

Ion Desktop and Ion Remote on iOS register the `ion://` URL scheme. Anything that
can open a URI — a shell script, a Makefile, a build tool, an intranet page, a
chat message — can ask Ion to open a conversation, a settings page, or a file,
open a terminal pane, start a conversation, or run an extension's link route.

Opening an `ion://` link launches Ion if it is not already running, then performs
the request.

There are two kinds of link:

- **Navigation** (`conversation`, `settings`, `file`) only moves your view. It runs
  nothing, so it never asks first.
- **Action** (`terminal`, `prompt`, `ext`) runs something, so it passes the
  [trust](#trust) gate.

The Studio server parses and checks every link. A client never interprets one
itself: it hands the URL to its server and acts on what comes back.

### Scheme registration

Ion registers the scheme itself, at startup, for the signed-in user -- not from
an installer script. On Windows that means `HKCU\Software\Classes\ion`, written
on first launch and rewritten on every launch, so a per-machine deployment still
leaves each user's own registration to their first run of Ion. Uninstalling the
app does not remove the key; a stale key simply points at an executable that is
no longer there, and the next install overwrites it.

On macOS the equivalent registration is Launch Services, driven by the app
bundle rather than a registry key.

:::info Where links open
- **Desktop.** The OS hands the URL to Ion Desktop, which passes it to its local
  Studio server.
- **iPhone.** Ion Remote registers `ion` (beside its `ion-studio` pairing scheme)
  and sends the URL to the server it is paired with. A conversation, setting,
  or file opens on the phone; an action runs on the server host after you
  approve it on the phone.
- **Browser.** A Studio server answers `https://<server>/open/<route>?<query>`,
  the same link in `https` form, for places that strip custom schemes. It opens
  the browser build of Studio, which opens the link the same way.

The engine has no `ion://` handler.
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
| `key` | no | Launch key. A stable identity for this launch, unique within the conversation. See [Reusing a pane](#reusing-a-pane). |
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

#### Reusing a pane

Without `key`, every request adds a pane. A tool that launches the same services
on every run should send a `key` per service, so a rerun reuses the panes of the
last run instead of piling up new ones.

When the conversation already has a pane that was opened with the same `key`:

1. Every process running in that pane is stopped: the whole process tree under
   its shell, not only the shell. Processes get `SIGTERM` and five seconds to
   exit, then `SIGKILL`.
2. A fresh shell starts in the same pane, in `dir` (or the pane's previous
   directory when `dir` is absent). `title`, when given, renames the pane.
3. `cmd` runs in the new shell.

When no pane holds the key, a new pane opens and takes it. Closing the pane
releases the key. Keys are scoped to one conversation: the same key in two
conversations names two panes. Two requests for one key run one after the
other, so they never open two panes.

The key survives an app restart with the pane it names. `dev run` sends
`dev.yaml/<checkout>/<service>`, where `<checkout>` is the repository folder name
plus a short hash of its path. Any stable string up to 200 characters works.

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

### `ion://conversation`

Open a conversation. A conversation that is saved but not open is reopened in a
new tab.

| Parameter | Required | Description |
|---|---|---|
| `id` | yes | The conversation id. |

### `ion://settings`

Open a settings page or one of its sections.

| Parameter | Required | Description |
|---|---|---|
| `panel` | yes | A page id or a section id from the settings taxonomy, e.g. `git-access` or `defaults-thinking`. |

On a phone, a page whose settings the phone can show opens there; any other
page shows a note that it is only on the desktop.

### `ion://file`

Open a file in Ion's editor.

| Parameter | Required | Description |
|---|---|---|
| `dir` | yes | An absolute directory. |
| `path` | yes | The file, absolute or relative to `dir`. It must stay inside `dir` and must exist. |

### `ion://ext/<routeId>`

Run a link route an extension registered (see
[Studio SDK › Link routes](../extensions/studio-sdk.md)). The route names a
slash command; the link's `args` are appended to it.

| Parameter | Required | Description |
|---|---|---|
| `args` | no | Text appended to the route's command. |
| `conversation` | no | Run in this conversation. The route must be one that conversation can run. |
| `dir` | when no `conversation` | Open a new conversation here and run the command in it. |
| `token` | no | Capability token. See [Trust](#trust). |

The confirmation shows the route's name and the full command that would run.

### Copying a link

**Copy link** is on a conversation's row menu, a settings page's header, and a
file editor tab's menu, and on the phone's conversation row menu. The desktop
copies the `ion://` form; Studio in a browser copies the `https` form.

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
token** from `~/.ion/deeplink.token`, created on first run.

The file is written mode `600` on macOS and Linux. Windows has no POSIX mode,
so there the token's protection comes from the profile ACL that
`%USERPROFILE%\.ion` inherits -- the signed-in user, SYSTEM, and
administrators. The property the trust model needs is the same on both: a
process running as another non-administrator user cannot read it.

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

A link opened on a phone or in a browser is always treated as untrusted, token or
not: the token is a secret on the server host, and a link that reached another
device came from somewhere else. The confirmation goes back to that device alone,
and only that device can approve it. A [handoff file](#handoff-file) link only
works on the host that wrote the file.

## Logging

Every request is logged by the Studio server that resolved it, to
`<ION_DATA_DIR>/server.jsonl` (`~/.ion/server.jsonl` by default), with its action,
transport, trust tier, target, and outcome:

```bash
jq -c 'select(.tag=="deeplink")' ~/.ion/server.jsonl
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
