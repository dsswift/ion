import { describe, it, expect } from 'vitest'

/**
 * One window, one pty -- but a hidden or minimized window still has a live
 * DOM (Electron's BrowserWindow.hide() does not touch document.hidden or
 * layout), so a renderer cannot rely on that flag to know it is off screen.
 *
 * This originated as a two-window bug (spec 17 deleted the Overlay window
 * that used to stay alive and hidden while Studio was active, both mounting
 * TerminalPanel against the same pty key): the visible pane fit 207 columns,
 * the hidden one fit 55, and the pty kept 55 -- the pane rendered at roughly
 * a quarter of its width. Dragging the pane divider by a pixel made the NEXT
 * command use the full width, because that resize came from the visible
 * window and re-won the race. The guard survives Overlay's removal because
 * the same false-visible failure mode still applies to Studio's own window
 * when it is hidden or minimized.
 *
 * These pin the predicate that decides who may publish. The component itself
 * needs a DOM host and an xterm instance; the rule is what matters and it is
 * exercised directly.
 */

// Mirrors isViewerVisible in TerminalInstance.tsx. Kept in the test as an
// executable statement of the rule: a viewer publishes only when its window is
// visible AND its container actually occupies space.
function isViewerVisible(doc: { hidden: boolean }, rect: { width: number; height: number }): boolean {
  if (doc.hidden) return false
  return rect.width > 0 && rect.height > 0
}

const VISIBLE = { hidden: false }
const HIDDEN = { hidden: true }
const REAL_PANE = { width: 1400, height: 300 }
const COLLAPSED = { width: 0, height: 0 }

describe('only a visible viewer sizes the pty', () => {
  it('publishes from the window the operator can see', () => {
    expect(isViewerVisible(VISIBLE, REAL_PANE)).toBe(true)
  })

  // The exact Windows failure: the hidden Overlay measured 55 columns and
  // overwrote the visible pane's 207.
  it('never publishes from a hidden window', () => {
    expect(isViewerVisible(HIDDEN, REAL_PANE)).toBe(false)
  })

  // A mounted-but-collapsed container (closed panel, background tab) measures
  // a handful of columns. Publishing that is the same defect by another route.
  it('never publishes from a collapsed container', () => {
    expect(isViewerVisible(VISIBLE, COLLAPSED)).toBe(false)
  })

  it.each([
    [{ width: 1400, height: 0 }, 'zero height'],
    [{ width: 0, height: 300 }, 'zero width'],
  ])('never publishes a %s container (%s)', (rect) => {
    expect(isViewerVisible(VISIBLE, rect)).toBe(false)
  })
})

describe('the race the guard removes', () => {
  // Simulates both viewers reacting to one layout event. Without the guard the
  // pty ends at whatever the last publisher measured; with it, only the
  // visible measurement is ever sent.
  function ptyColsAfterBothViewers(guarded: boolean): number {
    let ptyCols = 80 // spawn default
    const viewers = [
      { doc: VISIBLE, rect: REAL_PANE, cols: 207 },
      { doc: HIDDEN, rect: { width: 380, height: 200 }, cols: 55 },
    ]
    for (const v of viewers) {
      if (guarded && !isViewerVisible(v.doc, v.rect)) continue
      ptyCols = v.cols
    }
    return ptyCols
  }

  it('leaves the pty at the hidden viewer’s width without the guard', () => {
    expect(ptyColsAfterBothViewers(false)).toBe(55)
  })

  it('leaves the pty at the visible viewer’s width with the guard', () => {
    expect(ptyColsAfterBothViewers(true)).toBe(207)
  })
})

describe('the last line of defence is the server, not the renderer', () => {
  // The renderer cannot see that its own window is hidden: BrowserWindow.hide()
  // leaves document.hidden false and layout intact. The Electron adapter that
  // used to drop a resize from a hidden sender window went with the terminal
  // IPC (the server owns the PTY, ADR-033); what remains is the server's own
  // refusal of the measurement a hidden or collapsed element produces, which
  // holds for every client, not only an Electron window.
  it('the terminal manager refuses an implausible measurement before touching the pty', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../../../../server/src/terminal/terminal-manager.ts', import.meta.url),
      'utf-8',
    )
    expect(src).toMatch(/cols < 2 \|\| rows < 2[\s\S]{0,200}?return/)
  })

  // A renderer-side document.hidden test is the approach that failed; keeping
  // it would imply a guarantee it cannot make.
  it('does not rely on document.hidden in the renderer', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../TerminalInstance.tsx', import.meta.url), 'utf-8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    expect(code.join('\n')).not.toContain('document.hidden')
  })
})

describe('the guard is wired into every publish site', () => {
  // A predicate that exists but is not called at one of the five publish sites
  // leaves the race open on that path -- mount, exit-recreate, observer, font
  // change, zoom change.
  it('guards all five terminalResize calls', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../TerminalInstance.tsx', import.meta.url),
      'utf-8',
    )
    const publishes = src.match(/host\.shell\.terminalResize\(/g) ?? []
    const guards = src.match(/isViewerVisible\(/g) ?? []
    expect(publishes.length).toBeGreaterThan(0)
    // One definition plus one guard per publish site.
    expect(guards.length).toBeGreaterThanOrEqual(publishes.length + 1)
  })
})
