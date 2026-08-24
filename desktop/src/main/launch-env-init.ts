/**
 * Launch-environment repair, run as an import side effect.
 *
 * This module exists because ES import declarations are hoisted: a plain
 * `sanitizeLaunchEnvironment()` call written between two imports in index.ts
 * would still execute AFTER every one of those modules had been evaluated. A
 * side-effect import runs in source order, so importing this file first is what
 * actually guarantees the repair happens before any other main-process module
 * reads or spawns from `process.env`.
 *
 * The ordering is load-bearing rather than defensive. `cli-env.ts` probes PATH
 * with `execFileSync`, which inherits `process.env` directly. If the privilege
 * marker is still set at that moment, the probe shell skips the operator's
 * startup files, reports the bare system PATH, finds nothing new, and the
 * desktop caches a stripped PATH for the rest of its life.
 */
import { sanitizeLaunchEnvironment } from './launch-env'

sanitizeLaunchEnvironment()
