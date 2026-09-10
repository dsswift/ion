/**
 * Graph View configuration resolution — pure, no disk, no electron.
 *
 * Resolves the two settings scopes (user `~/.ion/settings.json` and project
 * `<projectPath>/.ion/settings.json`) into a single `GraphViewConfig`. This
 * module touches no disk and imports nothing from `electron`, which is what
 * makes every resolution rule directly unit-testable.
 *
 * Resolution rules (see `.workbench/gh-397-metadata-driven-graph-view/specs/01-configuration.md`):
 *   - `corpusRoots` is the union of project roots then user roots, de-duplicated
 *     by resolved absolute path, project order first.
 *   - `savedViews` is a concatenation, never a merge; each view carries its
 *     source scope.
 *   - Scalars take user scope first, then project scope, then the default.
 *   - Lists (arrays) take whichever scope set them (user first), replaced
 *     wholesale, never element-merged.
 */

import { expandHome } from '../git/ignore-paths'
import { debug as _debug, warn as _warn } from '../logger'
import { isAbsolutePath } from '../../shared/paths'
import {
  GRAPH_VIEW_DEFAULTS,
  GRAPH_VIEW_PROJECT_FIELDS,
  type CorpusRootConfig,
  type GraphPromotedField,
  type GraphViewConfig,
  type GraphViewCuratedField,
  type GraphViewSavedView,
  type ScopedSavedView,
} from '../../shared/graph-view-types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

type RawBag = Record<string, unknown>

