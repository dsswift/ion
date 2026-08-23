// Test setup: isolate every Vitest worker from the operator's real home, then
// backfill browser globals that renderer modules touch at import time. Runs in
// every test file (node and jsdom environments alike).
//
// Main-process modules resolve durable state through os.homedir(). A test that
// imports one of those modules without its own os mock must still be unable to
// write ~/.ion. Keep one temporary home per worker process so setup files and
// test modules agree on every lazy state path. Read-only real-data smoke tests
// use ION_REAL_HOME explicitly.
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

function installTestHome(): void {
  const existing = process.env.ION_VITEST_HOME
  if (existing) {
    process.env.HOME = existing
    process.env.USERPROFILE = existing
    return
  }

  const realHome = homedir()
  const testHome = mkdtempSync(join(tmpdir(), 'ion-vitest-home-'))
  mkdirSync(join(testHome, '.ion'), { recursive: true })
  process.env.ION_REAL_HOME = realHome
  process.env.ION_VITEST_HOME = testHome
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.once('exit', () => rmSync(testHome, { recursive: true, force: true }))
}

// `localStorage` is the only browser global that needs backfilling: jsdom does not
// expose a working `localStorage` in this runner configuration, and the
// preferences store reads it synchronously at module load. A minimal in-memory
// implementation keeps those imports side-effect-safe without pulling in a full
// DOM for logic tests. Component tests that need real DOM APIs still opt into
// jsdom via the `// @vitest-environment jsdom` docblock; this shim is harmless
// there because it only installs when `localStorage` is missing or non-functional.
function installLocalStorageShim(): void {
  const g = globalThis as unknown as { localStorage?: Storage }
  const hasWorking =
    typeof g.localStorage?.getItem === 'function' &&
    typeof g.localStorage?.setItem === 'function'
  if (hasWorking) return

  const store = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: shim,
  })
}

// jsdom does not implement Element.prototype.scrollIntoView. Any component that
// calls el.scrollIntoView(...) (e.g. inside a requestAnimationFrame callback)
// will throw a TypeError in jsdom-based renderer tests, which vitest surfaces as
// an unhandled error that can cause false positives. This no-op stub covers all
// renderer tests globally so no individual test needs to polyfill it.
function installScrollIntoViewStub(): void {
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function () { /* no-op in jsdom */ }
  }
}

// jsdom does not implement ResizeObserver. `useViewportClamp` constructs one to
// re-clamp a popover when its content grows, so every jsdom test that renders a
// popover would throw at layout-effect time without this. The stub is inert:
// tests that need to assert re-clamping drive it through the resize listener or
// a re-render instead.
function installResizeObserverStub(): void {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (typeof g.ResizeObserver === 'function') return
  g.ResizeObserver = class {
    observe(): void { /* no-op in jsdom */ }
    unobserve(): void { /* no-op in jsdom */ }
    disconnect(): void { /* no-op in jsdom */ }
  }
}

installTestHome()
installLocalStorageShim()
installScrollIntoViewStub()
installResizeObserverStub()
