---
description: Context-aware alignment. In plan mode it audits the active plan and folds the amendments in. Otherwise it reviews the branch, a named branch, or a pull request against Ion's principles, authors a fix plan, and after approval implements and commits the fixes.
allowed_bash_commands: [ls, stat, git, gh pr view, gh pr diff, gh pr list, gh pr checks, gh pr checkout]
---

# /align

**ARGS** means the raw arguments of this invocation:

```
$ARGUMENTS
```

An empty block means no arguments were passed.

`/align` has two modes.

| Mode | Runs when | Reviews | Writes |
|---|---|---|---|
| **A: Plan Alignment** | The conversation is in plan mode | The plan, before any code exists | The plan file only |
| **B: Post-Changes Alignment** | Everything else | A diff: the local branch, a named branch, or a pull request | A fix plan, then after approval the fixes and their commits |

## Limits

These hold in both modes.

1. **Review the whole target.** Mode and ARGS set the review surface. Size never does. A large diff produces a large report. The only narrowing is a focus or a target the operator typed in ARGS, so there is never a question to ask about scope.
2. **Review content, not commit shape or PR lifecycle.** `/squash` owns commit partitioning. `/create-pr` owns the pull request. The operator invokes both. No finding, amendment, recommendation, plan step, or open item sends the operator to either one, asks for a merge strategy, or asks for commits to be split, reordered, or squashed.
3. **No remote writes.** No `git push`, no `gh pr create`, `gh pr merge`, `gh pr review`, or `gh pr comment`.
4. **No history reshaping.** Commit count, order, and scope seams stay as they are. The one permitted rewrite is the amend delivery in B-Step 6.
5. **No commit before approval.** Mode A never commits. Mode B commits only after the operator approves its fix plan.
6. **One report.** The analysis is a single markdown report in this chat. The plan write follows it.

## Pick the mode

Decide once, when the command fires. Use the first row that matches.

| ARGS or state | Mode |
|---|---|
| ARGS is only PR references, or starts with `in PR` | B, PR mode |
| ARGS starts with `in branch` | B, Branch mode |
| Plan mode is active | A |
| Anything else | B, Local mode |

A PR reference is `287`, `#287`, `PR 287`, `PR #287`, or a list of these separated by commas or spaces. A PR or branch target wins over plan mode and over the state of the local checkout, because the operator named what to review.

Mode B enters plan mode itself in B-Step 5. That happens after detection and does not change the mode.

## Grounding

Read the root `AGENTS.md` on every run. Its § "Engine consumers" governs every engine finding.

Read the `AGENTS.md` of each component in scope: `engine/`, `server/`, `desktop/`, `ios/`. The relay and the shared packages have none; the root file governs them.

Read each doc below when its trigger matches the plan or the diff. Read it on this run, even if an earlier session read it.

| Trigger | Read |
|---|---|
| `engine/` is in scope | `docs/engine-grounding.md` |
| Engine or extension surface | `docs/architecture/adr/001-engine-vs-harness.md` |
| Events, agent lifecycle, snapshot semantics | `docs/architecture/agent-state.md`, `docs/protocol/normalized-events.md` |
| `server/`, Environments, the desktop as a client | `docs/architecture/adr/033-ion-studio-server-and-environments.md` |
| Auth, tenancy, per-principal visibility | `docs/architecture/adr/034-principal-isolation-and-tenancy.md` |
| Studio wire members or fixtures | `docs/architecture/adr/035-one-wire.md`, `docs/protocol/studio-wire.md` |
| Transcripts, iOS or thin-view rendering | `docs/architecture/adr/036-thin-clients-render-the-server-transcript.md` |
| Wire or event naming | `docs/architecture/adr/008-wire-event-naming-and-ownership.md` |
| Studio extension points | `docs/extensions/studio-sdk.md` |
| Hooks or the extension SDK | `docs/hooks/reference.md` |
| Tool instructions or tool definitions | `docs/architecture/adr/017-opinionless-tool-instructions.md` |
| Provider routing or backend selection | `docs/architecture/hybrid-backend.md` |
| Logging surface | `docs/architecture/adr/019-logging-architecture-and-standards.md`, `docs/observability/log-schema.md` |
| Files added, or a touched file near its cap | `docs/architecture/file-organization.md` |
| A new shared concept or name | `docs/vocabulary/terms.json` |

