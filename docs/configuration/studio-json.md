---
title: studio.json Reference
description: Ship Ion Studio behavior, such as Project Quick Tools, with your repository.
sidebar_position: 8
---

# studio.json Reference

`.ion/studio.json` is a **committed, project-level** file. It lets a project ship
Ion Studio behavior with its repository, so everyone who opens a conversation in
that project gets it without setting anything up.

**The file is optional.** With no file, Studio behaves as it always has.

The Ion Studio Server reads this file. The Ion Engine never does: the engine has
no concept of a user interface, and this file only describes one.

## Project Quick Tools

A Quick Tool is a shell command you run from the lightning button in the
composer. It opens in a terminal pane of the active conversation.

You can define Quick Tools for yourself in **Settings > Quick Tools**. A
**Project Quick Tool** is one the project defines instead, in `quickTools`:

```json
{
  "quickTools": [
    {
      "id": "build-desktop",
      "name": "Build desktop",
      "icon": "Hammer",
      "command": "make desktop"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Unique within the file. Letters, digits, dot, dash, and underscore. |
| `name` | Yes | The label in the tray. Up to 80 characters. |
| `command` | Yes | The shell command. Up to 2000 characters. `{cwd}` becomes the conversation's working directory and `{branch}` becomes its current branch. |
| `icon` | No | A [Phosphor](https://phosphoricons.com) icon name from the set the Quick Tools settings page offers. Defaults to `Lightning`. |

A Project Quick Tool has no directory scope. The project is the scope: the tool
is offered in every conversation whose directory is inside that repository.

The lightning button appears only when at least one Quick Tool applies to the
active conversation, whether it is yours or the project's. In the tray, the
project's tools are listed under **Project** and yours under **Yours**.

## Trust

A Project Quick Tool is a shell command that arrived with a repository, so Ion
does not run one until you have approved it.

- The first time you choose a Project Quick Tool in a project, Studio shows
  every command the project ships, in full, and asks whether you trust them.
- Your approval is tied to that exact list. If any tool's `id`, `name`, `icon`,
  or `command` changes, or a tool is added or removed, Studio asks again.
- Declining runs nothing. So does closing the dialog.
- The server enforces this, not only the dialog. It reads the command from the
  file at the moment of the run and refuses unless the list on disk is the list
  you approved. A client can never supply the command itself.

Approvals are stored per project root in the server's `settings.json` under
`trustedProjectQuickTools`.

## Which copy of the file counts

| Conversation | File that is read |
|---|---|
| In a repository | `.ion/studio.json` at the repository root, even when the conversation's directory is a subfolder. |
| In an Ion worktree | The **base repository's** copy, not the worktree's. |
| Outside any repository | `.ion/studio.json` in the conversation's own directory. |

Ion never looks above the repository root. Your home folder has an `.ion`
directory of its own, and it must not answer for every project beneath it.

The base repository is the authority for a worktree for the same reason it is
for [`.ion/worktree.json`](worktree-json.md): a change to what a project may run
should be a reviewed commit, not an uncommitted edit inside one worktree. One
consequence is that a Project Quick Tool you add on a worktree branch does not
appear in that worktree until the branch lands in the base repository.

## When the file is wrong

The parser fails closed. If the file is not valid JSON, or any one tool entry is
invalid, the file grants **no tools at all** and the server logs the reason.
**Settings > Quick Tools** shows that reason next to the project's tools.

Studio watches the file. Edits show up in open conversations without a restart.
