# Developer surfaces

Ion Studio shows source-control features beside every conversation: a changes
list, a commit graph, branch and status indicators, and worktree controls; and
it lets an administrator profile the server process. An organization can
switch each one off.

Switching a surface off removes the capability, not only the button. The
server refuses the actions behind it, stops sending its data, and every client
drops the controls that would reach it.

## The five surfaces

| Surface            | What it covers                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceControl`    | The changes list, diffs, blame, and every write to a repository: stage, commit, push, pull, fetch, branch changes, stash, reset, rebase, conflict resolution. |
| `commitGraph`      | The commit graph and commit details.                                                                                                                          |
| `repositoryStatus` | Read-only indicators: branch names and status badges.                                                                                                         |
| `worktrees`        | Worktrees and integration benches: create, convert, sync, land, retire, the overlap window, and the worktree grouping in the Inbox.                           |
| `profiling`        | A CPU profile or heap snapshot of the server process (`profile.capture`, `admin` scope), written under the data directory's `profiles/` folder.             |

Each surface is `"enabled"` or `"disabled"`. A surface that is not listed is
enabled, so a config with no `developerSurfaces` block changes nothing.

## Two places to set it

### On a server: what that server offers

Set this in the server's enterprise config. It applies to everyone who
connects to that server, from any device.

```json
{
  "customFields": {
    "ion-server": {
      "developerSurfaces": {
        "sourceControl": "disabled",
        "commitGraph": "disabled",
        "repositoryStatus": "enabled",
        "worktrees": "disabled"
      }
    }
  }
}
```

The server tells each client which surfaces it offers. A client then shows no
control for a surface the server does not offer, for conversations on that
server. Conversations on any other server are not affected.

This is the setting to use for a fleet. One switch on the server covers every
desktop, phone, and browser that connects to it, including a device paired
later. Nothing has to be deployed to the devices.

A server for staff who do not work with Git turns every surface off. A server
for engineers leaves them on. A person connected to both sees Git controls on
the engineering conversations only.

### On a managed desktop: what that desktop shows

Set this in the desktop's own enterprise config, under `ion-desktop`. It
applies to that desktop, for conversations on every server it connects to.

```json
{
  "customFields": {
    "ion-desktop": {
      "developerSurfaces": {
        "worktrees": "disabled"
      }
    }
  }
}
```

This is device policy. It is read only from the config installed on that
machine. A server's `ion-desktop` block never changes a visiting desktop.

When both are set, a surface is available only where both leave it on.

## What a disabled surface does

- **Actions are refused.** The server answers a refused action with
  `surface_disabled`. This covers the desktop, the iOS app, the browser
  client, keyboard shortcuts, and any other client of the server.
- **Data is withheld.** Repository events, worktree state, and bench state
  for a disabled surface are not sent.
- **Controls are absent.** Panels, tabs, menu items, shortcuts, and badges for
  a disabled surface are not shown. A panel saved in a layout is not restored.
- **New conversations open in the directory itself** when `worktrees` is off,
  even where the default is to create a worktree.
- **A transfer that would arrive in a worktree is refused** by a server with
  `worktrees` off.

A read that feeds several surfaces stays available while any of them is on.
With `sourceControl` and `commitGraph` off and `repositoryStatus` on, the
branch and status indicators still update.

This setting controls Ion Studio's own surfaces. It does not stop an agent
from running `git` in a shell. Use permission rules and the sandbox for that:
see [Sealed config](sealed-config.md).

## Related settings

`customFields["ion-desktop"].hiddenSettingsGroups` hides settings pages on a
managed desktop, including the Git workflow page. It is separate from
developer surfaces and can be combined with them.

## Checking what is applied

`studio_welcome` and `studio_environment_policy` carry the applied state as
`developerSurfaces`, with a `policyHash` that changes when the policy does.
The `policy.getDeveloperSurfaces` action returns the same two fields on
request. See [Studio wire](../protocol/studio-wire.md#developer-surfaces).
