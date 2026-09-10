# Windows dev VM loop

Three scripts. `Enable-IonDevSsh.ps1` and `Bootstrap-IonDevVM.ps1` run once;
`Update-IonDev.ps1` runs after every change on the Mac.

## Step 0: open the remote channel

This is the only step that cannot be driven remotely, because it is what
creates the remote channel. In an **elevated** PowerShell on the VM:

```powershell
.\Enable-IonDevSsh.ps1 -PublicKey 'ssh-ed25519 AAAA... user@host'
```

It installs OpenSSH Server, starts it, opens the firewall port, authorizes the
key in both the per-user and the administrators file (Windows OpenSSH ignores
the per-user file for administrators), and prints the address to connect to.

Everything below can then run over SSH from the Mac.

## Getting the code into the VM

Pick one. The first needs no network setup and no push.

### 1. A custom Parallels shared folder (recommended)

Parallels can expose one Mac folder to Windows as a network location. Share the
repository and nothing else — this is the least-privilege option and the path it
produces is short and stable.

VM Settings > Options > Sharing > Share Mac, tick **Share custom Mac folders
with Windows**, then **Manage Folders...** and add the base repository. Name the
share `ion`. Some settings on that page only apply after the VM is shut down; if
the change does not take, shut the VM down and set it there.

```powershell
.\Bootstrap-IonDevVM.ps1 -Source '\\Mac\ion' -Branch <branch>
```

Every iteration afterwards is a plain `git pull` from that same path. Nothing is
pushed anywhere, and no Mac-side step is needed per change.

**Share Mac volumes with Windows** is the broader alternative: it exposes whole
disks as `\\Mac\Macintosh HD\...`, so the repository is reachable at its real
path. It works, but it hands the VM far more of the Mac than the loop needs.

#### Clone the base repository, not the worktree

Ion development happens in worktrees under `~/.ion/worktrees/`, so the obvious
move is to point the VM at the worktree directory. Do not.

A linked worktree's `.git` is a *file* holding an absolute macOS path:

```
gitdir: /path/to/ion/.git/worktrees/<name>
```

It owns no objects and no refs. Git in the VM follows that pointer, cannot
resolve a macOS path, and the clone fails.

Point at the **base repository** instead and name the worktree's branch. A
worktree branch is an ordinary ref in the shared ref store, so the base
repository already has every commit:

```
/path/to/ion/.git/refs/heads/<branch>
```

That is what `-Source <base repo> -Branch <branch>` above does. The base
repository has its own branch checked out; `--branch` selects yours regardless.

Two consequences worth knowing:

- **Only committed work crosses.** A clone reads the object store, not a
  worktree's dirty files. Commit before pulling in the VM.
- **A new worktree means a new `-Branch`.** The branch name changes per
  worktree; the `-Source` path does not.

### 2. A bundle file

Use this when the share is home-only. Note that sharing the home folder does
*not* rescue a worktree clone: the worktree directory becomes visible, but the
macOS path inside its `.git` file still does not resolve. Write a bundle into
the home folder instead — a bundle is self-contained, with its own objects and
refs:

```bash
git bundle create ~/ion-win.bundle main..HEAD
```

```powershell
.\Bootstrap-IonDevVM.ps1 -Source '\\Mac\Home\ion-win.bundle' -Branch wt/<branch>
```

Refresh it with the same `git bundle create` before each pull. One extra Mac
command per iteration, but it works with the default share.

### 3. GitHub

Once the branch is pushed:

```powershell
.\Bootstrap-IonDevVM.ps1 -Source 'https://github.com/dsswift/ion.git' -Branch <branch>
```

Slowest loop of the three — every iteration needs a push before the pull.

## Clone to a native path, never a shared folder

`-Dest` defaults to `C:\dev\ion`. Keep it on the VM's own disk. `node_modules`
on a shared folder is punishingly slow and file watching does not work across
the boundary.

## The loop

```powershell
# build the installer for whatever changed
.\packaging\windows\dev\Update-IonDev.ps1

# build it, close a running Ion, and launch the installer
.\packaging\windows\dev\Update-IonDev.ps1 -Install

# remove every trace of Ion from this machine (elevated prompt required)
.\make.ps1 uninstall
```

`uninstall` is the developer reset. It runs whichever uninstallers are
registered, then sweeps the per-machine and per-user install directories, both
uninstall registrations, the `Ion Engine` Scheduled Task and the shortcuts. It
leaves `%ProgramData%\Ion` alone, because that is administrator-authored
enterprise policy rather than application state.