function isPlainObject(v: unknown): v is RawBag {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function graphViewBlock(fileRaw: RawBag | undefined | null): RawBag {
  const desktop = fileRaw && isPlainObject(fileRaw.desktop) ? (fileRaw.desktop as RawBag) : {}
  return isPlainObject(desktop.graphView) ? (desktop.graphView as RawBag) : {}
}

interface ScalarResult<T> {
  value: T
  source: 'user' | 'project' | 'default'
}

function readScalar<T>(
  userBlock: RawBag,
  projectBlock: RawBag,
  key: string,
  guard: (v: unknown) => v is T,
  fallback: T,
): ScalarResult<T> {
  const userVal = userBlock[key]
  if (guard(userVal)) return { value: userVal, source: 'user' }
  const projectVal = projectBlock[key]
  if (guard(projectVal)) return { value: projectVal, source: 'project' }
  return { value: fallback, source: 'default' }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

interface ListResult {
  value: string[]
  source: 'user' | 'project' | 'default'
}

function readStringList(userBlock: RawBag, projectBlock: RawBag, key: string, fallback: string[]): ListResult {
  const userVal = userBlock[key]
  if (Array.isArray(userVal)) {
    return { value: userVal.filter((v): v is string => typeof v === 'string'), source: 'user' }
  }
  const projectVal = projectBlock[key]
  if (Array.isArray(projectVal)) {
    return { value: projectVal.filter((v): v is string => typeof v === 'string'), source: 'project' }
  }
  return { value: fallback, source: 'default' }
}

function readCuratedFields(userBlock: RawBag, projectBlock: RawBag): GraphViewCuratedField[] {
  const pick = (raw: unknown): GraphViewCuratedField[] | null => {
    if (!Array.isArray(raw)) return null
    const out: GraphViewCuratedField[] = []
    for (const entry of raw) {
      if (!isPlainObject(entry) || typeof entry.field !== 'string' || !entry.field) continue
      out.push({
        field: entry.field,
        ...(typeof entry.displayName === 'string' ? { displayName: entry.displayName } : {}),
        ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
        ...(typeof entry.hidden === 'boolean' ? { hidden: entry.hidden } : {}),
      })
    }
    return out
  }
  return pick(userBlock.curatedFields) ?? pick(projectBlock.curatedFields) ?? []
}

/**
 * Read the promotable-property list. Each entry names a field and,
 * optionally, a hierarchy depth and a segment split; a malformed entry is
 * dropped with a log line rather than failing the whole list, because one
 * bad line in a corpus's settings should not withhold every anchor.
 */
function readPromotedFields(userBlock: RawBag, projectBlock: RawBag): GraphPromotedField[] {
  const pick = (raw: unknown, scope: 'user' | 'project'): GraphPromotedField[] | null => {
    if (!Array.isArray(raw)) return null
    const out: GraphPromotedField[] = []
    for (const entry of raw) {
      const field = typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry.field === 'string' ? entry.field : ''
      if (!field) {
        warn('graph_view: promoted field entry dropped', { scope, reason: 'no-field', raw: JSON.stringify(entry) })
        continue
      }
      const promoted: GraphPromotedField = { field }
      if (isPlainObject(entry)) {
        if (typeof entry.depth === 'number' && Number.isInteger(entry.depth) && entry.depth >= 0) promoted.depth = entry.depth
        else if (entry.depth !== undefined) warn('graph_view: promoted field depth ignored', { scope, field, raw: String(entry.depth) })
        if (isPlainObject(entry.split)) {
          const separator = entry.split.separator
          const index = entry.split.index
          if (typeof separator === 'string' && separator.length > 0 && typeof index === 'number' && Number.isInteger(index) && index >= 0) {
            promoted.split = { separator, index }
          } else {
            warn('graph_view: promoted field split ignored', { scope, field, raw: JSON.stringify(entry.split) })
          }
        }
      }
      out.push(promoted)
    }
    return out
  }
  return pick(userBlock.promotedFields, 'user') ?? pick(projectBlock.promotedFields, 'project') ?? []
}

/**
 * Extract the project-scope block from a raw project settings file, dropping
 * every key not in `GRAPH_VIEW_PROJECT_FIELDS` and every non-graphView
 * `desktop.*` key and every non-`desktop` top-level key. Every dropped key is
 * returned by name so the caller can log it.
 */
export function extractProjectBlock(projectFileRaw: RawBag | undefined | null): { block: RawBag; droppedKeys: string[] } {
  const droppedKeys: string[] = []
  if (!isPlainObject(projectFileRaw)) return { block: {}, droppedKeys }

  for (const key of Object.keys(projectFileRaw)) {
    if (key !== 'desktop') droppedKeys.push(key)
  }

  const desktop = isPlainObject(projectFileRaw.desktop) ? (projectFileRaw.desktop as RawBag) : {}
  for (const key of Object.keys(desktop)) {
    if (key !== 'graphView') droppedKeys.push(key)
  }

  const rawGraphView = isPlainObject(desktop.graphView) ? (desktop.graphView as RawBag) : {}
  const allowed = new Set<string>(GRAPH_VIEW_PROJECT_FIELDS)
  const block: RawBag = {}
  for (const key of Object.keys(rawGraphView)) {
    if (allowed.has(key)) block[key] = rawGraphView[key]
    else droppedKeys.push(key)
  }

  for (const key of droppedKeys) {
    log('graph_view: project settings key dropped', { key })
  }

  return { block, droppedKeys }
}

/** Normalize a raw `corpusRoots` list into absolute, `~`-expanded entries. */
export function normalizeRoots(list: unknown, scope: 'project' | 'user'): CorpusRootConfig[] {
  if (!Array.isArray(list)) return []
  const out: CorpusRootConfig[] = []
  for (const entry of list) {
    let rawPath: string | undefined
    let label: string | undefined
    if (typeof entry === 'string') {
      rawPath = entry
    } else if (isPlainObject(entry) && typeof entry.path === 'string') {
      rawPath = entry.path
      if (typeof entry.label === 'string') label = entry.label
    } else {
      warn('graph_view: corpus root entry dropped', { scope, reason: 'malformed', raw: JSON.stringify(entry) })
      continue
    }
    const expanded = expandHome(rawPath)
    if (!isAbsolutePath(expanded)) {
      warn('graph_view: corpus root entry dropped', { scope, reason: 'not-absolute', raw: rawPath })
      continue
    }
    out.push(label ? { path: expanded, label } : { path: expanded })
  }
  return out
}

function dedupeByPath(roots: CorpusRootConfig[]): CorpusRootConfig[] {
  const seen = new Map<string, CorpusRootConfig>()
  for (const root of roots) {
    if (!seen.has(root.path)) seen.set(root.path, root)
  }
  return [...seen.values()]
}

function tagSource(raw: unknown, source: 'project' | 'user'): ScopedSavedView[] {
  if (!Array.isArray(raw)) return []
  const out: ScopedSavedView[] = []
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || !entry.name) continue
    out.push({ ...(entry as unknown as GraphViewSavedView), source })
  }
  return out
}

/**
 * Resolve a project-scoped `.ion/settings.json` raw object, a user-scoped
 * `~/.ion/settings.json` raw object, and the conversation's project
 * directory into one `GraphViewConfig`.
 *
 * Never throws. Graph View is enabled by default: when the project scope
 * does not set `corpusRoots`, the project's contribution defaults to
 * `[{ path: projectPath }]` — the corpus root follows the conversation's
 * directory (worktree or otherwise). A project that sets its own
 * `corpusRoots` (even `[]`) opts out of that default entirely. User-scope
 * roots (e.g. subscribed knowledge bundles) always union in on top,
 * regardless of the project default. `projectPath: ''` (the invalid-path
 * IPC fallback) never gets a default root.
 */
