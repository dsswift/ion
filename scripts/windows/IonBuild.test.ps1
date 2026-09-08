<#
  Behaviour tests for the helpers in IonBuild.ps1.

  Runs anywhere PowerShell does, including the Linux CI runner, because every
  function under test is pure or writes only to a path the test supplies.
  Invoked by `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'IonBuild.ps1')

$script:failures = 0
function Assert-Equal {
  param($Expected, $Actual, [string] $Because)
  if ($Expected -ne $Actual) {
    Write-Host "FAIL  $Because`n      expected '$Expected', got '$Actual'" -ForegroundColor Red
    $script:failures++
  } else {
    Write-Host "ok    $Because" -ForegroundColor Green
  }
}

# ── Resolve-IonArch ──────────────────────────────────────────────────────────
# The engine binary and the installer must never disagree, so one call answers
# for both and every case is pinned.

$r = Resolve-IonArch -Requested 'auto' -HostArchitecture 'ARM64'
Assert-Equal 'arm64' $r.Arch   'auto on an ARM64 host builds arm64'
Assert-Equal 'arm64' $r.GoArch 'auto on an ARM64 host uses GOARCH=arm64'

$r = Resolve-IonArch -Requested 'auto' -HostArchitecture 'AMD64'
Assert-Equal 'x64'   $r.Arch   'auto on an x64 host builds x64'
Assert-Equal 'amd64' $r.GoArch 'auto on an x64 host uses GOARCH=amd64'

# An unknown host string must not silently produce an unbuildable target.
$r = Resolve-IonArch -Requested 'auto' -HostArchitecture ''
Assert-Equal 'x64'   $r.Arch   'auto with an unknown host falls back to x64'

# The override is what lets an ARM64 box produce the emulated x64 build.
$r = Resolve-IonArch -Requested 'x64' -HostArchitecture 'ARM64'
Assert-Equal 'x64'   $r.Arch   'an explicit x64 overrides an ARM64 host'
Assert-Equal 'amd64' $r.GoArch 'an explicit x64 carries GOARCH=amd64'

$r = Resolve-IonArch -Requested 'arm64' -HostArchitecture 'AMD64'
Assert-Equal 'arm64' $r.Arch   'an explicit arm64 overrides an x64 host'

# ── Get-IonVCComponents ──────────────────────────────────────────────────────
# Both components are required and both have been learned the hard way on a
# real machine: the VCTools workload's recommended set installs the x64/x86
# target compilers only (ARM64 absent -> MSB8020), and node-pty sets the
# Spectre mitigation property (no Spectre runtimes -> MSB8040). Naming the
# wrong set produces a Build Tools install that reports complete and then fails
# inside MSBuild, which is the failure this mapping exists to prevent.

$arm = Get-IonVCComponents -Arch 'arm64'
Assert-Equal 2 $arm.Count 'arm64 requires two VC components'
Assert-Equal $true ($arm -contains 'Microsoft.VisualStudio.Component.VC.Tools.ARM64') `
  'arm64 requires the ARM64 target compiler'
Assert-Equal $true ($arm -contains 'Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre') `
  'arm64 requires the ARM64 Spectre-mitigated runtimes'

