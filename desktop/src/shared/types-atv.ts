/**
 * Shared types for the Agent Team Visualizer (ATV): the main-process state
 * cache payloads and (as the theme system lands) the theme-pack manifest
 * shapes. Cross-process but desktop-internal — nothing here is mirrored from
 * Go or carried on an external wire.
 */
import type { NormalizedEvent } from './types-events'
import type { AgentStateUpdate, StatusFields } from './types-engine'

/** Per-tab state served by `atv:get-state` and pushed with `atv:active-tab`. */
export interface AtvTabState {
  /** Latest agent-state snapshot (replace-on-snapshot semantics). */
  agents: AgentStateUpdate[]
  /** Ring of recent dispatch_start / dispatch_end / permission_request events. */
  events: NormalizedEvent[]
  /** Latest status-fields snapshot for the tab, if any arrived. */
  statusFields: StatusFields | null
}

/** Response shape of `atv:get-state`. */
export interface AtvGetStateResult {
  activeTabId: string | null
  /** The active tab's engineProfileId (extension seed scope); null = plain tab. */
  activeProfileId: string | null
  state: AtvTabState | null
}

/** The ATV-scoped settings served by `atv:get-settings`. */
export interface AtvSettings {
  atvTheme: string
  atvPinned: boolean
  /** 0 = fit-to-window; 1..6 = manual zoom. */
  atvZoom: number
  /** Desktop-wide office seed ('' = built-in default). */
  atvSeed: string
  /** Dock/Cmd-Tab presence while the ATV window is open. */
  atvDockPresence: boolean
  /** Auto-open the side dock when the conversation awaits user input. */
  atvAutoDrawer: boolean
  /** Footstep-heat overlay on the canvas. */
  atvHeat: boolean
  /** Attention beacon (dock bounce/title) on unfocused permission arrivals. */
  atvBeacon: boolean
  /** Ambient soundscape (procedural synthesis; control-bar mute). */
  atvSound: boolean
  /** Shell layout — one global state (dock open/width/tab). */
  atvLayout: { dockOpen: boolean; dockWidth: number; dockTab: 'conversation' | 'files' }
  /**
   * Read-only, derived from surfacePolicy: false when the enterprise/operator
   * policy disables the ATV surface (launchers hide themselves).
   */
  atvEnabled: boolean
}

// ─── Theme-pack manifest shapes (contract: docs/design/atv/theme-pack-format.md) ───

export type AtvRole = 'manager' | 'lead' | 'specialist'
export type AtvRotationScheme = 'none' | '2-way' | '3-way-mirror'
export type AtvFurnitureCategory = 'work' | 'mail' | 'relax' | 'manager' | 'decor'
export type AtvZone = 'department' | 'manager' | 'mail' | 'break' | 'meeting' | 'lobby' | 'corridor'
export type AtvBubbleKind = 'waiting' | 'permission' | 'error' | 'dispatch' | 'plan' | 'question'
export type AtvDirection = 'down' | 'up' | 'left' | 'right'

export interface AtvThemeManifest {
  id: string
  name: string
  version: string
  extends?: string | null
  tileSize: number
  palette: string[]
  continuity?: Record<string, unknown>
}

export interface AtvAnimationSpec {
  file: string
  frames: number
}

export interface AtvCharacterManifest {
  id: string
  name: string
  roles: AtvRole[]
  tintable: boolean
  animations: Record<string, AtvAnimationSpec>
}

export interface AtvPetManifest {
  id: string
  name: string
  behavior: 'wander'
  animations: Record<string, AtvAnimationSpec>
}

export interface AtvSeatTile {
  x: number
  y: number
  dir: AtvDirection
}

export interface AtvFurnitureManifest {
  id: string
  name: string
  category: AtvFurnitureCategory
  footprintW: number
  footprintH: number
  /** Pixel size of one default-orientation frame image. */
  width: number
  height: number
  rotationScheme: AtvRotationScheme
  /** Variant key → file. `none` scheme uses the single key `default`. */
  images?: Record<string, string> | null
  /** State group → file (stateful items use states instead of images). */
  states?: Record<string, string> | null
  frames?: number
  isSurface?: boolean
  seatTiles?: AtvSeatTile[]
  canPlaceOnWalls?: boolean
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: boolean
  tintRegion?: boolean
  /** Live-data overlay drawn inside the item's pixel bounds. */
  dashboard?: 'kanban' | 'sparkline' | 'cost-plaque'
}

export interface AtvFloorManifest {
  id: string
  name: string
  file: string
  tintable?: boolean
}

export interface AtvWallManifest {
  id: string
  name: string
  /** Horizontal strip of 16 tiles indexed by NESW adjacency bitmask. */
  file: string
}

/** Four core kinds are required; attention kinds (plan/question) optional. */
export type AtvBubblesManifest = Record<'waiting' | 'permission' | 'error' | 'dispatch', string> & {
  plan?: string
  question?: string
}

export interface AtvDressingRequiredEntry {
  id?: string
  category?: AtvFurnitureCategory
  perSeat?: boolean
  count?: number
  wallItem?: boolean
}

export interface AtvDressingOptionalEntry {
  id?: string
  category?: AtvFurnitureCategory
  weight: number
  max?: number
}

export interface AtvDressingTemplate {
  zone: AtvZone
  floor?: string
  required: AtvDressingRequiredEntry[]
  optional: AtvDressingOptionalEntry[]
  density: number
}

// ─── Pack discovery / transfer shapes (main → renderer) ───

export interface AtvThemeListEntry {
  id: string
  name: string
  version: string
  builtin: boolean
}

/** One conversation row in the ATV toolbar's conversation picker. */
export interface AtvTabListEntry {
  tabId: string
  title: string
  /** TabStatus string ('running', 'idle', ...). */
  status: string
  /** Working directory basename ('' when unset). */
  directory: string
  /** Hosting extension profile id ('' for plain conversations). */
  extension: string
  /** Desktop tab-group label this conversation belongs to ('' = ungrouped). */
  group: string
  /** Desktop group ordering (groups render in this order). */
  groupOrder: number
}

/**
 * Everything JSON in one pack, read raw by the main process and validated in
 * the renderer. Keys of the record maps are the asset directory ids; values
 * are unvalidated parsed JSON.
 */
export interface AtvRawPackBundle {
  packId: string
  builtin: boolean
  theme: unknown
  characters: Record<string, unknown>
  pets: Record<string, unknown>
  furniture: Record<string, unknown>
  floors: Record<string, unknown>
  walls: Record<string, unknown>
  bubbles: unknown | null
  dressing: Record<string, unknown>
}
