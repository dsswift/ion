<#
.SYNOPSIS
  Report syntax a script uses that only PowerShell 7 can parse.

.DESCRIPTION
  A stock Windows install ships Windows PowerShell 5.1 and no pwsh. The repo's
  parse gate runs under pwsh 7, which accepts null-conditional member access,
  `??`, the ternary, and `&&`/`||` chains, so a script using them passes here
  and fails to parse on the machine it was written for. This walks the AST
  pwsh 7 produces and names each such node.

  A script that needs pwsh 7 says so with `#Requires -Version 7`, which also
  makes Windows PowerShell 5.1 refuse it with a clear message; such a script is
  skipped.

  Dot-source for Find-IonPowerShell7Syntax, or run with file paths to print one
  `path:line: text` per finding and exit 1 when there is any.
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Path
)

function Find-IonPowerShell7Syntax {
  param([Parameter(Mandatory = $true)] [System.Management.Automation.Language.ScriptBlockAst] $Ast)

  $requires = $Ast.ScriptRequirements
  if ($requires -and $requires.RequiredPSVersion -and $requires.RequiredPSVersion.Major -ge 7) {
    return @()
  }

  $nodes = $Ast.FindAll({
      param($n)
      $n -is [System.Management.Automation.Language.TernaryExpressionAst] -or
      $n -is [System.Management.Automation.Language.PipelineChainAst] -or
      ($n -is [System.Management.Automation.Language.MemberExpressionAst] -and $n.NullConditional) -or
      ($n -is [System.Management.Automation.Language.IndexExpressionAst] -and $n.NullConditional) -or
      ($n -is [System.Management.Automation.Language.BinaryExpressionAst] -and $n.Operator -eq 'QuestionQuestion') -or
      ($n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Operator -eq 'QuestionQuestionEquals')
    }, $true)

  foreach ($n in $nodes) {
    [pscustomobject]@{
      Line = $n.Extent.StartLineNumber
      Text = $n.Extent.Text.Split("`n")[0].Trim()
    }
  }
}

if ($MyInvocation.InvocationName -ne '.' -and $Path) {
  $found = 0
  foreach ($p in $Path) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $p).Path, [ref]$tokens, [ref]$errors)
    foreach ($hit in Find-IonPowerShell7Syntax -Ast $ast) {
      Write-Host "${p}:$($hit.Line): $($hit.Text)"
      $found++
    }
  }
  if ($found) {
    [Console]::Error.WriteLine("Windows PowerShell 5.1 cannot parse $found construct(s) above. Rewrite them, or add '#Requires -Version 7' to a script that needs pwsh.")
    exit 1
  }
}