export function resolveGraphViewConfig(
  userFileRaw: RawBag | undefined | null,
  projectFileRaw: RawBag | undefined | null,
  projectPath: string,
): GraphViewConfig {
  const userBlock = graphViewBlock(userFileRaw)
  const { block: projectBlock, droppedKeys } = extractProjectBlock(projectFileRaw)

  // Presence, not resulting length, decides whether the project opted out of
  // the automatic default: `corpusRoots: []` still suppresses it, even
  // though normalizing an empty array also yields zero entries.
  const projectSetCorpusRoots = Array.isArray(projectBlock.corpusRoots)
  const projectRootsConfigured = normalizeRoots(projectBlock.corpusRoots, 'project')
  const projectRootsSource = projectSetCorpusRoots ? 'project' : projectPath ? 'project-cwd-default' : 'none'
  const projectRoots = projectSetCorpusRoots ? projectRootsConfigured : projectPath ? [{ path: projectPath }] : []

  const roots = dedupeByPath([...projectRoots, ...normalizeRoots(userBlock.corpusRoots, 'user')])

  const savedViews: ScopedSavedView[] = [
    ...tagSource(projectBlock.savedViews, 'project'),
    ...tagSource(userBlock.savedViews, 'user'),
  ]

  const identity = readScalar(userBlock, projectBlock, 'identityField', isNonEmptyString, GRAPH_VIEW_DEFAULTS.identityField)
  const label = readScalar(userBlock, projectBlock, 'labelField', isNonEmptyString, GRAPH_VIEW_DEFAULTS.labelField)
  const tagField = readScalar(userBlock, projectBlock, 'tagField', isNonEmptyString, GRAPH_VIEW_DEFAULTS.tagField)
  const sectionNodes = readScalar(userBlock, projectBlock, 'sectionNodes', isBoolean, GRAPH_VIEW_DEFAULTS.sectionNodes)
  const sectionTopicsField = readScalar(userBlock, projectBlock, 'sectionTopicsField', isNonEmptyString, GRAPH_VIEW_DEFAULTS.sectionTopicsField)
  const defaultView = readScalar(userBlock, projectBlock, 'defaultView', isNonEmptyString, GRAPH_VIEW_DEFAULTS.defaultView)

  const rawDepth = readScalar(
    userBlock,
    projectBlock,
    'neighborhoodDepth',
    (v): v is number => typeof v === 'number' && Number.isInteger(v),
    GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
  )
  let neighborhoodDepth = rawDepth.value
  let neighborhoodDepthSource = rawDepth.source
  if (neighborhoodDepth < 1 || neighborhoodDepth > 5) {
    log('graph_view: neighborhoodDepth out of range, clamped to default', { raw: neighborhoodDepth })
    neighborhoodDepth = GRAPH_VIEW_DEFAULTS.neighborhoodDepth
    neighborhoodDepthSource = 'default'
  }

  const groupFields = readStringList(userBlock, projectBlock, 'groupFields', GRAPH_VIEW_DEFAULTS.groupFields)
  const edgeFields = readStringList(userBlock, projectBlock, 'edgeFields', GRAPH_VIEW_DEFAULTS.edgeFields)
  const hoverFields = readStringList(userBlock, projectBlock, 'hoverFields', GRAPH_VIEW_DEFAULTS.hoverFields)
  const curatedFields = readCuratedFields(userBlock, projectBlock)
  const promotedFields = readPromotedFields(userBlock, projectBlock)

  log('graph_view: config resolved', {
    rootCount: roots.length,
    projectRootsSource,
    identityField: identity.value,
    identityFieldSource: identity.source,
    labelFieldSource: label.source,
    tagFieldSource: tagField.source,
    defaultView: defaultView.value,
    defaultViewSource: defaultView.source,
    savedViewCount: savedViews.length,
    droppedProjectKeys: droppedKeys.join(','),
    groupFieldsSource: groupFields.source,
    edgeFieldsSource: edgeFields.source,
    hoverFieldsSource: hoverFields.source,
    sectionNodesSource: sectionNodes.source,
    sectionTopicsFieldSource: sectionTopicsField.source,
    promotedFieldCount: promotedFields.length,
    neighborhoodDepthSource,
  })

  return {
    corpusRoots: roots,
    identityField: identity.value,
    labelField: label.value,
    tagField: tagField.value,
    defaultView: defaultView.value,
    groupFields: groupFields.value,
    edgeFields: edgeFields.value,
    hoverFields: hoverFields.value,
    curatedFields,
    promotedFields,
    savedViews,
    sectionNodes: sectionNodes.value,
    sectionTopicsField: sectionTopicsField.value,
    neighborhoodDepth,
  }
}