A check that looks beyond the diff is a targeted search for one symbol (`graphify explain "<symbol>"`, or a grep). It is never a sweep of the codebase.

## What counts as a resolution

A plan entry (Mode A) or a fix (Mode B) resolves a finding only when it is one of these:

1. **Code change.** Named files, with the change described.
2. **Contract change.** A wire member, type, or hook signature, with the rationale the contract rules require.
3. **Code deletion.** Dead surface removed.
4. **Test.** A named test with the assertion that pins the behavior.
5. **Decision to change nothing.** Stated plainly, with the reason.

Anything that records the defect and leaves it in place is not a resolution. That covers a `TODO`, `FIXME`, `HACK`, or `XXX` marker; a comment that explains a known fragility; a follow-up issue; a warning log on the bad path; a "later phase"; and a note in the PR description. Flag every one of these in a plan, and never write one into a fix plan.

A finding about a commit message is resolved by correcting that message.

## Dimensions

Both modes review the same dimensions. Mode A reads the plan. Mode B reads the diff.

Tag each finding **BLOCKER**, **CONCERN**, or **NIT**. Every finding carries a citation: the plan section (Mode A), or the file and line range or commit SHA (Mode B). A claim with no citation is dropped.

### 1. Layer choice

Every change belongs to one layer: engine, server, harness, or client (root `AGENTS.md` § "Layered architecture").

For each engine change, write one sentence that answers: why is this in the engine and not in the server, the harness, or a client? In Mode B, an engine commit with no answer in its diff is a BLOCKER.

Judge engine surface by the question "would a plausible external consumer want this?" New engine surface with no caller in this repo is the expected state (root `AGENTS.md` § "Engine consumers"). Remove any finding that rests on whether the desktop, the server, or iOS uses it.

Flag:

- Engine code keyed on who the consumer is.
- UI words in engine code, comments, or docs: tab, panel, render, highlight.
- Engine code that waits on a person at the socket, persists preferences, or reads them at runtime.
- A policy hardcoded in an engine package: which agent loads, delegation routing, retention.
- A hook payload shaped for one renderer.
- An engine feature with one fixed behavior, no config field, and no hook or SDK seam (§ "Opinionless mechanics, extensible opinions").
- A signal surfaced twice: a typed `NormalizedEvent` plus stream content, a synthetic system message, or a log line (§ "The typed-event corollary").
- An engine change that only covers for a gap the consumer could close.
- Session, store, or orchestration logic in `desktop/src/main`. It belongs in `server/`.
- A store action that reaches outside the store without going through `server/src/store/host-api-*.ts`, or an Electron import under `server/src/store/`.
- A multi-step flow written as a component handler. It is one store action (`desktop/AGENTS.md` § "Studio shell rules").
- A Studio extension point added to the engine SDK. It belongs in `packages/studio-sdk/`, and a Studio capability changes no file under `engine/`.
- A setting with no scope in `packages/shared/src/settings-registry.ts`, or a remote server that narrows a visiting desktop's own UI (§ "Two enterprise policies").

### 2. Contract impact

The engine wire is scrutinized. Its surfaces are `engine/internal/protocol/`, `engine/internal/types/`, and `engine/internal/extension/sdk_*.go`. These are BLOCKERs:

- A removed or renamed field, type, constant, hook, or event variant.
- A retyped field.
- Reordered positional arguments in an SDK callback.
- A non-additive payload change on an existing hook.
- A change to framing or envelope structure.
- A change to event semantics with the shape unchanged, such as snapshot to incremental.
- A shared type changed without the regenerated manifest in the same commit: `cd engine && go test ./internal/types/ -run TestContractManifest -update`.
- A new wire member without its owner's prefix: `engine_`, `desktop_`, or `ion-studio.` (ADR-008).

The Studio wire is lockstep. A rename there is conforming when one change updates every side: `packages/shared/src/studio-wire/`, `server/src/remote/protocol.ts`, the iOS `RemoteCommand.swift` and `NormalizedEvent.swift` TypeKeys, `StudioTransportCommandMapping.swift`, and each handler that switches on the string. The only finding available there is a side left behind. A changed golden fixture under `packages/shared/src/studio-wire/__fixtures__` needs its version note in `docs/protocol/studio-wire.md` (`make check-studio-wire`).

### 3. Cross-platform and cross-surface completeness

Name the exact companion paths that are missing.

