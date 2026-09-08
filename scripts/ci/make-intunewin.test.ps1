<#
  Behaviour tests for make-intunewin.ps1.

  The property under test is WHAT GOES IN THE PACKAGE. The wrapper used to hand
  the content prep tool the installer's own parent directory, which is correct
  on a release runner (that directory holds one build's output) and wrong
  everywhere else: on a machine that has built twice it is desktop/release,
  holding every previous installer, their blockmaps and the whole unpacked
  application. One local run produced a 1.6 GB content folder and a package
  carrying three installers of other versions -- an artifact that would still
  have installed correctly, so nothing downstream would ever have caught it.

  The second property is WHAT THE PACKAGE SAYS ABOUT ITSELF. The .intunewin
  and the stamped detector are the two files an administrator actually uploads
  to Intune, and they are produced here rather than by the desktop build -- so
  the installer's own Ion-Artifacts-<version>-<arch>.json does not cover them.
  They shipped with no generated record at all. Hashing them by hand answers
  "what is this file" and cannot answer "which commit produced it", "was the
  tree clean", or "which installer went in", which are the questions asked
  when a device is carrying a build nobody recognises.

  The tool itself is a Windows PE binary, so it is stubbed here through
  -IntuneWinAppUtilPath: the stub records the content directory it was given,
  which is the only thing the packaging assertions care about.

  Invoked by `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'

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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-mkintune-" + [guid]::NewGuid().ToString('n'))
$release = Join-Path $work 'release'
$out = Join-Path $work 'intune'
New-Item -ItemType Directory -Path $release, $out -Force | Out-Null
try {
  # A release directory with the shape a repeat local build actually leaves:
  # the installer under test plus the leftovers of every earlier build.
  $installer = Join-Path $release 'Ion-Setup-9.9.9-x64.exe'
  Set-Content -LiteralPath $installer -Value 'the installer under test' -NoNewline
  foreach ($leftover in @('Ion-Setup-1.2.3-arm64.exe', 'Ion-Setup-9.9.8-x64.exe', 'latest.yml')) {
    Set-Content -LiteralPath (Join-Path $release $leftover) -Value 'stale' -NoNewline
  }
  New-Item -ItemType Directory -Path (Join-Path $release 'win-unpacked') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $release 'win-unpacked\Ion.exe') -Value 'unpacked' -NoNewline

  # The stub writes the package the real tool would, and records the listing of
  # the content directory it was handed.
  $stub = Join-Path $work 'stub-tool.ps1'
  $ledger = Join-Path $work 'content-listing.txt'
  Set-Content -LiteralPath $stub -Encoding utf8 -Value @"
param([string] `$c, [string] `$s, [string] `$o, [switch] `$q)
Write-Output 'INFO   Validating parameters'
(Get-ChildItem -LiteralPath `$c -Recurse -File | ForEach-Object { `$_.Name }) |
  Set-Content -LiteralPath '$ledger'
Set-Content -LiteralPath (Join-Path `$o ([System.IO.Path]::GetFileNameWithoutExtension(`$s) + '.intunewin')) -Value 'package' -NoNewline
Write-Output 'INFO   Done!!!'
exit 0
"@

  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $out -Version '9.9.9' -IntuneWinAppUtilPath $stub 2>&1 | Out-Null
  Assert-Equal 0 $LASTEXITCODE 'the wrapper succeeds against a stubbed tool'

  $content = @(Get-Content -LiteralPath $ledger)
  Assert-Equal 1 $content.Count 'exactly one file is handed to the packaging tool'
  Assert-Equal 'Ion-Setup-9.9.9-x64.exe' $content[0] 'and it is the installer that was asked for'
  foreach ($leftover in @('Ion-Setup-1.2.3-arm64.exe', 'Ion-Setup-9.9.8-x64.exe', 'latest.yml', 'Ion.exe')) {
    Assert-Equal $false ($content -contains $leftover) "an unrelated release file ($leftover) is not packaged"
  }

  Assert-Equal $true (Test-Path -LiteralPath (Join-Path $out 'Ion-Setup-9.9.9-x64.intunewin')) `
    'the package is written under the output directory'
  # The success line must name the package, not the tool's transcript with a
  # path on the end. That is what a chatty tool produced before its stdout was
  # taken off the success stream.
  $ok = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $out -Version '9.9.9' -IntuneWinAppUtilPath $stub 2>&1 |
    Where-Object { $_ -match 'make-intunewin: OK' }
  Assert-Equal $true ("$ok".TrimEnd().EndsWith('Ion-Setup-9.9.9-x64.intunewin')) `
    "the success line ends at the package path (got '$ok')"
  Assert-Equal $false ("$ok" -match 'INFO') 'the success line carries none of the tool transcript'
  Assert-Equal $true (Test-Path -LiteralPath (Join-Path $out 'Detect-Ion.ps1')) `
    'the stamped detector is written beside it'
  Assert-Equal $true ((Get-Content -LiteralPath (Join-Path $out 'Detect-Ion.ps1') -Raw) -match '9\.9\.9') `
    'the detector carries the packaged version'

  # The staged copy of a 130 MB installer must not be left behind next to the
  # artifact an operator is about to upload.
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $out '.content')) `
    'the staging directory is removed once the package exists'

  # -- Provenance -------------------------------------------------------------
  # The pair the policy package already writes, now written here too. Existence
  # first: a package with no record is the defect this section exists to catch.

  $provPath = Join-Path $out 'Ion-Setup-9.9.9-x64.json'
  $sumsPath = Join-Path $out 'Ion-Setup-9.9.9-x64.sha256'
  Assert-Equal $true (Test-Path -LiteralPath $provPath) 'the wrapper writes provenance beside the package'
  Assert-Equal $true (Test-Path -LiteralPath $sumsPath) 'the wrapper writes checksums beside the package'

  $prov = Get-Content -LiteralPath $provPath -Raw | ConvertFrom-Json
  Assert-Equal 1 $prov.schema 'the provenance declares its schema'
  Assert-Equal 'ion-desktop-intunewin' $prov.package 'the provenance names which package it describes'
  Assert-Equal '9.9.9' $prov.version 'the provenance records the packaged version'
  Assert-Equal 'x64' $prov.arch 'the provenance records the architecture, parsed off the installer name'
  Assert-Equal $true ($prov.commit.Length -gt 0) 'the provenance records a commit'
  Assert-Equal $true ($null -ne $prov.builtAtUtc) 'the provenance records when it was built'

  # Both upload artifacts, not just the .intunewin. The detector is uploaded
  # separately as the detection rule, so a record that omits it leaves the file
  # an administrator pastes into Intune unaccounted for.
  $names = @($prov.artifacts | ForEach-Object { $_.name })
  Assert-Equal 2 $names.Count 'the provenance records exactly the two upload artifacts'
  Assert-Equal $true ($names -contains 'Ion-Setup-9.9.9-x64.intunewin') 'the .intunewin is recorded'
  Assert-Equal $true ($names -contains 'Detect-Ion.ps1') 'the stamped detector is recorded'

  # Exact values, not shapes. A hash field that is merely 64 characters long
  # would pass while describing a different file. The .sha256 file is compared
  # line-for-line in the format `sha256sum -c` reads: two spaces, then the name.
  $sumsLines = @(Get-Content -LiteralPath $sumsPath)
  Assert-Equal 2 $sumsLines.Count 'the checksum file has one line per upload artifact'
  foreach ($pair in @(
    @{ File = (Join-Path $out 'Ion-Setup-9.9.9-x64.intunewin'); Name = 'Ion-Setup-9.9.9-x64.intunewin' },
    @{ File = (Join-Path $out 'Detect-Ion.ps1');                Name = 'Detect-Ion.ps1' }
  )) {
    $record = $prov.artifacts | Where-Object { $_.name -eq $pair.Name }
    $expectedHash = (Get-FileHash -LiteralPath $pair.File -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedBytes = (Get-Item -LiteralPath $pair.File).Length
    Assert-Equal $expectedHash $record.sha256 "the recorded sha256 for $($pair.Name) is the file's actual hash"
    Assert-Equal $expectedBytes $record.bytes "the recorded size for $($pair.Name) is the file's actual size"
    Assert-Equal $true ($sumsLines -contains "$expectedHash  $($pair.Name)") `
      "the .sha256 file carries the same hash for $($pair.Name) as the JSON does"
  }

  # "Which installer went into this package" is not answerable from the
  # .intunewin's own hash, so the input is recorded too.
  $expectedInstallerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-Equal 'Ion-Setup-9.9.9-x64.exe' $prov.inputs.installer.name 'the provenance names the installer that went in'
  Assert-Equal $expectedInstallerHash $prov.inputs.installer.sha256 'and records that installer''s actual hash'
  Assert-Equal (Get-Item -LiteralPath $installer).Length $prov.inputs.installer.bytes 'and its actual size'

  # A clean tree makes the commit resolvable; it does not make the bytes
  # reproducible, because nothing on a workstation pins the toolchain or the
  # signing identity. So a local package is a test build either way, and the
  # label must not quietly promote itself when git happens to be clean.
  Assert-Equal 'test-build' $prov.buildType 'a locally produced package is labelled a test build'
  Assert-Equal $false $prov.reproducible 'and is never claimed to be reproducible'

  # Nothing from the release folder leaked into the record any more than into
  # the package: the artifacts list is the two files above and no others.
  foreach ($leftover in @('Ion-Setup-1.2.3-arm64.exe', 'Ion-Setup-9.9.8-x64.exe', 'latest.yml', 'Ion.exe')) {
    Assert-Equal $false ($names -contains $leftover) "an unrelated release file ($leftover) is not in the provenance"
  }
  # Including the 130 MB staging copy, whose absence from the record is a
  # separate fact from its absence from disk.
  Assert-Equal $false (($prov | ConvertTo-Json -Depth 20) -match '\.content') `
    'the staging directory appears nowhere in the record'

  # -- Provenance source: a sync stamp outranks git ----------------------------
  # The VM builds from an extracted tar into a directory carrying .git metadata
  # from historic partial copies, so git there answers confidently about a tree
  # nobody synced. A stamp exists only because a sync wrote it.

  $stampRepo = Join-Path $work 'stamped-repo'
  New-Item -ItemType Directory -Path $stampRepo -Force | Out-Null
  & git -C $stampRepo init -q 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $stampRepo 'tracked.txt') -Value 'stale tree' -NoNewline
  & git -C $stampRepo add tracked.txt 2>&1 | Out-Null
  & git -C $stampRepo -c user.email='t@example.com' -c user.name='Test' commit -q -m 'stale' 2>&1 | Out-Null
  $staleCommit = (& git -C $stampRepo rev-parse HEAD).Trim()

  $stampCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  $stampFile = Join-Path $stampRepo '.ion-sync-stamp.json'
  Set-Content -LiteralPath $stampFile -Encoding utf8 -Value @'
{
  "commit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "dirty": false,
  "dirtyFiles": [],
  "desktopVersion": "9.9.9",
  "syncedAtUtc": "2026-09-07T12:00:00Z"
}
'@

  $stampOut = Join-Path $work 'intune-stamped'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $stampOut -Version '9.9.9' `
    -IntuneWinAppUtilPath $stub -RepoRoot $stampRepo 2>&1 | Out-Null
  Assert-Equal 0 $LASTEXITCODE 'a stamped tree packages successfully'
  $stampRaw = Get-Content -LiteralPath (Join-Path $stampOut 'Ion-Setup-9.9.9-x64.json') -Raw
  $stampProv = $stampRaw | ConvertFrom-Json
  Assert-Equal 'sync-stamp' $stampProv.provenanceSource 'the provenance says the stamp is what answered'
  Assert-Equal $stampCommit $stampProv.commit 'the recorded commit is the stamp''s, not git''s'
  Assert-Equal $false ($stampProv.commit -eq $staleCommit) 'the stale git HEAD does not reach the record'
  # The untracked stamp itself makes git report a dirty tree; the stamp says
  # clean, and the stamp is what a sync actually observed.
  Assert-Equal $false $stampProv.dirty 'the stamp''s dirty state outranks git''s'
  # Asserted against the RAW text, not the hydrated object. ConvertFrom-Json
  # turns an ISO-8601 string back into a [datetime], whose string form is the
  # reader's local display format -- so a check on the parsed value passes or
  # fails on the reading host's locale rather than on what was written. What
  # ships is the file, so the file is what is checked.
  Assert-Equal $true ($stampRaw -match '"syncedAtUtc":\s*"2026-09-07T12:00:00Z"') `
    'the record carries the synced instant in canonical UTC, whatever host reads it'

  # -- A present stamp that cannot be read is fatal ----------------------------
  # Falling through to git is exactly what produced a manifest naming a commit
  # its own bytes did not come from. A stamp only exists because a sync wrote
  # it, so a broken one means the sync is broken.

  $brokenRepo = Join-Path $work 'broken-stamp-repo'
  New-Item -ItemType Directory -Path $brokenRepo -Force | Out-Null
  & git -C $brokenRepo init -q 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $brokenRepo '.ion-sync-stamp.json') -Value '{ not json at all' -NoNewline
  $brokenOut = Join-Path $work 'intune-broken'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $brokenOut -Version '9.9.9' `
    -IntuneWinAppUtilPath $stub -RepoRoot $brokenRepo 2>&1 | Out-Null
  Assert-Equal $false ($LASTEXITCODE -eq 0) 'an unreadable sync stamp fails the wrapper'
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $brokenOut 'Ion-Setup-9.9.9-x64.json')) `
    'and no provenance is written from a tree whose stamp cannot be trusted'

  # -- The package version must be the version the stamp describes -------------
  # One was parsed off an installer filename, the other recorded at sync time.
  # A disagreement means the package describes a different tree than the one
  # that was synced, under a name that is not true.

  $mismatchRepo = Join-Path $work 'mismatch-repo'
  New-Item -ItemType Directory -Path $mismatchRepo -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $mismatchRepo '.ion-sync-stamp.json') -Encoding utf8 -Value @'
{
  "commit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "dirty": false,
  "dirtyFiles": [],
  "desktopVersion": "1.2.3",
  "syncedAtUtc": "2026-09-07T12:00:00Z"
}
'@
  $mismatchOut = Join-Path $work 'intune-mismatch'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $mismatchOut -Version '9.9.9' `
    -IntuneWinAppUtilPath $stub -RepoRoot $mismatchRepo 2>&1 | Out-Null
  Assert-Equal $false ($LASTEXITCODE -eq 0) 'a package version the sync stamp does not describe fails the wrapper'
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $mismatchOut 'Ion-Setup-9.9.9-x64.json')) `
    'and writes no provenance blessing the mismatch'

  # An explicit version may confirm the installer name, never relabel it.
  $explicitMismatchOut = Join-Path $work 'explicit-version-mismatch'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $explicitMismatchOut -Version '9.9.8' `
    -IntuneWinAppUtilPath $stub -RepoRoot $repo 2>&1 | Out-Null
  Assert-Equal 1 $LASTEXITCODE 'an explicit version that disagrees with the installer filename is fatal'
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $explicitMismatchOut 'Ion-Setup-9.9.8-x64.intunewin')) `
    'a mismatched explicit version writes no relabelled package'
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $explicitMismatchOut 'Ion-Setup-9.9.8-x64.json')) `
    'a mismatched explicit version writes no provenance'

  # A tool that fails must still clean up, and must not report success.
  $failing = Join-Path $work 'failing-tool.ps1'
  Set-Content -LiteralPath $failing -Encoding utf8 -Value 'param([string] $c, [string] $s, [string] $o, [switch] $q)
exit 3'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'make-intunewin.ps1') `
    -InstallerPath $installer -OutputDir $out -Version '9.9.9' -IntuneWinAppUtilPath $failing 2>&1 | Out-Null
  Assert-Equal 1 $LASTEXITCODE 'a failing packaging tool fails the wrapper'
  Assert-Equal $false (Test-Path -LiteralPath (Join-Path $out '.content')) `
    'the staging directory is removed even when packaging fails'
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nmake-intunewin.test.ps1: OK" -ForegroundColor Green
exit 0
