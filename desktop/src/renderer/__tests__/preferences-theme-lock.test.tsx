// @vitest-environment jsdom
/**
 * A locked enterprise themePolicy must reach every store-driven theme
 * consumer, not just the CSS variables: useColors(), getColors() and
 * useEffectiveThemeId() resolve the enforced id, while the user's saved
 * `selectedTheme` stays untouched so it returns when the lock lifts.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { getColors, useColors, useEffectiveThemeId, usePreferencesStore } from '../preferences'
import { lightColors, classicColors, registerCustomThemes, type ColorPalette } from '../theme-tokens'

const PACK_ACCENT = '#ff0077'
const acmePack = {
  id: 'acme-corp',
  name: 'Acme Corp',
  version: '1.0.0',
  base: 'ion-dark' as const,
  tokens: { accent: PACK_ACCENT },
}

function themePolicy(themeId: string, locked: boolean): EnterprisePolicy {
  return { customFields: { 'ion-desktop': { themePolicy: { themeId, locked } } } }
}

let seen: { colors: ColorPalette; themeId: string } | null = null
function Probe(): React.JSX.Element {
  seen = { colors: useColors(), themeId: useEffectiveThemeId() }
  return <div />
}

let root: Root | null = null
function render(node: React.ReactElement): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  seen = null
  registerCustomThemes([])
  usePreferencesStore.setState({ selectedTheme: 'ion-light', enterprisePolicy: null })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  registerCustomThemes([])
})

describe('locked enterprise themePolicy', () => {
  it('useColors() and getColors() return the enforced pack palette, not the saved theme', () => {
    registerCustomThemes([acmePack])
    usePreferencesStore.getState().setEnterprisePolicy(themePolicy('acme-corp', true))
    render(<Probe />)
    expect(seen?.themeId).toBe('acme-corp')
    expect(seen?.colors.accent).toBe(PACK_ACCENT)
    expect(getColors().accent).toBe(PACK_ACCENT)
    expect(usePreferencesStore.getState().selectedTheme).toBe('ion-light')
  })

  it('a policy arriving after first paint re-renders with the enforced theme', () => {
    registerCustomThemes([acmePack])
    render(<Probe />)
    expect(seen?.colors).toBe(lightColors)
    act(() => usePreferencesStore.getState().setEnterprisePolicy(themePolicy('acme-corp', true)))
    expect(seen?.colors.accent).toBe(PACK_ACCENT)
  })

  it('an enforced pack registering after the policy re-renders with its palette', () => {
    usePreferencesStore.getState().setEnterprisePolicy(themePolicy('acme-corp', true))
    render(<Probe />)
    expect(seen?.colors.accent).not.toBe(PACK_ACCENT)
    act(() => registerCustomThemes([acmePack]))
    expect(seen?.colors.accent).toBe(PACK_ACCENT)
  })

  it('removing the lock restores the user choice', () => {
    usePreferencesStore.getState().setEnterprisePolicy(themePolicy('ion-classic', true))
    render(<Probe />)
    expect(seen?.colors).toBe(classicColors)
    act(() => usePreferencesStore.getState().setEnterprisePolicy(null))
    expect(seen?.themeId).toBe('ion-light')
    expect(seen?.colors).toBe(lightColors)
  })

  it('an unlocked policy is only a default: the saved theme still renders', () => {
    usePreferencesStore.getState().setEnterprisePolicy(themePolicy('ion-classic', false))
    render(<Probe />)
    expect(seen?.themeId).toBe('ion-light')
    expect(getColors()).toBe(lightColors)
  })
})
