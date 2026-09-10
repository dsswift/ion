<#
  Behaviour tests for Write-IonArtifactManifest.ps1 and the signing gate in
  resolve-windows-signing.ps1.

  Runs anywhere PowerShell does. Both scripts are dot-sourced, which loads
  their functions without doing any work, and the end-to-end check builds a
  throwaway git repository so the dirty/clean branches are exercised for real
  rather than mocked. Invoked by `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1')
. (Join-Path $PSScriptRoot 'resolve-windows-signing.ps1')

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

# ── Get-IonBuildLabel ────────────────────────────────────────────────────────
# The rule the manifest exists to enforce: a build from a dirty tree cannot be
# reproduced from its commit, because its bytes depend on edits that live on
# exactly one machine. It may still be built and still gets a manifest -- what
# it may never do is claim to be a release.

$clean = Get-IonBuildLabel -Dirty $false -Requested 'release'
Assert-Equal 'release' $clean.BuildType    'a clean tree may be labelled a release'
Assert-Equal $true     $clean.Reproducible 'a clean release build is reproducible'

$dirty = Get-IonBuildLabel -Dirty $true -Requested 'release'
Assert-Equal 'test-build' $dirty.BuildType    'a dirty tree is a test build even when a release was requested'
Assert-Equal $false       $dirty.Reproducible 'a dirty build is never reproducible'

$asked = Get-IonBuildLabel -Dirty $false -Requested 'test-build'
Assert-Equal 'test-build' $asked.BuildType    'an explicitly requested test build stays one'
Assert-Equal $false       $asked.Reproducible 'a test build is not claimed reproducible'

# ── Portable checksum bytes ────────────────────────────────────────────────
$portableRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-sha-portable-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
try {
  $portable = Join-Path $portableRoot 'portable.sha256'
  Write-IonSha256File -Path $portable -Lines @('abc  one.exe', 'def  two.ps1')
  $portableBytes = [System.IO.File]::ReadAllBytes($portable)
  Assert-Equal 0 (@($portableBytes | Where-Object { $_ -eq 13 }).Count) 'checksum files contain no carriage returns'
  Assert-Equal 2 (@($portableBytes | Where-Object { $_ -eq 10 }).Count) 'checksum files use one LF per record'
} finally {
  Remove-Item -LiteralPath $portableRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# ── End to end, against a real repository ────────────────────────────────────

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-manifest-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  # Isolated from the operator's global git config: commit.gpgsign would make
  # every commit here wait on a pinentry prompt that never comes, and a
  # configured hooksPath would run this repository's hooks inside a throwaway.
  #
  # That isolation is why no commit below passes --no-verify. The flag is
  # forbidden by the repository's own rules, and once hooksPath is empty there
  # is nothing for it to skip -- carrying it anyway taught the flag as a
  # fixture idiom while the isolation was already doing the work.
  & git -C $work init --quiet 2>$null | Out-Null
  & git -C $work config user.email 'test@example.com' | Out-Null
  & git -C $work config user.name 'Test' | Out-Null
  & git -C $work config commit.gpgsign false | Out-Null
  & git -C $work config core.hooksPath '' | Out-Null
  Set-Content -LiteralPath (Join-Path $work 'tracked.txt') -Value 'committed' -NoNewline
  & git -C $work add -A | Out-Null
  & git -C $work commit --quiet --no-gpg-sign -m 'initial' 2>$null | Out-Null

  $artifact = Join-Path $work 'Ion-Setup-9.9.9-x64.exe'
  Set-Content -LiteralPath $artifact -Value 'not really an installer' -NoNewline
  # The artifact itself is untracked, so it is deliberately ignored rather
  # than allowed to make every build look dirty.
  Set-Content -LiteralPath (Join-Path $work '.gitignore') -Value "*.exe`n*.json`n*.sha256" -NoNewline
  & git -C $work add -A | Out-Null
  & git -C $work commit --quiet --no-gpg-sign -m 'ignore build output' 2>$null | Out-Null

  $manifestPath = Join-Path $work 'Ion-Artifacts-9.9.9-x64.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $manifestPath -Version '9.9.9' -Arch 'x64' -RepoRoot $work 2>&1 | Out-Null

  Assert-Equal $true (Test-Path -LiteralPath $manifestPath) 'the manifest is written'
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-Equal '9.9.9' $m.version 'the manifest records the version'
  Assert-Equal 'x64'   $m.arch    'the manifest records the architecture'
  Assert-Equal $false  $m.dirty   'a clean tree is recorded clean'
  Assert-Equal 'release' $m.buildType 'a clean tree is labelled a release'
  Assert-Equal $true   $m.reproducible 'a clean release build is reproducible'
  Assert-Equal 40      $m.commit.Length 'the manifest records the full commit sha'

  # The hash must be the real one, not a placeholder. Computed independently
  # here so a manifest that echoed its own input back would fail.
  $expected = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-Equal $expected $m.artifacts[0].sha256 'the manifest records the real SHA-256'
  Assert-Equal ((Get-Item -LiteralPath $artifact).Length) $m.artifacts[0].bytes 'the manifest records the byte size'
  # Never "signed" on intent. On a Linux runner this is unchecked; on Windows
  # an unsigned test file is unsigned. Neither may be "valid".
  Assert-Equal $true ($m.artifacts[0].signature -in @('unsigned', 'unchecked')) `
    "an unsigned artifact is not reported valid (got '$($m.artifacts[0].signature)')"

  $sums = Get-Content -LiteralPath ([System.IO.Path]::ChangeExtension($manifestPath, '.sha256')) -Raw
  Assert-Equal "$expected  Ion-Setup-9.9.9-x64.exe" $sums.Trim() 'the sha256 file is in sha256sum format'

  # Now dirty the tree and prove the label flips. This is the regression: a
  # build produced from uncommitted edits must not be publishable as one.
  Set-Content -LiteralPath (Join-Path $work 'tracked.txt') -Value 'edited' -NoNewline
  $dirtyManifest = Join-Path $work 'dirty.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $dirtyManifest -Version '9.9.9' -Arch 'x64' -RepoRoot $work 2>&1 | Out-Null
  $d = Get-Content -LiteralPath $dirtyManifest -Raw | ConvertFrom-Json
  Assert-Equal $true       $d.dirty        'an edited tree is recorded dirty'
  Assert-Equal 'test-build' $d.buildType   'an edited tree is labelled a test build'
  Assert-Equal $false      $d.reproducible 'an edited tree is not reproducible'
  Assert-Equal $true ($d.dirtyFiles -contains 'tracked.txt') 'the manifest names which files were uncommitted'

  # A missing artifact must be a hard failure, not a quietly shorter manifest.
  $missingOut = Join-Path $work 'missing.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path (Join-Path $work 'does-not-exist.exe') -OutputPath $missingOut -Version '9.9.9' -Arch 'x64' -RepoRoot $work 2>&1 | Out-Null
  Assert-Equal $false (Test-Path -LiteralPath $missingOut) 'a missing artifact writes no manifest'
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ── The sync stamp outranks git ──────────────────────────────────────────────
# The defect these cover, exactly as it happened: a synced VM tree carried a
# correct stamp for 57423b95 with a clean checkout, AND leftover .git metadata
# from a historic partial copy that answered with a dirty 40d39acc. The
# manifest read git, so a good installer shipped with provenance naming a
# commit its own bytes did not come from. Git must never answer while a stamp
# is present, and a broken stamp must never hand the question back to git.

