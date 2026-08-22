/**
 * Shared types for the Ion Studio (Studio): the main-process state
 * cache payloads and (as the theme system lands) the theme-pack manifest
 * shapes. Cross-process but desktop-internal — nothing here is mirrored from
 * Go or carried on an external wire.
 */
import type { NormalizedEvent } from "./types-events";
import type { AgentStateUpdate, StatusFields } from "./types-engine";
import type { IntegrationMember, IntegrationWorkspace } from "./types-bench";
import type { WorktreeInventoryEntry } from "./types-git";

/** Per-tab state served by `studio:get-state` and pushed with `studio:active-tab`. */
export interface StudioTabState {
  /** Latest agent-state snapshot (replace-on-snapshot semantics). */
  agents: AgentStateUpdate[];
  /** Ring of recent dispatch_start / dispatch_end / permission_request events. */
  events: NormalizedEvent[];
  /** Latest status-fields snapshot for the tab, if any arrived. */
  statusFields: StatusFields | null;
}

/** Response shape of `studio:get-state`. */
export interface StudioGetStateResult {
  activeTabId: string | null;
  /** The active tab's engineProfileId (extension seed scope); null = plain tab. */
  activeProfileId: string | null;
  state: StudioTabState | null;
}

/**
 * Owner-rendered worktree inventory and benches, serialized for Studio.
 *
 * This is a complete replacement snapshot. `revision` is assigned by main,
 * not trusted from the owner renderer, so Studio can reject stale pushes.
 */
export interface StudioWorktreeSnapshot {
  revision: number;
  /** True once the owner has completed its initial worktree refresh. */
  ready: boolean;
  inventory: Record<string, WorktreeInventoryEntry[]>;
  workspaces: Record<string, IntegrationWorkspace[]>;
  benchSourceTips: Array<[string, Record<string, string>]>;
  benchRetired: Array<[string, Array<[string, IntegrationMember[]]>]>;
  gitConflictAlerts: Array<[string, StudioGitConflictAlert]>;
  worktreePipeline: StudioWorktreePipeline | null;
  workspaceOperationLedger: StudioWorkspaceOperation[];
}

/** Structured-clone-safe conflict state for the Studio mirror. */
export interface StudioGitConflictAlert {
  source: "sync" | "land" | "detected";
  kind?: "conflict" | "refusal";
  operationState?: "rebasing" | "merging" | "cherry-picking";
  message?: string;
  label?: string;
  dismissed: boolean;
  recordedAt: number;
}

/** Structured-clone-safe progress state for the Studio mirror. */
export interface StudioWorktreePipeline {
  repoPath: string;
  sourceBranch: string | null;
  phase: "syncing" | "awaiting-ai-confirm" | "resolving" | "assembling" | "done" | "failed";
  outcomes: unknown[];
  lastSummary?: unknown;
  queue: string[];
  current: string | null;
  needsManual: string[];
  resolvedByAi: number;
  cancelled: boolean;
  startedAt: number;
  summary?: string;
}

/** Structured-clone-safe operation record retained for Studio progress UI. */
export interface StudioWorkspaceOperation {
  id: string;
  action: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/** User turn sent from main to Studio mirror with stable delivery identity. */
export interface StudioUserMessageEcho {
  id: string;
  content: string;
  timestamp: number;
}

/**
 * Wholesale message-list replacement pushed to the Studio mirror after a
 * successful engine rewind commits a new truncation. Mirrors the semantics
 * of `desktop_conversation_history` on the iOS wire: the mirror REPLACES the
 * named pane instance's messages, it never merges the new list against the
 * old one. The message shape matches `EngineHistoryMessage`
 * (main/remote/handlers/engine-history.ts) so one owner-side read serves
 * both this push and the iOS broadcast from the same committed transcript.
 */
export interface StudioHistoryReplace {
  tabId: string;
  instanceId: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolName?: string;
    toolId?: string;
    toolStatus?: string;
    timestamp: number;
    dedupKey?: string;
    dedupMode?: "relocate";
    planFilePath?: string;
    attachments?: Array<{ id: string; type: string; name: string; path: string; contentHash?: string }>;
  }>;
}

