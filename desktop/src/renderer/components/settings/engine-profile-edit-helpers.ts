import type { EngineProfile } from '../../../shared/types'

export interface ProfileEditState {
  name: string
  extensions: string[]
  defaultMode: 'auto' | 'plan'
}

export const emptyProfileEdit: ProfileEditState = {
  name: '',
  extensions: [],
  defaultMode: 'auto',
}

export function profileToEdit(p: EngineProfile): ProfileEditState {
  return {
    name: p.name,
    extensions: [...(p.extensions || [])],
    defaultMode: p.defaultMode ?? 'auto',
  }
}

export function editToProfile(id: string, e: ProfileEditState): EngineProfile {
  return {
    id,
    name: e.name.trim(),
    extensions: e.extensions.filter((x) => x.trim()),
    defaultMode: e.defaultMode,
  }
}
