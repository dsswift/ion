/**
 * Live check: does a Studio browser guest present itself as plain Chrome?
 *
 * Google's and Microsoft's sign-in pages refuse a browser whose identity
 * carries an embedded-framework tag (`Electron/…`). Unit tests pin the string
 * transform; this asks the RUNNING app what a real page sees, which is the
 * only thing a sign-in page will ever look at.
 *
 * Run it against a live Ion with a browser tab open:
 *   node scripts/verify-browser-identity.mjs
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

const { chromium } = require('playwright-core')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
try {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith('file:///') && !p.url().startsWith('devtools:'))
  if (pages.length === 0) fail('no browser tab is open; open one in Studio and rerun')
  let bad = 0
  for (const page of pages) {
    const identity = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData?.brands?.map((b) => b.brand) ?? [],
      webdriver: navigator.webdriver,
    }))
    const embedded = /Electron\//.test(identity.userAgent) || identity.brands.some((b) => /electron/i.test(b))
    console.log(`${embedded || identity.webdriver ? 'BAD ' : 'ok  '} ${page.url().slice(0, 60)}`)
    console.log(`     ua: ${identity.userAgent}`)
    console.log(`     brands: ${identity.brands.join(', ') || '(none)'}  webdriver: ${identity.webdriver}`)
    if (embedded || identity.webdriver) bad += 1
  }
  if (bad > 0) fail(`${bad} guest(s) still present as an embedded or automated browser`)
  console.log('PASS: every Studio browser guest presents as plain Chrome')
} finally {
  // Never browser.close(): over CDP that asks the real Electron app to exit.
  process.exit(0)
}
