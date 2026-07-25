/**
 * useAllThemes — reactive view over the theme registry (built-ins + custom
 * theme packs). Re-renders when the custom-theme set is replaced (boot fetch
 * or a live `ion:themes-changed` push registered in preferences-bootstrap).
 */
import { useEffect, useState } from 'react'
import { getAllThemes, onThemeRegistryChanged, type ThemeDefinition } from '../theme-tokens'

export function useAllThemes(): ThemeDefinition[] {
  const [all, setAll] = useState<ThemeDefinition[]>(() => getAllThemes())
  useEffect(() => onThemeRegistryChanged(() => setAll(getAllThemes())), [])
  return all
}