| Change | Companions |
|---|---|
| Shared Go type | `packages/shared/src/types-engine.ts`, `types-events.ts`, or `types-engine-event.ts`; `packages/shared/src/__tests__/contract-sync.test.ts`; the Swift model in `ios/IonRemote/Models/` and `ContractSyncTests.swift` |
| New store action | Classified in `packages/shared/src/studio-wire/actions.ts`, or `mirror-parity.test.ts` fails |
| New main-process event push | Sent through `broadcast()`, or `make check-server-parity` fails |
| New phone command | A row in `packages/shared/src/studio-wire/phone-command-map.json` |
| New setting | `SETTINGS_DEFAULTS`, the key allowlist, `StudioSettings`, and its scope (`server/AGENTS.md` § "Studio wire rules") |
| Feature on both clients | The iOS side in the same change, or a stated reason it does not apply |
| Anything visible in Studio | Present in the snapshot iOS receives, or derivable from it |
| New SDK hook or type | `docs/extensions/sdk-typescript.md`, `sdk-go.md`, `sdk-raw.md`, and `docs/hooks/reference.md` |
| New event variant or field | `docs/protocol/normalized-events.md` or `docs/protocol/server-events.md` |
| New shared concept | An entry in `docs/vocabulary/terms.json`, then `make generate-vocabulary` and `make check-vocabulary` |
| Log, span, or metric schema change | The schema version bump and every consumer under `docs/observability/` (§ "Telemetry schema moves forward") |

An engine change needs no client counterpart. That is not a parity gap.

### 4. Abstraction posture

Flag:

- A workaround where an extension point exists.
- `TODO`, `HACK`, `FIXME`, or `XXX` added. In Mode B, quote each with file and line.
- Copied blocks that belong in one helper.
- Code added to a file listed in `.file-size-allowlist.yml` or marked `@file-size-exception`. The allowlist file is the list; read it.
- Comments stripped or whitespace collapsed to fit a cap.
- New state bolted onto an existing type where a new typed concept fits.
- A no-op, pass-through, or vestigial layer kept without a cited live producer or consumer, or deleted without showing which layer is dead (§ "Dead code is not load-bearing until proven otherwise").
- A count the code determines, written into docs or comments (§ "Volatile counts").
- A comment describing behavior the code lacks (§ "Aspirational comments").

### 5. Logging

Check against root `AGENTS.md` § "Logging policy" and § "No silent failures", using the logger that section names for each surface.

- Each new operation logs its outcome with identifiers.
- Each new branch logs which side ran, on both sides.
- Each failure is handled and logged, or marked benign with a reason.

In Mode A, a plan for non-trivial behavior that names no logging is a CONCERN.

### 6. Tests

| Change | Expect |
|---|---|
| Engine behavior | A `*_test.go` or integration test. Absent is a BLOCKER. |
| Agent lifecycle | `manager_agent_lifecycle_test.go` extended |
| New hook wiring | A test that the hook fires |
| Contract change | `TestContractManifest` rerun. With no test at all, a BLOCKER. |
| Server, desktop, or shared logic | The matching `*.test.ts` |
| Bug fix | A test that fails with the fix reverted |
| New behavior | A test that pins the value: the field at the changed path, or the serialized shape of a cross-boundary field |
| Field that reaches one client through the snapshot | A test that it reaches the other, or a recorded decision that it does not apply |

A test that only proves a payload arrived is false coverage. In Mode A, "add a test" with no named file and assertion is not a test plan.

### 7. File size and organization

Caps are in root `AGENTS.md` § "File-size caps". A file over its cap is a BLOCKER unless allowlisted or marked. A file close to its cap is a CONCERN. Flag a feature spread across many folders.

### 8. Harness completeness

This dimension applies only when a named harness is the source of the bug or the consumer the feature exists for (§ "Harnesses and extensions are in scope").

- The engine or SDK mechanism ships with the harness upgrade that consumes it, committed in the harness's own tree.
- A harness that routes around a missing primitive, such as a timer for a missing schedule kind or polling for a missing event, is a finding. The fix is the engine or SDK primitive.

### 9. Necessity and correctness

For each logical change, name the consumer and say whether the change serves it: right layer, right primitive, tested, documented, additive where possible. When the honest answer is no, recommend the smaller alternative. "This belongs in the harness" and "this did not need to be done" are valid findings.

### 10. Unstated assumptions (Mode A)

List what the plan assumes and does not say: that one client is the only consumer, that an event is incremental when it is a snapshot, that a hook fires where it does not, that code is already instrumented.

