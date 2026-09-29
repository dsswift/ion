/**
 * Installs the Ion Studio SDK beside the engine SDK under `~/.ion/extensions/`.
 *
 * The Studio SDK is how an extension extends Ion Studio. It is deliberately
 * not part of the engine SDK (the engine has no concept of a user interface),
 * so the engine's installer does not ship it. Studio owns it, and the desktop
 * that hosts Studio puts it where extensions can import it:
 *
 *   ~/.ion/extensions/studio-sdk/      TypeScript: `import { studio } from '../studio-sdk'`
 *   ~/.ion/extensions/studio-sdk-go/   Go: `replace … => ../../studio-sdk-go`
 *
 * It runs on every launch and rewrites a file only when its content differs,
 * so an upgraded desktop upgrades the SDK and a normal launch touches nothing.
 * A failure is logged and never blocks startup: an extension that needs the
 * SDK fails to build with a clear missing-module error, which is recoverable;
 * a desktop that refuses to start is not.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import { log as _log, warn as _warn } from './logger'

const TAG = 'studio-sdk-install'

/** One file to install: where it comes from (relative to the SDK source root) and where it lands (relative to `~/.ion/extensions`). */
export interface StudioSdkFile {
  from: string
  to: string
  /** Rewrites the content on the way through. */
  transform?: (content: string) => string
}

/**
 * Inside the repository the Go module reaches the engine SDK at
 * `../../../sdk/go`. Installed, the engine SDK is its sibling `../sdk-go`.
 */
export function rewriteGoModReplace(goMod: string): string {
  const rewritten = goMod.replace(
    /^replace github\.com\/dsswift\/ion\/sdk\/go => .*$/m,
    'replace github.com/dsswift/ion/sdk/go => ../sdk-go',
  )
  // Drop the comment that explains the in-repository path; it is false here.
  return rewritten.replace(/^\/\/ Inside the Ion repository[\s\S]*?(?=^replace )/m, '')
}

export const STUDIO_SDK_FILES: readonly StudioSdkFile[] = [
  { from: 'contract.json', to: 'studio-sdk/contract.json' },
  { from: 'ts/index.ts', to: 'studio-sdk/index.ts' },
  { from: 'ts/package.json', to: 'studio-sdk/package.json' },
  { from: 'contract.json', to: 'studio-sdk-go/contract.json' },
  { from: 'go/studio.go', to: 'studio-sdk-go/studio.go' },
  { from: 'go/go.mod', to: 'studio-sdk-go/go.mod', transform: rewriteGoModReplace },
]

/** The SDK source root: a packaged resource, or the repository in a dev run. */
export function resolveStudioSdkSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'studio-sdk')
    : join(app.getAppPath(), '..', 'packages', 'studio-sdk')
}

export interface StudioSdkInstallResult {
  written: string[]
  unchanged: string[]
  failed: string[]
}

/** Pure over its two directories, so it is tested without Electron. */
export function installStudioSdkFiles(sourceDir: string, extensionsDir: string): StudioSdkInstallResult {
  const result: StudioSdkInstallResult = { written: [], unchanged: [], failed: [] }
  for (const file of STUDIO_SDK_FILES) {
    const target = join(extensionsDir, file.to)
    try {
      const raw = readFileSync(join(sourceDir, file.from), 'utf-8')
      const content = file.transform ? file.transform(raw) : raw
      if (existsSync(target) && readFileSync(target, 'utf-8') === content) {
        result.unchanged.push(file.to)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      atomicWriteFileSync(target, content)
      result.written.push(file.to)
    } catch (err) {
      _warn(TAG, 'could not install a Studio SDK file', { file: file.to, error: String(err) })
      result.failed.push(file.to)
    }
  }
  return result
}

export function installStudioSdk(): void {
  const sourceDir = resolveStudioSdkSourceDir()
  if (!existsSync(sourceDir)) {
    _warn(TAG, 'Studio SDK source not found; extensions that import it will not build', { source_dir: sourceDir, packaged: app.isPackaged })
    return
  }
  const result = installStudioSdkFiles(sourceDir, join(homedir(), '.ion', 'extensions'))
  _log(TAG, 'Studio SDK install finished', {
    source_dir: sourceDir,
    written: result.written.length,
    unchanged: result.unchanged.length,
    failed: result.failed.length,
  })
}
