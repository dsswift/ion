import type { Dispatch, SetStateAction } from 'react'

export type InboxProjectSelection = ReadonlySet<string>

export const ALL_PROJECTS: InboxProjectSelection = new Set<string>()

export function loadProjectSelection(stored: string | null): InboxProjectSelection {
  if (!stored) return ALL_PROJECTS
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return new Set([stored])
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    // Before multi-select, this value was one unencoded project path.
    return new Set([stored])
  }
}

export function saveProjectSelection(selection: InboxProjectSelection): string | null {
  return selection.size === 0 ? null : JSON.stringify([...selection])
}

export function toggleProjectSelection(
  selection: InboxProjectSelection,
  projectKey: string,
): InboxProjectSelection {
  const next = new Set(selection)
  if (next.has(projectKey)) next.delete(projectKey)
  else next.add(projectKey)
  return next
}

export type ProjectSelectionSetter = Dispatch<SetStateAction<InboxProjectSelection>>
