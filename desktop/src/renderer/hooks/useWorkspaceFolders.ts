/**
 * useWorkspaceFolders — a Project's extra folders, on the server of the
 * conversation on screen.
 *
 * `workspaceFolders` is an Account setting: the paths in it are paths on one
 * server. The explorer and the git panel show the conversation on screen, so
 * they read that conversation's server's list and write back to it. Writing a
 * path from another server into this machine's list, or mounting this
 * machine's folders into another server's conversation, names directories
 * that are not there.
 */
import { useCallback } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { PreferencesState } from '@ion/server/preferences-types'
import { usePreferencesStore } from '../preferences'
import { withWorkspaceFolderAdded, withWorkspaceFolderRemoved } from '../preferences-workspace'
import { host } from '../host/host-instance'
import { promptForDirectory } from '../host/save-path-prompt-state'
import { useActiveTabEnvironmentId } from '../studio/connection/tab-environment'
import { environmentSetting, saveEnvironmentSettings, useEnvironmentSettingsStore } from '../studio/state/environment-settings-store'
import { isWorkspaceFolders, NO_WORKSPACE_FOLDERS, useServerSetting } from '../studio/state/use-server-setting'
import { rInfo, rWarn } from '../rendererLogger'

type WorkspaceFolders = PreferencesState['workspaceFolders']

export interface WorkspaceFoldersHandle {
  /** The server these folders live on. */
  environmentId: string
  folders: WorkspaceFolders
  add(projectDir: string, dir: string): void
  remove(projectDir: string, dir: string): void
  /** Ask for a directory on that server: the native dialog here, a typed path elsewhere. */
  pick(startPath?: string): Promise<string | null>
}

function currentRemoteFolders(environmentId: string): WorkspaceFolders {
  const raw = environmentSetting<unknown>(useEnvironmentSettingsStore.getState(), environmentId, 'workspaceFolders')
  return isWorkspaceFolders(raw) ? raw : NO_WORKSPACE_FOLDERS
}

function saveRemote(environmentId: string, next: WorkspaceFolders, change: string): void {
  saveEnvironmentSettings(environmentId, { workspaceFolders: next })
    .then(() => rInfo('workspace', 'workspace folders saved on the conversation server', { environment_id: environmentId, change }))
    .catch((err: unknown) => rWarn('workspace', 'workspace folders save failed', { environment_id: environmentId, change, error: String(err) }))
}

export function useWorkspaceFolders(): WorkspaceFoldersHandle {
  const environmentId = useActiveTabEnvironmentId()
  const folders = useServerSetting(environmentId, 'workspaceFolders', isWorkspaceFolders, NO_WORKSPACE_FOLDERS)

  const add = useCallback((projectDir: string, dir: string): void => {
    if (environmentId === LOCAL_ENVIRONMENT_ID) { usePreferencesStore.getState().addWorkspaceFolder(projectDir, dir); return }
    const next = withWorkspaceFolderAdded(currentRemoteFolders(environmentId), projectDir, dir)
    if (next) saveRemote(environmentId, next, 'add')
  }, [environmentId])

  const remove = useCallback((projectDir: string, dir: string): void => {
    if (environmentId === LOCAL_ENVIRONMENT_ID) { usePreferencesStore.getState().removeWorkspaceFolder(projectDir, dir); return }
    const next = withWorkspaceFolderRemoved(currentRemoteFolders(environmentId), projectDir, dir)
    if (next) saveRemote(environmentId, next, 'remove')
  }, [environmentId])

  const pick = useCallback(async (startPath?: string): Promise<string | null> => {
    // The native dialog browses this machine, so it can only name a folder
    // for a conversation that is on this machine.
    if (environmentId === LOCAL_ENVIRONMENT_ID) return host.pickDirectory()
    return (await promptForDirectory(startPath)).filePath
  }, [environmentId])

  return { environmentId, folders, add, remove, pick }
}
