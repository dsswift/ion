---
description: Squash the current branch into clean conventional commits. Creates a backup branch first, reads all commits to understand logical groupings, generates a squash plan, then rebuilds the branch from a soft reset into one commit per scope per feature. Does not push.
---

You are running the `/squash` command. Your job is to collapse the current branch's commits into clean conventional commits — one per code scope per logical feature — by rebuilding the branch from a soft reset (Step 7). You create a backup branch first, generate a squash plan for review, and execute it.

**Two distinct units are in play and they never collapse into each other: the feature is the unit of *counting*; the scope is the unit of *physical commits*.**

- **Counting unit — the feature.** A single feature that touches `engine/`, `desktop/`, `ios/`, `relay/`, and `docs/` is **one feature**. When you count, group, headline, and report, count *features*. The per-scope commits are the *implementation* of a feature, not separate features. Never report "N features" using the scoped-commit total: a branch that implemented a dozen features across many scopes is a dozen features, not thirty commits' worth of features. All the scattered fixes, tests, alignment commits, and per-scope slices that serve one feature fold into that one feature's count. The headline number the user sees is always the feature count first; the resulting scoped-commit count is a secondary, parenthetical figure.

- **Physical-commit unit — the scope. The scope split is mandatory and can never be bypassed by the feature-counting rule.** Counting a cross-scope feature as *one feature* does **not** authorize merging its scopes into one commit. Each code scope a feature touches (`engine/`, `desktop/`, `ios/`, `relay/`) becomes its **own** commit — `feat(engine)`, `feat(desktop)`, `feat(ios)`, `feat(relay)` — never a single commit carrying two component directories. This is not a stylistic preference: the CI/CD release pipeline (Release Damnit) detects which components changed **by commit scope**, and builds each component's artifact from its matching scoped commit. An `engine` change piggybacked inside a `feat(desktop)` commit is invisible to the versioning system — the engine artifact never builds. So a one-feature count *always* still expands into one physical commit per code scope. Feature counting compresses the *headline*; it never compresses the *commits*.

**Output contract: no narrative.** This command emits only structured output at every step — commit lists, the plan block, tool calls, and the final report. Never narrate analysis, reasoning, or intermediate findings as prose. Emit the structure; skip the commentary.

**Interaction rule.**

