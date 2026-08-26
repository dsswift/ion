import type { BrowserWindow } from 'electron'

let resolveStudioWindow: () => BrowserWindow | null = () => null

/**
 * Supplies the Studio window to browser views without importing main state.
 *
 * Browser tool handlers load during engine startup. Importing state from the
 * view layer would re-enter state through that handler graph before it has
 * finished creating the engine bridge.
 */
export function setStudioBrowserWindowResolver(resolver: () => BrowserWindow | null): void {
  resolveStudioWindow = resolver
}

export function getStudioBrowserWindow(): BrowserWindow | null {
  return resolveStudioWindow()
}
