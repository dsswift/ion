/**
 * install-profile — what kind of install this server process is, when the
 * launcher says so.
 *
 * A Studio Server's safe default is isolation: several signed-in people may
 * share it, so nothing is visible across principals and a paired device
 * does not administer it. One person's own install is the opposite case --
 * every device that person pairs is theirs -- and it has to be stated, never
 * inferred. The headless installer states it in `server.json`
 * (`ion studio install` writes `tenancy.mode: shared` and adds `admin` to
 * the pairing scopes). A desktop's built-in server has no `server.json`, so
 * the desktop states it here instead: `ION_STUDIO_PROFILE=personal`.
 *
 * The profile only moves DEFAULTS. Anything `server.json` sets explicitly
 * wins, and `config/current.ts` steps the shared default back to isolated
 * when the engine has per-principal storage partitioning on.
 */
export type InstallProfile = 'personal' | 'standard'

export const INSTALL_PROFILE_ENV = 'ION_STUDIO_PROFILE'

export function installProfile(env: NodeJS.ProcessEnv = process.env): InstallProfile {
  return env[INSTALL_PROFILE_ENV] === 'personal' ? 'personal' : 'standard'
}
