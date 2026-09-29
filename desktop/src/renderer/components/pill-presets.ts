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
