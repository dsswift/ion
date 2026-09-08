/**
 * Cross-platform shell resolution for Studio terminal panes. Manifest
 * contract C9 (windows-mvp program).
 *
 * darwin/linux: the account's configured login shell (falls back to
 * /bin/zsh), spawned as an interactive login shell (`-il`).
 * win32: pwsh.exe if on PATH, else powershell.exe, else %COMSPEC%, else a
 * hardcoded cmd.exe path — there is no "login shell" concept on Windows, so
 * no args are needed for the cmd family and `-NoLogo` suppresses the
 * PowerShell banner (which would otherwise print before every prompt).
 */
import { userInfo as defaultUserInfo } from 'os'
import { delimiter, join } from 'path'
import { existsSync } from 'fs'

export type ShellFamily = 'zsh' | 'bash' | 'sh' | 'other' | 'pwsh' | 'powershell' | 'cmd'

export interface ShellResolution {
  shell: string
  args: string[]
  family: ShellFamily
  /** Which branch produced this resolution, for the startup log line. */
  reason: string
}

function familyOf(shellPath: string): ShellFamily {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath
  if (base === 'zsh') return 'zsh'
  if (base === 'bash') return 'bash'
  if (base === 'sh') return 'sh'
  return 'other'
}

/** Finds exe on one of PATH's directories (case-sensitive filename match). */
function findOnPath(exe: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolves the shell a new terminal pane spawns. Injectable env/account for
 * tests; production callers use the defaults.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  account: () => { shell?: string | null } = defaultUserInfo,
): ShellResolution {
  if (platform === 'win32') {
    for (const [exe, family] of [
      ['pwsh.exe', 'pwsh'],
      ['powershell.exe', 'powershell'],
    ] as const) {
      const found = findOnPath(exe, env.PATH)
      if (found) return { shell: found, args: ['-NoLogo'], family, reason: `${family}-on-path` }
    }
    if (env.COMSPEC) return { shell: env.COMSPEC, args: [], family: 'cmd', reason: 'comspec' }
    return { shell: 'C:\\Windows\\System32\\cmd.exe', args: [], family: 'cmd', reason: 'cmd-fallback' }
  }

  // Read from the account record rather than $SHELL, because $SHELL is
  // inherited from whatever launched Ion and is wrong exactly when it
  // matters (a package-installer launch supplies SHELL=/bin/sh). Guarded
  // because the account lookup can itself throw (or, as an injected test
  // double, return undefined) — either way this falls back to /bin/zsh
  // rather than letting the pane fail to spawn at all.
  let accountShell: string | undefined
  try {
    accountShell = account()?.shell?.trim() ?? undefined
  } catch {
    accountShell = undefined
  }
  if (accountShell) return { shell: accountShell, args: ['-il'], family: familyOf(accountShell), reason: 'account-shell' }
  return { shell: '/bin/zsh', args: ['-il'], family: 'zsh', reason: 'default-zsh' }
}
