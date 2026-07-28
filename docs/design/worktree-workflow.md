---
title: Worktree Workflow
description: Parallel feature development with worktrees, the integration bench, and the land lifecycle.
---

# Worktree Workflow

For doing several pieces of work at once without them colliding, and testing
them together before any of them lands.

## The problem this solves

Worktree mode gives each conversation its own directory, so a dozen agents can
work in parallel without stepping on each other. That isolation is the point —
and it is also what used to make testing painful. A feature could only be
exercised alone, so the only way to test two together was to land one into the
feature branch, putting unproven work there to answer whether it worked.

Landing also used to be terminal. "Finish work" merged, deleted the worktree,
and closed the conversation in one action, so integrating always cost the
conversation with it.

Now: land is repeatable and non-destructive, a conversation outlives its
worktree, and the **bench** lets you test any combination of in-flight features
without landing anything.

## Vocabulary

| Term | Meaning |
|---|---|
| **member worktree** | A `wt/…` worktree where a feature is being built. |
| **source branch** | The feature branch worktrees are cut from and land into (`josh`, `beta`, …). Never the trunk. |
| **bench** / integration workspace | A rebuildable worktree holding the source branch plus selected members, for combined testing. |
| **bench branch** | `ion/bench/<slug>` — recreated from scratch on every rebuild. |
| **member** | A worktree enrolled in a bench. |
| **pin** | The exact commit of a member that is currently integrated. |
| **stale (member)** | The worktree has committed work newer than its pin. |
| **stale (base)** | The source branch has moved ahead of where a worktree was cut from. |
| **land** | Integrate a worktree's work into the source branch. |
| **retire** | Remove a worktree, keeping the conversation. |
| **re-attach** | Give an existing conversation a fresh worktree. |
| **sync** | Rebase a worktree onto the current source-branch tip. |

## The worktree lifecycle

Every verb is available from the git panel's Worktrees section, the tab context
menu, and iOS.

| Verb | Effect on the worktree | Effect on the conversation |
|---|---|---|
| **Land** | Work merges into the source branch. Worktree stays. | Untouched. Repeatable. |
| **Land & retire** | Work lands, then the worktree and branch are removed. | Stays open, relocated to the repo root. |
| **Land & close** | Work lands, worktree removed, tab closed. | Closed deliberately. |
| **Push & PR** | Branch pushed, compare URL opened. | Untouched. |
| **Sync** | Rebased onto the current source tip. | Untouched. |
| **Re-attach** | A fresh worktree is created from the source tip. | Same conversation, now isolated again. |

**Landing is repeatable.** Land picks the least destructive primitive: when the
source branch is checked out nowhere it advances the ref directly with zero
working-tree impact; when it *is* checked out it merges in place after checking
that tree is clean. It never runs `git checkout`, so it cannot yank your working
tree out from under a running build.

**Closing a tab never destroys a worktree.** Close is safe and reversible. If
the worktree still holds uncommitted or unlanded work you are told so, and told
where to find it. To get back in, open the Worktrees list and click the row.

## Two directions of staleness

These point opposite ways and have different resolutions. Conflating them would
make both meaningless.

| Signal | Meaning | Fix |
|---|---|---|
| **Member stale** | The worktree committed work newer than the bench holds. | **Update** the member. |
| **Base stale** | The source branch moved ahead of the worktree. | **Sync** the worktree. |

Base staleness fires constantly in parallel work: every land by another worktree
advances the source branch, as does a teammate's push or a direct commit to it.
Developing against a stale base means writing code that compiles locally and
conflicts on land.

The base-moved badge only appears when a sync would **actually change** your
worktree. Right after your own work lands you are technically "behind" by the
merge commit, but syncing would gain nothing — so no badge. A badge that nothing
can clear teaches you to ignore every badge.

## Using the bench

### Enrolling — the bench appears when you need it

There is no "create a bench" step. Open a worktree's row menu in the Worktrees
section and choose **Add to integration bench**: the bench is created on that
first enrollment. Creating it writes a record, not a directory — the bench
worktree itself is materialised by the first rebuild — so there is nothing to
commit to and nothing to choose.

Which bench a worktree joins is fully determined by its repo and source branch,
so there is no picker. Once a bench exists you can also add further members from
the Integration section's **Add worktree to bench**, which offers only worktrees
cut from that bench's source branch.

Each bench is keyed by `(repo, source branch)`, so different projects and
different feature branches always get separate benches. They cannot blend.

Enrollment is **never automatic**. Putting a worktree in the bench means "I want
this integrated", which is a judgement only you can make.

### Leaving — automatic when a worktree is retired

Disenrollment *is* automatic, and the asymmetry is deliberate. Retiring a
worktree removes it from every bench that held it, because a member whose
worktree no longer exists can never be updated, rebuilt from, or landed — it
would sit as a permanent `missing` row you could only clear by hand.

When the last member leaves, the bench is pruned entirely: record and worktree.
An empty bench holds nothing unique (its content is exactly the feature branch),
and keeping them would accumulate one dead bench per feature branch you ever
integrated into. The next enrollment recreates it.