function Assert-Throws {
  param([scriptblock] $Action, [string] $Pattern, [string] $Because)
  $message = $null
  try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
  if (-not $message) {
    Write-Host "FAIL  $Because`n      expected a throw, got none" -ForegroundColor Red
    $script:failures++
  } elseif ($message -notmatch $Pattern) {
    Write-Host "FAIL  $Because`n      threw '$message', expected /$Pattern/" -ForegroundColor Red
    $script:failures++
  } else {
    Write-Host "ok    $Because" -ForegroundColor Green
  }
}

$stampWork = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-stamp-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stampWork -Force | Out-Null
try {
  $goodSha = '57423b95bea7000000000000000000000000abcd'
  function New-Stamp([string] $name, [string] $json) {
    $f = Join-Path $stampWork $name
    Set-Content -LiteralPath $f -Value $json -Encoding utf8
    return $f
  }

  # No stamp at all is not an error; it is an ordinary developer checkout.
  Assert-Equal $null (Get-IonSyncStamp -StampPath (Join-Path $stampWork 'absent.json')) `
    'an absent stamp returns null rather than throwing'

  $good = New-Stamp 'good.json' (@"
{ "commit": "$goodSha", "dirty": false, "dirtyFiles": [],
  "desktopVersion": "1.98.0-dev.57423b95bea7", "syncedAtUtc": "2026-09-07T21:00:00Z" }
"@)
  $parsed = Get-IonSyncStamp -StampPath $good
  Assert-Equal $goodSha $parsed.Commit 'a valid stamp yields its full commit sha'
  Assert-Equal $false   $parsed.Dirty  'a valid stamp yields its dirty flag'
  Assert-Equal 'sync-stamp' $parsed.Source 'a valid stamp names itself as the provenance source'

  # Malformed: not JSON at all.
  $broken = New-Stamp 'broken.json' '{ this is not json'
  Assert-Throws { Get-IonSyncStamp -StampPath $broken } 'not readable JSON' `
    'an unparseable stamp is fatal, never a fallback to git'

  # Malformed: valid JSON, wrong shape.
  $arr = New-Stamp 'array.json' '["not", "an", "object"]'
  Assert-Throws { Get-IonSyncStamp -StampPath $arr } 'does not contain a JSON object' `
    'a stamp that is not a JSON object is fatal'

  # Partial: each required field missing in turn.
  $fields = [ordered]@{
    commit         = """commit"": ""$goodSha"""
    dirty          = '"dirty": false'
    dirtyFiles     = '"dirtyFiles": []'
    desktopVersion = '"desktopVersion": "1.98.0-dev.57423b95bea7"'
    syncedAtUtc    = '"syncedAtUtc": "2026-09-07T21:00:00Z"'
  }
  foreach ($missing in $fields.Keys) {
    $kept = @($fields.Keys | Where-Object { $_ -ne $missing } | ForEach-Object { $fields[$_] })
    $f = New-Stamp "partial-$missing.json" ('{ ' + ($kept -join ', ') + ' }')
    Assert-Throws { Get-IonSyncStamp -StampPath $f } "carries no '$missing'" `
      "a stamp missing '$missing' is fatal"
  }

  # `dirty: false` must be distinguishable from an absent dirty field. It is
  # the one partial case a naive truthiness check cannot see, and the reason
  # presence is tested on the property rather than on the value.
  $noDirty = New-Stamp 'no-dirty.json' (@"
{ "commit": "$goodSha", "dirtyFiles": [],
  "desktopVersion": "1.98.0", "syncedAtUtc": "2026-09-07T21:00:00Z" }
"@)
  Assert-Throws { Get-IonSyncStamp -StampPath $noDirty } "carries no 'dirty'" `
    'an absent dirty field is not silently read as a clean tree'

  # Wrongly typed fields.
  $badBool = New-Stamp 'bad-bool.json' (@"
{ "commit": "$goodSha", "dirty": "false", "dirtyFiles": [],
  "desktopVersion": "1.98.0", "syncedAtUtc": "2026-09-07T21:00:00Z" }
"@)
  Assert-Throws { Get-IonSyncStamp -StampPath $badBool } 'not a JSON boolean' `
    'a stringly-typed dirty flag is fatal'

  $shortSha = New-Stamp 'short-sha.json' '{ "commit": "57423b9", "dirty": false, "dirtyFiles": [], "desktopVersion": "1.98.0", "syncedAtUtc": "2026-09-07T21:00:00Z" }'
  Assert-Throws { Get-IonSyncStamp -StampPath $shortSha } 'not a full 40-character SHA' `
    'an abbreviated commit sha is fatal'

  $badList = New-Stamp 'bad-list.json' (@"
{ "commit": "$goodSha", "dirty": true, "dirtyFiles": "desktop/x.ts",
  "desktopVersion": "1.98.0", "syncedAtUtc": "2026-09-07T21:00:00Z" }
"@)
  Assert-Throws { Get-IonSyncStamp -StampPath $badList } 'not a JSON array' `
    'a scalar dirtyFiles is fatal'
} finally {
  Remove-Item -LiteralPath $stampWork -Recurse -Force -ErrorAction SilentlyContinue
}

