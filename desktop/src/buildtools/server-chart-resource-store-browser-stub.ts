/**
 * server-chart-resource-store-browser-stub — the Studio renderer's
 * build-time replacement for `server/src/persistence/chart-resource-store.ts`.
 *
 * The real file persists chart resource records to disk
 * (`fs.readdirSync`/`readFileSync`/`unlinkSync` under `~/.ion/resources/`).
 * It is reachable from the renderer transitively through
 * `store/chart-reconcile.ts` via `sessionStore.ts`'s reactive selectors.
 * Chart persistence is a Desktop-owned product surface per the real file's
 * own docs, and per spec 17 ("server owns the store, Studio renders") that
 * "Desktop" is now the server process — the renderer never reads or writes
 * `~/.ion/resources/**` itself, only the resource deltas the engine
 * broadcasts.
 *
 * Pure, I/O-free logic (id derivation, record validation, the resource-item
 * projection) is copied verbatim since it does no filesystem work and
 * callers may reasonably use it on data they already have in memory. Every
 * disk-touching function returns a safe empty/failure result instead of
 * throwing, since a chart list is normal to render as empty rather than as
 * an error. Wired in via `electron.vite.config.ts`'s renderer plugin, keyed
 * on chart-resource-store.ts's resolved absolute path so every relative
 * import of it resolves here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChartSpec = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChartRequest = any;

export const CHART_RESOURCE_KIND = "chart";

export interface ChartResourceContent {
  chartId: string;
  title: string;
  spec: ChartSpec;
  revision: number;
  toolMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChartRecord extends ChartResourceContent {
  conversationId: string;
}

export interface ChartCommitContext {
  conversationId: string;
  toolCallId: string;
  now?: () => Date;
}

export interface ChartCommitSuccess {
  ok: true;
  record: ChartRecord;
  op: "create" | "update";
}

export interface ChartCommitFailure {
  ok: false;
  message: string;
}

export type ChartCommitResult = ChartCommitSuccess | ChartCommitFailure;

export function chartIdFromToolCallId(toolCallId: string): string {
  const cleaned = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-48);
  return cleaned.length > 0 ? cleaned : `c${Date.now().toString(36)}`;
}

export function conversationsWithCharts(): string[] {
  return [];
}

export function loadChartRecords(_conversationId: string): ChartRecord[] {
  return [];
}

export function parseChartRecord(raw: unknown, conversationId: string): ChartRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const { chartId, title, revision, toolMessageId, createdAt, updatedAt, spec } = body;
  if (typeof chartId !== "string" || chartId.length === 0) return null;
  if (typeof title !== "string" || title.length === 0) return null;
  if (typeof toolMessageId !== "string") return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return null;
  return {
    conversationId,
    chartId,
    title,
    spec: spec as ChartSpec,
    revision,
    toolMessageId,
    createdAt,
    updatedAt,
  };
}

export function commitChartRequest(
  _request: ChartRequest,
  _ctx: ChartCommitContext,
): ChartCommitResult {
  return {
    ok: false,
    message: "Chart persistence is server-owned; not available in the Studio renderer.",
  };
}

export function chartResourceItem(record: ChartRecord): {
  id: string;
  kind: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  metadata: Record<string, unknown>;
} {
  const content: ChartResourceContent = {
    chartId: record.chartId,
    title: record.title,
    spec: record.spec,
    revision: record.revision,
    toolMessageId: record.toolMessageId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return {
    id: record.chartId,
    kind: CHART_RESOURCE_KIND,
    title: record.title,
    content: JSON.stringify(content),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    conversationId: record.conversationId,
    metadata: {
      chartRevision: record.revision,
      chartToolMessageId: record.toolMessageId,
      chartKind: record.spec?.kind,
      chartSeriesCount: record.spec?.datasets?.length,
      chartPointCount: record.spec?.labels?.length,
    },
  };
}

export interface ChartHistoryRow {
  toolMessageId: string;
  toolInput: string;
  resultText?: string;
  index: number;
}

export interface ChartRebuildOutcome {
  records: ChartRecord[];
  created: ChartRecord[];
  updated: ChartRecord[];
  retained: ChartRecord[];
  removed: string[];
}

export function rebuildFromHistory(
  _conversationId: string,
  _rows: ChartHistoryRow[],
): ChartRebuildOutcome {
  return { records: [], created: [], updated: [], retained: [], removed: [] };
}
