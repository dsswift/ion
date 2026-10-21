---
title: worktree.json Reference
description: The committed project manifest a worktree-provisioning client reads, and the one field the engine reads from it.
sidebar_position: 6
---

# worktree.json Reference

`.ion/worktree.json` is a **committed, project-level** file. A client that
provisions worktrees (the archived Ion Studio did, with seed directories, a
setup command, ephemeral defaults, and a bench verify command) owns most of the
manifest and documents its own fields. The engine reads exactly one field:
`worktree.sharedPaths`.

**The file is optional.** With no manifest, a worktree conversation is simply
refused every write into its base repository.

## Shape

```json
{
  "version": 1,
  "worktree": {
    "sharedPaths": ["docs/retros"]
  }
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `version` | number | Manifest version. Only `1` exists. |
| `worktree.sharedPaths` | string[] | Gitignored base-repo directories a worktree conversation may write into. See "Shared paths" below. |

Other keys are ignored by the engine.

## Shared paths

A conversation running in a worktree may not write into the base repository it
was cut from. That rule exists because such writes interleave several
conversations' work in one dirty checkout and review cannot attribute the hunks
afterwards. It is enforced by the engine, in `internal/workspaces`.

The rule has an exact boundary, and `sharedPaths` is where a project declares
it. A path git **ignores** cannot interleave reviewable work: no `git add -A`
will stage it, no diff will show it, no commit can carry it. The refusal
protects review, so where there is nothing to review it protects nothing.

The motivating case is a durable operator artifact that belongs beside the code
but must outlive the worktree that produced it — a retrospective, a generated
report, a local analysis run. Written inside the worktree it dies at Retire; the
base repo is the only location that survives.

```json
"worktree": {
  "sharedPaths": ["docs/retros"]
}
```

**Both conditions are required.** A declared path is writable only when the
engine also confirms `git check-ignore` reports it ignored:

- Declaration alone is not enough. A project could declare a tracked directory
  and reintroduce the interleaving the guard prevents, so the ignore check is
  the engine's own verification rather than a matter of trust.
- Being ignored alone is not enough. That would silently widen the gate to
  every ignored path in the repo — `node_modules`, build caches, `.env` — which
  no project asked for.

Declaration is the opt-in; the ignore check is the proof the opt-in is safe.

**The authority is the base repo's committed manifest, never the worktree's
copy.** The manifest is committed, so every worktree carries one — and reading
that copy would be a hole straight through the guard: a conversation could
declare the whole repo shared from inside its own sandbox. Widening the
allowance is therefore a reviewed commit on the source branch, not an
uncommitted edit in a working tree.

**Git stays refused inside a shared path.** A shared path is exempt from the
write refusal precisely because git cannot see it. A git invocation is the one
operation that would make it seen, so a `Bash` segment that runs git in a
shared base-repo directory is still refused. Writing, reading, and rendering
there are unaffected.

**Rejected declarations.** Each is logged at WARN in `~/.ion/engine.jsonl` with
the reason, because a declaration that silently does nothing is
indistinguishable from a broken guard:

| Declaration | Why it is rejected |
|---|---|
| An absolute path (`/etc`) | Declarations are repo-relative. |
| A `..` escape (`../outside`) | Would hand out write access outside the repository. |
| The repo root (`.`) | A blanket exemption is the opposite of a narrow allowance. |
| A path git does not ignore | Fails the ignore check above. |

**Unlike provisioning, this fails closed.** An unreadable or malformed manifest
yields no shared paths and the pre-existing refusal stands. Failing open would
let a corrupt file silently disable containment.

Sibling worktrees are never shared. A gitignored path inside another
conversation's checkout is that conversation's private build state, not a shared
artifact directory.
## Observability

Every shared-path decision lands in `~/.ion/engine.jsonl` under
`tag=workspaces`: the manifest that was loaded, and each declaration accepted
or rejected with its reason.

```bash
jq -c 'select(.tag=="workspaces")' ~/.ion/engine.jsonl
```
