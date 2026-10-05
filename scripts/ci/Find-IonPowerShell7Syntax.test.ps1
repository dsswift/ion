<#
  Behaviour tests for Find-IonPowerShell7Syntax.ps1. Invoked by
  `make check-windows-scripts`.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Find-IonPowerShell7Syntax.ps1')

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

function Measure-Pwsh7Syntax([string] $Source) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
  @(Find-IonPowerShell7Syntax -Ast $ast).Count
}

Assert-Equal 1 (Measure-Pwsh7Syntax '$s = (Get-Command pwsh)?.Source') 'null-conditional member access is found'
Assert-Equal 1 (Measure-Pwsh7Syntax '$s = ${list}?[0]')                'null-conditional index is found'
Assert-Equal 1 (Measure-Pwsh7Syntax '$s = $a ?? "b"')                   'null-coalescing is found'
Assert-Equal 1 (Measure-Pwsh7Syntax '$s ??= "b"')                        'null-coalescing assignment is found'
Assert-Equal 1 (Measure-Pwsh7Syntax '$s = $a ? 1 : 2')                   'the ternary is found'
Assert-Equal 1 (Measure-Pwsh7Syntax 'git fetch && git status')           'a pipeline chain is found'

$plain = @'
$cmd = Get-Command pwsh -ErrorAction SilentlyContinue
$shell = if ($cmd) { $cmd.Source } else { 'powershell.exe' }
$first = $list[0]
if ($a -and $b) { $c = $a.Name }
'@
Assert-Equal 0 (Measure-Pwsh7Syntax $plain) 'syntax Windows PowerShell 5.1 parses is not reported'

$needsPwsh = @'
#Requires -Version 7
$s = (Get-Command pwsh)?.Source
'@
Assert-Equal 0 (Measure-Pwsh7Syntax $needsPwsh) 'a script that requires pwsh 7 is skipped'

if ($script:failures) {
  Write-Host "$script:failures failure(s)" -ForegroundColor Red
  exit 1
}
