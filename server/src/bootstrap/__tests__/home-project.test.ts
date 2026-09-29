/**
 * Pins ensureHomeProject's two contracts: it clones the configured repo
 * ONLY when the target directory is absent (never touches an existing
 * path), and it idempotently converges settings.json's engineProfiles,
 * projects[path], and defaultBaseDirectory to match config on every call --
 * self-healing whatever another save path did to them since the last boot.
 *
 * Regression context: this whole module exists because a personal
 * instance's home-project registration was previously applied by hand
 * (kubectl exec-ing JSON edits onto the live pod) and silently disappeared
 * across a redeploy. `readSettings`/`writeSettings`/`runGit`/`fs` are all
 * mocked so these tests exercise the real convergence logic without a real
 * disk or a real git clone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { existsSyncMock, mkdirSyncMock, copyFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
}))
vi.mock('fs', () => ({ existsSync: existsSyncMock, mkdirSync: mkdirSyncMock, copyFileSync: copyFileSyncMock }))

vi.mock('../../paths', () => ({ dataDir: () => '/data' }))

const { readSettingsMock, writeSettingsMock } = vi.hoisted(() => ({
  readSettingsMock: vi.fn(),
  writeSettingsMock: vi.fn(),
}))
vi.mock('../../persistence/settings-store', () => ({ readSettings: readSettingsMock, writeSettings: writeSettingsMock }))

const { runGitMock } = vi.hoisted(() => ({ runGitMock: vi.fn() }))
vi.mock('../../git/git-runner', () => ({ runGit: runGitMock }))

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { ensureHomeProject } from '../home-project'
import type { ServerHomeProjectConfig } from '../../config/server-config'

const CONFIG: ServerHomeProjectConfig = {
  directory: '/data/home/jsprague/orion',
  gitRemote: 'git@gitlab.dcim.com:cloud/ops.git',
  engineProfile: { name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' },
}

/** existsSync is called for several distinct paths -- the project directory itself, the writable bootstrap known_hosts, and the mounted one. Default: nothing exists yet, except tests override the project directory's own check explicitly via `setDirectoryExists`. */
function setDirectoryExists(exists: boolean): void {
  existsSyncMock.mockImplementation((p: string) => (p === CONFIG.directory ? exists : false))
}

beforeEach(() => {
  existsSyncMock.mockReset()
  mkdirSyncMock.mockReset()
  copyFileSyncMock.mockReset()
  readSettingsMock.mockReset()
  writeSettingsMock.mockReset()
  runGitMock.mockReset()
  runGitMock.mockResolvedValue('')
  setDirectoryExists(false)
})

