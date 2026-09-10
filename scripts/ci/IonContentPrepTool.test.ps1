<#
  Behaviour tests for IonContentPrepTool.ps1.

  These exist because of one defect, and it is the kind static analysis will
  not see. A PowerShell function returns its ENTIRE success stream, so a
  Write-Output progress line is part of the return value. Get-IonContentPrepTool
  narrated two lines and then returned a path, so its callers received a
  three-element array, passed it to a [string] parameter, and both .intunewin
  wrappers died with "Cannot convert value to type System.String" -- after the
  tool had already been downloaded and hash-verified, so the failure looked
  like a packaging problem rather than a narration problem.

  The assertion that matters is therefore a COUNT: exactly one item out, and it
  is a string. Anything that reintroduces narration on the success stream fails
  here rather than at the end of a 10-minute Windows build.

  Invoked by `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'IonContentPrepTool.ps1')

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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ion-contentprep-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  # ── Resolve-IonContentPrepTool, given a tool that is already on disk ────────
  $existing = Join-Path $work 'IntuneWinAppUtil.exe'
  Set-Content -LiteralPath $existing -Value 'stub' -NoNewline

  $resolved = @(Resolve-IonContentPrepTool -ExistingPath $existing)
  Assert-Equal 1 $resolved.Count 'resolving an existing tool returns exactly one value'
  Assert-Equal $true ($resolved[0] -is [string]) 'the resolved tool path is a string, not a stream'
  Assert-Equal $true ($resolved[0].EndsWith('IntuneWinAppUtil.exe')) 'the resolved value is the tool path'

  # A named tool that is not there is a hard failure, not a silent download.
  $threw = $false
  try { Resolve-IonContentPrepTool -ExistingPath (Join-Path $work 'absent.exe') | Out-Null }
  catch { $threw = $true }
  Assert-Equal $true $threw 'a named tool that does not exist is a hard failure'

  # ── Invoke-IonContentPrep ──────────────────────────────────────────────────
  # A stub standing in for IntuneWinAppUtil.exe: it takes the same flags and
  # writes the package where the real tool would, so the contract under test is
  # "what does this function hand back", not "does Microsoft's tool work".
  $src = Join-Path $work 'src'
  $out = Join-Path $work 'out'
  New-Item -ItemType Directory -Path $src, $out -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $src 'Install-Thing.ps1') -Value '# setup' -NoNewline

  $stub = Join-Path $work 'stub-tool.ps1'
  # The stub TALKS, because the real IntuneWinAppUtil.exe prints roughly twenty
  # INFO lines and a native command's stdout joins the success stream exactly as
  # Write-Output does. A silent stub passed this file while the real tool made
  # the function return its whole transcript with the path on the end.
  Set-Content -LiteralPath $stub -Encoding utf8 -Value @'
param([string] $c, [string] $s, [string] $o, [switch] $q)
Write-Output 'INFO   Validating parameters'
Write-Output 'INFO   Compressing the source folder'
$name = [System.IO.Path]::GetFileNameWithoutExtension($s) + '.intunewin'
Set-Content -LiteralPath (Join-Path $o $name) -Value 'package bytes' -NoNewline
Write-Output 'INFO   Done!!!'
exit 0
'@
  # Invoked through pwsh so the stub is executable on every host this test runs
  # on; the real tool is a native .exe and takes the identical flags.
  $shim = Join-Path $work 'shim.ps1'
  Set-Content -LiteralPath $shim -Encoding utf8 -Value "param([string] `$c, [string] `$s, [string] `$o, [switch] `$q)`n& '$stub' -c `$c -s `$s -o `$o -q:`$q`nexit `$LASTEXITCODE"

  $produced = @(Invoke-IonContentPrep -ToolPath $shim -SourceDir $src -SetupFile 'Install-Thing.ps1' -OutputDir $out)
  Assert-Equal 1 $produced.Count 'wrapping a package returns exactly one value'
  Assert-Equal $true ($produced[0] -is [string]) 'the produced package path is a string, not a stream'
  Assert-Equal $true (Test-Path -LiteralPath $produced[0]) 'the returned path is the package that was written'
  Assert-Equal 'Install-Thing.intunewin' (Split-Path -Leaf $produced[0]) 'the package is named after the setup file'

  # A tool that exits 0 without writing anything must not read as a success.
  $silent = Join-Path $work 'silent.ps1'
  Set-Content -LiteralPath $silent -Encoding utf8 -Value 'param([string] $c, [string] $s, [string] $o, [switch] $q)
exit 0'
  $threw = $false
  try { Invoke-IonContentPrep -ToolPath $silent -SourceDir $src -SetupFile 'Install-Thing.ps1' -OutputDir (Join-Path $work 'empty') | Out-Null }
  catch { $threw = $true }
  Assert-Equal $true $threw 'a tool that exits 0 without writing a package fails the build'
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Structural: no narration on the success stream ───────────────────────────
# Get-IonContentPrepTool cannot be exercised without the network, so its return
# shape is pinned structurally instead. Every line it emits must go to the host,
# because anything on the success stream becomes part of what it returns.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'IonContentPrepTool.ps1') -Raw
Assert-Equal $false ($source -match '(?m)^\s*Write-Output\b') `
  'no function in this file narrates onto the success stream it returns'

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) failure(s)" -ForegroundColor Red
  exit 1
}
Write-Host "`nIonContentPrepTool.test.ps1: OK" -ForegroundColor Green
exit 0