# ── End to end: stamp beside a stale, dirty git repository ───────────────────

$syncWork = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-synced-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $syncWork -Force | Out-Null
try {
  & git -C $syncWork init --quiet 2>$null | Out-Null
  & git -C $syncWork config user.email 'test@example.com' | Out-Null
  & git -C $syncWork config user.name 'Test' | Out-Null
  & git -C $syncWork config commit.gpgsign false | Out-Null
  & git -C $syncWork config core.hooksPath '' | Out-Null
  Set-Content -LiteralPath (Join-Path $syncWork '.gitignore') -Value "*.exe`n*.json`n*.sha256" -NoNewline
  Set-Content -LiteralPath (Join-Path $syncWork 'stale.txt') -Value 'historic' -NoNewline
  & git -C $syncWork add -A | Out-Null
  & git -C $syncWork commit --quiet --no-gpg-sign -m 'historic partial copy' 2>$null | Out-Null
  # Dirty it, so git's answer is both a different commit AND dirty=true --
  # the exact stale pair the VM produced.
  Set-Content -LiteralPath (Join-Path $syncWork 'stale.txt') -Value 'edited by nobody' -NoNewline
  $staleCommit = (& git -C $syncWork rev-parse HEAD).Trim()

  $artifact = Join-Path $syncWork 'Ion-Setup-1.98.0-dev.57423b95bea7-x64.exe'
  Set-Content -LiteralPath $artifact -Value 'installer bytes' -NoNewline

  $syncedSha = '57423b95bea7f00d1234567890abcdef12345678'
  $syncedVersion = '1.98.0-dev.57423b95bea7'
  $stampPath = Join-Path $syncWork '.ion-sync-stamp.json'
  Set-Content -LiteralPath $stampPath -Encoding utf8 -Value (@"
{
  "commit": "$syncedSha",
  "dirty": false,
  "dirtyFiles": [],
  "desktopVersion": "$syncedVersion",
  "syncedAtUtc": "2026-09-07T21:00:00Z"
}
"@)

  $out = Join-Path $syncWork 'synced.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $out -Version $syncedVersion -Arch 'x64' `
    -RepoRoot $syncWork -BuildType 'test-build' 2>&1 | Out-Null

  Assert-Equal $true (Test-Path -LiteralPath $out) 'a synced tree still gets a manifest'
  $m = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
  Assert-Equal $syncedSha  $m.commit 'the stamp commit wins over the stale git commit'
  Assert-Equal $false ($m.commit -eq $staleCommit) 'the stale git commit is not recorded'
  Assert-Equal $false      $m.dirty  'the stamp clean flag wins over the stale git dirty flag'
  Assert-Equal 'sync-stamp' $m.provenanceSource 'the manifest records that the stamp answered'
  # Read off the raw JSON, not the hydrated object: ConvertFrom-Json would turn
  # the timestamp back into a [datetime] here and the assertion would then pass
  # for a manifest that had written a host-local display string.
  Assert-Equal $true ((Get-Content -LiteralPath $out -Raw) -match '"syncedAtUtc":\s*"2026-09-07T21:00:00Z"') `
    'the manifest records when the source was synced, in canonical UTC'
  # Requirement 3: a clean synced local build is honest about being a pilot.
  Assert-Equal 'test-build' $m.buildType    'a clean local build is still labelled a test build'
  Assert-Equal $false       $m.reproducible 'a local test build is never claimed reproducible'
  Assert-Equal $null        $m.dirtyFiles   'a clean stamp records no dirty files'

  # Version disagreement between the build and the source it was built from.
  $mismatchOut = Join-Path $syncWork 'mismatch.json'
  $err = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $mismatchOut -Version '1.98.0-dev.40d39acc' -Arch 'x64' `
    -RepoRoot $syncWork -BuildType 'test-build' 2>&1 | Out-String
  Assert-Equal $false (Test-Path -LiteralPath $mismatchOut) 'a version that disagrees with the stamp writes no manifest'
  # Matched on single tokens. PowerShell wraps a thrown message across gutter
  # lines, so any multi-word phrase can be split by a newline that is an
  # artifact of the console width rather than of the message.
  Assert-Equal $true ($err -match 'desktopVersion')          'the mismatch names the stamp field that disagreed'
  Assert-Equal $true ($err -match [regex]::Escape('1.98.0-dev.40d39acc')) 'the mismatch names the version the build resolved'
  Assert-Equal $true ($err -match [regex]::Escape($syncedVersion))        'the mismatch names the version the stamp carries'

  # A broken stamp must fail the build, not silently fall back to the stale git
  # answer sitting right beside it.
  Set-Content -LiteralPath $stampPath -Value '{ "commit": "abc"' -Encoding utf8
  $brokenOut = Join-Path $syncWork 'broken-stamp.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $brokenOut -Version $syncedVersion -Arch 'x64' `
    -RepoRoot $syncWork -BuildType 'test-build' 2>&1 | Out-Null
  Assert-Equal $false (Test-Path -LiteralPath $brokenOut) 'a broken stamp writes no manifest and never falls back to git'

  # A dirty stamp carries its file list through to the manifest.
  Set-Content -LiteralPath $stampPath -Encoding utf8 -Value (@"
{
  "commit": "$syncedSha",
  "dirty": true,
  "dirtyFiles": ["desktop/src/main/index.ts", "engine/internal/server/server.go"],
  "desktopVersion": "$syncedVersion",
  "syncedAtUtc": "2026-09-07T21:00:00Z"
}
"@)
  $dirtyOut = Join-Path $syncWork 'dirty-stamp.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $dirtyOut -Version $syncedVersion -Arch 'x64' `
    -RepoRoot $syncWork -BuildType 'release' 2>&1 | Out-Null
  $dm = Get-Content -LiteralPath $dirtyOut -Raw | ConvertFrom-Json
  Assert-Equal $true        $dm.dirty        'a dirty stamp is recorded dirty'
  Assert-Equal 'test-build' $dm.buildType    'a dirty stamp downgrades a requested release'
  Assert-Equal $true ($dm.dirtyFiles -contains 'desktop/src/main/index.ts') `
    'the manifest names the dirty files the stamp listed'
  Assert-Equal 2 (@($dm.dirtyFiles).Count) 'every file the stamp listed is carried through'

  # Removing the stamp restores the ordinary git path for a normal checkout.
  Remove-Item -LiteralPath $stampPath -Force
  $gitOut = Join-Path $syncWork 'git-fallback.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $gitOut -Version '9.9.9' -Arch 'x64' `
    -RepoRoot $syncWork -BuildType 'test-build' 2>&1 | Out-Null
  $gm = Get-Content -LiteralPath $gitOut -Raw | ConvertFrom-Json
  Assert-Equal 'git'      $gm.provenanceSource 'a tree with no stamp reads git as before'
  Assert-Equal $staleCommit $gm.commit         'the git fallback records the git commit'
  Assert-Equal $true      $gm.dirty            'the git fallback still sees the dirty tree'
  Assert-Equal $null      $gm.syncedAtUtc      'a git-sourced manifest carries no sync timestamp'
  # No stamp means no version cross-check to fail: git cannot claim a version.
  Assert-Equal '9.9.9'    $gm.version          'a git-sourced manifest takes the version it is given'

  # An explicitly named stamp that is not there is a broken invocation.
  $namedOut = Join-Path $syncWork 'named-missing.json'
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Write-IonArtifactManifest.ps1') `
    -Path $artifact -OutputPath $namedOut -Version '9.9.9' -Arch 'x64' `
    -RepoRoot $syncWork -StampPath (Join-Path $syncWork 'nope.json') 2>&1 | Out-Null
  Assert-Equal $false (Test-Path -LiteralPath $namedOut) 'an explicitly named missing stamp writes no manifest'
} finally {
  Remove-Item -LiteralPath $syncWork -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Resolve-IonSigningDecision ───────────────────────────────────────────────
# The signing gate. It has to fail closed in exactly two situations and must
# not fail in the third, and each of those is a decision nobody re-derives by
# hand at release time.

$r = Resolve-IonSigningDecision -HasCertificate $true -Required $true
Assert-Equal 'sign' $r.Action 'a required release with a certificate signs'

$r = Resolve-IonSigningDecision -HasCertificate $true -Required $false
Assert-Equal 'sign' $r.Action 'a configured certificate is used even when not required'

# The fail-closed case. An official release that is meant to be signed and has
# no identity must not quietly ship an unsigned installer that a fleet will
# then trust.
$r = Resolve-IonSigningDecision -HasCertificate $false -Required $true
Assert-Equal 'fail' $r.Action 'a required release with no certificate fails'

# The local case. There is no certificate and none is required, so the build
# proceeds and the artifact is explicitly labelled rather than exempted.
$r = Resolve-IonSigningDecision -HasCertificate $false -Required $false
Assert-Equal 'unsigned' $r.Action 'a local build with no certificate proceeds unsigned'
Assert-Equal $true ($r.Reason -match 'UNSIGNED') 'the unsigned decision says so in its reason'

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nWrite-IonArtifactManifest.test.ps1: OK" -ForegroundColor Green
exit 0