### 11. Commit messages (Mode B)

Check each commit message against root `AGENTS.md` § "Commits". Legal scopes are the `scope-enum` in `commitlint.config.js`. Work from an issue needs the ` (#N)` subject suffix and a `Fixes #N` or `Closes #N` line.

## Report

The reader's cursor lands at the bottom of the output, so the verdict goes last. Render the sections in this order.

| # | Mode A | Mode B |
|---|---|---|
| 1 | Header | Header |
| 2 | What was not audited | What was not reviewed |
| 3 | Findings | Findings |
| 4 | Proposed plan amendments | Recommendations |
| 5 | ⚠️ Destructive Plan Steps | ⚠️ Destructive Recommendations |
| 6 | Critical Plan Actions Summary | Critical Actions Summary |
| 7 | Verdict | Verdict |

### 1. Header

Mode A:

```
Plan: <absolute path>
Selected by: <argument "<arg>" | conversation attachment | mtime-fallback + topic-match>
Title: <first heading of the plan>
Branch: <git branch --show-current>
Uncommitted work for this plan: yes/no
Scopes the plan touches: <scopes per .commit.json>
```

Mode B, Local and Branch:

```
Mode: local | branch
Branch: <name>
Range: {base}..<HEAD or branch> (<N> commits)
Files changed: <N>
Scopes touched: <scopes per .commit.json>
Uncommitted changes: yes/no        (Local mode only)
Focus: <quoted instruction or "none">
```

Mode B, PR: see "PR mode batch report" below.

### 2. What was not audited or reviewed

Name what was skipped or could not be evaluated: binary assets, vendored dependencies, generated files, runtime behavior that needs execution.

### 3. Findings

Group by dimension, in dimension order. A dimension with nothing to report gets the single line `No findings.`

```
🛑 [BLOCKER] 🟢 CONSTRUCTIVE — Add <one-sentence claim>
  <Plan section: | Where:> <citation>
  Why: <the principle it breaks>

🔶 [CONCERN] ⚠️ DESTRUCTIVE — Remove <one-sentence claim>
  ...

💬 [NIT] 🟢 CONSTRUCTIVE — Replace <one-sentence claim>
  ...
```

Severity is urgency. Action class is the effect on the plan or the shipped code. They are independent.

| Action class | Mode A | Mode B |
|---|---|---|
| 🟢 CONSTRUCTIVE | Add, Move, Replace, Strengthen | Add, Refactor, Fix, Document |
| ⚠️ DESTRUCTIVE | Remove, Revert planned change, Narrow planned scope | Revert, Remove feature, Narrow contract |

### 4. Amendments or recommendations

A numbered list in priority order. Each item names its finding and gives the exact change.

- Mode A: quote the plan section and write the replacement or added text, ready to apply.
- Mode B: give the command or the file change. "Regenerate the contract manifest, then mirror `StatusFields.foo` in `packages/shared/src/types-engine.ts`" is a recommendation. "Maintain contract stability" is not.

### 5. Destructive items

Omit this section when there are none.

A plan that reached `/align` is committed thinking, and code that reached it has passed its tests. Removing either costs the author real work. A destructive item must clear all four checks. If one fails, recommend a constructive alternative.

```
⚠️ Destructive <Plan Step | Recommendation> #N — <one-line summary>

What is lost:
  <the functionality, consistency, or capability that goes away>

Higher-bar justification:
  <why a constructive alternative will not do, in terms of consumer impact>

Alternatives considered:
  - <constructive alternative, and why it was rejected>

Four-check gate:
  1. Concrete failure mode: <the consumer, the failure, the repro>
  2. Constructive alternative considered: <which, and why rejected>
  3. Preserves prior investment: <yes/no, and why>
  4. Surfaced in the summary table: <yes>
```

### 6. Summary table

One row per amendment or recommendation. Destructive rows are bold.

```
| # | Severity | Action class | What | <Plan section | Files> | One-line rationale |
|---|---|---|---|---|---|
| 1 | 🛑 BLOCKER | 🟢 CONSTRUCTIVE — Add | ... | ... | ... |
| 2 | 🔶 CONCERN | ⚠️ **DESTRUCTIVE — Remove** | ... | ... | ... |
```

In Mode B with more than eight actions, put the constructive rows in their own table above section 5.

### 7. Verdict

