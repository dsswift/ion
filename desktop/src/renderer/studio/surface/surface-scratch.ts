import type { TabState } from '../../../shared/types'
import {
  scratchTabId,
  type ScratchDocument,
  type ScratchProject,
  type ScratchTab,
} from '../../../shared/studio-surface-types'
import { editorDirForTab, nextUntitledNameFromNames } from '../../stores/session-store-helpers'

export function scratchProjectKey(tab: Pick<TabState, 'workingDirectory' | 'worktree'> | undefined): string | null {
  return tab ? editorDirForTab(tab) : null
}

export function scratchTabsForProject(
  projects: Readonly<Record<string, ScratchProject>>,
  projectKey: string | null,
): ScratchTab[] {
  if (!projectKey) return []
  return (projects[projectKey]?.documents ?? []).map((document) => ({
    kind: 'scratch',
    id: scratchTabId(document.id),
    projectKey,
    documentId: document.id,
    fileName: document.fileName,
    dirty: document.content !== document.savedContent,
  }))
}

export function createScratchDocument(
  projects: Readonly<Record<string, ScratchProject>>,
  projectKey: string,
  namesInUse: Iterable<string>,
  id: string,
): { projects: Record<string, ScratchProject>; document: ScratchDocument } {
  const document: ScratchDocument = {
    id,
    fileName: nextUntitledNameFromNames(namesInUse),
    content: '',
    savedContent: '',
    isPreview: false,
  }
  const current = projects[projectKey] ?? { documents: [] }
  return {
    projects: {
      ...projects,
      [projectKey]: { documents: [...current.documents, document] },
    },
    document,
  }
}

export function updateScratchDocument(
  projects: Readonly<Record<string, ScratchProject>>,
  projectKey: string,
  documentId: string,
  update: (document: ScratchDocument) => ScratchDocument,
): Record<string, ScratchProject> | null {
  const current = projects[projectKey]
  if (!current) return null
  let found = false
  const documents = current.documents.map((document) => {
    if (document.id !== documentId) return document
    found = true
    return update(document)
  })
  return found ? { ...projects, [projectKey]: { documents } } : null
}

export function removeScratchDocument(
  projects: Readonly<Record<string, ScratchProject>>,
  projectKey: string,
  documentId: string,
): Record<string, ScratchProject> | null {
  const current = projects[projectKey]
  if (!current || !current.documents.some((document) => document.id === documentId)) return null
  const documents = current.documents.filter((document) => document.id !== documentId)
  const next = { ...projects }
  if (documents.length === 0) delete next[projectKey]
  else next[projectKey] = { documents }
  return next
}
