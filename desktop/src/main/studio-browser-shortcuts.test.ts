import { describe, expect, it } from 'vitest'
import { resolveBrowserShortcut, type ShortcutInput } from './studio-browser-shortcuts'

function press(key: string, mods: Partial<ShortcutInput> = {}): ShortcutInput {
  return { type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, isAutoRepeat: false, ...mods }
}

describe('resolveBrowserShortcut', () => {
  it('reads the command key on darwin and the control key on win32', () => {
    expect(resolveBrowserShortcut(press('l', { meta: true }), 'darwin')).toBe('focus-url-bar')
    expect(resolveBrowserShortcut(press('l', { control: true }), 'win32')).toBe('focus-url-bar')
    // The other platform's modifier is a page key, never a browser shortcut.
    expect(resolveBrowserShortcut(press('l', { control: true }), 'darwin')).toBeNull()
    expect(resolveBrowserShortcut(press('l', { meta: true }), 'win32')).toBeNull()
  })

  it('maps the browser verbs', () => {
    const mod = { meta: true }
    expect(resolveBrowserShortcut(press('f', mod), 'darwin')).toBe('open-find')
    expect(resolveBrowserShortcut(press('g', mod), 'darwin')).toBe('find-next')
    expect(resolveBrowserShortcut(press('g', { ...mod, shift: true }), 'darwin')).toBe('find-previous')
    expect(resolveBrowserShortcut(press('r', mod), 'darwin')).toBe('reload')
    expect(resolveBrowserShortcut(press('[', mod), 'darwin')).toBe('back')
    expect(resolveBrowserShortcut(press(']', mod), 'darwin')).toBe('forward')
    expect(resolveBrowserShortcut(press('=', mod), 'darwin')).toBe('zoom-in')
    expect(resolveBrowserShortcut(press('-', mod), 'darwin')).toBe('zoom-out')
    expect(resolveBrowserShortcut(press('0', mod), 'darwin')).toBe('zoom-reset')
    expect(resolveBrowserShortcut(press('L', mod), 'darwin')).toBe('focus-url-bar')
  })

  it('maps history arrows per platform', () => {
    expect(resolveBrowserShortcut(press('ArrowLeft', { meta: true }), 'darwin')).toBe('back')
    expect(resolveBrowserShortcut(press('ArrowRight', { meta: true }), 'darwin')).toBe('forward')
    expect(resolveBrowserShortcut(press('ArrowLeft', { alt: true }), 'win32')).toBe('back')
    expect(resolveBrowserShortcut(press('ArrowRight', { alt: true }), 'win32')).toBe('forward')
    expect(resolveBrowserShortcut(press('ArrowLeft', { control: true }), 'win32')).toBeNull()
    expect(resolveBrowserShortcut(press('ArrowLeft', { alt: true }), 'darwin')).toBeNull()
  })

  it('treats a bare Escape as close-find and leaves everything else to the page', () => {
    expect(resolveBrowserShortcut(press('Escape'), 'darwin')).toBe('close-find')
    expect(resolveBrowserShortcut(press('Escape', { meta: true }), 'darwin')).toBeNull()
    expect(resolveBrowserShortcut(press('a'), 'darwin')).toBeNull()
    expect(resolveBrowserShortcut(press('l', { meta: true, alt: true }), 'darwin')).toBeNull()
    expect(resolveBrowserShortcut({ ...press('l', { meta: true }), type: 'keyUp' }, 'darwin')).toBeNull()
  })
})