The verdict is the last line of the report. Include the counts.

| Findings | Mode A | Mode B |
|---|---|---|
| None | ✅ **ALIGNED** | ✅ **READY** |
| Nits only | 💬 **ALIGNED WITH NITS** | 💬 **READY WITH NITS** |
| Concerns, no blockers | 🔶 **NEEDS AMENDMENT** | 🔶 **NEEDS WORK** |
| Any blocker | 🛑 **MISALIGNED** | 🛑 **BLOCKED** |

---

# Mode A: Plan Alignment

## A-Step 1: Resolve and read the plan

The plan is the one this conversation is pinned to. Several plan-mode conversations are often open at once, so the newest file on disk is often a different conversation's plan.

Use the first source that applies.

1. **ARGS.** An absolute path is used as given. A bare filename or hash, with or without `.md`, resolves under `~/.ion/plans/`. A hash prefix resolves through `~/.ion/plans/{prefix}*.md` and must match exactly one file. With zero or several matches, report the ambiguity and stop.
2. **The plan pinned in context.** One of these forms, the most recent if several appear:
   - `**Your plan file for this session: <absolute-path>**`. If the text after it says no plan file exists yet, report that there is nothing to audit and stop.
   - `[Attached plan: <path>]`
   - `Implement the following plan:` followed by the plan.
3. **Neither.** List the three newest plans with `ls -1t ~/.ion/plans/*.md | head -3` and read each first heading. Compare them with the conversation topic, the branch name, and recent commits. Use a plan only when exactly one matches, and mark it `mtime-fallback + topic-match`. Otherwise list the candidates and ask which to audit.

If no plan is found: "No plan found in `~/.ion/plans/` and no plan attachment in this conversation. Create a plan first, or pass a plan path as an argument."

Read the plan in full. Run `git branch --show-current` and `git status --porcelain`. If the file is empty, a stub, or not a plan, say so and stop.

Print a one-paragraph orientation: the plan path, its title, how it was selected, the branch, and one line on what the plan proposes.

## A-Step 2: Ground

Read the grounding docs for every component the plan touches.

## A-Step 3: Audit

Run dimensions 1 through 10 against the plan.

## A-Step 4: Report

Emit the report in the format above.

## A-Step 5: Apply the amendments

Edit the plan file.

- Apply every amendment at the section it cites. Replace the affected lines, insert the added step in place, move the moved step to its new layer.
- Keep the plan's structure and headings. Do not append a list of amendments at the end.
- For each destructive amendment, add one line at the top of the edited section that says what was removed.
- Every amendment obeys "What counts as a resolution".

The verdict and counts describe the plan as audited. Do not recompute them after the edit.

## A-Step 6: Stop

Print:

`✅ Alignment check complete — {verdict} with {N blockers, N concerns, N nits}. Plan updated with the amendments.`

> Alignment check complete and the plan has been updated with the amendments above. I have not made code changes or started implementation. Review the amended plan. If an amendment is not what you wanted, tell me to revert it; the original wording is in the findings above.

Mode A ends here. It writes the plan file and nothing else.

---

# Mode B: Post-Changes Alignment

## B-Step 1: Parse ARGS and set the scope

```
ARGS     ::= [<target>] [<focus>]
<target> ::= "in PR" <pr-list> | <pr-list> | "in branch" <branch-name> | (empty)
<pr-list>::= <pr-ref> (("," | " ") <pr-ref>)*
<pr-ref> ::= ("PR")? "#"? <positive-integer>
<focus>  ::= any remaining text
```

Apply in order to the trimmed ARGS. Prefixes are case-insensitive.

1. Empty: Local mode, no focus.
2. Only PR references: PR mode, no focus.
3. Starts with `in PR`: PR mode. The text after the last PR number is the focus.
4. Starts with `in branch`: Branch mode. The next token is the branch. The rest is the focus.
5. Anything else: Local mode, and the whole string is the focus.

A focus runs the matching dimensions at full depth and gives each other dimension a one-paragraph pass. Grounding is always read in full.

### Resolve the review base

The range is measured from `{base}`, the branch this work was cut from. A worktree is usually cut from a long-lived source branch, so measuring from `main` would pull that whole branch into the review and offer its commits as amend targets.

Look the checkout up in the worktree registry by path. For Branch mode, match on `branchName` instead of the path.