/** The Studio-scoped settings served by `studio:get-settings`. */
export interface StudioSettings {
  studioTheme: string;
  /** 0 = fit-to-window; 1..6 = manual zoom. */
  studioZoom: number;
  /** Desktop-wide office seed ('' = built-in default). */
  studioSeed: string;
  /** Dock/Cmd-Tab presence while the Studio window is open. */
  studioDockPresence: boolean;
  /** Footstep-heat overlay on the canvas. */
  studioHeat: boolean;
  /** Attention beacon (dock bounce/title) on unfocused permission arrivals. */
  studioBeacon: boolean;
  /** Ambient soundscape (procedural synthesis; control-bar mute). */
  studioSound: boolean;
  /** Shell geometry shared across conversations. */
  studioLayout: StudioLayout;
  /** Conversation-keyed surface state plus global core-tab pins. */
  studioSurface: unknown;
  /**
   * Read-only, derived from surfacePolicy: false when the enterprise/operator
   * policy disables the Studio window surface (launchers hide themselves).
   */
  studioEnabled: boolean;
}

/** Which view the Studio left sidebar shows. 'inbox' joins in the inbox workstream. */
export type StudioSidebarView = "inbox" | "explorer" | "git";

/**
 * Studio shell geometry — global across conversations. All sizes in px except dispatchSplitRatio.
 * Bounds enforced by the ipc/studio.ts validator (single write path).
 */
export interface StudioLayout {
  leftSidebarVisible: boolean;
  leftSidebarView: StudioSidebarView;
  /** 320..1400 */
  surfaceWidth: number;
  /** 120..800 */
  terminalHeight: number;
  /** Dispatch split pane share of the center row, 0.2..0.8. */
  dispatchSplitRatio: number;
}

export const STUDIO_LAYOUT_DEFAULTS: StudioLayout = {
  leftSidebarVisible: false,
  leftSidebarView: "explorer",
  surfaceWidth: 520,
  terminalHeight: 240,
  dispatchSplitRatio: 0.45,
};

export const STUDIO_LAYOUT_BOUNDS = {
  surfaceWidth: { min: 320, max: 1400 },
  terminalHeight: { min: 120, max: 800 },
  dispatchSplitRatio: { min: 0.2, max: 0.8 },
} as const;

/**
 * Normalize an unknown persisted value into a complete StudioLayout.
 * Unknown fields dropped, missing fields defaulted, numbers clamped.
 * Shared by the main-side validator and the renderer's restore path so
 * the two can never disagree about what a valid layout is.
 */
export function normalizeStudioLayout(raw: unknown): StudioLayout {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const num = (
    key: keyof typeof STUDIO_LAYOUT_BOUNDS,
    fallback: number,
  ): number => {
    const b = STUDIO_LAYOUT_BOUNDS[key];
    const n =
      typeof v[key] === "number" && Number.isFinite(v[key] as number)
        ? (v[key] as number)
        : fallback;
    return Math.min(b.max, Math.max(b.min, n));
  };
  const view = v.leftSidebarView;
  return {
    leftSidebarVisible: v.leftSidebarVisible === true,
    leftSidebarView:
      view === "inbox" || view === "explorer" || view === "git"
        ? view
        : STUDIO_LAYOUT_DEFAULTS.leftSidebarView,
    surfaceWidth: num("surfaceWidth", STUDIO_LAYOUT_DEFAULTS.surfaceWidth),
    terminalHeight: num(
      "terminalHeight",
      STUDIO_LAYOUT_DEFAULTS.terminalHeight,
    ),
    dispatchSplitRatio: num(
      "dispatchSplitRatio",
      STUDIO_LAYOUT_DEFAULTS.dispatchSplitRatio,
    ),
  };
}

// ─── Theme-pack manifest shapes (contract: docs/design/visualizer/theme-pack-format.md) ───

export type StudioRole = "manager" | "lead" | "specialist";
export type StudioRotationScheme = "none" | "2-way" | "3-way-mirror";
export type StudioFurnitureCategory =
  "work" | "mail" | "relax" | "manager" | "decor";
