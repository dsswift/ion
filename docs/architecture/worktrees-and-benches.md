---
title: Worktrees and Benches
description: Which writes worktrees and integration benches refuse, and how land, transfer, and provisioning behave.
sidebar_position: 8
---

# Worktrees and Benches

Two directory kinds under `~/.ion/` refuse a class of writes based on what the
directory *is*. Worktree containment is enforced for the agent by the engine
(`engine/internal/workspaces/containment.go`). Bench write and history refusal is
enforced for the agent by the server's tool-gate policy
(`server/src/engine/tool-gate-responder.ts`) and for the operator by the server's
git API. Both fail open when
their backing record is unreadable, because a false refusal where the operator is
working is worse than a briefly missing guard.

**An integration bench refuses history writes.** A directory under
`~/.ion/integration/` is a rebuildable bench: its branch is recreated from the
feature branch plus each member's pinned commit on every rebuild. A commit made
there is destroyed by the next rebuild, and a push would publish a synthetic
merge of other people's in-flight work. So `commit`, `push`, `pull`, `merge`,
`rebase`, `cherry-pick`, `revert`, `reset`, `stash`, `tag`, and branch mutation
are refused by the server (`server/src/integration/bench-guard.ts`), which
owns the bench end to end — the engine deliberately carries no bench-specific
rules. Reading, building, testing, and staging are unaffected. A fix diagnosed in
the bench belongs in the member worktree that owns the file: commit it there,
then update that member in the bench.

**A bench refuses edits, and names where they belong.** The history rule above
covers `commit`/`push`; a bench also refuses `Write` and `Edit`, because an edit
made there is destroyed by the next rebuild. `Bash` stays open — building and
testing are what a bench is for, as do staging and discarding. The refusal names
the member worktree that owns the file, resolved by diffing each member's pinned
commit against the bench base rather than asking who last touched it: when
several members change one file, all of them are listed with their changed line
ranges so the agent can pick by the region it is editing. The git panel matches:
in a bench it hides Changes and Graph and titles the section
`Integration (Bench)`.

**A worktree refuses writes outside itself.** A conversation whose cwd is a
registered worktree (`~/.ion/worktree-registry.json`) may not write into the base
repo it was cut from, nor into a sibling worktree of the same repo. This one *is*
engine-owned, in `engine/internal/workspaces/containment.go`, because it derives
from one JSON record plus git state and must hold regardless of which extensions
are loaded. It is **not** a cwd jail: `/tmp`, `~/.ion`, and unrelated repos all
stay writable, and a conversation that is not in a worktree is unaffected. The
rule exists because cross-worktree writes interleave several conversations in one
dirty checkout, and review cannot attribute the hunks afterwards. A `Bash` call
is judged by its command text, not only its cwd: every literal `cd` / `pushd` /
`git -C` / `--work-tree` destination in the chain is checked
(`engine/internal/workspaces/bash.go`), because a command that `cd`s into the
base repo and commits there is the exact way two commits once landed on the
wrong branch. A dynamic destination (`cd "$VAR"`, `cd $(...)`) cannot be
resolved, so it passes and is logged at WARN rather than guessed at — a refusal
requires a literal path, which is what makes a false refusal in your own
worktree impossible.

**A project may share specific gitignored paths with its worktrees.** The
refusal above protects review, so it stops exactly where review does: a path git
ignores cannot interleave reviewable work, because nothing can stage it. A
project declares such paths in the committed `.ion/worktree.json` under
`worktree.sharedPaths`, and the engine allows a write only when the path is
**both** declared **and** confirmed ignored by `git check-ignore`
(`engine/internal/workspaces/shared_paths.go`). This is what lets a durable
artifact that must outlive its worktree — a retrospective, a generated report —
live beside the code instead of dying at Retire. The authority is the base repo's
committed manifest, never the worktree's own copy, so widening the allowance is a
reviewed commit rather than an uncommitted edit inside a sandbox. Git stays
refused inside a shared path: the exemption exists because git cannot see the
path, and a git invocation is what would make it seen. Unlike the rest of the
package, this fails closed — a malformed manifest grants nothing. Reference:
[`docs/configuration/worktree-json.md`](../configuration/worktree-json.md)
§ "Shared paths".

