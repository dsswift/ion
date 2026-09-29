/**
 * Redirect the process's notion of "home" for a git-fixture or homedir()-based
 * test, on every platform.
 *
 * Node's `os.homedir()` does not read the same environment variable
 * everywhere: on darwin/linux it reads `HOME`, but on win32 it reads
 * `USERPROFILE` (falling back to `HOMEDRIVE`+`HOMEPATH`) and ignores `HOME`
 * entirely. A test that isolates itself from the operator's real home by
 * setting only `process.env.HOME` therefore isolates nothing on Windows —
 * `os.homedir()` keeps returning the real profile directory, so a fixture's
 * workspace/config record lands somewhere the code under test never reads,
 * and every assertion that depends on the fixture being found silently sees
 * "nothing here" instead of the fixture's data (this is the same class of
 * defect fixed on the engine side in commit 18aefc4b9, "honor HOME on windows
 * so test isolation isolates" — this is its desktop-side counterpart).
 *
 * Setting both variables is correct on every platform: darwin/linux ignore
 * `USERPROFILE`, so setting it alongside `HOME` is a harmless no-op there.
 */
export interface SavedHomeEnv {
  HOME: string | undefined
  USERPROFILE: string | undefined
}

/** Capture the current values so they can be restored exactly in afterEach. */
export function saveHomeEnv(): SavedHomeEnv {
  return { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
}

/** Point both HOME and USERPROFILE at `path`. */
export function setHomeEnv(path: string): void {
  process.env.HOME = path
  process.env.USERPROFILE = path
}

/** Restore exactly what saveHomeEnv() captured, including "was unset". */
export function restoreHomeEnv(saved: SavedHomeEnv): void {
  if (saved.HOME === undefined) delete process.env.HOME
  else process.env.HOME = saved.HOME
  if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = saved.USERPROFILE
}
