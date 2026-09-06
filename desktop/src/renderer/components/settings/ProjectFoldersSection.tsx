/**
 * ProjectFoldersSection — one Project row's mounted folders.
 *
 * A Project is its source directory plus zero or more mounted folders, and
 * every checkout of that Project — the base repo, each worktree, each bench —
 * shows the same set. The explorer's "Add Folder to Workspace" writes the list
 * for whichever Project the active tab resolves to; this is where the operator
 * sees and edits it for a Project they are not currently sitting in.
 *
 * Lives in its own file so ProjectsCategory stays under the file-size cap.
 */
import React from 'react'
import { Folders, Trash } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { rError } from '../../rendererLogger'
import { pickDirectoryForSession } from '../../stores/remote-fs-store'

/** Stable empty list: a fresh [] out of the selector would re-render forever. */
const NO_FOLDERS: string[] = []

export function ProjectFoldersSection({
  projectDir,
  displayName,
  disabled,
}: {
  projectDir: string
  displayName: string
  disabled?: boolean
}): React.JSX.Element {
  const colors = useColors()
  const folders = usePreferencesStore((state) => state.workspaceFolders[projectDir] ?? NO_FOLDERS)
  const addWorkspaceFolder = usePreferencesStore((state) => state.addWorkspaceFolder)
  const removeWorkspaceFolder = usePreferencesStore((state) => state.removeWorkspaceFolder)

  const handleAdd = async (): Promise<void> => {
    const directory = await pickDirectoryForSession({ currentPath: projectDir })
    if (directory) addWorkspaceFolder(projectDir, directory)
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: colors.textTertiary,
    fontFamily: 'monospace',
    fontSize: 11,
    minWidth: 0,
  }

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {folders.map((folder) => (
        <div key={folder} style={rowStyle}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder}</span>
          <button
            aria-label={`Remove ${folder} from ${displayName}`}
            onClick={() => removeWorkspaceFolder(projectDir, folder)}
            disabled={disabled}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 2,
              cursor: disabled ? 'default' : 'pointer',
              color: colors.textTertiary,
              opacity: disabled ? 0.55 : 1,
              display: 'flex',
            }}
          >
            <Trash size={13} />
          </button>
        </div>
      ))}
      <button
        aria-label={`Add folder to ${displayName}`}
        onClick={() => { void handleAdd().catch((error: unknown) => rError('settings', 'add project folder failed', { project: projectDir, error: String(error) })) }}
        disabled={disabled}
        style={{
          alignSelf: 'flex-start',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: disabled ? 'default' : 'pointer',
          color: colors.textSecondary,
          opacity: disabled ? 0.55 : 1,
          fontSize: 11,
        }}
      >
        <Folders size={14} />
        Add folder to workspace
      </button>
    </div>
  )
}