$x64 = Get-IonVCComponents -Arch 'x64'
Assert-Equal 2 $x64.Count 'x64 requires two VC components'
Assert-Equal $true ($x64 -contains 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64') `
  'x64 requires the x86.x64 target compiler'
Assert-Equal $true ($x64 -contains 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre') `
  'x64 requires the x64 Spectre-mitigated runtimes'

# The two sets must not overlap: installing the x64 set on an ARM64 machine is
# exactly the bug that let setup be skipped and MSBuild fail.
Assert-Equal 0 (@($arm | Where-Object { $x64 -contains $_ }).Count) `
  'the arm64 and x64 component sets are disjoint'

# ── Set-IonEngineLogLevel ────────────────────────────────────────────────────
# This writes the operator's real engine config, so the destructive cases are
# the ones worth pinning: it must not drop their other settings, and it must
# not overwrite a file it failed to understand.

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-ps-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path (Join-Path $sandbox '.ion') -Force | Out-Null
$savedProfile = $env:USERPROFILE
$env:USERPROFILE = $sandbox
$configPath = Join-Path $sandbox '.ion\engine.json'

try {
  # Existing keys survive.
  '{"logLevel":"info","modelId":"claude-opus-5","nested":{"a":1}}' | Set-Content $configPath -Encoding utf8
  Set-IonEngineLogLevel -Level 'debug' | Out-Null
  $after = Get-Content $configPath -Raw | ConvertFrom-Json
  Assert-Equal 'debug'          $after.logLevel  'logLevel is raised to debug'
  Assert-Equal 'claude-opus-5'  $after.modelId   'an unrelated key survives the write'
  Assert-Equal 1                $after.nested.a  'a nested value survives the write'

  # A file that does not parse is left exactly as it was. Overwriting an
  # operator config to fix a log level would be a poor trade.
  $garbage = '{ this is not json'
  $garbage | Set-Content $configPath -Encoding utf8
  Set-IonEngineLogLevel -Level 'debug' | Out-Null
  Assert-Equal $garbage ((Get-Content $configPath -Raw).Trim()) 'unparseable config is left untouched'

  # No file at all is the fresh-machine case.
  Remove-Item $configPath -Force
  Set-IonEngineLogLevel -Level 'debug' | Out-Null
  $created = Get-Content $configPath -Raw | ConvertFrom-Json
  Assert-Equal 'debug' $created.logLevel 'a missing config is created with the level set'
} finally {
  $env:USERPROFILE = $savedProfile
  Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Invoke-IonNative ─────────────────────────────────────────────────────────
# Success is the exit code, never the presence of stderr output. Go, npm and
# electron-builder all write progress to stderr; treating that as failure broke
# a build on the line `go: downloading golang.org/x/sys`.
#
# Only Windows PowerShell 5.1 turns that stderr line into a terminating error
# under $ErrorActionPreference = 'Stop'; pwsh 7 does not, so this case passes
# either way on macOS and Linux and only distinguishes fixed from broken when
# the CI Windows leg runs it under powershell.exe.

Start-IonLog -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("ion-native-" + [guid]::NewGuid() + '.log')) -Title 'native'

# $IsWindows is PowerShell 6+; this file must also run under Windows
# PowerShell 5.1, which is where the stderr behaviour below actually bites.
$onWindows = ($env:OS -eq 'Windows_NT')

$ErrorActionPreference = 'Stop'
$shell  = if ($onWindows) { 'cmd.exe' } else { 'bash' }
$noisy  = if ($onWindows) { @('/c', 'echo progress 1>&2 & exit 0') } else { @('-c', 'echo progress >&2; exit 0') }

$threw = $false
try {
  Invoke-IonNative $shell $noisy | Out-Null
} catch {
  $threw = $true
}
Assert-Equal $false $threw 'stderr output on a zero exit is not a failure'

# And a real failure must still be one, or nothing in the build is trustworthy.
$failing = if ($onWindows) { @('/c', 'exit 3') } else { @('-c', 'exit 3') }
$threw = $false
try {
  Invoke-IonNative $shell $failing | Out-Null
} catch {
  $threw = $true
}
Assert-Equal $true $threw 'a non-zero exit throws'

# AllowFailure returns the code instead of throwing, for optional steps.
$code = Invoke-IonNative $shell $failing -AllowFailure
Assert-Equal 3 $code 'AllowFailure returns the exit code'

# npm, vite and electron-builder write UTF-8 checkmarks/box-drawing characters
# to stdout. Node reproduces that exactly: when its stdout is not a TTY (a
# redirected pipe, same as here) it always writes UTF-8, regardless of the
# console's own codepage. If Invoke-IonNative decodes that byte stream using
# the console codepage instead of UTF-8, a checkmark comes back as mojibake
# instead of the real character -- this is the "OK" -> "ГЁô" bug. The
# checkmark is built from its code point on both sides (in the node script
# and in the comparison) so this file never has to carry a literal non-ASCII
# byte -- this file must also parse correctly under Windows PowerShell 5.1,
# which reads a BOM-less script using the system ANSI codepage, not UTF-8.
#
# Like the stderr case above, the console-codepage bug this pins is
# Windows-only: macOS and Linux decode a native command's output as UTF-8
# regardless, so this case passes on both the fixed and the broken
# implementation there and only distinguishes the two on the Windows CI legs.
$utf8LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-native-utf8-" + [guid]::NewGuid() + '.log')
Start-IonLog -Path $utf8LogPath -Title 'utf8'
Invoke-IonNative 'node' @('-e', 'process.stdout.write("checkmark:" + String.fromCharCode(0x2713) + ":end\n")') | Out-Null
$logged = Get-Content $utf8LogPath -Raw -Encoding utf8
Assert-Equal $true ($logged.Contains('checkmark:' + [char]0x2713 + ':end')) 'a UTF-8 checkmark from a native command decodes correctly, not mojibake'

# -- Child output sanitising --------------------------------------------------
# npm, vite and electron-builder emit SGR colour codes whenever they believe a
# terminal is attached, and they believe it even when their stdout is a
# redirected pipe. Windows PowerShell 5.1 has no virtual-terminal processing
# enabled by default, so those bytes are printed rather than interpreted: the
# operator sees "<ESC>[32m" wrapped around every line, and make.log carries
# them into whatever reads it later.
#
# The escape character is built from its code point rather than written
# literally, for the same reason as the checkmark above: this file must parse
# under Windows PowerShell 5.1, which reads a BOM-less script as ANSI.
$esc = [char]27

$coloured = "$esc[32m" + [char]0x2713 + "$esc[39m 489 modules transformed."
$stripped = Remove-IonAnsi $coloured
Assert-Equal $false ($stripped -match [regex]::Escape($esc)) 'SGR colour codes are stripped from child output'
Assert-Equal $true ($stripped.Contains([char]0x2713)) 'stripping escapes keeps the text they wrapped'
Assert-Equal 'building' (Remove-IonAnsi "$esc[2K$esc[1Gbuilding") 'cursor-movement sequences are stripped'
Assert-Equal 'done' (Remove-IonAnsi "$esc]0;npm run build$([char]7)done") 'OSC title sequences are stripped'
Assert-Equal 'plain' (Remove-IonAnsi 'plain') 'text with no escapes is unchanged'
Assert-Equal '' (Remove-IonAnsi '') 'empty input is returned unchanged'

# electron-builder's "duplicate dependency references" line is a single JSON
# array of every transitively duplicated package -- 6,894 characters on this
# repository, on one line. It buries every line around it in both the console
# and the log.
$long = 'x' * 6894
$capped = Limit-IonLineLength $long
Assert-Equal $true ($capped.Length -lt 600) 'an absurdly long child line is capped'
Assert-Equal $true ($capped.EndsWith('chars]')) 'a capped line says how much was dropped'
Assert-Equal 'short' (Limit-IonLineLength 'short') 'a normal-length line is untouched'

# Both must apply to what a child actually printed, on both streams. A helper
# that exists but is not wired into the capture path fixes nothing.
$buildScript = Get-Content (Join-Path $PSScriptRoot 'IonBuild.ps1') -Raw
Assert-Equal $true ($buildScript -match 'Write-IonChildLine \$line') `
  'child stdout goes through the sanitising writer'
Assert-Equal $true ($buildScript -match 'ForEach-Object \{ Write-IonChildLine \$_ \}') `
  'child stderr goes through the sanitising writer'

# -- Get-IonSevenZipFilter ----------------------------------------------------
# The value is load-bearing rather than cosmetic. 7-Zip applies an ARM64 branch
# filter to ARM64 executables; the nsis7z plugin electron-builder unpacks with
# cannot decode it, drops those entries without reporting anything, and the
# install still exits 0 -- an ARM64 Ion with no Ion.exe in it. Only the filters
# in the plugin's LZMA SDK 19.00 set are safe, so pin the value and pin that it
# stays inside that set.

$filter = Get-IonSevenZipFilter
Assert-Equal 'BCJ' $filter 'the 7-Zip filter is pinned to BCJ'

$decodable = @('BCJ', 'BCJ2', 'ARM', 'ARMT', 'IA64', 'PPC', 'SPARC', 'DELTA')
Assert-Equal $true ($decodable -contains $filter) 'the filter is one nsis7z can decode'
Assert-Equal $false ($filter -eq 'ARM64') 'the filter is never the undecodable ARM64 one'

# The build must actually put it in the environment, and must not leave it set
# afterwards -- IonDesktop.ps1 wraps the electron-builder call to do both.
$desktopScript = Get-Content (Join-Path $PSScriptRoot 'IonDesktop.ps1') -Raw
Assert-Equal $true ($desktopScript -match 'ELECTRON_BUILDER_7Z_FILTER\s*=\s*Get-IonSevenZipFilter') `
  'the installer build sets ELECTRON_BUILDER_7Z_FILTER from the pinned value'
Assert-Equal $true ($desktopScript -match 'finally\s*\{\s*\$env:ELECTRON_BUILDER_7Z_FILTER\s*=\s*\$previousFilter') `
  'the installer build restores the caller environment'

# CI builds the shipped artifact and never runs IonDesktop.ps1, so the same
# value has to be on the workflow step or releases carry the broken installer.
$workflow = Get-Content (Join-Path $PSScriptRoot '..\..\.github\workflows\build.yml') -Raw
Assert-Equal $true ($workflow -match "ELECTRON_BUILDER_7Z_FILTER:\s*$filter") `
  'the release workflow pins the same filter as the local build'

# -- ARM64 per-machine install directory --------------------------------------
# app-builder-lib upgrades the per-machine directory to the 64-bit Program Files
# only under APP_64, which an ARM64-only build never defines, so an ARM64
# install lands in Program Files (x86) while still reporting success. The patch
# runs at postinstall, but npm ci is skipped when the lockfile is unchanged, so
# the build has to apply it too or a developer's incremental build ships wrong.
Assert-Equal $true ($desktopScript -match 'patch-nsis-arm64\.js') `
  'the installer build applies the arm64 install-directory patch'
Assert-Equal $true ($desktopScript -match "(?s)patch-nsis-arm64\.js.*?electron-builder") `
  'the patch is applied before electron-builder runs'

# -- installer.nsh payload verification ---------------------------------------
# The filter is the fix; this is the backstop. electron-builder never checks
# what its extractor produced, so without a check of our own any future silent
# drop is again indistinguishable from a clean install.

$nsh = Get-Content (Join-Path $PSScriptRoot '..\..\packaging\windows\installer.nsh') -Raw
Assert-Equal $true ($nsh -match '!macro verifyAppPayload') 'installer.nsh verifies the payload'
Assert-Equal $true ($nsh -match '\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}') `
  'the verification looks for the real application executable'
foreach ($arch in @('arm64', 'x64')) {
  Assert-Equal $true ($nsh -match "!macro customFiles_$arch[\s\S]{0,120}?verifyAppPayload") `
    "the $arch install path runs the verification"
}
# -- VM source sync -----------------------------------------------------------
# The VM builds from a COPY at C:\dev\ion with no git remote. Two retests in
# one session reported a defect unfixed while measuring the previous binary,
# because the sync was skipped or partial -- and the second exposed a tree
# missing a file that predated the branch, so per-file copying had been
# drifting for an unknown number of iterations.
#
# These assert the sync ships EVERYTHING tracked rather than a diff, since a
# diff cannot name what an earlier partial sync missed.
$syncPath = Join-Path $PSScriptRoot '..\sync-windows-vm.sh'
Assert-Equal $true (Test-Path $syncPath) 'the VM sync script exists'
$sync = Get-Content $syncPath -Raw

Assert-Equal $true ($sync -match 'git ls-files') `
  'the sync enumerates every tracked file'
Assert-Equal $false ($sync -match 'git diff --name-only') `
  'the sync does not ship only the current diff'
foreach ($root in @('engine', 'desktop', 'packaging', 'scripts')) {
  Assert-Equal $true ($sync -match "\b$root\b") "the sync covers $root"
}
# Named individually because the VM builds by running make.ps1, which arrived
# there by hand once and then drifted -- the per-file failure this script
# exists to remove. release-please-manifest.json is what the version resolver
# reads.
foreach ($rootFile in @('make\.ps1', 'bootstrap\.ps1', 'release-please-manifest\.json')) {
  Assert-Equal $true ($sync -match "ROOTS=\([^)]*$rootFile") `
    "the sync ships the root file $($rootFile -replace '\\', '')"
}

# An unreachable VM must fail loudly. A silent failure is what leaves a retest
# measuring a stale binary.
Assert-Equal $true ($sync -match 'ConnectTimeout') `
  'the sync fails fast when the VM is unreachable'
Assert-Equal $true ($sync -match 'set -euo pipefail') `
  'the sync aborts on any step failing'
# Syncing an empty file list would "succeed" while shipping nothing.
Assert-Equal $true ($sync -match 'refusing to sync nothing') `
  'the sync refuses an empty file list'
# The build log has to be tie-able to a revision.
Assert-Equal $true ($sync -match 'rev-parse') `
  'the sync reports which commit the VM now holds'

# -- The sync stamp travels INSIDE the source archive -------------------------
# It used to be a second scp, sent after the source archive had already been
# extracted. A failure between the two left the VM holding NEW source under
# the PREVIOUS stamp, so the build stamped a version and a commit that did not
# describe the tree it built -- false provenance produced by the mechanism
# that exists to prevent it. These pin the atomic shape.

$scpCount = ([regex]::Matches($sync, '(?m)^\s*scp ')).Count
Assert-Equal 1 $scpCount `
  'the sync makes exactly one transfer, so source and stamp cannot separate'
Assert-Equal $false ($sync -match 'scp[^\n]*ion-sync-stamp\.json') `
  'the stamp is never transferred on its own'

Assert-Equal $true ($sync -match 'tar rf "\$archive" -C "\$stamp_dir" \.ion-sync-stamp\.json') `
  'the stamp is appended to the same archive as the source'
$extractCount = ([regex]::Matches($sync, 'tar xzf')).Count
Assert-Equal 1 $extractCount `
  'one extraction places both the source and the stamp'

# The stamp has to answer what an artifact from this tree actually is.
foreach ($field in @('commit', 'dirty', 'dirtyFiles', 'desktopVersion')) {
  Assert-Equal $true ($sync -match "\`"$field\`":") "the stamp records $field"
}
Assert-Equal $true ($sync -match 'head_sha_full="\$\(git rev-parse HEAD\)"') `
  'the stamp records the FULL commit sha, not the abbreviation'
Assert-Equal $true ($sync -match 'git status --porcelain --untracked-files=no \| cut -c4-') `
  'the stamp names which tracked files were modified, not merely that some were'

# Resolution happens before the archive exists; a version that cannot be
# resolved must abort before anything is sent.
$versionRefusal = $sync.IndexOf('Refusing to sync a tree it cannot version')
$firstScp = $sync.IndexOf('scp -q')
Assert-Equal $true ($versionRefusal -gt 0 -and $versionRefusal -lt $firstScp) `
  'an unresolvable version aborts before any transfer'

# One entry point, so the instruction and the mechanism cannot drift.
$mk = Get-Content (Join-Path $PSScriptRoot '..\..\Makefile') -Raw
Assert-Equal $true ($mk -match 'sync-windows-vm:') 'make exposes the sync target'

# -- installer phase status ---------------------------------------------------
# Three shipped attempts displayed nothing, so these assert the measured
# mechanism rather than the presence of a macro.
#
# What failed and why, from probes run on a Windows 11 endpoint:
#   - bare DetailPrint: electron-builder issues SetDetailsPrint none first.
#   - restoring the mode: text reaches control 1006, but common.nsh sets
#     ShowInstDetails nevershow, and every phase fires either side of one
#     opaque extraction block.
#   - WM_SETTEXT to control 1000: that is the one-click banner; read back
#     empty on an assisted installer.
#   - a timer for live progress: zero callbacks during a 3s blocking call,
#     because extraction blocks the message loop the timer runs on.
#
# What works: the MUI page header on the OUTER dialog (1037 title, 1038
# subtitle). Measured mid-section, both carry WS_VISIBLE and hold their text,
# and nothing redraws the header inside a section.
$nshPhase = [regex]::Match($nsh, '(?s)!macro ionPhase.*?!macroend').Value
Assert-Equal $true ($nshPhase -match '1037') 'ionPhase writes the page header title'
Assert-Equal $true ($nshPhase -match '1038') 'ionPhase writes the page header subtitle'
Assert-Equal $true ($nshPhase -match 'WM_SETTEXT') 'ionPhase sets the header text'
Assert-Equal $false ($nshPhase -match 'GetDlgItem \$\d+ \$0 1000') `
  'ionPhase does not write the one-click banner control'
Assert-Equal $true ($nsh -match '!include WinMessages\.nsh') `
  'WinMessages is included for WM_SETTEXT'

# The progress bar fills and restarts once per NSIS step. Each step must set
# its own caption, or the restarts read as one phase failing and retrying.
#
# customHeader sets the OPENING caption -- it is the only hook that runs
# before the page list is built. Everything after that is ionPhase at a step
# boundary.
Assert-Equal $true ($nsh -match '(?s)!macro customHeader.*?MUI_INSTFILESPAGE_HEADER_TEXT.*?!macroend') `
  'the page opens with an Ion caption'

# ONE surface per caption. ionPhase wrote the header subtitle AND printed the
# same string to the status line above the progress bar, so every caption
# rendered twice. The header is what persists for a whole step, so it is the
# one kept.
$nshPhase = [regex]::Match($nsh, '(?s)!macro ionPhase.*?!macroend').Value
Assert-Equal $false ($nshPhase -match 'DetailPrint') `
  'ionPhase does not also print to the status line'
Assert-Equal $false ($nshPhase -match 'SetDetailsPrint') `
  'ionPhase does not touch the details print mode'
Assert-Equal $true ($nshPhase -match '1037') 'ionPhase writes the header title'
Assert-Equal $true ($nshPhase -match '1038') 'ionPhase writes the header subtitle'

# The FIRST progress bar is electron-builder's uninstallOldVersion, which runs
# before any hook this script can reach -- customUnInstallCheck fires after it
# finishes. So the opening caption has to name that step, or the first bar runs
# captionless while every later one is labelled.
$nshHeader = [regex]::Match($nsh, '(?s)!macro customHeader.*?!macroend').Value
Assert-Equal $true ($nshHeader -match 'previous installation') `
  'the opening caption names the uninstall step that owns the first bar'
Assert-Equal $false ($nshHeader -match 'Preparing to install') `
  'the opening caption is not a generic placeholder'

# One caption per progress cycle. The uninstall-old-version hook is what
# labels the LONG cycle (decompression), because it fires immediately before
# it and nothing can repaint while extraction holds the message loop.
Assert-Equal $true ($nsh -match '(?s)!macro customUnInstallCheck\b.*?ionPhase.*?!macroend') `
  'the step before decompression captions it'
Assert-Equal $true ($nsh -match '(?s)!macro customFiles_arm64.*?verifyAppPayload.*?!macroend') `
  'the post-decompression step runs verification'
# customInit runs inside .onInit, before any window exists, so it cannot
# caption anything -- customHeader covers that window instead. customInstall
# runs with the page up and captions the registration step.
$bodyInstall = [regex]::Match($nsh, '(?s)!macro customInstall.*?!macroend').Value
Assert-Equal $true ($bodyInstall -match 'ionPhase') 'customInstall captions its step'
$bodyInit = [regex]::Match($nsh, '(?s)!macro customInit.*?!macroend').Value
Assert-Equal $false ($bodyInit -match 'ionPhase') `
  'customInit does not try to caption before a window exists' 

# customUnInstallCheck REPLACES electron-builder's failure handling -- it
# `Return`s right after inserting the macro. Dropping that handling would let
# a failed uninstall of the previous version install over the top of it.
$nshUn = [regex]::Match($nsh, '(?s)!macro customUnInstallCheck\b.*?!macroend').Value
Assert-Equal $true ($nshUn -match 'SetErrorLevel 2') `
  'a failed uninstall of the previous version still sets an error level'
Assert-Equal $true ($nshUn -match 'Quit') `
  'a failed uninstall of the previous version still aborts'
Assert-Equal $true ($nshUn -match 'IfErrors') `
  'a launch failure of the previous uninstaller is still detected'

# customCheckAppRunning must NOT be defined. Defining it makes
# allowOnlyOneInstallerInstance.nsh skip its getProcessInfo include and its
# Var pid -- both guarded by !ifmacrondef -- so the stock app-running check
# no longer compiles. Two builds died on exactly this.
Assert-Equal $false ($nsh -match '!macro customCheckAppRunning') `
  'the app-running check is left to electron-builder'

# customPageAfterChangeDir does not work either: assistedInstaller.nsh builds
# its page list before our file is parsed, so the page is silently dropped and
# NSIS fails on an unreferenced function.
Assert-Equal $false ($nsh -match '!macro customPageAfterChangeDir') `
  'no page hook, which is inserted before our macros are defined'

# A silent install has no dialog: the phase must still reach the log, and must
# not try to paint a window that does not exist.
Assert-Equal $true ($nshPhase -match '(?s)IfNot.*?Silent.*?GetDlgItem') `
  'the on-screen write is skipped for a silent install'
Assert-Equal $true ($nshPhase -match '(?s)EndIf.*?ionLog "phase:') `
  'the phase is logged on both silent and interactive paths'

# -- machine-wide install and the uninstall verb -------------------------------
# Ion installs per-machine only. That removes the situation the old
# refuseWhenManaged macro guarded -- a per-user install landing beside a
# managed one -- because there is no per-user install to refuse. A device
# carries one copy and one version, which is what an MDM fleet, a shared
# workstation and a multi-session host each need.

$desktopPkg = Get-Content (Join-Path $PSScriptRoot '..\..\desktop\package.json') -Raw | ConvertFrom-Json
Assert-Equal $true $desktopPkg.build.nsis.perMachine `
  'the installer is built per-machine only'
# electron-builder stops defining $hasPerMachineInstallation and
# $hasPerUserInstallation under perMachine, and makensis runs with warnings as
# errors -- so reading either one does not merely log wrongly, it fails the
# build. That is exactly how it was caught.
Assert-Equal $false ($nsh -match '\$hasPerMachineInstallation|\$hasPerUserInstallation') `
  'installer.nsh does not read variables perMachine leaves undefined'
Assert-Equal $false ($nsh -match 'refuseWhenManaged') `
  'the per-user refusal is gone rather than left as dead script'

$makeScript = Get-Content (Join-Path $PSScriptRoot '..\..\make.ps1') -Raw
Assert-Equal $true ($makeScript -match "'uninstall'") 'make.ps1 exposes an uninstall target'
Assert-Equal $true ($makeScript -match "ValidateSet\([^)]*'uninstall'") 'uninstall is an accepted target'

Assert-Equal $true ($desktopScript -match 'function Uninstall-IonEverywhere') `
  'IonDesktop.ps1 implements the uninstall'
Assert-Equal $true ($desktopScript -match '(?s)Uninstall-IonEverywhere[\s\S]*?WindowsBuiltInRole\]::Administrator[\s\S]*?throw') `
  'uninstall refuses without elevation'
Assert-Equal $true ($desktopScript -match 'QuietUninstallString') `
  'uninstall runs the registered uninstaller rather than reconstructing its command'
Assert-Equal $true ($desktopScript -match "Unregister-ScheduledTask -TaskName 'Ion Engine'") `
  'uninstall removes the engine Scheduled Task'
# schtasks writes to stderr when a task is absent, and under
# $ErrorActionPreference = 'Stop' that alone fails the run -- so the absence of
# a task must not be discovered with schtasks.exe.
Assert-Equal $false ($desktopScript -match "(?s)Uninstall-IonEverywhere[\s\S]*?schtasks /Query /TN 'Ion Engine'") `
  'uninstall does not probe for the task with schtasks'
# Policy is administrator-authored configuration; the uninstaller does not
# remove it either, and neither should this.
Assert-Equal $false ($desktopScript -match "Remove-Item[^\r\n]*ProgramData") `
  'uninstall leaves ProgramData policy in place'

# -- installer.nsh install log ------------------------------------------------
# NSIS keeps no log and a silent install has no details pane, so without this a
# failed Intune deployment leaves no record of which branch it took. Both sides
# of each decisive branch have to be recorded, not just the happy path.

Assert-Equal $true ($nsh -match '!macro ionLog') 'installer.nsh defines an install log'
Assert-Equal $true ($nsh -match 'Ion-Setup\.log') 'the install log has a fixed, collectable path'
foreach ($branch in @('mode=silent', 'mode=interactive', 'privileges=admin', 'privileges=standard',
                      'instance=inner', 'instance=outer')) {
  Assert-Equal $true ($nsh -match [regex]::Escape($branch)) "the install log records $branch"
}
Assert-Equal $true ($nsh -match 'extract: FAILED') 'the install log records a failed extraction'
Assert-Equal $true ($nsh -match 'extract: ok') 'the install log records a successful extraction'
# A logger that can abort the install it is meant to explain is worse than none.
Assert-Equal $true ($nsh -match '(?s)!macro ionLog.*?\$\{IfNot\} \$\{Errors\}.*?!macroend') `
  'a log that cannot be opened does not fail the install'

# A check that cannot fail the install is decoration.
Assert-Equal $true ($nsh -match '(?s)!macro verifyAppPayload.*?SetErrorLevel 3.*?Quit.*?!macroend') `
  'a missing payload aborts with a non-zero exit instead of continuing'

# -- Desktop version ----------------------------------------------------------
# The local Windows build shipped installers named, stamped and registered as
# 1.82.0 -- the version release-please last wrote into desktop/package.json --
# while the release manifest said 1.97.0. Every surface agreed with every other
# surface on a number that was wrong, which is precisely what made it invisible
# for as long as it lasted.

Assert-Equal '1.97.0' (Get-IonVersionFromInstallerName -Name 'Ion-Setup-1.97.0-x64.exe') `
  'a release version is parsed out of the installer filename'
Assert-Equal '1.98.0-dev.abc123def456' (Get-IonVersionFromInstallerName -Name 'Ion-Setup-1.98.0-dev.abc123def456-arm64.exe') `
  'a prerelease version survives filename parsing intact'
Assert-Equal '1.98.0-dev.abc123.dirty' (Get-IonVersionFromInstallerName -Name 'Ion-Setup-1.98.0-dev.abc123.dirty-x64.exe') `
  'a dirty-tree version survives filename parsing intact'
Assert-Equal $null (Get-IonVersionFromInstallerName -Name 'Ion-Setup-1.97.0.exe') `
  'a filename with no architecture is not a version'
Assert-Equal $null (Get-IonVersionFromInstallerName -Name 'Setup.exe') `
  'an unrelated filename yields no version'

# ION_DESKTOP_VERSION wins, so a caller that has already resolved is never
# second-guessed -- and so this test needs neither git nor node.
$previous = $env:ION_DESKTOP_VERSION
try {
  $env:ION_DESKTOP_VERSION = '9.9.9-test'
  Assert-Equal '9.9.9-test' (Resolve-IonDesktopVersion -Root $PSScriptRoot) `
    'ION_DESKTOP_VERSION is used when the caller set it'
} finally {
  $env:ION_DESKTOP_VERSION = $previous
}

# The sync stamp path. The Windows VM builds from a tar of tracked files with
# no .git at all, so without this the resolver throws there and the build has
# no version -- which is how it ended up reading package.json in the first
# place.
$stampDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-stamp-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
try {
  $stamp = Join-Path $stampDir '.ion-sync-stamp.json'
  '{ "commit": "abc", "dirty": true, "desktopVersion": "1.98.0-dev.abc123.dirty", "syncedAtUtc": "2026-01-01T00:00:00Z" }' |
    Set-Content -LiteralPath $stamp -Encoding utf8
  Assert-Equal '1.98.0-dev.abc123.dirty' (Resolve-IonDesktopVersion -Root $stampDir -StampPath $stamp) `
    'a git-less tree resolves its version from the sync stamp'

  $threw = $false
  try { Resolve-IonDesktopVersion -Root $stampDir -StampPath (Join-Path $stampDir 'absent.json') | Out-Null }
  catch { $threw = $true }
  Assert-Equal $true $threw 'a git-less tree with no stamp refuses to guess a version'

  # A stamp that is present but incomplete cannot describe the tree it sits in,
  # and falling back to git is exactly what this ordering exists to stop. Each
  # required field is pinned separately so dropping any one of them fails.
  foreach ($missing in @('desktopVersion', 'commit', 'syncedAtUtc')) {
    $fields = @{
      desktopVersion = '"desktopVersion": "1.98.0"'
      commit         = '"commit": "abc"'
      syncedAtUtc    = '"syncedAtUtc": "2026-01-01T00:00:00Z"'
    }
    $fields.Remove($missing)
    $partial = Join-Path $stampDir "partial-$missing.json"
    ('{ ' + ($fields.Values -join ', ') + ' }') | Set-Content -LiteralPath $partial -Encoding utf8
    $threw = $false
    try { Resolve-IonDesktopVersion -Root $stampDir -StampPath $partial | Out-Null }
    catch { $threw = $true }
    Assert-Equal $true $threw "a sync stamp missing $missing is a hard failure, not a fallback"
  }

  # Unparseable is the same class of broken as incomplete.
  $garbage = Join-Path $stampDir 'garbage.json'
  'not json at all' | Set-Content -LiteralPath $garbage -Encoding utf8
  $threw = $false
  try { Resolve-IonDesktopVersion -Root $stampDir -StampPath $garbage | Out-Null }
  catch { $threw = $true }
  Assert-Equal $true $threw 'an unparseable sync stamp is a hard failure, not a fallback'
} finally {
  Remove-Item $stampDir -Recurse -Force -ErrorAction SilentlyContinue
}

# THE REGRESSION. A synced Windows tree can carry .git metadata left by historic
# partial copies, describing a commit nobody synced. The resolver used to ask
# git first, so it answered from that stale history -- a dirty 40d39acc -- while
# the correct stamp for f326e5636 sat unread beside it, and the build stamped a
# version its own source did not match.
#
# The stamp wins whenever it is present. This test proves it by making git's
# answer impossible to use: the repository is real and has history, but has no
# desktop/scripts/desktop-version.js at all, so any resolution that consults git
# throws instead of returning the stamped version.
if (Test-IonCommand 'git') {
  $staleDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-stale-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $staleDir -Force | Out-Null
  try {
    & git -C $staleDir init --quiet *> $null
    & git -C $staleDir config user.email 'test@example.com' *> $null
    & git -C $staleDir config user.name 'test' *> $null
    Set-Content -LiteralPath (Join-Path $staleDir 'stale.txt') -Value 'historic partial copy' -Encoding ascii
    & git -C $staleDir add -A *> $null
    & git -C $staleDir commit --quiet -m 'stale' *> $null
    # Dirty, as the VM's leftover metadata was.
    Set-Content -LiteralPath (Join-Path $staleDir 'stale.txt') -Value 'edited' -Encoding ascii

    & git -C $staleDir rev-parse --git-dir *> $null
    Assert-Equal 0 $LASTEXITCODE 'the regression fixture really is a git repository'

    '{ "commit": "f326e5636", "dirty": false, "desktopVersion": "1.99.0-dev.f326e56", "syncedAtUtc": "2026-01-01T00:00:00Z" }' |
      Set-Content -LiteralPath (Join-Path $staleDir '.ion-sync-stamp.json') -Encoding utf8

    # Caught rather than allowed to propagate: git-first resolution throws in
    # this fixture, and an aborted suite reports less than a named failure.
    $resolved = $null
    try { $resolved = Resolve-IonDesktopVersion -Root $staleDir }
    catch { $resolved = "threw: $($_.Exception.Message)" }
    Assert-Equal '1.99.0-dev.f326e56' $resolved `
      'a valid sync stamp beats stale git metadata in the same tree'
  } finally {
    Remove-Item $staleDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host 'skip  stale-git regression needs git on PATH' -ForegroundColor DarkGray
}

# -- Version agreement --------------------------------------------------------
# The check that makes "they all came from one variable" a fact rather than an
# intention. Exercised through the filename and latest.yml surfaces, which are
# the two readable without a Windows host.

$relDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-rel-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $relDir -Force | Out-Null
try {
  $exe = Join-Path $relDir 'Ion-Setup-1.98.0-dev.abc123-x64.exe'
  Set-Content -LiteralPath $exe -Value 'not a real installer' -Encoding ascii
  Set-Content -LiteralPath (Join-Path $relDir 'latest.yml') `
    -Value "version: 1.98.0-dev.abc123`npath: Ion-Setup-1.98.0-dev.abc123-x64.exe" -Encoding ascii

  $ok = $true
  try {
    Assert-IonInstallerVersion -InstallerPath $exe -Arch 'x64' `
      -Version '1.98.0-dev.abc123' -ReleaseDir $relDir
  } catch { $ok = $false; Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray }
  Assert-Equal $true $ok 'a build whose surfaces agree passes the check'

  $threw = $false
  try {
    Assert-IonInstallerVersion -InstallerPath $exe -Arch 'x64' -Version '1.82.0' -ReleaseDir $relDir
  } catch { $threw = $true }
  Assert-Equal $true $threw 'an installer named for a different version fails the build'

  Set-Content -LiteralPath (Join-Path $relDir 'latest.yml') -Value 'version: 1.82.0' -Encoding ascii
  $threw = $false
  try {
    Assert-IonInstallerVersion -InstallerPath $exe -Arch 'x64' `
      -Version '1.98.0-dev.abc123' -ReleaseDir $relDir
  } catch { $threw = $true }
  Assert-Equal $true $threw 'an update feed naming a different version fails the build'

  # The provenance manifest is what identifies an installer that arrives by
  # hand. One that names a different version is worse than none, because it is
  # believed.
  $manifest = Join-Path $relDir 'Ion-Artifacts.json'
  '{ "version": "1.98.0-dev.abc123", "arch": "x64", "buildType": "test-build", "reproducible": false }' |
    Set-Content -LiteralPath $manifest -Encoding utf8
  $ok = $true
  try { Assert-IonManifestVersion -ManifestPath $manifest -Version '1.98.0-dev.abc123' -Arch 'x64' }
  catch { $ok = $false }
  Assert-Equal $true $ok 'a manifest that agrees passes'

  $threw = $false
  try { Assert-IonManifestVersion -ManifestPath $manifest -Version '1.97.0' -Arch 'x64' } catch { $threw = $true }
  Assert-Equal $true $threw 'a manifest naming a different version fails the build'

  $threw = $false
  try { Assert-IonManifestVersion -ManifestPath $manifest -Version '1.98.0-dev.abc123' -Arch 'arm64' } catch { $threw = $true }
  Assert-Equal $true $threw 'a manifest naming a different architecture fails the build'
} finally {
  Remove-Item $relDir -Recurse -Force -ErrorAction SilentlyContinue
}

# -- The build path uses the resolver -----------------------------------------
# These are the wiring facts the checks above cannot see. If Build-IonInstaller
# stops passing the resolved version to electron-builder, every surface goes
# back to agreeing on package.json's stale number and every assertion above
# still passes.

$ionDesktop = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'IonDesktop.ps1') -Raw
Assert-Equal $true ($ionDesktop -match 'Resolve-IonDesktopVersion') `
  'Build-IonInstaller resolves the version rather than letting the tools guess'
Assert-Equal $true ($ionDesktop -match [regex]::Escape('-c.extraMetadata.version=$version')) `
  'the resolved version is passed to electron-builder instead of editing package.json'