Closing a conversation never removes an ordinary worktree. Removal is the
explicit Retire verb, which appraises what would be lost, refuses when the answer
is work, and relocates any conversation still living there so it is not left
pointed at a deleted directory.

**An ephemeral worktree closes with its conversation.** A worktree cut for a
conversation can be marked ephemeral when it is created (`ephemeralWorktree` on
`tabs.create` and `createConversationTab`, the fourth argument of
`setupWorktree`). The registry ties it to that conversation
(`server/src/worktree/registry-ephemeral.ts`). When the conversation closes, by
settling, deleting, or closing outright, the server runs Retire's own steps on it
(`server/src/store/slices/ephemeral-worktree-close.ts`): the pre-flight over the
worktree and every bench its removal would prune, then Retire's removal (the
landed cleanup for a landed worktree, otherwise Retire's discard), then Retire's
relocation of anything left in those directories. The discard appraises inside
the repository's mutation slot and, unless the project allows discarding,
refuses on any uncommitted file or unlanded commit instead of preserving and
removing. Anything that keeps the worktree (unlanded work, another conversation
still open there, active work in a bench it would prune, a failed removal) turns
it into an ordinary worktree for good and records why. The worktree list on
desktop and iOS marks an ephemeral worktree and shows that reason on a kept one.
A project sets the default and the discard permission in `.ion/worktree.json`
(`worktree.ephemeralDefault`, `worktree.ephemeralMayDiscard`, both off). A
person's remembered answer for the project (`worktreeEphemeral` on its
`projects` entry, saved with the branch when a create sets
`rememberWorktreeChoice`) outranks that default
(`server/src/worktree/worktree-choice.ts`). A
worktree cut with no conversation is never ephemeral, because nothing could
close it. Reference:
[`docs/configuration/worktree-json.md`](../configuration/worktree-json.md)
§ "Ephemeral worktrees". Retire also disenrolls the worktree from every bench. A
worktree deleted outside Ion skips that step, so the bench disenrolls any member
whose worktree directory is gone the next time it assembles or refreshes its
staleness (`server/src/integration/bench-removed-members.ts`).

**A landed worktree is sealed.** A successful Land records `landedAt`, immediately
removes the worktree from every bench, and does not rebuild the remaining bench
or advance any remaining pin. The checkout stays as a read-only review record:
existing conversations remain readable but input-locked, engine tool writes and
Bash are refused, and only Retire remains. Remaining worktrees receive landed
source content through their normal Sync, then an explicit pin Update and
assembly. `landedAt` is terminal; never infer, clear, or reverse it from live
Git state. A record that predates `landedAt` remains active because Git cannot
distinguish it from a worktree that never started.

**A transfer is a move, and it moves what you chose.** A conversation's own
Transfer moves just that conversation. When it lives in a worktree it leaves
the worktree behind, with the worktree's other conversations, and lands on
the destination in a project's checkout, one of its live worktrees, or a new
worktree cut from a branch there (`server/src/transfer/landing.ts`). The
destination may be the machine the conversation is already on: then nothing
is exported, and the conversation and its live session are repointed
together (`transfer.relocate`, `server/src/transfer/relocate.ts`).

A worktree's own Transfer, on the worktree row, moves it whole: the checkout
and every open conversation in it go to another machine together, and the
bundle is cut against the destination's own branch tips (so a base branch
that is behind there still receives the commits the worktree sits on, and
the destination's base branch is never moved). The checkout is retired once,
after its last conversation lands.

**What moves.** A transfer moves the conversations the tab owns: its current
conversation, the earlier ones a checkpoint cut left as its history, and
their dispatch children. A fork is a separate conversation and never moves
with its source, even when it has no tab of its own
(`server/src/transfer/collect-family.ts`). With each conversation go every
file it uses:

