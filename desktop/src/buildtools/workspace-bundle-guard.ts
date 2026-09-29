/**
 * Build-time guard: workspace packages that ship only TypeScript source must be
 * bundled into the main and preload artifacts, never left as runtime loads.
 *
 * `@ion/server` and `@ion/shared` are npm workspace members whose `exports`
 * maps point straight at `src/**.ts`. They are listed in desktop's
 * `dependencies` so npm links them, and electron-vite externalizes every
 * `dependencies` entry by default. Left external, the emitted bundle contains
 * `require("@ion/server/state")`, which the packaged app resolves to a `.ts`
 * file inside the asar. Electron's Node has no type stripping, so the CJS
 * loader falls through to the `.js` handler, detects ESM syntax, compiles it
 * as a module, and dies on the first type annotation:
 *
 *   SyntaxError: Unexpected token ':'
 *     at compileSourceTextModule (node:internal/modules/esm/utils)
 *     at ModuleLoader.importSyncForRequire
 *     at loadESMFromCJS
 *
 * That is a crash before the first line of the main process runs, with no log
 * line anywhere, because the logger is itself behind one of those requires. A
 * sandboxed preload fares no better: its restricted `require` resolves
 * `electron` and a few builtins and nothing else.
 *
 * The build config excludes these packages from externalization; this guard
 * fails the build if that exclusion ever stops covering an emitted artifact,
 * so the defect surfaces at `npm run build` rather than as a dialog on the
 * operator's desktop after install.
 */

/** One emitted artifact: path relative to its out dir, plus its source text. */
export interface EmittedBundleFile {
  file: string
  code: string
}

/** A workspace-source package load found inside an emitted bundle. */
export interface WorkspaceSourceLoad {
  file: string
  specifier: string
}

/**
 * The workspace packages that exist only as TypeScript source. Every one of
 * them must be inlined by rollup; none may survive as a runtime specifier.
 * Kept here, next to the guard, so the electron-vite config and the assertion
 * cannot drift apart.
 */
export const WORKSPACE_SOURCE_PACKAGES: readonly string[] = [
  '@ion/server',
  '@ion/shared',
]

/**
 * Matches the three ways an emitted bundle can load a module by bare
 * specifier: a CJS `require('x')`, a static `import ... from 'x'`, and a
 * dynamic `import('x')`. Specifiers are literal in emitted output, so a
 * source-text scan sees every one of them.
 */
const BARE_LOAD = /(?:require\(\s*|import\s*\(\s*|from\s*)['"]([^'"./][^'"]*)['"]/g

function isWorkspaceSourceSpecifier(
  specifier: string,
  packages: readonly string[],
): boolean {
  return packages.some(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  )
}

/** Every workspace-source package load in the given emitted artifacts. */
export function findWorkspaceSourceLoads(
  files: readonly EmittedBundleFile[],
  packages: readonly string[] = WORKSPACE_SOURCE_PACKAGES,
): WorkspaceSourceLoad[] {
  const found: WorkspaceSourceLoad[] = []
  for (const { file, code } of files) {
    BARE_LOAD.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = BARE_LOAD.exec(code)) !== null) {
      if (isWorkspaceSourceSpecifier(match[1], packages)) {
        found.push({ file, specifier: match[1] })
      }
    }
  }
  return found
}

/**
 * Throws when any emitted artifact loads a workspace-source package at
 * runtime. Called from the main and preload builds so a regression fails
 * `npm run build` instead of reaching a packaged app that cannot start.
 */
export function assertNoWorkspaceSourceLoads(
  files: readonly EmittedBundleFile[],
  packages: readonly string[] = WORKSPACE_SOURCE_PACKAGES,
): void {
  const loads = findWorkspaceSourceLoads(files, packages)
  if (loads.length === 0) return
  const detail = loads
    .map(({ file, specifier }) => `  ${file} -> ${specifier}`)
    .join('\n')
  throw new Error(
    'Bundle loads a workspace package at runtime. These packages ship only ' +
      'TypeScript source, which the packaged app cannot load (SyntaxError: ' +
      "Unexpected token ':' in the main process; module-not-found in a " +
      'sandboxed preload):\n' +
      detail +
      '\nThey must be bundled in: keep them listed under ' +
      'build.externalizeDeps.exclude in electron.vite.config.ts ' +
      '(see WORKSPACE_SOURCE_PACKAGES in workspace-bundle-guard.ts).',
  )
}
