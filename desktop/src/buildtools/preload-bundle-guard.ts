/**
 * Build-time guard: Electron preload bundles must be self-contained.
 *
 * A sandboxed preload script (`webPreferences.sandbox: true`) runs with a
 * restricted `require` that resolves `electron` and a subset of node builtins
 * and nothing else. A relative `require('./chunks/foo.js')` throws
 * "module not found" before a single line of the preload body executes, so the
 * bridge is never exposed: the renderer sees `window.ionapi === undefined` and
 * the window paints an empty frame that still swallows clicks.
 *
 * Rollup emits exactly that shape the moment two preload entries share a
 * module — the shared module is hoisted into `chunks/` and both entries
 * require it. The build layout is therefore load-bearing, and this guard fails
 * the build rather than shipping preloads that cannot load.
 */

/** One emitted preload artifact: path relative to the preload out dir. */
export interface EmittedPreloadFile {
  file: string
  code: string
}

/** A relative module load found inside an emitted preload bundle. */
export interface RelativePreloadLoad {
  file: string
  specifier: string
}

/**
 * Matches the three ways an emitted bundle can reference a sibling artifact:
 * a CJS `require('./x')`, a static `import ... from './x'`, and a dynamic
 * `import('./x')`. Specifiers are literal in emitted output, so a source-text
 * scan sees every one of them.
 */
const RELATIVE_LOAD =
  /(?:require\(\s*|import\s*\(\s*|from\s*)['"](\.\.?\/[^'"]+)['"]/g

/** Every relative module load in the given emitted preload artifacts. */
export function findRelativePreloadLoads(
  files: readonly EmittedPreloadFile[],
): RelativePreloadLoad[] {
  const found: RelativePreloadLoad[] = []
  for (const { file, code } of files) {
    RELATIVE_LOAD.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = RELATIVE_LOAD.exec(code)) !== null) {
      found.push({ file, specifier: match[1] })
    }
  }
  return found
}

/**
 * Throws when any emitted preload artifact loads a sibling file. Called from
 * the preload build so a split bundle fails `npm run build` instead of
 * reaching a packaged app as an invisible, click-eating window.
 */
export function assertSelfContainedPreloads(
  files: readonly EmittedPreloadFile[],
): void {
  const splits = findRelativePreloadLoads(files)
  if (splits.length === 0) return
  const detail = splits
    .map(({ file, specifier }) => `  ${file} -> ${specifier}`)
    .join('\n')
  throw new Error(
    'Preload bundle is not self-contained. A sandboxed preload cannot ' +
      'require sibling files, so these loads fail at runtime and the bridge ' +
      'is never exposed:\n' +
      detail +
      '\nBuild each preload entry as its own single-entry bundle ' +
      '(see selfContainedPreloadEntry in electron.vite.config.ts).',
  )
}
