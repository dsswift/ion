/**
 * Tests for launch-environment repair.
 *
 * THE DEFECT (the reason this file exists):
 * The desktop package installer launches Ion from a postinstall script, so the
 * app inherits the Installer's script environment. That environment contains
 * `APPLE_PKGKIT_ESCALATING_ROOT`, and Apple's shipped /bin/zsh and /bin/bash
 * treat that variable as an order to run with the PRIVILEGED option on. A
 * privileged zsh reads ONLY the system startup files and skips every user file
 * — ~/.zshenv, ~/.zprofile, ~/.zshrc — even with -i and -l, even with a real
 * PTY, even running as the real user.
 *
 * Observable on a live installed build:
 *
 *   env -i HOME=$HOME USER=$USER PATH=/bin:/usr/bin /bin/zsh -ilc 'echo $PATH'
 *     -> the operator's full PATH (Homebrew, ~/.local/bin, ~/.ion/bin)
 *   env -i HOME=$HOME USER=$USER PATH=/bin:/usr/bin \
 *       APPLE_PKGKIT_ESCALATING_ROOT=1 /bin/zsh -ilc 'echo $PATH'
 *     -> only the system path_helper PATH; no Starship, no Zoxide
 *
 * Two earlier fixes changed the shell (account shell) and the shell arguments
 * (`-il`) and neither could work, because the shell and the arguments were
 * never the problem: the shell obeyed an inherited environment variable. The
 * contamination also reaches PATH discovery, which spawns its probe shells
 * with the same inherited environment, so the desktop cached a stripped PATH.
 *
 * The environment below is a real capture from `launchctl procinfo` of an
 * installed Ion launched by the package installer, with identities replaced by
 * placeholders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}))

import {
  planLaunchEnvironmentSanitization,
  sanitizeLaunchEnvironment,
  stripPrivilegeEscalation,
  PRIVILEGE_ESCALATION_VAR,
  type LaunchEnvironmentAccount,
} from '../launch-env'

/** The account the process actually runs as. */
const ACCOUNT: LaunchEnvironmentAccount = {
  username: 'operator',
  homedir: '/Users/operator',
  shell: '/bin/zsh',
}

/**
 * A real installer-launched environment (identities replaced).
 *
 * Note `LOGNAME=root` alongside a process running as the console user, and
 * `SHELL=/bin/sh`: the installer's script identity, inherited wholesale.
 */
function installerEnv(): NodeJS.ProcessEnv {
  return {
    OSLogRateLimit: '64',
    PWD: '/private/tmp/PKInstallSandbox.Ovg7IL/Scripts/com.sprague.ion.desktop.f9fQ1p',
    MallocNanoZone: '0',
    USER: 'operator',
    DSTROOT: '/Applications',
    INSTALLER_SECURE_TEMP: '/Library/InstallerSandboxes/.PKInstallSandboxManager/A/activeSandbox/B',
    SCRIPT_NAME: 'postinstall',
    LANG: 'C.UTF-8',
    __CFBundleIdentifier: 'com.sprague.ion.desktop',
    COMMAND_MODE: 'unix2003',
    APPLE_PKGKIT_ESCALATING_ROOT: '1',
    PATH: '/bin:/sbin:/usr/bin:/usr/sbin:/usr/libexec',
    DSTVOLUME: '/System/Volumes/Data',
    LOGNAME: 'root',
    SHARED_INSTALLER_TEMP: '/private/var/folders/zz/C/PKInstallSandboxManager-shared-tmp',
    INSTALLER_TEMP: '/private/tmp/PKInstallSandbox.Ovg7IL/tmp',
    PACKAGE_PATH: '/Users/operator/release/Ion.pkg',
    SHLVL: '1',
    PYTHONNOUSERSITE: '1',
    SHELL: '/bin/sh',
    LAUNCHCTL_ENV_REEXEC: '1',
    HOME: '/Users/operator',
    INSTALL_PKG_SESSION_ID: 'com.sprague.ion.desktop',
    INSTALLER_PAYLOAD_DIR: '/Library/InstallerSandboxes/.PKInstallSandboxManager/A/activeSandbox/Root',
    TMPDIR: '/private/tmp/PKInstallSandbox.Ovg7IL/tmp',
  }
}

/** A normal user launch: nothing to repair. */
function normalEnv(): NodeJS.ProcessEnv {
  return {
    USER: 'operator',
    LOGNAME: 'operator',
    HOME: '/Users/operator',
    SHELL: '/bin/zsh',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    TMPDIR: '/var/folders/t_/T/',
  }
}

/** Every installer sandbox path is gone by the time the app is running. */
const dirExists = (path: string): boolean => !path.includes('PKInstallSandbox')