Assert-Equal $true ($ionDesktop -match [regex]::Escape('$env:ION_DESKTOP_VERSION = $version')) `
  'the resolved version is passed to electron-vite'
Assert-Equal $true ($ionDesktop -match 'Assert-IonInstallerVersion') `
  'the build asserts its artifacts carry the version it resolved'
Assert-Equal $true ($ionDesktop -match 'Assert-IonManifestVersion') `
  'the build asserts its provenance manifest carries the version it resolved'

# Provenance is required, not best-effort.
#
# A local build is the one most likely to be handed to somebody for a pilot and
# the one least likely to be reproducible. It used to warn and continue when
# the manifest failed, which left a 130 MB installer nobody could tie to a
# commit, a hash or a signature. The failure is now fatal, and the manifest
# script is run through Invoke-IonNative rather than a bare `&` -- a bare call
# discards the child's exit code, so a manifest script that exited 1 without
# throwing was reported as a success.
Assert-Equal $false ($ionDesktop -match 'could not write the artifact manifest') `
  'a failed artifact manifest no longer degrades to a warning'
Assert-Equal $true ($ionDesktop -match "(?s)Write-IonStep 'artifact manifest'.*?Invoke-IonNative 'pwsh'") `
  'the manifest script runs through the wrapper that checks its exit code'
Assert-Equal $true ($ionDesktop -match 'exited 0 but wrote no manifest') `
  'a manifest script that exits 0 without writing a file still fails the build'

# A local build is a pilot build, never a release, even from a spotless tree.
# Cleanliness makes the commit resolvable; it does not pin the toolchain or the
# signing identity the way the release runner does. Without this the manifest
# defaults to 'release' and a clean synced VM build would claim reproducibility
# nothing here can deliver.
Assert-Equal $true ($ionDesktop -match "(?s)Write-IonStep 'artifact manifest'.*?'-BuildType', 'test-build'") `
  'a local build labels its manifest a test build rather than a release'

# package.json is not a local workaround surface. Editing it to match would
# make the working tree lie rather than making the build honest.
$pkgVersion = ([regex]::Match((Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\desktop\package.json') -Raw), '"version":\s*"(?<v>[^"]+)"')).Groups['v'].Value
Assert-Equal $false ($ionDesktop -match 'package\.json.*version.*=') `
  "the build never rewrites desktop/package.json (still $pkgVersion, owned by release-please)"

if ($script:failures -gt 0) {
  Write-Host "`n$script:failures failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nIonBuild.ps1: all checks passed" -ForegroundColor Green
