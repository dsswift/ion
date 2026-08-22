import type { TabState } from '../../shared/types'

/** Registers a fallback tab when no persisted tabs exist. */
export async function registerInitialRestoredTab(args: {
  homeDir: string
  defaultBaseDirectory: string | null
  createTab: () => Promise<{ tabId: string }>
  update: (updater: (tabs: TabState[]) => TabState[]) => void
  finish: (tabId: string) => void
  fail: (error: string) => void
}): Promise<void> {
  const startDir = args.defaultBaseDirectory || args.homeDir
  const hasChosen = !!args.defaultBaseDirectory
  args.update((tabs) => tabs.map((tab, index) => index === 0 ? { ...tab, workingDirectory: startDir, hasChosenDirectory: hasChosen } : tab))
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { tabId } = await args.createTab()
      args.update((tabs) => tabs.map((tab, index) => index === 0 ? { ...tab, id: tabId } : tab))
      args.finish(tabId)
      return
    } catch {
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  args.fail('Could not create initial conversation tab')
}