| What | Where it lands on the destination |
|------|-----------------------------------|
| Conversation files and its own folder (plans, attachments, images) | `<conversationsDir>/<id>.*` and `<conversationsDir>/<id>/` |
| Spilled tool output | `<conversationsDir>/tool-results/<id>/` |
| Charts | `<dataDir>/resources/<id>/` |
| A plan kept in a shared folder | the conversation's own `plans/`, or `<working dir>/.ion/plans/` for a claude-code plan |
| An attached file (shared store, or anywhere on disk) | the conversation's own `attachments/` |
| Extension resources | handed to the same extension there (`resource_import`) |

A name already taken by a different file gets `-<sha8>`; an identical file
is reused. Every path the conversation stores is rewritten to the new
location before anything is written (`server/src/transfer/path-rewrite.ts`),
so the destination never points at the machine the conversation left. If an
extension there cannot take the conversation's resources, the import is
undone and refused, naming the extension, and the source keeps everything.

Either way the source is **deleted** once the destination has it — the
conversation family's files, its own folder, spilled tool output, and
charts, a plan it kept in a shared folder, its extension resources
(`resource_forget`), the tab record, the tab content, and, for a
whole-worktree move, the worktree checkout and its branch
(`server/src/transfer/remove-source.ts`). Three things stay, and the removal
logs each: a file in the content-named shared attachment store (another
conversation may use it; the moved conversation carries its own copy), a
file the user attached from their own folders, and a shared plan or tool
output that a fork made before forks owned their files still uses. So a
conversation that goes to another machine and comes back finds nothing old
waiting to collide with. Nothing is marked, kept read-only,
or left to reconcile: the conversation exists on one host at a time, and it
either moved or it did not. Moving it back is an ordinary transfer in the
other direction.

Deleting is only safe because the destination proves it has the bytes first.
The archive's manifest carries the sha256 of every entry
(`server/src/transfer/entries.ts`); the destination re-hashes what it
extracted and what it committed, and refuses on any mismatch. The removal
then refuses any tab that is not mid-transfer to the environment asking, and
answers ok when the source is already gone so a retry can finish an
interrupted move. A worktree is removed before the files, because it is the
only part that can refuse. Every failure path leaves the original intact,
and an import that refuses after writing anything rolls it back, so a retry
never mistakes a failed copy for a finished one.

A dirty worktree cannot be moved whole: the export refuses it
(`dirty_worktree`) and the dialog blocks the verb before that. Commit first —
the move packages a clean tree, verifies it on the far side, and deletes the
near side, and none of that can be done around uncommitted work. A
conversation leaving a dirty worktree on its own is not refused: the
worktree and its changes stay where they are.

**A new worktree arrives provisioned.** A bare checkout has no `node_modules`, no
git hooks, and no build caches — everything gitignored is absent, so nothing
builds. Ion materialises what the project declares in the committed
`.ion/worktree.json`: each `seed` entry is cloned (copy-on-write), built with its
own command, or copied, and the project's `setup` command runs afterward. A clone
is a separate inode sharing blocks, so an install inside a worktree stays
independent of the main clone — Ion never symlinks a shared dependency directory.
No manifest means no provisioning. Ion refuses to seed any path git does not
ignore, so provisioning can never dirty `git status`. A worktree a transfer
restores from its bundle is provisioned the same way once the import
succeeds. A project Ion cloned is not provisioned, and its setup does not
run, until the operator trusts it
(`server/src/environment/project-trust.ts`): its commands are someone else's
code until then. Trust can be given with the clone request itself, and then
the setup runs as soon as the clone lands. Trusting a project provisions
every worktree of it that was refused while it was untrusted. Reference:
[`docs/configuration/worktree-json.md`](../configuration/worktree-json.md).

See [ADR-024](adr/024-integration-workspace.md).