describe('planLaunchEnvironmentSanitization', () => {
  it('removes the marker that makes zsh skip the user startup files', () => {
    const plan = planLaunchEnvironmentSanitization(installerEnv(), ACCOUNT, dirExists)

    // This single assertion is the whole bug: with the variable present, no
    // shell Ion starts will ever read ~/.zshrc, whatever shell or args it uses.
    expect(plan.privileged).toBe(true)
    expect(plan.remove).toContain(PRIVILEGE_ESCALATION_VAR)
  })

  it('restores the account identity the installer overwrote', () => {
    const plan = planLaunchEnvironmentSanitization(installerEnv(), ACCOUNT, dirExists)

    // LOGNAME=root is the installer's identity; a shell that believes it is
    // root resolves the wrong home and the wrong per-user tool state.
    expect(plan.correct.LOGNAME).toMatchObject({ from: 'root', to: 'operator' })
    // SHELL=/bin/sh is what made $SHELL-based resolution pick the wrong shell.
    expect(plan.correct.SHELL).toMatchObject({ from: '/bin/sh', to: '/bin/zsh' })
    // Already correct, so not rewritten.
    expect(plan.correct.USER).toBeUndefined()
    expect(plan.correct.HOME).toBeUndefined()
  })

  it('drops installer sandbox paths that no longer exist', () => {
    const plan = planLaunchEnvironmentSanitization(installerEnv(), ACCOUNT, dirExists)

    // Installer deletes its sandbox when the package finishes, so PWD and
    // TMPDIR point at directories that are gone before the first pane opens.
    expect(plan.remove).toContain('PWD')
    expect(plan.remove).toContain('INSTALLER_TEMP')
    expect(plan.remove).toContain('DSTROOT')
    const repaired = plan.correct.TMPDIR?.to ?? null
    const dropped = plan.remove.includes('TMPDIR')
    expect(repaired !== null || dropped).toBe(true)
    if (repaired) expect(repaired).not.toContain('PKInstallSandbox')
  })

  it('leaves a normal user launch completely untouched', () => {
    const plan = planLaunchEnvironmentSanitization(normalEnv(), ACCOUNT, dirExists)

    expect(plan.contaminated).toBe(false)
    expect(plan.privileged).toBe(false)
    expect(plan.remove).toEqual([])
    expect(plan.correct).toEqual({})
  })

  it('does not rewrite identity without installer provenance', () => {
    // An operator may deliberately run with SHELL=/bin/sh. Absent the markers
    // that prove an installer launch, that is a choice, not contamination —
    // overwriting it from the account record would be a guess.
    const env: NodeJS.ProcessEnv = { ...normalEnv(), SHELL: '/bin/sh', LOGNAME: 'someone-else' }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.contaminated).toBe(false)
    expect(plan.correct).toEqual({})
  })

  it('repairs a dangling TMPDIR even in an uncontaminated environment', () => {
    // Non-existence is a fact rather than an inference, so it is acted on with
    // or without installer markers: a dangling TMPDIR breaks every child that
    // writes a temporary file.
    const env: NodeJS.ProcessEnv = { ...normalEnv(), TMPDIR: '/private/tmp/PKInstallSandbox.X/tmp' }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.contaminated).toBe(false)
    const repaired = plan.correct.TMPDIR?.to ?? null
    const dropped = plan.remove.includes('TMPDIR')
    expect(repaired !== null || dropped).toBe(true)
    if (repaired) expect(repaired).not.toContain('PKInstallSandbox')
  })

  it('reports every installer marker it found', () => {
    const plan = planLaunchEnvironmentSanitization(installerEnv(), ACCOUNT, dirExists)

    // The marker list is the log evidence that says WHY the repair happened.
    expect(plan.markers).toContain(PRIVILEGE_ESCALATION_VAR)
    expect(plan.markers).toContain('INSTALL_PKG_SESSION_ID')
    expect(plan.contaminated).toBe(true)
  })
})

describe('stripPrivilegeEscalation', () => {
  it('removes the marker and reports that it did', () => {
    const env: NodeJS.ProcessEnv = { [PRIVILEGE_ESCALATION_VAR]: '1', PATH: '/usr/bin' }

    expect(stripPrivilegeEscalation(env)).toBe(true)
    expect(env[PRIVILEGE_ESCALATION_VAR]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('reports false when there was nothing to strip', () => {
    expect(stripPrivilegeEscalation({ PATH: '/usr/bin' })).toBe(false)
  })
})

describe('sanitizeLaunchEnvironment', () => {
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    saved = { ...process.env }
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  it('clears the marker from process.env so later spawns read user rc files', () => {
    // process.env is what execFileSync and node-pty inherit. Leaving the marker
    // there is what made PATH discovery probe with a privileged shell and cache
    // a stripped PATH for the rest of the process lifetime.
    process.env[PRIVILEGE_ESCALATION_VAR] = '1'
    process.env.INSTALL_PKG_SESSION_ID = 'com.sprague.ion.desktop'

    const plan = sanitizeLaunchEnvironment()

    expect(plan.privileged).toBe(true)
    expect(process.env[PRIVILEGE_ESCALATION_VAR]).toBeUndefined()
    expect(process.env.INSTALL_PKG_SESSION_ID).toBeUndefined()
  })
})