**Closing a conversation does not disenroll anything.** Close leaves the
worktree intact so you can come back to it, so its membership stays valid too.
Only Retire removes a worktree.

### Only committed work integrates

A member contributes the tree of its branch HEAD. Uncommitted changes never
reach the bench, and there is no setting that changes this.

A bench built from a half-saved working tree would be a state that exists
nowhere in history — unreproducible, unreviewable, unlandable, and if the build
fails there is no commit to point at. Committing is how you declare a unit of
work coherent, and that is exactly the judgement the bench needs.

### Nothing rebuilds on its own

The bench never changes until you say so. Members go **stale** when their
worktree commits new work; the bench itself does not move. This is deliberate:
a change may need two commits to build, and a rebuild firing between them would
put a broken state in the bench that is nobody's real state.

- **Update** (per member) — advance that member's pin and rebuild.
- **Update all & rebuild** — advance every stale member at once.
- **Rebuild** — re-merge the existing pins. Advances nothing, so it is always
  safe to press.

The pin is why this works. Rebuilding to pick up member A cannot drag in member
B's half-finished pair, because B stays at the commit it was pinned to.

### Testing in the bench

Click **Open conversation** in the Integration header to start a conversation in
the bench directory. Run the build, run tests, ask an agent to diagnose a
cross-feature failure — it can see all the members at once, which is the whole
reason the bench exists.

The bench refuses any git command that writes history — `commit`, `push`,
`pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `stash`, `tag`, and
branch mutation — both from the git panel and from agents. A commit there would
be destroyed by the next rebuild, and a push would publish a synthetic merge of
other people's in-flight work. Reading, building, testing, and staging all stay
available, so reviewing a diff or running a build in the bench works normally.
When you find a fix, apply it in the **member worktree that owns the file**,
commit it there, then Update that member.

### When a member breaks the build

Uncheck it. The member stays in the list but is skipped, so you can prove the
rest still builds. Re-check it when it is fixed.

A member that cannot be merged is reported `conflicted`, with the colliding
paths and which earlier member it collided with, and is **skipped** — the rest
of the bench still builds. A bad member never costs you the working bench.

### After a land

When a member's work lands into the source branch it becomes part of the bench's
base permanently. The bench rebuilds from the source tip, so the work arrives
with the base and the member is retired from the list. Nothing is lost: the
content is in the feature branch, which is where a pull request into the trunk
reads from.

This works even when you squash a dozen iteration commits into one before
landing, and even after **Land & retire** deletes the branch.

## A worked run

1. Branch `josh` from `main`. Cut two worktrees off `josh` and start work.
2. Add both to the bench. It builds: `josh` plus two merges.
3. Both rack up commits. Members show **stale**; the bench stays put.
4. Worktree 1 is done. Squash its commits into one tight commit.
5. **Land** it into `josh`. `josh` is now one commit ahead of `main`.
6. Rebuild. Worktree 1 is absorbed into the base and retired; only worktree 2 is
   layered on top. The bench content is unchanged — worktree 1's work now comes
   from the base instead of a merge.
7. Worktree 2 keeps iterating. Sync it so it develops against the updated `josh`.
8. When it is ready: squash, land, rebuild. The bench equals `josh`.
9. Open a pull request from `josh` into `main`.

## Reading member status

| Status | Meaning | What clears it |
|---|---|---|
| `@9c2b17e` | Integrated at that commit. | — |
| `@9c2b17e · stale` | Worktree has newer commits. | Update. |
| `conflict` | Could not merge; skipped. | Resolve the collision, then Update. |
| `missing` | Branch or worktree is gone. | Remove from the bench. |
| `excluded` | Disabled by you. | Re-check it. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Land refused: "commit your changes first" | The worktree is dirty. | Commit or discard, then land. |
| Land refused: source branch dirty | The source branch is checked out somewhere with uncommitted changes. | Commit or stash there. |
| Land refused: cannot fast-forward | Source branch moved on. | Sync the worktree, then land. |
| Sync refused | The worktree is dirty. Your changes are untouched. | Commit or stash, then sync. |
| The bench "didn't pick up my work" | Integration is manual. | Update the member. |
| No bench exists yet | Benches appear on first enrollment. | Worktrees row menu → Add to integration bench. |
| A bench vanished | Its last member was retired, so it was pruned. | Enroll a worktree; it comes back. |
| A member shows `stale` and Update changes nothing | You amended or reworded — same content, new sha. | Nothing to do; the badge clears on the next evaluation. |
| Rebuild refused | The bench tree is dirty or a bench conversation is running. | Discard the bench edits or export them to the member. |
| A worktree is missing from the list | It was created outside Ion. | It still appears, but with "source unknown" — land and sync are disabled because Ion cannot know what it was cut from. |
| Two benches for one repo | You integrate into two source branches. | Expected; each branch gets its own. |
| Bench build is slow | The first build after creating a bench is cold. | Later rebuilds are incremental — ignored build output is preserved. |
| The bench directory was deleted | Removed outside Ion. | It self-heals on the next rebuild. |
| An edit in the bench was refused | Edits there are destroyed by the next rebuild. | The refusal names the member worktree that owns the file — edit and commit there, then Update that member. |
| The refusal listed several members | More than one member changes that file, so no single owner is the honest answer. | Pick the member whose listed line ranges cover the region you are editing. |
| The bench panel has no Changes or Graph | Deliberate: a bench must hold no uncommitted changes, and its history is synthetic. | Use the member worktrees for both. |
| A new worktree has no `node_modules` | The repo has no `.ion/worktree.json`, or the seed entry is missing. | Add the manifest; existing worktrees get it via Re-provision. |
| Provisioning shows a warning badge | A `build` or `setup` command failed. | Read the reason in the tooltip, fix it, then Re-provision. |
| Provisioning is slow every time | No copy-on-write between your repo and the worktree root — different volumes, or a filesystem without reflink (NTFS, ext4). | Expected. Put the worktree root on the same volume as the repo to get the fast path. |
| A seeded path shows in `git status` | It cannot: Ion refuses to seed any path git does not ignore. | If you see this, the path came from something other than provisioning. |
| The graph is missing in a worktree | `make bootstrap` deliberately skips the graph build in a worktree. | Provisioning seeds it; `make graph-refresh` forces one. |

## Provisioning — a new worktree arrives ready to build

A git worktree is a bare checkout. Everything your project needs but git does
not track — `node_modules`, git hooks, build caches, generated config — is
absent, so a fresh worktree looks like the repo and cannot run a single gate.

Ion fills that gap from a committed manifest at `.ion/worktree.json`. **No
manifest means no provisioning**, and worktree creation behaves exactly as it
always has.

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      { "path": "node_modules", "build": "npm ci", "staleWhen": ["package-lock.json"] }
    ],
    "setup": "make bootstrap"
  }
}
```

