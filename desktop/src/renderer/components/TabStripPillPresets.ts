import type React from 'react'
import { Diamond, Square, StarFour, Triangle, Heart, Hexagon, Lightning, Terminal, DeviceMobile, Monitor, Gear } from '@phosphor-icons/react'

/** Pill background-color presets shown in the color picker. `null` means "use theme default".
 * These are user-selected identity colors persisted as literal values on the tab
 * (runtime data rendered as-is across themes), not themed chrome — so they are
 * intentionally not theme tokens. */
export const PILL_COLOR_PRESETS = [
  { color: null, label: 'Default' },
  { color: '#f08c4a', label: 'Orange' }, // hardcoded-ok: user-picked pill preset persisted as literal value
  { color: '#4ece78', label: 'Green' }, // hardcoded-ok: user-picked pill preset persisted as literal value
  { color: '#ef5350', label: 'Red' }, // hardcoded-ok: user-picked pill preset persisted as literal value
  { color: '#42a5f5', label: 'Blue' }, // hardcoded-ok: user-picked pill preset persisted as literal value
  { color: '#b06de8', label: 'Purple' }, // hardcoded-ok: user-picked pill preset persisted as literal value
  { color: '#f5c842', label: 'Gold' }, // hardcoded-ok: user-picked pill preset persisted as literal value
] as const

/** Pill status-icon presets shown in the icon picker. `null` means "use the default dot". */
export const PILL_ICON_PRESETS = [
  { icon: null, label: 'Default' },
  { icon: 'diamond', label: 'Diamond' },
  { icon: 'square', label: 'Square' },
  { icon: 'star', label: 'Star' },
  { icon: 'triangle', label: 'Triangle' },
  { icon: 'heart', label: 'Heart' },
  { icon: 'hexagon', label: 'Hexagon' },
  { icon: 'lightning', label: 'Lightning' },
  { icon: 'mobile', label: 'Mobile' },
  { icon: 'desktop', label: 'Desktop' },
  { icon: 'gear', label: 'Gear' },
] as const

/** Maps the persisted `pillIcon` string to a Phosphor icon component. */
export const PILL_ICON_MAP: Record<string, React.ComponentType<any>> = {
  diamond: Diamond,
  square: Square,
  star: StarFour,
  triangle: Triangle,
  heart: Heart,
  hexagon: Hexagon,
  lightning: Lightning,
  Terminal,
  // Note: `Monitor` is used instead of `Desktop` to avoid collision with the
  // reserved JS keyword; the persisted icon string remains "desktop".
  mobile: DeviceMobile,
  desktop: Monitor,
  gear: Gear,
}

