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
| **bench** / integration workspace | A reassemblable worktree holding the source branch plus selected members, for combined testing. |
| **bench branch** | `ion/bench/<slug>` — recreated from scratch on every assembly. |
| **member** | A worktree enrolled in a bench. |
| **pin** | The exact commit of a member that is currently integrated. |
| **behind (member)** | The worktree has committed work newer than its pin. |
| **review verdict** | Your judgement on a member's *current pin*. Cleared automatically when the pin advances. |
| **stale (base)** | The source branch has moved ahead of where a worktree was cut from. |
| **land and retire** | Integrate a clean worktree into the source branch, then remove its checkout and branch. |
| **re-attach** | Give an existing conversation a fresh worktree. |
| **sync** | Rebase a worktree onto the current source-branch tip. |

## The worktree lifecycle

Every verb is available from the Inbox worktree hierarchy, the tab context
menu, and iOS.

| Verb | Effect on the worktree | Effect on the conversation |
|---|---|---|
| **Land and retire** | Work merges into the source branch, then the worktree and branch are removed. | Finished conversations close. A conversation that becomes active during deletion moves to the source repository rather than staying on a deleted path. |
| **Push & PR** | Branch pushed, compare URL opened. | Untouched. |
| **Sync** | Rebased onto the current source tip. | Untouched. |
| **Re-attach** | A fresh worktree is created from the source tip. | Same conversation, now isolated again. |

**Land and retire is terminal.** The operation uses the least destructive merge primitive, then deletes the completed checkout. It never runs `git checkout`, so it cannot yank your working tree out from under a running build. New work starts in a new worktree.

**Closing a tab never destroys a worktree.** Close is safe and reversible. If
the worktree still holds uncommitted or unlanded work you are told so, and told
where to find it. To get back in, open the Inbox project and click the worktree
row. If nothing is open on that worktree a conversation is created; if something is, you are taken to it — and when several
conversations live in one worktree, clicking again moves to the next, so none of
them is stranded.

### Reviewing what the bench holds

Each bench member carries an optional verdict on its **current pin**: a check for
reviewed-good, a bug for a problem found. The pair sits on the lower line of the
row, under the gutter, so it is present and clickable on every member regardless
of what else the row is reporting. Clicking the verdict already set clears it.

Two properties make this trustworthy rather than decorative:

- **Unreviewed is visible.** The buttons render greyed rather than hidden, so
  "nobody has looked at this" is a state you can see while scanning, not an
  absence you have to infer. They are also the *only* indicator of the verdict —
  the row's state slot deliberately does not repeat it, because a second mark per
  reviewed row is what makes a list of them hard to read.
- **A verdict belongs to a contribution, not a worktree.** Advancing the pin
  (Update, or Update all) clears it, because the reviewed content is gone. An
  Update that finds nothing new keeps it — the reviewed thing has not changed.

## Two directions of staleness

These point opposite ways and have different resolutions. Conflating them would
make both meaningless.

| Signal | Meaning | Fix |
|---|---|---|
| **Member behind** | The worktree committed work newer than the bench holds. | **Update** the member. |
| **Base stale** | The source branch moved ahead of the worktree. | **Sync** the worktree. |

**When both are true, sync first.** A sync is a rebase, so it rewrites every
commit in the worktree — any pin taken beforehand is stale the moment the sync
lands, it costs a bench assembly to take, and in the window between the two it
publishes pre-rebase content to anyone who reassembles the bench.

Both clients enforce the same order. The base-moved control ranks above the
update-pin control and stays there even when the worktree is dirty and the sync
cannot run yet: it renders disabled with the reason on hover, rather than
reordering itself around a fact you may not have noticed. On iOS the pin badge is
suppressed while a sync is pending and **Update pin** is disabled in the row
menu, for the same reason. Clean the worktree, sync, then update the pin.

Base staleness fires constantly in parallel work: every land by another worktree
advances the source branch, as does a teammate's push or a direct commit to it.
Developing against a stale base means writing code that compiles locally and
conflicts on land.