describe('ensureHomeProject', () => {
  it('is a no-op when server.json.homeProject is absent', async () => {
    await ensureHomeProject(null)
    expect(runGitMock).not.toHaveBeenCalled()
    expect(readSettingsMock).not.toHaveBeenCalled()
  })

  it('clones the repo when the directory does not exist', async () => {
    setDirectoryExists(false)
    readSettingsMock.mockReturnValue({})

    await ensureHomeProject(CONFIG)

    expect(runGitMock).toHaveBeenCalledTimes(1)
    const [, args, env] = runGitMock.mock.calls[0]
    expect(args).toEqual(['clone', CONFIG.gitRemote, CONFIG.directory])
    // Its own known_hosts handling (see bootstrapGitEnv's doc comment), not
    // a passthrough of the pod-level GIT_SSH_COMMAND.
    expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new')
    expect(env.GIT_SSH_COMMAND).toContain('/data/home-project-known-hosts')
  })

  it('seeds the bootstrap known_hosts file from the mounted one when neither exists yet', async () => {
    setDirectoryExists(false)
    existsSyncMock.mockImplementation((p: string) => {
      if (p === CONFIG.directory) return false
      if (p === '/data/home-project-known-hosts') return false
      if (p === '/etc/git-secret/known_hosts') return true
      return false
    })
    readSettingsMock.mockReturnValue({})

    await ensureHomeProject(CONFIG)

    expect(copyFileSyncMock).toHaveBeenCalledWith('/etc/git-secret/known_hosts', '/data/home-project-known-hosts')
  })

  it('never clones when the directory already exists', async () => {
    setDirectoryExists(true)
    readSettingsMock.mockReturnValue({})

    await ensureHomeProject(CONFIG)

    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('still registers the project even when the clone fails', async () => {
    setDirectoryExists(false)
    readSettingsMock.mockReturnValue({})
    runGitMock.mockRejectedValue(new Error('network unreachable'))

    await ensureHomeProject(CONFIG)

    expect(writeSettingsMock).toHaveBeenCalledTimes(1)
  })

  it('registers the engine profile, the project as sole default, and defaultBaseDirectory on an empty settings.json', async () => {
    setDirectoryExists(true)
    readSettingsMock.mockReturnValue({})

    await ensureHomeProject(CONFIG)

    expect(writeSettingsMock).toHaveBeenCalledTimes(1)
    const written = writeSettingsMock.mock.calls[0][0]
    expect(written.engineProfiles).toEqual([
      { id: 'cos2', name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' },
    ])
    expect(written.projects[CONFIG.directory]).toMatchObject({
      isDefault: true,
      profileOverride: { kind: 'profile', profileId: 'cos2' },
    })
    expect(written.defaultBaseDirectory).toBe(CONFIG.directory)
    expect(written.projectSettingsVersion).toBe(1)
  })

  it('is idempotent: a second call against already-correct settings writes nothing', async () => {
    setDirectoryExists(true)
    const alreadyCorrect = {
      engineProfiles: [{ id: 'cos2', name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' }],
      projects: {
        [CONFIG.directory]: {
          addedManually: true, lastUsedAt: 12345, isDefault: true,
          profileOverride: { kind: 'profile', profileId: 'cos2' },
        },
      },
      defaultBaseDirectory: CONFIG.directory,
      projectSettingsVersion: 1,
    }
    readSettingsMock.mockReturnValue(alreadyCorrect)

    await ensureHomeProject(CONFIG)

    expect(writeSettingsMock).not.toHaveBeenCalled()
  })

  it('regression: sets projectSettingsVersion=1 so the client never re-runs the legacy profile migration that strips profileOverride', async () => {
    // Exactly the state found live 2026-09-16: home-project registration was
    // otherwise fully correct, but projectSettingsVersion was never set, so
    // preferences-persist.ts's loadPersistedSettings() treated the modern
    // projects entry as unmigrated legacy data on every single client load
    // and silently discarded profileOverride via migrateProjectRegistry() --
    // observed as cos2 never appearing as the default engine profile despite
    // settings.json on disk being correct the whole time.
    setDirectoryExists(true)
    readSettingsMock.mockReturnValue({
      engineProfiles: [{ id: 'cos2', name: 'cos2', extensions: ['/data/.ion/extensions/cos2/main'], defaultMode: 'auto' }],
      projects: {
        [CONFIG.directory]: {
          addedManually: true, lastUsedAt: 12345, isDefault: true,
          profileOverride: { kind: 'profile', profileId: 'cos2' },
        },
      },
      defaultBaseDirectory: CONFIG.directory,
      // projectSettingsVersion absent, matching the live incident exactly.
    })

    await ensureHomeProject(CONFIG)

    expect(writeSettingsMock).toHaveBeenCalledTimes(1)
    const written = writeSettingsMock.mock.calls[0][0]
    expect(written.projectSettingsVersion).toBe(1)
  })

  it('preserves an unrelated existing project, clearing only its isDefault flag', async () => {
    setDirectoryExists(true)
    readSettingsMock.mockReturnValue({
      projects: {
        '/data/home/jsprague/other-repo': {
          addedManually: true, lastUsedAt: 999, isDefault: true, name: 'My Other Repo',
        },
      },
    })

    await ensureHomeProject(CONFIG)

    const written = writeSettingsMock.mock.calls[0][0]
    expect(written.projects['/data/home/jsprague/other-repo']).toEqual({
      addedManually: true, lastUsedAt: 999, isDefault: false, name: 'My Other Repo',
    })
    expect(written.projects[CONFIG.directory].isDefault).toBe(true)
  })

  it('self-heals a corrupted registration from a prior save (the production incident)', async () => {
    setDirectoryExists(true)
    // Exactly the state found live 2026-09-16: an unrelated save had frozen
    // an empty projects map into the identity's settings, wiping the home
    // project's registration entirely.
    readSettingsMock.mockReturnValue({ projects: {} })

    await ensureHomeProject(CONFIG)

    const written = writeSettingsMock.mock.calls[0][0]
    expect(written.projects[CONFIG.directory]).toMatchObject({ isDefault: true })
  })
})
