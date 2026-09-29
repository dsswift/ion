/**
 * use-server-setting — read a server-owned setting for the server a
 * conversation actually lives on.
 *
 * An Environment setting and an Account setting belong to ONE server
 * (`@ion/shared/settings-registry`). A surface that acts on a conversation
 * must read that conversation's server's value. Reading the app-wide
 * preference store instead reads the LOCAL server's, and for a conversation
 * elsewhere that is the wrong machine's answer: this Mac's commit command run
 * in another server's terminal, this Mac's quick tools offered where they do
 * not exist, this Mac's land strategy applied to another server's worktree.
 *
 * For the local server the value comes from the app-wide store, which is
 * already validated and updates the instant a setter runs. For any other
 * server it comes from `environment-settings-store`, which holds what that
 * server sent, so the caller passes a guard and a fallback: the wire value is
 * unvalidated JSON.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { PreferencesState } from '@ion/server/preferences-types'
import type { SettingKey } from '@ion/shared/settings-registry'
import { usePreferencesStore } from '../../preferences'
import { useActiveTabEnvironmentId } from '../connection/tab-environment'
import { environmentSetting, useEnvironmentSettingsStore } from './environment-settings-store'

/** Keys that are both a server-owned setting and a field of the preference store. */
type ServerSettingKey = SettingKey & keyof PreferencesState

/** Pure form, for code outside React. */
export function serverSettingOf<K extends ServerSettingKey>(
  environmentId: string,
  key: K,
  isValid: (value: unknown) => value is PreferencesState[K],
  fallback: PreferencesState[K],
): PreferencesState[K] {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return usePreferencesStore.getState()[key]
  const raw = environmentSetting<unknown>(useEnvironmentSettingsStore.getState(), environmentId, key)
  return isValid(raw) ? raw : fallback
}

/** `key` as the server `environmentId` holds it for this person. */
export function useServerSetting<K extends ServerSettingKey>(
  environmentId: string,
  key: K,
  isValid: (value: unknown) => value is PreferencesState[K],
  fallback: PreferencesState[K],
): PreferencesState[K] {
  // Both stores are subscribed on every render; which one answers depends on
  // the server, and hooks may not be called conditionally.
  const local = usePreferencesStore((s) => s[key])
  const remote = useEnvironmentSettingsStore((s) => environmentSetting<unknown>(s, environmentId, key))
  if (environmentId === LOCAL_ENVIRONMENT_ID) return local
  return isValid(remote) ? remote : fallback
}

/** `key` on the server of the conversation on screen. */
export function useActiveServerSetting<K extends ServerSettingKey>(
  key: K,
  isValid: (value: unknown) => value is PreferencesState[K],
  fallback: PreferencesState[K],
): PreferencesState[K] {
  return useServerSetting(useActiveTabEnvironmentId(), key, isValid, fallback)
}

// ── guards for the settings conversation surfaces read ──────────────────

export const isString = (v: unknown): v is string => typeof v === 'string'
export const isGitOpsMode = (v: unknown): v is PreferencesState['gitOpsMode'] => v === 'manual' || v === 'worktree'
export const isCompletionStrategy = (v: unknown): v is PreferencesState['worktreeCompletionStrategy'] => v === 'merge-ff' || v === 'merge' || v === 'pr'
export const isNonNegativeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
export const isQuickToolList = (v: unknown): v is PreferencesState['quickTools'] =>
  Array.isArray(v) && v.every((t) => !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string')
export const isEngineProfileList = (v: unknown): v is PreferencesState['engineProfiles'] =>
  Array.isArray(v) && v.every((p) => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
export const isProjectRegistry = (v: unknown): v is PreferencesState['projects'] =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => !!x && typeof x === 'object')
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
export const isNumberRecord = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'number')

/** Stable empty values, so a server that has not answered does not re-render its readers. */
export const NO_PROJECTS: PreferencesState['projects'] = {}
export const NO_STRINGS: string[] = []
export const NO_COUNTS: Record<string, number> = {}
export const isWorkspaceFolders = (v: unknown): v is PreferencesState['workspaceFolders'] =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isStringList)
export const NO_WORKSPACE_FOLDERS: PreferencesState['workspaceFolders'] = {}
