---
title: Windows VM Testing
description: Diagnosing a Windows CI failure on the local Windows VM.
sidebar_position: 8
---

# Windows VM Testing

**This section applies only when a Windows VM is open for testing.** Ordinary
development and testing happen on macOS and never involve the VM. Nothing here
fires unless the conversation is actively exercising Windows behavior on a live
machine.

## When to reach for the VM

A local (macOS) test run cannot prove a Windows-specific fix works. Two
failure classes are invisible on macOS by construction:

- **Windows-only code paths** (no `/bin/sh`, backslash vs. forward-slash
  paths, short-form `RUNNER~1`-style paths, PowerShell instead of a POSIX
  shell). The bug never triggers on macOS because the code path itself
  doesn't exist there.
- **Contention-driven timeouts.** Windows CI runs the full suite at once
  under the race detector, so hundreds of tests spawn `git`/`node`/
  `powershell` subprocesses concurrently on one machine. Running the single
  failing test in isolation — on macOS or on the VM — never recreates that
  pile-up, so a passing isolated run does not prove the timeout won't
  recur under real CI load.

**Use the local Windows VM (Parallels, reachable over SSH) specifically to
diagnose a Windows CI/CD failure when a macOS run cannot verify the fix** —
confirm the failing test/behavior reproduces there, apply the fix, confirm
it now passes there. This is a diagnostic tool for a specific failure, not a
routine step: **do not build or run the Windows test suite on the VM for
every Windows-touching change.** Reach for it only when CI has already
failed on Windows and the fix needs Windows-real verification before you
call it done. For contention timeouts specifically, running the isolated
test on the VM still won't recreate CI's full-suite pile-up — say so rather
than implying an isolated VM pass proves the timeout is gone for good.

When it does apply, the rule is absolute:

> **Run `make sync-windows-vm` before every VM build. No exceptions, no
> per-file copies.**

The VM builds from `C:\dev\ion`, which is a *copy*, not a checkout. It has no
git remote and pulls nothing. Every change made on the Mac reaches it only
because someone pushed it there, and a build that runs against a stale copy
produces a result that looks authoritative and is worthless.

## Why a hand-picked file list is forbidden

`scp`-ing the files you just edited is the obvious shortcut and it is the exact
thing that fails. Twice in one session it produced a false negative:

- A fix was committed, verified on macOS, and reported done. The VM was never
  updated, the operator's agent retested, and it reported the defect unfixed —
  correctly, because it was measuring the previous binary.
- The second occurrence exposed a longer-running drift: the VM's tree was
  missing a source file that **predated the branch entirely**. Per-file copying
  had been leaving it inconsistent for an unknown number of iterations, so even
  a correct diff-based sync would not have repaired it.

`git diff` names only what the current branch touched. It cannot name what an
earlier partial sync missed. That is why the sync ships every tracked file
under the roots named in `scripts/sync-windows-vm.sh` (the engine, the Studio
server, the workspace packages, the desktop, packaging, scripts, the CI workflows, and the npm
workspace root) every time — a few seconds of transfer in exchange for
eliminating the failure mode.

The same holds in reverse for a file deleted from git. Extraction never
deletes, so after it the sync prunes each source folder it names
(`PRUNE_ROOTS`) to exactly the tracked set, leaving dependency and build
folders alone. Without that, a test deleted on the Mac keeps running on the
VM against code that no longer exists.

## The loop

```bash
make sync-windows-vm                                    # always first
ssh <vm> 'cd C:\dev\ion; .\make.ps1 installer'         # build there
```

Then verify the artifact carries the change before asking anyone to test it:

```bash
# Does the built engine actually contain the fix?
ssh <vm> 'powershell -NoProfile -Command "Select-String -Path \"C:\dev\ion\desktop\release\win-arm64-unpacked\resources\engine\ion.exe\" -Pattern <a-string-your-change-added> -SimpleMatch -Quiet"'
```

**A source-level check is not verification.** Confirming the code is right in
`git`, or that a macro is present in a script, says nothing about what the
packaged binary contains. Grep the built artifact for a string your change
introduced. This session shipped four consecutive "fixed" reports for the
installer status text that displayed nothing, each verified at the source level
only.

### Build and install in one step

When the VM is a host in your [fleet](../deployment/fleet.md), `ion fleet deploy <vm> --source .` does the sync, the build, and the install: it ships this checkout as it is in the working tree (new files included) with the same sync stamp, builds with `make.ps1 installer` in the host's `buildDir` (a folder Defender excludes, such as one under `C:\dev\ion`) on the VM, fetches the installer back to `~/.ion/fleet/artifacts/`, and installs it silently for every user. The grep above still applies, against the installed `C:\Program Files\Ion\resources\engine\ion.exe`.

## Running the release smoke test on the VM

`make smoke-windows-vm` runs `scripts/ci/windows-smoke.ps1`, the smoke test the release build runs, on the VM against this checkout. It syncs, builds the installer there, stamps the Intune detection script, and runs the smoke test. Before and after, `scripts/windows/Reset-IonTestState.ps1` returns the machine to "Ion was never installed", so every run is a true first launch. When a run fails, the engine, desktop, and server logs come back to `build/windows-smoke-logs/`. It publishes nothing.

The VM runs with UAC off (`EnableLUA=0`), as the GitHub-hosted runners do. With UAC on, the elevated SSH session launches Ion elevated, the unelevated engine task cannot open the elevated desktop to verify it, and the engine rejects every connection, which CI never sees.

To reproduce a release-only failure in CI instead, dispatch the Build workflow with `dry_run` and the branch as `ref`.

## Reporting a result

Before you call a VM fix done, confirm the built binary carries your change
(grep it for your marker, as above). "The fix is in the source" is not a result.
Tell the operator in one plain line which build you tested and that the retest
passes; the build time and marker are evidence for you, not for the report.
When the operator's agent reports a defect as unfixed, **check whether the VM
has the fix before re-diagnosing** — that check takes one command and would
have saved two full diagnostic rounds here.