export type StudioZone =
  | "department"
  | "manager"
  | "mail"
  | "break"
  | "meeting"
  | "lobby"
  | "corridor";
export type StudioBubbleKind =
  "waiting" | "permission" | "error" | "dispatch" | "plan" | "question";
export type StudioDirection = "down" | "up" | "left" | "right";

export interface StudioThemeManifest {
  id: string;
  name: string;
  version: string;
  extends?: string | null;
  tileSize: number;
  palette: string[];
  continuity?: Record<string, unknown>;
}

export interface StudioAnimationSpec {
  file: string;
  frames: number;
}

export interface StudioCharacterManifest {
  id: string;
  name: string;
  roles: StudioRole[];
  tintable: boolean;
  animations: Record<string, StudioAnimationSpec>;
}

export interface StudioPetManifest {
  id: string;
  name: string;
  behavior: "wander";
  animations: Record<string, StudioAnimationSpec>;
}

export interface StudioSeatTile {
  x: number;
  y: number;
  dir: StudioDirection;
}

export interface StudioFurnitureManifest {
  id: string;
  name: string;
  category: StudioFurnitureCategory;
  footprintW: number;
  footprintH: number;
  /** Pixel size of one default-orientation frame image. */
  width: number;
  height: number;
  rotationScheme: StudioRotationScheme;
  /** Variant key → file. `none` scheme uses the single key `default`. */
  images?: Record<string, string> | null;
  /** State group → file (stateful items use states instead of images). */
  states?: Record<string, string> | null;
  frames?: number;
  isSurface?: boolean;
  seatTiles?: StudioSeatTile[];
  canPlaceOnWalls?: boolean;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: boolean;
  tintRegion?: boolean;
  /** Live-data overlay drawn inside the item's pixel bounds. */
  dashboard?: "kanban" | "sparkline" | "cost-plaque";
}

export interface StudioFloorManifest {
  id: string;
  name: string;
  file: string;
  tintable?: boolean;
}

export interface StudioWallManifest {
  id: string;
  name: string;
  /** Horizontal strip of 16 tiles indexed by NESW adjacency bitmask. */
  file: string;
}

/** Four core kinds are required; attention kinds (plan/question) optional. */
export type StudioBubblesManifest = Record<
  "waiting" | "permission" | "error" | "dispatch",
  string
> & {
  plan?: string;
  question?: string;
};

export interface StudioDressingRequiredEntry {
  id?: string;
  category?: StudioFurnitureCategory;
  perSeat?: boolean;
  count?: number;
  wallItem?: boolean;
}

export interface StudioDressingOptionalEntry {
  id?: string;
  category?: StudioFurnitureCategory;
  weight: number;
  max?: number;
}

export interface StudioDressingTemplate {
  zone: StudioZone;
  floor?: string;
  required: StudioDressingRequiredEntry[];
  optional: StudioDressingOptionalEntry[];
  density: number;
}

// ─── Pack discovery / transfer shapes (main → renderer) ───

export interface StudioThemeListEntry {
  id: string;
  name: string;
  version: string;
  builtin: boolean;
}

/** One conversation row in the Studio window toolbar's conversation picker. */
export interface StudioTabListEntry {
  tabId: string;
  title: string;
  /** TabStatus string ('running', 'idle', ...). */
  status: string;
  /** Working directory basename ('' when unset). */
  directory: string;
  /** Hosting extension profile id ('' for plain conversations). */
  extension: string;
  /** Desktop tab-group label this conversation belongs to ('' = ungrouped). */
  group: string;
  /** Desktop group ordering (groups render in this order). */
  groupOrder: number;
}

/**
 * Everything JSON in one pack, read raw by the main process and validated in
 * the renderer. Keys of the record maps are the asset directory ids; values
 * are unvalidated parsed JSON.
 */
export interface StudioRawPackBundle {
  packId: string;
  builtin: boolean;
  theme: unknown;
  characters: Record<string, unknown>;
  pets: Record<string, unknown>;
  furniture: Record<string, unknown>;
  floors: Record<string, unknown>;
  walls: Record<string, unknown>;
  bubbles: unknown | null;
  dressing: Record<string, unknown>;
}
