/**
 * Types for the procedural office generator. The generator is pure and
 * deterministic: seed + roster + theme data in, OfficeLayout out. Layout
 * structures are plain JSON-serializable objects so the determinism contract
 * can be pinned byte-for-byte.
 */
import type {
  AtvDirection,
  AtvDressingTemplate,
  AtvFurnitureManifest,
  AtvRole,
  AtvZone,
} from '../../../shared/types-atv'

// ─── Roster (derived from live agent state) ───

export interface RosterAgent {
  name: string
  displayName: string
  role: AtvRole
  /** Department accent color from the agent color resolution. */
  color: string
  /** Pinned character sheet id (`atv-character` frontmatter); null = cast by seed. */
  characterId: string | null
  /**
   * Named hallway wing (`atv-wing` frontmatter): offices sharing a wing name
   * generate on their own dedicated hallway. `atv-seat: executive` implies
   * wing 'executive'. Empty = general hallways.
   */
  wing?: string
}

export interface RosterDepartment {
  lead: RosterAgent
  specialists: RosterAgent[]
  /**
   * True when the lead sits in the executive wing (`atv-seat: executive`):
   * the department room is built WITHOUT a corner office, and the lead's
   * desk is its wing office instead.
   */
  leadInWing?: boolean
}

export interface Roster {
  departments: RosterDepartment[]
  /**
   * Executives: agents whose direct reports are all themselves parents
   * (chiefs over leads), or that declare `atv-seat: private-office`. Each
   * gets a private office in the executive wing.
   */
  executives: RosterAgent[]
  /** Root-level agents with no dispatched children (seated in the bullpen). */
  solo: RosterAgent[]
}

// ─── Theme data the generator needs (manifests only, no bitmaps) ───

export interface GenTheme {
  tileSize: number
  furniture: Map<string, AtvFurnitureManifest>
  /** Floor ids available in the pack. */
  floors: string[]
  /** Wall-set ids available in the pack. */
  walls: string[]
  dressing: Map<string, AtvDressingTemplate>
}

// ─── Grid ───

export enum Cell {
  Void = 0,
  Floor = 1,
  Wall = 2,
  Door = 3,
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ─── Layout output ───

export interface Room {
  id: string
  zone: AtvZone
  /** Exterior rect including walls. */
  rect: Rect
  /** Interior floor rect. */
  interior: Rect
  doorTiles: Point[]
  floorId: string | null
  /** Lead agent name for department rooms; null otherwise. */
  leadAgent: string | null
  /** Department accent color (tints carpet/door trim); null = neutral. */
  accent: string | null
  /**
   * The lead's private office pocket carved into a corner of a department
   * room (shares the room's outer walls). Null for rooms without one.
   */
  innerOffice: { rect: Rect; interior: Rect; door: Point } | null
}

export interface PlacedFurniture {
  itemId: string
  /** Anchor tile (top-left of footprint). */
  x: number
  y: number
  /** images/states key to draw ('default', 'front', 'down', ...; 'left' = mirrored 'right'). */
  variant: string
  roomId: string
  /** True when the item sits on a surface item (drawn above it). */
  onSurface: boolean
}

export type SeatKind = 'manager' | 'head' | 'cluster' | 'hot'

export interface Seat {
  id: string
  roomId: string
  tile: Point
  dir: AtvDirection
  kind: SeatKind
  /** Agent name this seat is assigned to; null = free (hot desk pool). */
  agent: string | null
}

export interface OfficeLayout {
  seed: string
  width: number
  height: number
  /** Row-major cell grid. */
  cells: Cell[]
  rooms: Room[]
  furniture: PlacedFurniture[]
  seats: Seat[]
  /** Break-room rest tiles (sofa seats) for done-agents to relax on. */
  restTiles: Point[]
  petSpawn: Point | null
  /** Wall set id used for the office. */
  wallId: string | null
  /**
   * Floor id for corridor tiles (from the corridor dressing template), so
   * hallways read as hallways and never share a room's flooring.
   */
  corridorFloorId: string | null
}

export function cellAt(layout: OfficeLayout, x: number, y: number): Cell {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return Cell.Void
  return layout.cells[y * layout.width + x]
}

/** Maximum office grid edge, per the generator contract. */
export const MAX_GRID = 64