The base-moved badge only appears when a sync would **actually change** your
worktree. Right after your own work lands you are technically "behind" by the
merge commit, but syncing would gain nothing — so no badge. A badge that nothing
can clear teaches you to ignore every badge.

## Using the bench

### Adding a member — the bench appears when you need it

There is no "create a bench" step, and no separate list to manage. Click the
diamond at the start of a worktree's row — or use **Add to integration bench**
in its row menu — and the bench is created when you add its first member.
Creating it writes a record, not a directory (the bench worktree is materialised by the
first assembly), so there is nothing to commit to and nothing to choose.

Which bench a worktree joins is fully determined by its repo and source branch,
so there is no picker.

The diamond has three readings, and the middle one matters:

| Diamond | Meaning |
|---|---|
| hollow, grey | Not in the bench. |
| solid, accent | In the bench and merged in member order. |

Each bench is keyed by `(repo, source branch)`, so different projects and
different feature branches always get separate benches. They cannot blend.

Membership is **never automatic**. A worktree is either present in the bench
member list or absent from it. Adding it means "I want this integrated", which
is a judgement only you can make.

### Removing a member

Removing a worktree from a bench makes it absent from that bench's member list.
Retiring a worktree removes it from every bench because a member whose worktree
no longer exists can never be updated, rebuilt from, or landed.

An empty workspace record remains. It retains the bench identity and other
workspace state until a later member is added.

**Closing a conversation does not remove membership.** Close leaves the
worktree intact so you can come back to it, so its membership stays valid too.
Only an explicit removal or Retire removes a worktree from a bench.

### Only committed work integrates

A member contributes the tree of its branch HEAD. Uncommitted changes never
reach the bench, and there is no setting that changes this.

A bench built from a half-saved working tree would be a state that exists
nowhere in history — unreproducible, unreviewable, unlandable, and if the build
fails there is no commit to point at. Committing is how you declare a unit of
work coherent, and that is exactly the judgement the bench needs.

### Nothing assembles on its own

The bench never changes until you say so. Members go **behind** when their
worktree commits new work; the bench itself does not move. This is deliberate:
a change may need two commits to build, and an assembly firing between them would
put a broken state in the bench that is nobody's real state.

- **Update** (per member) — advance that member's pin and assemble. When the
  new pin will collide with another member, the update proceeds and a warning
  names the files — warn, never gate.
- **Update all & assemble** — advance every member that is behind, at once.
- **Assemble** — re-merge the existing pins. Advances nothing, so it is always
  safe to press.

The pin is why this works. Reassembling to pick up member A cannot drag in member
B's half-finished pair, because B stays at the commit it was pinned to.

### Assembly is all-or-nothing, and a conflict is resolved once

The bench presents the exact enrolled combination or nothing. When a member's
contribution will not merge, the whole assembly fails and the bench is wiped to
an empty tree — a terminal opened there finds nothing to falsely test, instead
of a partial combination that silently omits one member's work. The bench bar
says `assembly failed` and names the collision; the member's row badge opens a
dialog listing the conflicting files and which member they collide with.

Two ways out, both in that dialog:

- **Resolve once.** The machinery re-creates the failed merge in the bench and
  leaves it open; the normal conflict resolver (accept a side, 3-way merge,
  AI Assisted) finishes it. Completing the merge records the resolution
  (`git rerere`, stored in the main repo — wiping the bench cannot lose it),
  and every later assembly replays it automatically. You resolve a given
  collision exactly once; it only asks again if either side's conflicting
  lines genuinely change.
- **Open the member worktree.** The durable fix: rework the collision where it
  can be committed, then Update that member and reassemble.

Remove the conflicted member from the bench to assemble a different exact member set.

#### The second conflict on the same file is not a cold start

`git rerere` replays a resolution whose **conflict text** matches, which covers
the same collision recurring across assemblies. It cannot help when the same
*file* conflicts against a **different member**: the hunks differ, so nothing
matches, and historically each of those resolutions started from nothing. On a
busy bench that is the common case, not the edge one — five of six merges in one
recorded hour collided on a single file.

So Ion also records **why** each resolution went the way it did, and hands it to
whoever hits the same file next:

- Completing a bench merge writes a journal entry (path, the member being merged,
  the members it collided with, and the resolver's own rationale) once the
  resolution has passed its postconditions and the project's `bench.verify`.
- A later failed assembly attaches the matching entries to the conflicted
  member's record, so the dialog reporting the conflict already carries the prior
  reasoning.
- A conversation resolving in a bench can query it directly with
  **`BenchResolutionHistory`**, and read any member's pinned version of a file
  with **`BenchMemberFile`** instead of opening sibling worktrees by hand.

The journal is **advisory**. Nothing replays it — `rerere` remains the only
mechanism that applies a recorded resolution, because a recording keyed by
conflict text is verifiable and a paragraph of prose is not. Entries whose base
has left the source branch's history are dropped, since they describe a
reconciliation against code that no longer exists.

### Testing in the bench

**Open terminal** gives you a shell in the bench — build, run development
tools, test the combined result. It is one dedicated tab per bench: press it
again from anywhere and you return to the same tab and the same scrollback,
rather than accumulating identical shells. Use the `+` in the terminal strip
to run several commands side by side inside that one tab — a build in one, a
test watcher in another. Closing the tab is a complete reset; the next press
opens a fresh one.

The button builds the bench first if its directory is not there — on a bench
you have never built, and on one whose directory was removed outside Ion.

A shell is deliberately the only way in. Conversations are not offered in a
bench: a conversation invites development work, and anything written in a
bench is destroyed by the next assembly. The conversation about fixing a
failure belongs in the member worktree that owns the file — the fix lands
there, the bench rebuilds with it. The one exception is machine-created: the
AI-assisted conflict-resolution flow opens a conversation in the bench to
complete an in-progress resolution merge, and that conversation is
input-locked — it accepts no follow-up prompts, so it cannot grow into
development work.

The bench refuses any git command that writes history — `commit`, `push`,
`pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `stash`, `tag`, and
branch mutation — both from the git panel and from agents. A commit there would
be destroyed by the next assembly, and a push would publish a synthetic merge of
other people's in-flight work. Reading, building, testing, and staging all stay
available, so reviewing a diff or running a build in the bench works normally.
When you find a fix, apply it in the **member worktree that owns the file**,
commit it there, then Update that member.

That applies to the terminal as much as to an agent: an assembly recreates the
bench branch from the feature branch plus each member's pinned commit, so
anything you commit in the bench shell is destroyed the next time the bench
builds. The shell is for running things, not for recording them.

Both verbs are on the phone too, in the bench header on the Worktrees screen,
labelled "Go to conversation" / "Go to terminal" once something is already open.

### When a member breaks the build

Uncheck it. The member stays in the list but is skipped, so you can prove the
rest still builds. Re-check it when it is fixed.

A member that cannot be merged is reported `conflicted`, with the colliding
paths and which earlier member it collided with, and is **skipped** — the rest
of the bench still builds. A bad member never costs you the working bench.

### After terminal completion

**Land and retire** merges the worktree into its source branch, removes it from
every bench, then removes the checkout and branch. Finished conversations close.

Land and retire does not reassemble the bench or advance any other pin. Sync each remaining
worktree from the source branch, then use Update or Update all & assemble when
its new committed contribution is ready. This brings landed source content into
remaining worktrees natively rather than retaining a duplicate bench member.

When an explicit assembly runs, landed content comes from the source branch
base and the remaining members layer on top. Nothing is lost: the content is in
the feature branch, which is where a pull request into the trunk reads from.

This works even when you squash a dozen iteration commits into one before
landing, and even after terminal completion deletes the branch.

## A worked run

1. Branch `josh` from `main`. Cut two worktrees off `josh` and start work.
2. Add both to the bench. It builds: `josh` plus two merges.
3. Both rack up commits. Members show **stale**; the bench stays put.
4. Worktree 1 is done. Squash its commits into one tight commit.
5. **Land** it into `josh`. `josh` is now one commit ahead of `main`.
6. Assemble. Worktree 1 is absorbed into the base and retired; only worktree 2 is
   layered on top. The bench content is unchanged — worktree 1's work now comes
   from the base instead of a merge.
7. Worktree 2 keeps iterating. Sync it so it develops against the updated `josh`.
8. When it is ready: squash, land, assemble. The bench equals `josh`.
9. Open a pull request from `josh` into `main`.

## Reading member status

| Status | Meaning | What clears it |
|---|---|---|
| `@9c2b17e` | Integrated at that commit. | — |
| `@9c2b17e · stale` | Worktree has newer commits. | Update. |
| `conflict` | Could not merge; the assembly failed and the bench is empty. | Resolve once (recorded and replayed), rework in the member worktree, or remove the member. |
| `missing` | Branch or worktree is gone. | Remove from the bench. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Land refused: "commit your changes first" | The worktree is dirty. | Commit or discard, then land. |
| Land refused: source branch dirty | The source branch is checked out somewhere with uncommitted changes. | Commit or stash there. |
| Land refused: cannot fast-forward | Source branch moved on. | Sync the worktree, then land. |
| Sync refused | The worktree is dirty. Your changes are untouched. | Commit or stash, then sync. |
| The bench "didn't pick up my work" | Integration is manual. | Update the member. |
| No bench exists yet | The workspace has no members yet. | Click the diamond at the start of a worktree row. |
| A bench has no members | All members were removed or retired. | Add a worktree when you want to assemble it. |
| A member shows `behind` and Update changes nothing | You amended or reworded — same content, new sha. | Nothing to do; the badge clears on the next evaluation. |
| A worktree I just completed is still at the top of the list | Terminal completion removes the checkout and its branch. | Refresh the Inbox. New work starts in a new worktree. |
| A worktree I landed long ago is still present | It predates terminal completion. | Retire it with the existing lifecycle cleanup, then it disappears. |
| Assemble refused | The bench tree is dirty or a bench conversation is running. | Discard the bench edits or export them to the member. |
| A worktree is missing from the list | It was created outside Ion. | It still appears, but with "source unknown" — land and sync are disabled because Ion cannot know what it was cut from. |
| Two benches for one repo | You integrate into two source branches. | Expected; each branch gets its own. |
| Bench build is slow | The first build after creating a bench is cold. | Later assemblies are incremental — ignored build output is preserved. |
| The bench directory was deleted | Removed outside Ion. | It self-heals on the next assembly. |
| An edit in the bench was refused | Edits there are destroyed by the next assembly. | The refusal names the member worktree that owns the file — edit and commit there, then Update that member. |
| The refusal listed several members | More than one member changes that file, so no single owner is the honest answer. | Pick the member whose listed line ranges cover the region you are editing. |
| The bench panel has no Changes or Graph | Deliberate: a bench must hold no uncommitted changes, and its history is synthetic. | Use the member worktrees for both. |
| A new worktree has no `node_modules` | The repo has no `.ion/worktree.json`, or the seed entry is missing. | Add the manifest; existing worktrees get it via Re-provision. |
| Provisioning shows a warning badge | A `build` or `setup` command failed. | Read the reason in the tooltip, fix it, then Re-provision. |
| Provisioning is slow every time | No copy-on-write between your repo and the worktree root — different volumes, or a filesystem without reflink (NTFS, ext4). | Expected. Put the worktree root on the same volume as the repo to get the fast path. |
| A seeded path shows in `git status` | It cannot: Ion refuses to seed any path git does not ignore. | If you see this, the path came from something other than provisioning. |
| The graph is missing in a worktree | Primary checkout has no graph, or worktree predates linked-file provisioning. | Re-provision after building the graph in the primary checkout. Worktrees query the primary `graph.json`; `make graph-refresh` creates or validates its link for older manifests, while `make graph` refuses there. |

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
| `~/.ion/integration/<repo>-<slug>/` | Bench worktrees. | Recreated on the next assembly. |
| `~/.ion/integration-workspaces.json` | Member sets and pins. | Loses the member set only, never code. |
| `~/.ion/worktree-registry.json` | Which branch each worktree was cut from. | Land/sync fall back to "source unknown". |
| `~/.ion/integration-resolutions.json` | Why past bench conflicts were resolved the way they were. | Loses the reasoning only; `rerere` recordings and code are untouched. |
| `refs/ion/discarded/…` | Work preserved before a forced discard. | Recover with a normal checkout. |

## Where the controls are

**Desktop** — Inbox is the single project, bench, worktree, and conversation
navigator. A project with worktrees shows its Integration Bench first, then its
Source Repository, then its worktrees. The Inbox Bench bar is the production
mount for its singleton terminal, automated re-sync pipeline, assembly/update,
replay-cache deletion, conflict recovery, and verification analysis. A normal
Bench row click cycles an already-open Bench conversation only; it never creates
one. Right-click opens the Bench menu, where **Open Bench Conversation** is the
explicit creation verb. Empty worktrees remain visible and start a new
conversation when clicked. Enrolled worktrees retain merge order; their Inbox
state slot shows the same pin, sync, conflict, verification, replay, provision,
and active auto-fix states as the former worktree panel.

Every per-row control — the bench diamond, the activity dot, the dirty marker,
the unlanded count, the state indicator — sits in a fixed-width gutter at the
START of the row, with the worktree name trailing and ellipsising.

The **activity dot** is the aggregate status of the conversations living in that
worktree, in the same colour vocabulary the tab and group pills use: it pulses
while something is running, shows the waiting colour when a conversation is
blocked on background work, greys when everything is idle, and renders as a
hollow ring when no conversation is open there at all. The **dirty marker** is a
small red `!` beside it — the `git status` convention, which is what lets it use
the danger hue without reading as a failure. They are two facts and two
indicators; the dot used to try to be both, in green, which said "success" about
a worktree full of unsaved work. Clicking a row opens its
conversation, or cycles when several are open; **right-click** anywhere on the
row for its menu, where **New conversation here** creates an additional one.

The row hosting the **active conversation** carries an accent rail down its
leading edge — "you are here". Any conversation in the worktree counts, so a
worktree with four open conversations is marked whichever one you are in. It is a
rail rather than a background tint because background is already spoken for twice
in this row (hover, and the drag drop-target), and the hover card heading says it
in words as well, since colour must never be the only carrier.

Line 2 of each row leads with the **worktree ID** — the directory name under
`~/.ion/worktrees/`, which is also the suffix of the branch (`wt/<id>`) — before
the last commit subject, in monospace. That is the token the Inbox worktree row
and the tab strip have in common: a conversation's title is renamed by its first
prompt and a worktree carries its own label, so without the ID the two surfaces
share no visible string to correlate. The same ID appears on the iOS row.

These surfaces are deliberately complementary rather than redundant. The tab
strip says which *tab* is focused and how work is grouped; the workspace
indicator says which conversations are live or waiting across every group; Inbox
says which *checkout* you are standing in and what git thinks of it. The activity dot appearing in two of them is one shared fold rendered twice,
not two opinions — which is why it cannot drift.

The gutter deliberately carries no conversation button and no `⋯` button. The
first duplicated the row click while wearing the same glyph as the bench bar's
Open-conversation button; the second duplicated right-click. Both spent
permanently reserved width that the worktree name needs. A second gutter column on the row's lower line carries the **review
verdict** pair for bench members (see below). No name length can push a control out of reach, and every name and
control lines up in Inbox. The Git panel now holds changes, history, and conflict
resolution only.

Land verbs are also on the tab context menu, and worktrees and benches appear in
the new-tab directory picker.

**Studio** — the side dock mounts the same Inbox navigator as the overlay.

**iOS** — Inbox is the same project, Bench, Source Repository, worktree, and
conversation console. Its toolbar provides project scope, sorting, global group
collapse and expansion, search, and Settled History. A collapsed group shows only
pinned conversations; expanding it shows every conversation in that checkout.
Long-press menus and confirmation sheets provide the mobile forms of desktop
row menus: create or convert worktrees, create another conversation in a
worktree, manage Bench membership and order, sync, assemble, recover, discard
recordings, re-provision, and Land and retire. Finder reveal remains desktop-only
because an iPhone cannot open the paired Mac's Finder.
