---
title: Wiki-Link Maintenance
description: How the engine keeps wiki-style links resolving when documents are renamed, and how it reports links that resolve to nothing.
---

# Wiki-Link Maintenance

A wiki link is `[[target]]` or `[[target|alias]]` inside a document. It names another file. When that file is renamed, the link still holds the old name and resolves to nothing. No error is raised.

The engine prevents that in a watched workspace. It detects the rename, rewrites every link the rename broke, and reports what it rewrote. A separate read-only scan reports links that are already broken.

Everything here is configured by the [`wikiLinks`](../configuration/engine-json.md#wikilinks) block in `engine.json`.

## Where it applies

Maintenance runs inside a session's **workspace watcher**: the recursive filesystem watcher rooted at the session's working directory. Every session gets one while `wikiLinks.enabled` is true, whether or not it loads an extension. Sessions that share a working directory share one watcher, so a rename is handled once however many sessions watch it.

On macOS the watcher is one FSEvents stream per root, and on Windows one handle on the root, whatever the tree's size. On Linux it holds one inotify watch per directory; the workspace ignore patterns keep it out of dependency and build output, and [`workspace.maxWatchedDirs`](../configuration/engine-json.md#workspace) caps it. With `wikiLinks.enabled` set to `false`, a session with no extension loaded runs no watcher at all.

Every operation is confined to that working directory. A file is read or rewritten only when all of these hold:

- It is a regular file under the working directory. Symbolic links are never followed and never rewritten.
- The workspace ignore patterns do not exclude it. See [`workspaceWatchIgnore`](../configuration/engine-json.md#workspacewatchignore).
- Its extension is in `wikiLinks.extensions` (default `.md`). These files are the **documents**.

## Rename detection

Detection is driven by what changed on disk, never by which tool made the change. A rename from a file explorer, a shell `mv`, a `git mv`, or an editor all look the same to the engine.

The watcher remembers the identity of every document: the file itself, its size, and its modification time. A rename keeps all three. When a document disappears from one path and the same file appears at another within a short window, the engine reports one rename carrying both paths.

All three parts must match. The file alone is not enough, because a filesystem can give a deleted file's slot to the next file created.

What this means in practice:

| Change | Reported as a rename |
|--------|----------------------|
| A document is moved or renamed in place | Yes |
| A directory holding documents is moved | Yes, one rename per document |
| A document is deleted and a different one created | No |
| An editor saves by writing a temporary file over the original | No |
| A file is copied and the original deleted | No. The copy is a new file |
| A version-control checkout replaces a file with a renamed copy | No. The checkout writes new files |

A rename the engine did not observe is not repaired later. Use the [link integrity scan](#link-integrity-scan) to find the links it broke.

The existing `workspace_file_changed` hook is unchanged. A rename still produces a `delete` for the old path and a `create` for the new one. The rename is reported in addition, through the [`workspace_file_renamed`](../hooks/reference.md#file-changes) hook.

## How a link resolves

A link target is the text before any `#section` or `|alias`. The engine resolves it in this order and stops at the first match:

1. A target starting with `/` is a path from the workspace root.
2. A path relative to the directory of the file holding the link.
3. A path relative to the workspace root.
4. A bare name with no `/`, matched against file names without regard to case. It resolves only when exactly one file carries the name.

A path may leave off a document extension: `[[notes/plan]]` matches `notes/plan.md`. A target may name any file, so `[[diagram.png]]` resolves to an image.

Links inside a fenced code block or an inline code span are ignored. So is a regex character class such as `[[:space:]]`, which has the shape of a link and never names a file. A link with no target, such as `[[#section]]`, points into its own document and is ignored.

## Link propagation

After a rename, the engine waits a moment for related renames to arrive, then handles them as one batch in a single pass over the workspace. A directory move is one pass.

The rule for the pass: **every link keeps naming the file it named before the renames.** The engine works out what each link resolved to before, and rewrites the link only when it no longer resolves to that same file. That covers two cases:

- Links to a renamed document, from anywhere in the workspace.
- Links inside a moved document whose relative targets no longer reach what they reached.

A rewrite changes only the target. The alias, the `#section`, and the surrounding whitespace are kept as written. The link also keeps its style:

| Before | After renaming `guide/setup.md` to `ref/install.md` |
|--------|------------------------------------------------------|
| `[[setup]]` | `[[install]]` |
| `[[setup\|Start here]]` | `[[install\|Start here]]` |
| `[[setup.md]]` | `[[install.md]]` |
| `[[guide/setup]]` | `[[ref/install]]` |
| `[[/guide/setup]]` | `[[/ref/install]]` |
| `[[./setup]]` (from `guide/`) | `[[../ref/install]]` |

When the preferred style would be ambiguous, for example a bare name that two files now share, the engine writes a path from the workspace root instead.

A link is left alone when:

- It named nothing before the renames. It was already broken.
- It was an ambiguous bare name before the renames.
- It still resolves to the right file. Moving a document without renaming it leaves `[[name]]` links untouched.

Each file is replaced atomically and keeps its permissions. A file that something else writes during the pass is read again, so newer content is never overwritten with a stale rewrite.

### The propagation report

Each pass produces one report: the renames it handled, every file it changed, and every link in that file with its text before and after. A file that could not be written is listed under `failed`. The report is emitted once per pass, even when no link needed rewriting.

It reaches consumers two ways, with the same payload:

- The [`engine_wiki_links_propagated`](../protocol/server-events.md#engine_wiki_links_propagated) event, on the stream of every session watching the workspace.
- The [`wiki_links_propagated`](../hooks/reference.md#file-changes) hook, for extensions.

## Link integrity scan

The scan reads every document in a session's working directory and reports each link that names no single file:

- `missing`: nothing in the workspace matches the target.
- `ambiguous`: a bare name that more than one file carries. The candidates are listed.

It writes nothing and can run at any time. It runs only when asked:

- The [`scan_wiki_links`](../protocol/client-commands.md#scan_wiki_links) command, for a client.
- `ctx.scanWikiLinks()` in the [TypeScript SDK](../extensions/sdk-typescript.md) and `Context.ScanWikiLinks` in the [Go SDK](../extensions/sdk-go.md), for an extension.

## Cost

| Setting | What the engine does |
|---------|----------------------|
| `enabled: false` | Nothing. No file identity is recorded, no rename is detected, no file is read. The scan is refused before the workspace is read. |
| Enabled, no rename happening | Records the identity of each document from the directory walk the watcher already performs. It reads no file content. |
| A rename happens | One pass over the workspace. Each document is read once; one without the text `[[` is not parsed. |
| The scan is requested | One pass over the workspace, only for that request. |

Turning the subsystem off does not touch existing links. Turning it back on does not repair renames that happened while it was off.
