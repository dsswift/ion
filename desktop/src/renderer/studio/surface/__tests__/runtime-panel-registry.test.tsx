// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerRuntimePanel, RuntimePanelBody, updateRuntimePanel } from '../runtime-panel-registry'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RuntimePanelBody', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('rerenders canvas body when an async panel publishes conflict content', () => {
    const id = registerRuntimePanel({
      title: 'Conflicts',
      body: <div data-testid="runtime-content">Loading conflict state…</div>,
      close: () => undefined,
    })
    act(() => root.render(<RuntimePanelBody id={id} />))
    expect(host.textContent).toContain('Loading conflict state')

    act(() => {
      updateRuntimePanel(id, {
        title: 'Conflicts',
        body: <div data-testid="runtime-content">engine/internal/backend/runloop.go</div>,
      })
    })
    expect(host.textContent).toContain('engine/internal/backend/runloop.go')
  })
})
