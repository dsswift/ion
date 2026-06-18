# Ion Project Commands

This directory contains project-level slash commands for Ion development. These commands are available to anyone who clones the repo.

## How commands work

Type `/{filename}` (without `.md` extension) in any Ion session with this repo as the working directory. The engine resolves project-level commands from `.ion/commands/` automatically.

## Commands

### `/align`

Context-aware alignment gate. In plan mode (after `/spec`): audits the current plan against Ion's architectural principles, then updates the plan with the alignment amendments. Outside plan mode: reviews all branch changes against Ion quality standards as a pre-PR gate, then enters planning mode and authors a fix plan for the findings. Supports PR mode (`in PR #N`), branch mode (`in branch <name>`), and optional focus narrowing. Never edits source files — the only file it writes is a plan.

### `/create-pr`

Push the current feature branch and open a pull request into `main`. Generates a structured PR title and description derived from the branch's commits and issue references. Validates the branch is not `main`, checks for uncommitted work, and handles existing open PRs gracefully.

### `/create-issue`

Open a GitHub issue on the `dsswift/ion` repository based on the current conversation. Handles confidentiality scrubbing to ensure no consumer project details leak into the public issue. Presents a draft for review before creating. Includes plan-mode integration to partition engine work from other plan items when an issue is filed mid-plan.

### `/squash`

Collapse the current branch's commits into clean conventional commits. Creates a backup branch first, analyzes commit messages to identify logical groupings, presents a squash plan for review, then executes the rebase. Does not push.

### `/resolve-dependabot-prs`

Triage the repo's open Dependabot PRs. Runs a read-only analysis pass and returns a terse risk/action summary table, with notes only on special cases (a required follow-up PR, or a close-as-too-risky recommendation). Then enters planning mode and authors an ordered rebase → merge → follow-up → resume resolution plan for the user to review and approve before any merge happens. The command itself never merges, rebases, closes, comments, or pushes — those steps execute only after the plan is approved.
