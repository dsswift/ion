/**
 * page-harness — mounts one Settings page in jsdom and finds its controls
 * by accessible name, for the page tests beside it.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Harness {
  container: HTMLDivElement
  render(node: React.ReactElement): Promise<void>
  unmount(): void
  /** A button or switch by visible text or aria-label. */
  control(name: string): HTMLElement
  maybeControl(name: string): HTMLElement | undefined
  click(name: string): Promise<void>
}

export function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }

export function createHarness(): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  const maybeControl = (name: string): HTMLElement | undefined => [...container.querySelectorAll<HTMLElement>('button, [role="switch"], [role="radio"], select')]
    .find((el) => el.getAttribute('aria-label') === name || el.textContent?.trim() === name)
  const control = (name: string): HTMLElement => {
    const el = maybeControl(name)
    if (!el) throw new Error(`no control named "${name}"`)
    return el
  }
  return {
    container,
    control,
    maybeControl,
    async render(node) { await act(async () => { root?.render(node); await flush() }) },
    unmount() { act(() => root?.unmount()); root = null; container.remove() },
    async click(name) { await act(async () => { control(name).click(); await flush(); await flush() }) },
  }
}
