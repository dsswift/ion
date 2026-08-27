/**
 * Helpers shared by the browser tool families.
 */
import type { Page } from 'playwright-core'

/** URL and title, the two facts an agent checks after every mutation. */
export async function pageSummary(page: Page): Promise<{ url: string; title: string }> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  return { url, title }
}

/** Bounded snapshot appended after an action, so the agent sees the result. */
export async function briefSnapshot(page: Page, depth = 6): Promise<string> {
  try {
    return await page.locator('body').ariaSnapshot({ mode: 'ai', depth, timeout: 5_000 })
  } catch {
    // A snapshot is context, not the result. If the page is mid-navigation the
    // action still succeeded, so this must never turn a success into a failure.
    return ''
  }
}