Any point where the protocol needs a human decision MUST be a single `AskUserQuestion` tool call. Never end a turn on a decision-shaped question written as prose: a prose question followed by `end_turn` leaves the session idle with nothing to wait on, and the run stalls. This applies to scripted gates (Step 6's proceed/adjust/abort confirmation) AND to any unscripted fork discovered mid-execution (e.g. an execution-method choice surfaced during conflict analysis in Step 7).

**Hard rules.**

- Never run on `main`. Abort immediately if the current branch is `main`.
- Never run `git push`. Report that changes are ready to push.
- Preserve the full unsquashed history in the backup branch before squashing.
- Never fabricate commit messages. Every squashed commit message must be grounded in the actual commits being squashed.
- The squashed commits must follow conventional commit format exactly.
- **Subject-only commit messages. No bodies.** Every result commit is a single conventional-commit subject line with no body and no trailers of any kind: no `Squashed from:` provenance list, no summary paragraph, no `Co-authored-by`, no generator footer. The only exception is an issue trailer (`Fixes #N` / `Closes #N`) when the group is associated with a GitHub issue; that is the sole content permitted below the subject.
- **Code scope isolation is mandatory; documentation may ride anywhere.** The scope-isolation rule applies to **code** files under a versioned component directory (`engine/`, `desktop/`, `relay/`, `ios/`): a commit scoped `engine` must not contain `desktop/` *code*, a commit scoped `desktop` must not contain `engine/` *code*, and so on. **Documentation files (`*.md`, anything under `docs/`) are exempt** — they do not trigger releases and may ride in any commit. Feature documentation bundles into its feature's commit (a `docs/` file under a `feat(engine)` commit is correct); only documentation *not* associated with a feature (e.g. cross-cutting `AGENTS.md` behavior changes) becomes a standalone `docs(repo)` commit, which may span directories.

  **Why the distinction exists.** Scopes exist *only* to drive independent component builds and version bumps. A `feat(engine)` + `feat(desktop)` pair triggers both the engine build and the desktop build to produce new releases. A `docs`-type (or `repo`-type) commit triggers no build and no version bump — it does not touch the release pipeline at all. So documentation cannot build or version anything, which means its placement relative to commit scope is irrelevant to the only thing scopes are for. The single failure mode the rule guards against is a *code* file under a versioned component directory riding in a commit whose scope doesn't match that directory — that is what makes a component's build fail to trigger (the CI/CD release pipeline, Release Damnit, uses commit scopes to detect which components changed). A bundled `docs/` file never causes that.

---

## Step 1: Check the branch

Run:

```bash
git branch --show-current
```

If the result is `main`, stop immediately:

> Cannot squash on `main`. Switch to a feature branch first.

Do nothing else.

---

## Step 2: Check for pending work

Run:

```bash
git status --porcelain
```

If there are uncommitted changes (staged or unstaged), stop:

> There are uncommitted changes on this branch. Commit or stash them before squashing.

---

## Step 3: Create or update the backup branch

Run:

```bash
git branch --show-current
```

The backup branch name is `backup--{branch_name}`.

Check if it already exists:

```bash
git branch --list backup--{branch_name}
```

If it exists, move it to the current HEAD:

```bash
git branch -f backup--{branch_name} HEAD
```

If it does not exist, create it:

```bash
git branch backup--{branch_name} HEAD
```

Report: "Backup branch `backup--{branch_name}` is now pointing to `{HEAD SHA}`."

---

## Step 4: Count commits ahead of main

Run:

```bash
git log main..HEAD --oneline
```

Count the commits. If there is exactly one commit, stop:

> Nothing to squash — the branch has a single commit. No action taken.

Print the list of commits so the user can see what's on the branch.

---

## Step 5: Read all commit messages

Run:

```bash
git log main..HEAD --format=fuller --no-merges
```

Read every commit message in full: subject, body, and trailers. The commit messages are the source of truth for understanding the logical groupings. Do not infer groupings from file paths alone — read the messages.

---

## Step 6: Generate the squash plan

Analyze the commits and identify logical groupings. A logical group is a set of commits that all implement a single feature, fix, or task. Rules:

- Commits that implement the same feature belong in one group, even if they were made separately (e.g. the initial implementation, a fix, and a test addition).
- **A feature that spans multiple scopes is still one logical group.** Do not create a separate group per scope. The single group for a cross-scope feature (engine + desktop + ios + relay + docs) is what gets counted as *one feature*; the scope split in the next subsection then expands that one group into one commit per code scope. Grouping is by feature; the per-scope expansion happens after, at commit time.
- Alignment fixes that address a specific feature belong with that feature's group.
- Unrelated changes stay in separate groups.
- The order of groups should be chronological (oldest first).

The feature count is the number of logical groups. The scoped-commit count is the number of result commits after the scope split below (always ≥ the feature count, because every cross-scope feature expands). Report both, feature count first.

### Scope enforcement

After grouping by feature, enforce **code** scope isolation: each logical group produces **one result commit per code scope directory** it touches. Documentation files (`*.md`, `docs/`) are not scope-isolated and bundle into the feature commit they document (see "Documentation bundling" below).

- If a group contains only `engine/` code, it produces one `feat(engine)` commit.
- If a group contains `engine/`, `desktop/`, and `ios/` code, it produces three result commits: `feat(engine)`, `feat(desktop)`, `feat(ios)`.
- If a group contains `engine/` code plus a `docs/` file documenting that engine feature, it produces a single `feat(engine)` commit that **includes** the `docs/` file — not a separate `docs(docs)` commit.
- Root-level config/build files (`Makefile`, `.github/`, `scripts/`, `.ion/`) that are not feature documentation get their own `chore(repo)` commit — they must not be bundled into a component scope commit alongside that component's code.

#### Documentation bundling

Documentation does not build or version anything, so where a doc file sits relative to commit scope is irrelevant to the release pipeline. Apply this policy:

- **Feature documentation rides with its feature commit.** If `docs/configuration/engine-json.md` documents the engine feature in this group, that doc edit belongs *in* the `feat(engine)` commit. Do **not** pull it into a separate docs commit.
- **When a feature spans multiple scopes** (e.g. desktop + iOS), feature docs may be bundled into *either* scope's commit — it doesn't matter which. If the docs split cleanly per scope (a desktop-specific doc file and a separate iOS-specific doc file), bundle each with its matching scope. If one shared doc file applies to both, attach it to either one.
- **Only documentation not associated with any feature** becomes a standalone `docs(repo)` commit. The canonical case is cross-cutting `AGENTS.md` behavior/governance changes: edited all at once, tied to no single feature, a repo-level concern. Such a commit may span directories (root `AGENTS.md` + `engine/AGENTS.md` + `desktop/AGENTS.md` + `ios/AGENTS.md` collapse into **one** `docs(repo)` commit, not four).

To verify, run this check against every commit on the branch (including commits that won't be squashed):

```bash
for sha in $(git log main..HEAD --format="%H"); do
  subject=$(git log -1 --format="%s" $sha)
  scope=$(echo "$subject" | sed 's/[^(]*(\([^)]*\)).*/\1/')
  dirs=$(git diff-tree --no-commit-id --name-only -r $sha | awk -F/ '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "$scope | $dirs | $(echo $sha | cut -c1-8) $subject"
done
```

Flag any commit where a **code** directory doesn't match the scope — that is the versioning-critical violation that must be carved into separate per-scope commits during the rebuild. The script will *also* show multi-dir output for a feature commit carrying a `docs/` file (e.g. `engine | docs,engine`) or for a `docs(repo)` commit spanning directories — those flags are **expected and acceptable**, not violations, because documentation is versioning-inert. The check only matters for code under a mismatched scope.

The plan must list every result commit with its scope and the directories it will contain. No result commit may mix **code** directories across scopes; documentation directories riding alongside a feature (or spanning a `docs(repo)` commit) are fine.

For each logical group, propose a clean conventional commit:
- `type(scope): description (#N)` — the conventional commit subject. This is the **entire** message.
- No body. Do not write a "concise description of what this group does", a `Squashed from:` list, or any other prose below the subject.
- Trailer: `Fixes #N` or `Closes #N` if the group is associated with a GitHub issue. This issue trailer is the only content permitted below the subject line.

### Cross-feature shared files

Do not assume feature groups map to disjoint sets of files. The same file is frequently edited by **two or more different feature groups** across separate source commits. Detect this **before** finalizing the plan, because it changes how the rebuild must be executed (Step 7).

Detect shared files: for every file changed on the branch, list which source commits touched it. Any file touched by commits that you've assigned to *different* result groups is a **cross-feature shared file**.

```bash
# For each changed file, show the source commits that touched it.
# A file listed under commits from different feature groups is shared.
for f in $(git diff --name-only main..HEAD); do
  echo "=== $f ==="
  git log main..HEAD --oneline -- "$f"
done
```

**Default policy: hunk-level precise split.** A shared file's individual hunks belong to the feature that introduced them. Do **not** assign the whole file to one feature: the final file state is the union of every feature's hunks, so a whole-file assignment leaves the other features' commits missing their contribution and produces logically wrong commits. Each hunk rides in the commit of the feature that authored it.

This is the correct default attribution. The deeper reason: when two genuinely different features both edit the same file, the final file content contains both features' changes; only hunk-level splitting attributes each change to the right commit. Whole-file or "latest-commit-wins" path-staging cannot do this — as a **default**, **do not** stage a shared file whole into one feature's commit; that scatters a feature's hunks into unrelated commits. Use the soft-reset rebuild + `git add -p` hunk-staging method in Step 7.

### Exception: impossibly-interleaved shared files → whole-file to last-toucher

Hunk-splitting is achievable only when a file's per-feature hunks can be laid down in a single linear feature order. When features were developed **interleaved** — the normal case in this repo — a hot shared file can carry a **cyclic** feature sequence in history: feature A edits it, then B, then A again (history order `… A … B … A …`). No linear ordering of feature commits preserves authorship order for such a file, so clean per-feature hunk attribution is **mathematically unachievable by replay**; forcing it requires hand-resolved 3-way surgery on a known-target tree, where every manual resolution risks a silently-wrong tree.

For any shared file where hunk-splitting is either impossible (cyclic sequence) or low-value and high-risk (a **generated** file such as `ios/IonRemote.xcodeproj/project.pbxproj`, or a mechanically-formatted lock/manifest file), use **whole-file to last-toucher**: the file's final content lands, in full, in the commit of the **last feature (in result-commit order) that touches it**; earlier features do not carry it. This is deterministic, conflict-free, and its final tree is guaranteed correct by construction — the Step 8 `git diff backup--{branch_name}` identity check proves it.

This exception is safe for versioning because **every file lives in exactly one scope directory**, so whole-file placement never moves a file across scopes — it only chooses *which feature's commit within that scope* carries it. The versioning-critical rule (no *code* file under a mismatched scope) is untouched. A consequence to expect: a feature whose entire contribution to a scope was edits to shared files may **collapse** — that scope's commit disappears because a later feature now owns those files wholesale. That is correct, not a defect; note it in the plan.

Decision rule when planning: hunk-split shared files whose feature sequence is **linear** (contiguous per feature) and where attribution has review value; use **whole-file to last-toucher** for shared files that are cyclic, generated, or low-value/high-risk.

Note in the plan which files are shared and, for each, whether its hunks are split per feature or the whole file rides with its last-toucher, so the user sees the attribution before approving.

Present the squash plan to the user. **Output the structured block only — no narrative, no reasoning, no commentary before or after the block.** The user wants the outcome, not the analysis.

```
{N} source commits → {F} features → {M} result commits. {squash count} squash(es), {split count} split(s).

Features (counting unit — one line per feature, regardless of scope span):
  1. {feature description} — scopes: {engine, desktop, ios, relay, docs}   [{source SHAs}]
  2. {feature description} — scopes: {desktop}                             [{source SHAs}]
  ...

Result commits (physical unit — one per code scope per feature; docs ride with their feature):
  1. {proposed commit subject}        [feature 1] [{source SHAs}]
  2. {proposed commit subject}        [feature 1] [{source SHAs}]
  ...

Shared files (attribution):
  hunk-split:      {file}: feature X owns hunks A-B, feature Y owns hunks C-D
  last-toucher:    {file}: whole file → feature Z (cyclic|generated|low-value)
  (omit this section if no shared files exist)

Collapsed scope commits (feature touched the scope only via shared files a later feature now owns):
  {feature} {scope}: collapses into {later feature}
  (omit if none)

Backup: backup--{branch_name} at {HEAD SHA}
```

After presenting the plan, call `AskUserQuestion` with the question "Proceed with the squash as planned?" and options: `Proceed`, `Adjust`, `Abort`. Do not begin the rebuild until the user selects `Proceed`.

---

## Step 7: Execute the squash

When the user selects `Proceed` (or after making any requested adjustments to the plan):

### Method: rebuild from a soft reset, do not replay history

**The execution method is `git reset --soft main` followed by rebuilding each result commit forward in plan order. This is the primary method, not a fallback.** Do **not** use `git rebase -i main` to replay and squash the original commits.

This is a deliberate choice grounded in how this repository works. Nearly all work here is **interleaved multi-scope features**: a single feature touches `engine/`, `desktop/`, `ios/`, `relay/`, and `docs/`, and several features in flight at once edit the **same merge-hostile files** — `ios/IonRemote.xcodeproj/project.pbxproj`, `desktop/src/main/remote/protocol.ts`, the Go event/type files, the iOS event-handler switches. An interactive rebase *replays* the original commits in a new order, so it stops to hand-resolve a conflict in those shared files at nearly every reorder boundary — dozens of error-prone manual resolutions, each a chance to silently corrupt the tree. The soft-reset rebuild **reorders nothing and replays nothing**: the final tree is already correct on the branch tip, so you reset the branch pointer back to `main` with the working tree untouched, then carve that single known-correct tree into clean commits moving forward. There are no conflicts to resolve because there is no replay. The Step 8 `git diff backup--{branch_name}` check proves the rebuild reproduced the tip tree exactly.

Execute:

```bash
git reset --soft main
```

This moves the branch pointer to `main` and stages every net change from the whole branch, with the working tree byte-identical to the pre-squash tip. Nothing is lost; the backup branch holds the original history regardless.

Now build the result commits **in plan order (oldest feature first)**. The staging index currently holds everything; you will unstage it and add back precisely what each commit owns:

```bash
git reset            # unstage everything; working tree still identical to tip
```

For each result commit in the plan, in order:

1. **Stage exactly the files/hunks this commit owns:**
   - **Single-owner files** (touched by only one result commit): `git add <path>` — whole file.
   - **Cross-feature shared files** (touched by multiple result commits, detected in Step 6): `git add -p <path>` — interactively stage **only** this commit's hunks. Use `s` to split a hunk and `e` to hand-edit when this commit's changes are adjacent to another commit's. The remaining hunks stay unstaged for the commits that own them.
2. **Verify the staged slice matches the intended scope** before committing:
   ```bash
   git diff --cached --name-only | awk -F/ '{print $1}' | sort -u
   ```
   A code-scoped commit's staged files must all sit under that one code directory (docs may ride along — see the scope rules). If anything foreign is staged, `git restore --staged <path>` it before committing.
3. **Commit with the clean conventional subject from the plan:**
   ```bash
   git commit -m "type(scope): subject (#N)"
   ```
   Subject-only, per the hard rules. Add a `Fixes #N` / `Closes #N` trailer only when the feature is issue-associated (on the primary scope's commit).

Repeat until the index and working tree are empty. If `git status` shows any remaining tracked changes after the last planned commit, a hunk or file was missed — do not force it into an unrelated commit; find which result commit owns it and correct the sequence.

### Scope split is mechanical here, not a special case

Because you are building commits forward from a clean tree, a multi-scope feature is not a commit to be "split after the fact" — you simply stage and commit each scope's slice as its own commit in sequence:

```bash
git add engine/ ...   && git commit -m "feat(engine): ..."   # engine slice (+ its feature docs)
git add desktop/ ...  && git commit -m "feat(desktop): ..."  # desktop slice
git add ios/ ...      && git commit -m "feat(ios): ..."      # iOS slice
git add relay/ ...    && git commit -m "feat(relay): ..."    # relay slice
```

Feature documentation may ride with any one of the feature's scope commits (documentation is versioning-inert — see the scope rules). Root-level config/build files (`Makefile`, `.github/`, `scripts/`, `.ion/`) that are not feature docs get their own `chore(repo)` / `feat(ci)` commit. Issue references (`(#N)`) stay on all of a feature's scope commits so GitHub cross-links work; `Closes #N` / `Fixes #N` goes only on the primary scope commit.

### Cross-feature shared files: attribution by the Step 6 treatment

A file edited by two or more features (detected in Step 6) carries one of two treatments, decided in the plan:

**Linear/high-value files → hunk-split.** Divide the file's hunks between those features' commits; each hunk rides in the commit of the feature that authored it. Because commits are built forward in feature order, `git add -p <shared-file>` at each feature's turn stages only that feature's hunks; the rest wait in the working tree for later features. By the last feature that touches the file, its remaining hunks are all that's left to stage. **Attribute by authorship, never by "whoever staged it last."**

**Cyclic/generated/low-value files → whole-file to last-toucher.** Do not attempt to hunk-split. Leave the file unstaged at every earlier feature's turn; when the **last feature (in result-commit order) that touches it** builds its commit, stage the whole file (`git add <path>`). Its content is already the final version in the working tree (the rebuild started from a tree identical to the tip), so a whole-file `git add` lands exactly the target content. A deletion vs `main` is staged with `git rm <path>` at its last-toucher's turn instead.

Whichever treatment a file takes, attribution changes only *which commit* owns the content; it never changes the final tree, which the Step 8 `git diff backup--{branch_name}` identity check guarantees. If applying the last-toucher rule empties a feature's scope slice (every file it would have carried is now owned by a later feature), that scope commit **collapses** — do not create an empty commit; the feature simply produces fewer scoped commits than it touched scopes.

### Unscripted method forks during execution

If hunk attribution is genuinely ambiguous (a single hunk plausibly belongs to two features) or any situation surfaces a real strategy choice, do **not** proceed on a silent default. Stop and call `AskUserQuestion` with the specific choice and options. The interaction rule applies here exactly as it does at scripted gates. Never invent code to resolve an ambiguity — the source commits and their messages are ground truth for what each hunk was for.

### Unscripted method forks during execution

If hunk attribution is genuinely ambiguous (a single hunk plausibly belongs to two features) or any situation surfaces a real strategy choice, do **not** proceed on a silent default. Stop and call `AskUserQuestion` with the specific choice and options. The interaction rule applies here exactly as it does at scripted gates. Never invent code to resolve an ambiguity — the source commits and their messages are ground truth for what each hunk was for.

---

## Step 8: Verify

After the rebuild is complete:

```bash
git log main..HEAD --oneline
```

Verify the output matches the squash plan: correct number of commits, correct subjects.

```bash
git log main..HEAD --format=fuller
```

Verify trailers are present on each commit that had an issue association.

### Verify scope isolation

Run the scope check against every result commit:

```bash
for sha in $(git log main..HEAD --format="%H"); do
  subject=$(git log -1 --format="%s" $sha)
  scope=$(echo "$subject" | sed 's/[^(]*(\([^)]*\)).*/\1/')
  dirs=$(git diff-tree --no-commit-id --name-only -r $sha | awk -F/ '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "$scope | $dirs | $(echo $sha | cut -c1-8) $subject"
done
```

Apply the pass condition by file type, not by raw directory count:

- A commit containing a versioned-component **code** file (`engine/`, `desktop/`, `ios/`, `relay/`) under a **mismatched** scope **fails** — go back and split it (Step 7). This is the only scope violation that matters.
- A feature commit that also carries its own `docs/` file (e.g. `engine | docs,engine`) **passes** — feature documentation legitimately rides with its feature.
- A standalone `docs(repo)` commit spanning multiple directories (e.g. the `AGENTS.md` collapse) **passes** — documentation is versioning-inert.

The script flagging a docs-bearing feature commit or a multi-directory documentation commit as multi-dir is **expected**, not a failure. Only a code file under the wrong scope blocks completion.

### Verify tree identity

The final tree must be identical to the pre-squash tree:

```bash
git diff backup--{branch_name}
```

If this produces any output, the squash changed the code — which is a bug. Abort and investigate.

---

**Output contract: no narrative.** Every step of this command emits only structured output — commit lists, tool calls, and the templates below. Do not narrate analysis, reasoning, or intermediate findings as prose. The user reads the result, not the process.

---

## Step 9: Report

```
Squash complete.

Branch: {branch name}
Before: {N} commits  After: {M} commits ({F} features across {M} scoped commits)

{short SHA} {subject}
{short SHA} {subject}
...

Backup: backup--{branch_name} at {SHA}
```