Each `seed` entry names a gitignored directory and how to rebuild it. `setup` is
your project's own idempotent recipe, run once after seeding. The fields carry
no knowledge of any language: the same four express `vendor/` + `go mod
download`, `.venv/` + `uv sync`, or `Pods/` + `pod install`.

### How a directory gets there

| Rung | When | Cost |
|---|---|---|
| **clone** | Source and destination are on one copy-on-write volume (APFS, Btrfs, XFS, ReFS Dev Drive) | near-zero |
| **build** | No clone available — runs your `build` command | a normal install |
| **copy** | Last resort, only when no `build` is declared | full disk, slow |

Ion probes the filesystem rather than guessing from the operating system, so a
Btrfs Linux box gets the fast path and an NTFS Windows box correctly falls to
`build`. Reflink needs both sides on the **same volume**, so if your repo and
`~/.ion/worktrees` are on different disks you will get `build` regardless of
filesystem.

**A cloned directory is fully independent.** A reflink shares physical blocks but
is a separate file, so the first write splits them. Running `npm install` inside
a worktree is safe and affects nothing else — it costs only the packages that
actually change. Ion never symlinks a shared `node_modules`, because that *would*
make one worktree's install mutate every other.

### Keeping it current

Just run your package manager. Because every rung produces an independent tree,
`npm install` in a worktree is correct with no involvement from Ion.

Ion also compares each `staleWhen` file (your lockfiles) against the source and
re-runs `build` when they diverge — which is what happens when you sync and pick
up a sibling's dependency bump. If a tree still looks wrong, **Re-provision** in
the worktree row menu re-runs the whole ladder.

### Watching it happen

Provisioning runs *behind* worktree creation, so the directory is usable
immediately. The worktree row shows a spinner while it works and a warning if it
fails, with the failing command's output in the tooltip. A failure never blocks
you and never destroys anything: you get a usable worktree, an explanation, and
the Re-provision verb.

## Where state lives

| Path | Contents | If deleted |
|---|---|---|
| `~/.ion/worktrees/` | Member worktrees. | Real work — do not delete by hand. |
| `~/.ion/integration/<repo>-<slug>/` | Bench worktrees. | Recreated on the next rebuild. |
| `~/.ion/integration-workspaces.json` | Member sets and pins. | Loses the member set only, never code. |
| `~/.ion/worktree-registry.json` | Which branch each worktree was cut from. | Land/sync fall back to "source unknown". |
| `refs/ion/discarded/…` | Work preserved before a forced discard. | Recover with a normal checkout. |

## Where the controls are

**Desktop** — the git panel carries a **Worktrees** section (list, re-entry,
per-row sync/land/retire) and an **Integration** section (bench header with
Open conversation / Rebuild, member rows with pins and status). Land verbs are
also on the tab context menu, and worktrees and benches appear in the new-tab
directory picker.

**ATV** — the side dock has a Worktrees tab mounting the same two sections.

**iOS** — worktrees and benches appear in the new-tab sheet (one tap from the
tab list) and the tab-row context menu. The full console, with per-member pins
and bench controls, is in the git pane under **Worktrees & Bench**. A tab whose
base has moved shows an indicator on its row.