```bash
ROOT=$(git rev-parse --show-toplevel)
python3 -c "
import json, os
reg = os.path.expanduser('~/.ion/worktree-registry.json')
root = os.path.realpath('$ROOT')
try:
    entries = json.load(open(reg)).get('entries', [])
except Exception:
    entries = []
for e in entries:
    if os.path.realpath(e.get('worktreePath', '')) == root:
        print(e.get('sourceBranch') or '')
        break
"
```

- A result is `{base}`.
- No result means `{base}` is `main`.
- Verify it with `git rev-parse --verify {base}`. If the registry names a branch that does not exist, stop:

> The worktree registry names source branch `{base}`, which does not exist in this checkout. Cannot determine a safe review base. Resolve the missing branch (`git fetch`, or correct the registry) and re-run.

### Local mode

If `git branch --show-current` is `main`, stop: "Review is meaningless on `main`. Switch to a feature branch and rerun, or pass PR numbers to review specific pull requests."

```bash
git status --porcelain
git diff
git diff --staged
git log {base}..HEAD --oneline
git log {base}..HEAD --format=fuller --no-merges
git diff {base}...HEAD --stat
git diff {base}...HEAD
```

If the log is empty and the tree is clean, stop: "Nothing to align — branch is even with its base `{base}` and the working tree is clean."

### Branch mode

Verify the branch with `git rev-parse --verify <name>`, then `origin/<name>`. If both fail, stop: "Branch `<name>` not found locally or on origin."

```bash
git log {base}..<branch> --oneline
git log {base}..<branch> --format=fuller --no-merges
git diff {base}...<branch> --stat
git diff {base}...<branch>
```

The working tree is not part of a named branch, so skip `git status` and `git diff`. If the log is empty, stop: "Nothing to review — branch `<name>` is even with its base `{base}`."

### PR mode

The target is the PR's head branch as it exists on the remote. The local checkout plays no part: run no `git status`, `git diff`, or `git log` against it.

For each PR number:

1. `gh pr view <N> --json number,title,author,state,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,changedFiles,body,labels,isDraft,mergeable,mergeStateStatus,url`
2. `gh pr diff <N>`
3. `gh pr checks <N>`

A PR that fails to resolve is recorded under "What was not reviewed" and the run continues. If every PR fails, report the failures and stop.

Each failed check is a finding: a BLOCKER for a required check, a contract-sync gate, or a file-size gate, and a CONCERN otherwise. Its resolution is a fix for the root cause. Note pending checks in the header.

### Orientation

Print one paragraph: the mode, the branch or PRs, `{base}`, commits ahead, files changed, scopes touched, and the focus.

## B-Step 2: Ground

Read the grounding docs for every component the diff touches. In PR mode that is the union across the PRs, each doc read once.

## B-Step 3: Review

Run dimensions 1 through 9 and 11 against the diff.

## B-Step 4: Report

Emit the report in the format above.

### PR mode batch report

Open with:

```
Mode: pr
PRs reviewed: <N>
PR numbers: <list>
Total files changed across batch: <N>
Scopes touched across batch: <list>
Focus: <quoted instruction or "none">
```

Then one full report per PR, in the order given, with this header:

```
PR: #<N> — <title>
Author: <author>
Base → Head: <baseRefName> ← <headRefName> (<additions> additions, <deletions> deletions, <changedFiles> files)
State: <state>, draft: <isDraft>, mergeable: <mergeable> (<mergeStateStatus>)
CI: <passing | failing | pending, from gh pr checks>
URL: <url>
```

Add a **Cross-PR** section only when the PRs interact: overlapping files, contract changes that could conflict, a dependency, or a contradiction.

End with `Batch verdict:` and the most severe per-PR verdict.

## B-Step 5: Author the fix plan

Enter plan mode and author the fix plan. Plan mode creates the plan file and the approval flow.

The plan:

- Resolves every BLOCKER, CONCERN, and NIT, each by a resolution from "What counts as a resolution".
- In PR mode, names each PR's head branch and the worktree path where it will be checked out. The local branch is never the target.
- With no findings, is a short plan that says no alignment issues were found.

Print the line for the mode:

- Local: `✅ Review complete — {verdict} with {N blockers, N concerns, N nits}. Fix plan authored.`
- Branch: `✅ Branch review complete — {verdict} with {N blockers, N concerns, N nits}. Fix plan authored.`
- PR: `✅ PR review complete — {batch verdict} across {N} PRs. Fix plan authored.`

Then the handoff.

