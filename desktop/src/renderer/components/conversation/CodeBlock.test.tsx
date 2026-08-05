// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Deterministic highlighter mock: colors every line's single token, and lets
// tests hold the resolution to exercise the no-flash / stale-guard contracts.
const pending: Array<{ resolve: (rows: Array<Array<{ content: string; color?: string }>>) => void; code: string }> = []
const highlightToTokens = vi.fn((code: string) =>
  new Promise<Array<Array<{ content: string; color?: string }>>>((resolve) => {
    pending.push({ resolve, code })
  }))
const getCachedHighlight = vi.fn((): Array<Array<{ content: string; color?: string }>> | undefined => undefined)

vi.mock('./codeHighlight', () => ({
  getCachedHighlight: (...args: unknown[]) => getCachedHighlight(...(args as [])),
  highlightToTokens: (code: string) => highlightToTokens(code),
  langFromFence: (fence: string | undefined) => (fence === 'ts' || fence === 'typescript' ? 'typescript' : null),
  languageForFile: (name: string) => (name.endsWith('.ts') ? 'typescript' : null),
  plaintextTokens: (code: string) => code.split('\n').map((line: string) => [{ content: line }]),
}))

import { CodeBlock } from './CodeBlock'

function colored(code: string) {
  return code.split('\n').map((line) => [{ content: line, color: '#123456' }])
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(el: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(el) })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeAll(() => {
  ;(window as unknown as { ion: object }).ion = {
    getFavicon: () => Promise.resolve(null),
    openExternal: () => Promise.resolve(true),
  }
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  pending.length = 0
  highlightToTokens.mockClear()
  getCachedHighlight.mockReset()
  getCachedHighlight.mockReturnValue(undefined)
})

describe('CodeBlock', () => {
  it('renders plaintext immediately, then swaps in highlighted tokens (no flash of nothing)', async () => {
    const el = render(<CodeBlock code={'const x = 1'} fenceLang="ts" />)
    // Before the async highlight resolves the raw code is already visible.
    expect(el.textContent).toContain('const x = 1')
    expect(el.querySelector('[style*="rgb(18, 52, 86)"]')).toBeNull()

    act(() => { pending[0].resolve(colored('const x = 1')) })
    await flush()
    const span = el.querySelector('code span span') as HTMLElement
    expect(span.style.color).toBe('rgb(18, 52, 86)')
  })

  it('seeds synchronously from the highlight cache on mount', () => {
    getCachedHighlight.mockReturnValue(colored('cached line'))
    const el = render(<CodeBlock code={'cached line'} fenceLang="ts" />)
    const span = el.querySelector('code span span') as HTMLElement
    expect(span.style.color).toBe('rgb(18, 52, 86)')
    expect(highlightToTokens).not.toHaveBeenCalled()
  })

  it('drops a stale resolution after the code changed', async () => {
    const el = render(<CodeBlock code={'old code'} fenceLang="ts" />)
    act(() => { root!.render(<CodeBlock code={'new code'} fenceLang="ts" />) })
    // Resolve the FIRST (stale) request — it must not overwrite the new render.
    act(() => { pending[0].resolve(colored('old code')) })
    await flush()
    expect(el.textContent).toContain('new code')
    expect(el.textContent).not.toContain('old code')
    // The new request resolving does land.
    act(() => { pending[1].resolve(colored('new code')) })
    await flush()
    const span = el.querySelector('code span span') as HTMLElement
    expect(span.style.color).toBe('rgb(18, 52, 86)')
  })

  it('labels the badge from the fence token (ts → TypeScript)', () => {
    const el = render(<CodeBlock code={'x'} fenceLang="ts" />)
    expect(el.textContent).toContain('TypeScript')
  })

  it('prefers the filename over the fence token for the badge', () => {
    const el = render(<CodeBlock code={'x'} fenceLang="ts" fileName="src/foo.ts" />)
    expect(el.textContent).toContain('src/foo.ts')
    expect(el.textContent).not.toContain('TypeScript')
  })

  it('copy copies the raw code', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const el = render(<CodeBlock code={'copy me\nline 2'} fenceLang="ts" />)
    const copyBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Copy'))!
    await act(async () => { copyBtn.click(); await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('copy me\nline 2')
  })

  it('wrap toggles whiteSpace between pre and pre-wrap', () => {
    const el = render(<CodeBlock code={'x'} fenceLang="ts" />)
    const pre = el.querySelector('pre') as HTMLElement
    expect(pre.style.whiteSpace).toBe('pre')
    const wrapBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Wrap'))!
    act(() => { wrapBtn.click() })
    expect(pre.style.whiteSpace).toBe('pre-wrap')
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('colors diff fences by line kind without the highlighter', () => {
    const el = render(<CodeBlock code={'+added\n-removed\n@@ -1 +1 @@\ncontext'} fenceLang="diff" />)
    expect(highlightToTokens).not.toHaveBeenCalled()
    const add = el.querySelector('[data-diff-kind="add"]') as HTMLElement
    const remove = el.querySelector('[data-diff-kind="remove"]') as HTMLElement
    const hunk = el.querySelector('[data-diff-kind="hunk"]')
    const plain = el.querySelector('[data-diff-kind="plain"]') as HTMLElement
    expect(add.style.color).not.toBe('')
    expect(remove.style.color).not.toBe('')
    expect(add.style.color).not.toBe(remove.style.color)
    expect(hunk).not.toBeNull()
    expect(plain.style.background).toBe('')
  })
})
