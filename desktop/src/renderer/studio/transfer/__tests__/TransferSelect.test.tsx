// @vitest-environment jsdom
/**
 * TransferSelect: the dialog's themed choice field.
 *
 * Pins what the operator asked for in place of the native `<select>`s: an
 * option shows a name with its path under it, the menu is the app's own
 * picker menu, and a required choice left empty says so in the field.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))

import { TransferSelect } from '../TransferSelect'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const options = [
  { value: '/Users/Shared/source/personal/ion', label: 'ion', detail: '/Users/Shared/source/personal/ion' },
  { value: '/Users/josh/orion', label: 'orion', detail: '/Users/josh/orion' },
]

function render(props: Partial<React.ComponentProps<typeof TransferSelect>> = {}): { onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn()
  act(() => root.render(<TransferSelect label="Lands in" heading="Projects on This Mac" value="" placeholder="Choose where it lands…" options={options} onChange={onChange} {...props} />))
  return { onChange }
}

describe('TransferSelect', () => {
  it('shows the chosen project by name, with its path underneath', () => {
    render({ value: '/Users/Shared/source/personal/ion' })
    const trigger = host.querySelector('button[aria-label="Lands in"]')!
    expect(trigger.textContent).toContain('ion')
    expect(trigger.textContent).toContain('/Users/Shared/source/personal/ion')
  })

  it('opens the picker menu with every option, and picking one reports it', () => {
    const { onChange } = render()
    act(() => { (host.querySelector('button[aria-label="Lands in"]') as HTMLButtonElement).click() })

    const items = Array.from(host.querySelectorAll('[role="menuitemradio"]'))
    expect(items.map((i) => i.textContent)).toEqual(['ion/Users/Shared/source/personal/ion', 'orion/Users/josh/orion'])

    act(() => { (items[1] as HTMLButtonElement).click() })
    expect(onChange).toHaveBeenCalledWith('/Users/josh/orion')
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('says so in the field when a required choice is empty', () => {
    render({ invalid: true, invalidMessage: 'Pick the project on This Mac this conversation belongs in.' })
    const trigger = host.querySelector('button[aria-label="Lands in"]')!
    expect(trigger.getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Pick the project on This Mac this conversation belongs in.')
  })

  it('shows no complaint once a choice is made', () => {
    render({ value: '/Users/josh/orion', invalid: false, invalidMessage: 'Pick one.' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  // The match first, then every other project under its own heading.
  it('groups options under their section headings, one heading per run', () => {
    render({ options: [
      { value: '/src/ion', label: 'ion' },
      { value: '/notes', label: 'notes', section: 'Other projects' },
      { value: '/src/orion', label: 'orion', section: 'Other projects' },
    ] })
    act(() => { (host.querySelector('button[aria-label="Lands in"]') as HTMLButtonElement).click() })
    const menu = host.querySelector('[role="menu"]')!
    const sequence = Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="presentation"]')).map((el) => el.getAttribute('role') === 'presentation' ? `#${el.textContent}` : el.textContent)
    expect(sequence).toEqual(['ion', '#Other projects', 'notes', 'orion'])
  })
})
