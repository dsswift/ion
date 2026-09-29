import { execFileSync } from 'child_process'
import { debug as _debug } from '../../logger'

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Windows paths have no leading dot — AppData, ProgramData, and the legacy
 * junctions are all marked by the attribute alone. Without this they render
 * identically to ordinary source folders.
 *
 * One PowerShell call per listing rather than one per entry, and empty on
 * every non-Windows platform (where the dot prefix is the whole convention).
 * A failure returns empty rather than throwing: losing the dimming on a
 * directory is a cosmetic degradation, while failing the listing would empty
 * the tree.
 *
 * Exported so the file API (`files/file-api.ts`) computes the same
 * `isHidden` bit rather than reimplementing the probe — that listing is a
 * second consumer of the same fact, not a second definition of it.
 */
export function windowsHiddenNames(directory: string): Set<string> {
  if (process.platform !== 'win32') return new Set()
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        // -Force includes hidden entries; the Hidden attribute test is what
        // selects them. Names only, one per line.
        `Get-ChildItem -LiteralPath '${directory.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue | ` +
          'Where-Object { $_.Attributes -band [System.IO.FileAttributes]::Hidden } | ' +
          'ForEach-Object { $_.Name }',
      ],
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    )
    return new Set(out.split(/\r?\n/).map((n) => n.trim()).filter(Boolean))
  } catch (err) {
    debug('fs: windows hidden-attribute probe failed; entries render unhidden', {
      directory,
      error: String(err),
    })
    return new Set()
  }
}