Local and Branch:

> Review complete and a fix plan has been authored. I have not edited source or committed. Once you approve the plan, I implement the fixes and land them: amended into the branch commit that introduced each defect, and as new commits for anything else. If there was nothing to fix, the plan is empty.

PR:

> Review complete and a fix plan has been authored. I have not changed these pull requests or your local branch. Once you approve the plan, I check out each PR's head branch in its own worktree, implement the fixes, and commit them on top of the PR. If there was nothing to fix, the plan is empty.

Wait for approval.

## B-Step 6: Implement and land

This step runs after the operator approves the fix plan.

### Where the fixes land

| Mode | Target |
|---|---|
| Local | The current branch |
| Branch | The named branch, checked out in its own worktree when it is not the current checkout |
| PR | The PR's head branch, in its own worktree |

PR mode, per PR:

1. `git fetch origin <headRefName>`, then `git worktree add ../ion-align-pr-<N> <headRefName>`. For a cross-fork PR, run `gh pr checkout <N>` inside a fresh worktree.
2. Commit the fixes as new commits on top of the PR's history. That history is published, so it is never amended.
3. For a CI failure, verify the fix with the scoped local equivalent of the failing check.
4. Leave the worktree in place and report its path and branch.

### Implement

1. Implement every plan step as written.
2. Run the scoped gates for what changed, from root `AGENTS.md` § "Quality gates (run while developing)" and the component's own `AGENTS.md`:

   | Touched | Gates |
   |---|---|
   | `engine/` | Scoped `go test` and `golangci-lint` for the packages |
   | `server/` | `npm -w server run typecheck`, `npm -w server run lint`, scoped `npm -w server run test -- <pattern>` |
   | `desktop/` | `npm run typecheck`, scoped `npm test -- <pattern>` |
   | `packages/shared/` | `npm -w @ion/shared run typecheck`, scoped `npm -w @ion/shared test -- <pattern>` |
   | Any code | `make check-file-sizes` |
   | A shared type | `make check-contracts` |
   | Logging | `make check-logging` |
   | A main-process event push, or desktop main's imports | `make check-server-parity` |
   | A Studio wire fixture | `make check-studio-wire` |
   | `engine_status` or `engine_session_status` emitters | `make check-status-writers` |
   | The vocabulary registry | `make check-vocabulary` |

   The heavy gates in root `AGENTS.md` § "Heavy gates" stay with `/create-pr`.
3. For a bug fix, revert the fix, watch the test fail, and restore the fix.

### Deliver

Classify each fix before landing anything.

| The defect | Delivery |
|---|---|
| Came from one commit in `{base}..HEAD` that is not on a remote | Amend that commit |
| Spans several such commits | Amend each with its own portion |
| Exists on `{base}` or `main`, or in published history | New commit |
| Is new work the plan adds | New commit at its own scope seam |

Amending keeps the history honest: the defect never appears in it, and commit count, order, and scope stay the same.

Find the originating commit from evidence: `git log {base}..HEAD --oneline -- <path>`, then `git log -L<start>,<end>:<path>` or `git blame` when several commits touched the file.

A commit is an amend target only when both checks pass:

```bash
git merge-base --is-ancestor <sha> {base} && echo "on base: new commit" || echo "branch-local"
git branch -r --contains <sha>     # any output means published: new commit
```

Amend with a fixup commit and an autosquash rebase. Run the gates first, so the amend carries a verified fix.

```bash
git add <paths>
git commit --fixup=<sha>
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <sha>^
```

When the fix changes what the commit claims, carry the new message in the same step:

```bash
git add <paths>
git commit -m "amend! <original subject>" -m "<new subject>" -m "<new body>"
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <sha>^
```

After the rebase:

- `git log {base}..HEAD --oneline` shows the same count and the same subjects, apart from a message that was updated on purpose.
- `git show --stat <new sha>` shows the fix in the amended commit.
- `git status` is clean of this run's changes, and no `.git/rebase-merge` or `.git/rebase-apply` remains.

If the rebase cannot start because the tree holds changes this run did not make, or it conflicts and cannot be resolved toward the plan's end state, run `git rebase --abort`, land the fix as a new commit, and say so in the report.

New commits follow root `AGENTS.md` § "Commits", one scope per commit.

### Report and stop

Report which commits were amended, which are new, and that the gates passed. In PR mode add the worktree path and the head branch that carry the fix commits.