It requires an elevated prompt on purpose. The installer refuses to put a
per-user copy beside a managed per-machine one, and this is the only way past
that refusal -- so gating it behind administrator rights is what keeps a
standard user on a managed device from stepping around their fleet's install,
while leaving a developer with local admin free to reset their own loop.

`Update-IonDev.ps1` owns pulling and nothing else; the build belongs to
`make.ps1` in the repository root, so there is one implementation of the build
rather than one per entry point. An earlier version carried its own copy, which
is how it came to hardcode an architecture.

Only committed work crosses. A clone reads the object store, not the Mac
worktree's files, so commit on the Mac before pulling here.

`desktop/resources/engine/` is gitignored, so `ion.exe`, the SDKs and the
Scheduled Task template never arrive with a pull. `make.ps1` stages them on
every build — that is why the VM needs Go.

Both scripts write a transcript (`bootstrap.log`, `make.log`) into the checkout,
which is what to read when the loop is driven from the Mac over SSH.

## Toolchain

`bootstrap.ps1` in the repository root installs it: Git, Go, Node.js LTS,
PowerShell 7, Python, Visual Studio Build Tools, and a global `esbuild` (which
is what the engine looks for on `PATH` and in `%APPDATA%\npm` when it transpiles
a TypeScript extension). winget resolves the host architecture itself, so
nothing takes an arch argument and the same command works on x64 and ARM64.

Python and Visual Studio Build Tools are required, and the reason is easy to
get wrong. The desktop's postinstall runs `electron-builder install-app-deps`,
which rebuilds native modules against **Electron's** ABI rather than Node's, so
node-gyp runs regardless of what the packages ship. That rebuild is not
avoidable by preferring the prebuilt binaries: `node-pty`'s are Node-ABI
specific (plain `pty.node`, fetched by its own prebuild script), and Electron's
ABI differs.

Two Visual Studio components have to be named explicitly, per target
architecture, because neither comes with the workload's recommended set:

| Component | Without it |
|---|---|
| `VC.Tools.<arch>` | `MSB8020: the build tools for v143 cannot be found` — the workload installs the x64 and x86 targets only, so ARM64 is absent on an ARM64 machine |
| `VC.Runtimes.<arch>.Spectre` | `MSB8040: Spectre-mitigated libraries are required` — `node-pty` sets the Spectre mitigation property |

`bootstrap.ps1` installs both, and refuses rather than warns if they are still
absent afterwards. Adding them to an existing Build Tools install needs the
Visual Studio Installer's `modify` verb: `winget install` on an already-present
package discards `--override` and reports success having changed nothing.

Neither macOS nor CI shows any of this. macOS already has Xcode Command Line
Tools, and the `windows-latest` runner image ships Python and Build Tools — a
bare VM is the only place the requirement is visible, which is most of the
argument for having one.

## Driving it from the Mac

Bootstrap enables OpenSSH Server and prints the VM's address. After that:

```bash
ssh <user>@<vm-ip> "pwsh -File C:\dev\ion\packaging\windows\dev\Update-IonDev.ps1 -Fast"
```

A long run needs to outlive the SSH session, and the obvious answer does not
work here. `Start-Process ... -WindowStyle Hidden` launched from an SSH session
returns a PID and then produces nothing: no output in the redirected log, no
files on disk, no error anywhere. It is indistinguishable from a script that ran
and did nothing, which is exactly how it wastes an afternoon.

Keep the SSH connection in the foreground and let the client wait:

```bash
ssh <user>@<vm-ip> 'Set-Location C:\dev\ion\desktop; npm ci'
```

If the caller must not block, background the **`ssh` client on the Mac** rather
than the process in the VM, and keep the connection alive for the whole run.

Whatever you choose, do not judge the run by an exit status. Piping a script to
`Out-String` reports success no matter what the script did, and a `Start-Process`
launch reports only that a process started. Verify the state the run was
supposed to produce -- the checkout's `git log`, the presence of `node_modules`,
the installer file, the tool versions.

## What a VM on Apple silicon does and does not prove

A Parallels VM on Apple silicon is **ARM64** Windows. Bootstrap builds natively
for it, so the loop exercises the ARM64 product end to end -- the installer, the
scheduled task, the registry identity, and the engine binary are all the real
ARM64 artifacts, not emulated ones.

What it does not prove is x64. Windows on ARM can run the x64 build under
emulation, which is worth a pass because it is what an x64-only dependency would
break on, but emulated execution is not evidence about a native x64 machine.
Native x64 proof comes from the `windows-latest` CI jobs; final sign-off needs
one real x64 machine.
