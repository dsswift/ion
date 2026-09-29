/**
 * settings-nav — where the Settings dialog is, readable and changeable from
 * any page, so a page can link to another (Overview → Health) or react to
 * the row a search hit asked it to reveal.
 */
import React, { createContext, useContext } from 'react'
import type { SettingsLocation } from './settings-catalog'

export interface SettingsNav {
  location: SettingsLocation
  navigate(location: SettingsLocation): void
}

const NavContext = createContext<SettingsNav>({ location: { pageId: '', environmentId: null, anchor: null }, navigate: () => {} })

export function SettingsNavProvider({ value, children }: { value: SettingsNav; children: React.ReactNode }): React.JSX.Element {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useSettingsNav(): SettingsNav {
  return useContext(NavContext)
}
