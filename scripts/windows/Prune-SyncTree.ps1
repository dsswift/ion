# Removes every file under the given source roots that the sync's tracked-file
# list does not name. The sync's tar extraction adds and overwrites but never
# deletes, so without this a file deleted from git keeps running on the VM.
# Dependency and build folders are left alone. Prints the number removed.
param(
  [Parameter(Mandatory)] [string] $Base,
  [Parameter(Mandatory)] [string[]] $Roots
)
$ErrorActionPreference = 'Stop'
# -File hands a comma list over as one string, not an array.
$Roots = $Roots | ForEach-Object { $_ -split ',' } | Where-Object { $_ }

$base = (Resolve-Path -LiteralPath $Base).Path
$keep = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($line in Get-Content -LiteralPath (Join-Path $base '.ion-sync-files.txt')) {
  [void]$keep.Add($line.Replace('/', '\'))
}

$skip = '\\(node_modules|dist|out|release|build|bin|\.vite)\\'
$pruned = 0
foreach ($root in $Roots) {
  $dir = Join-Path $base $root
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch $skip } |
    ForEach-Object {
      $rel = $_.FullName.Substring($base.Length + 1)
      if (-not $keep.Contains($rel)) {
        Remove-Item -LiteralPath $_.FullName -Force
        $pruned++
      }
    }
}
Write-Output $pruned
