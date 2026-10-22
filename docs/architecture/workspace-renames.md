---
title: Workspace Renames
description: How the workspace watcher turns a removal and a creation of the same file into one rename event.
---

# Workspace Renames

The workspace watcher reports a rename as a delete of the old path followed by a create of the new one. That pair does not say the two belong together. The engine correlates them from what changed on disk and reports one rename carrying both paths, through the [`workspace_file_renamed`](../hooks/reference.md#file-changes) hook. What a harness does with a rename is its own policy.

Rename tracking is configured by `trackRenames` and `renameExtensions` in the [`workspace`](../configuration/engine-json.md#workspace) block of `engine.json`.

## Where it applies

Rename tracking runs inside a session's **workspace watcher**: the recursive filesystem watcher rooted at the session's working directory. A session runs one while it has an extension loaded. Sessions that share a working directory share one watcher, so a rename is detected once however many sessions watch it, and each of them is told.

On macOS the watcher is one FSEvents stream per root, and on Windows one handle on the root, whatever the tree's size. On Linux it holds one inotify watch per directory. The watcher's startup walk, which attaches directories on Linux and seeds rename tracking everywhere, runs in the background: the session is usable before it finishes. The workspace ignore patterns keep the walk out of dependency and build output, and [`workspace.maxWatchedDirs`](../configuration/engine-json.md#workspace) bounds it on every platform.

A file is tracked only when all of these hold:

- It is a regular file under the working directory.
- The workspace ignore patterns do not exclude it. See [`workspaceWatchIgnore`](../configuration/engine-json.md#workspacewatchignore).
- Its extension is in `workspace.renameExtensions` (default `.md`).

## Detection

Detection is driven by what changed on disk, never by which tool made the change. A rename from a file explorer, a shell `mv`, a `git mv`, or an editor all look the same to the engine.

The watcher remembers the identity of every tracked file: the file itself, its size, and its modification time. A rename keeps all three. When a file disappears from one path and the same file appears at another within a short window, the engine reports one rename carrying both paths.

All three parts must match. The file alone is not enough, because a filesystem can give a deleted file's slot to the next file created.

| Change | Reported as a rename |
|--------|----------------------|
| A file is moved or renamed in place | Yes |
| A directory holding tracked files is moved | Yes, one rename per file |
| A file is deleted and a different one created | No |
| An editor saves by writing a temporary file over the original | No |
| A file is copied and the original deleted | No. The copy is a new file |
| A version-control checkout replaces a file with a renamed copy | No. The checkout writes new files |

A rename the engine did not observe is never reported later.

The existing `workspace_file_changed` hook is unchanged. A rename still produces a `delete` for the old path and a `create` for the new one. The rename is reported in addition.

## Cost

| Setting | What the engine does |
|---------|----------------------|
| `trackRenames: false` | Nothing. No file identity is recorded and no rename is detected. |
| Enabled | Records the identity of each tracked file from the directory walk the watcher already performs. It reads no file content. |
