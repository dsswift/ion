---
title: Conversation Branching
description: Tree model, forking, navigation, and branch points.
sidebar_position: 4
---

# Conversation Branching

Conversations are stored as a tree, not a flat list. Every message is a node with a parent pointer. The current position in the tree is tracked by a leaf pointer (`leafId`). Branching lets you explore alternative conversation paths without losing history.

## Tree structure

```
root (user: "explain auth")
  |
  +-- entry-1 (assistant: "auth uses JWT...")
        |
        +-- entry-2 (user: "show me the code")
        |     |
        |     +-- entry-3 (assistant: "here's the handler...")  <-- leaf
        |
        +-- entry-4 (user: "what about OAuth?")    <-- branch
              |
              +-- entry-5 (assistant: "OAuth flow is...")
```

In this tree, entries 2 and 4 share the same parent (entry-1). Entry 4 is a branch point. The current conversation path is determined by walking from the leaf back to the root.

## Context path

`BuildContextPath` walks from the current leaf to the root, reverses the path, and extracts messages. This path becomes the LLM's conversation history for the next turn.

Only entries on the active path contribute to the context. Entries on other branches are preserved in the tree but excluded from the message list.

Compaction entries on the path are converted to synthetic user messages prefixed with `[Previous conversation summary]:`.

## Operations

### Fork

`ForkSession(key, messageIndex)` creates a branch point at a specific message index in the current path.

For v2 conversations (tree-based), this moves the leaf pointer to the entry at the given index. The next message appended will create a new branch from that point.

For v1 conversations (legacy flat list), this creates a new conversation with messages copied up to the fork point.

The `session_before_fork` hook can cancel the fork. The `session_fork` hook fires after a successful fork.

### Branch

`BranchSession(key, entryID)` moves the leaf pointer to the specified entry and rebuilds the message list. Use this to switch between existing branches.

### Navigate

`NavigateSession(key, targetID)` is functionally identical to `Branch`. It moves the leaf pointer and rebuilds messages.

### Get tree

`GetSessionTree(key)` returns the full conversation tree as nested `TreeNode` structures:

```go
type TreeNode struct {
    Entry    SessionEntry
    Children []TreeNode
}
```

This is used by clients to render a visual tree of the conversation with all branches.

## Branch points and leaves

Two helper functions provide structural information:

**GetBranchPoints** returns entries that have more than one child. These are the points where the conversation diverged.

**GetLeaves** returns entries with no children. These are the tips of all branches, each representing a potential continuation point.

## Appending entries

`AppendEntry` adds a new entry chained from the current leaf:

1. Generate a new 8-character hex ID.
2. Set `ParentID` to the current `LeafID`.
3. Append the entry to the entries list.
4. Update `LeafID` to point to the new entry.

This means sequential messages form a chain. Branching happens when you move the leaf pointer backward and then append, creating a new child of an existing entry.
