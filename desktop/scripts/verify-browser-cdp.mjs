/**
 * Live CDP integration check for the Studio browser surface.
 *
 * WHY THIS EXISTS: the unit tests mock `pageForTarget`, so they proved the
 * logic above the attach seam and nothing about the seam itself. That is
 * exactly how a `<webview>` body shipped: every test passed while no browser
 * tool could work, because Chromium reports a `<webview>` as a CDP target of
 * type `webview` and Playwright only converts `page`/`iframe`/`frame` targets
 * into objects. The guest was invisible to `context.pages()` forever.
 *
 * This script is the check that mocking cannot do. It talks to the RUNNING
 * app over its real DevTools endpoint and asserts that the Studio browser tab
 * is a target Playwright can actually attach to.
 *
 * Run it against a live Ion with a browser tab open:
 *   node scripts/verify-browser-cdp.mjs
 *
 * It is a script rather than a vitest case on purpose: it requires a running
 * desktop app with an open browser tab, which CI does not have.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const PORT_FILE = join(homedir(), 'Library', 'Application Support', 'Ion', 'DevToolsActivePort')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const port = (() => {
  try {
    return readFileSync(PORT_FILE, 'utf8').split('\n')[0].trim()
  } catch (err) {
    fail(`cannot read ${PORT_FILE} (is Ion running?): ${err.message}`)
  }
})()

const endpoint = `http://127.0.0.1:${port}`
const targets = await fetch(`${endpoint}/json/list`).then((r) => r.json()).catch((err) => fail(`DevTools endpoint unreachable: ${err.message}`))

const browserTabs = targets.filter((t) => t.url && !t.url.startsWith('file:///') && t.type !== 'browser')
console.log(`CDP targets: ${targets.length}`)
for (const t of targets) console.log(`  - ${t.type.padEnd(10)} ${String(t.url).slice(0, 64)}`)

// The regression this file exists to prevent. A browser tab reported as
// `webview` can never be driven, no matter what the resolver does.
const webviewTargets = targets.filter((t) => t.type === 'webview')
if (webviewTargets.length > 0) {
  fail(
    `${webviewTargets.length} browser guest(s) are CDP type "webview". Playwright cannot attach to those, ` +
    'so every browser tool would fail. The Studio browser body must be a WebContentsView.',
  )
}

const { chromium } = require('playwright-core')
const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts().flatMap((c) => c.pages())
  console.log(`playwright pages: ${pages.length}`)
  for (const p of pages) console.log(`  - ${p.url().slice(0, 70)}`)

  if (browserTabs.length > 0 && pages.length <= 2) {
    fail('a browser tab is open but Playwright sees only the renderer pages; the guest is not attachable')
  }
  console.log('PASS: every Studio browser guest is attachable by Playwright')
} finally {
  // Never browser.close(): on a CDP connection that asks the real Electron
  // app to exit.
  process.exit(0)
}
