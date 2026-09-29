/**
 * The composer's prompt stash, as the renderer holds it.
 *
 * The Environment's settings are the truth (`studioComposerStash`); this store
 * is the loaded copy plus the two writes. Every write goes back through
 * `studioSetSetting`, whose validator is the same parser used here, and other
 * windows converge through `ion:settings-changed`.
 */
import { create } from 'zustand'
import {
  EMPTY_COMPOSER_STASH,
  parseComposerStash,
  pushStashEntry,
  removeStashEntry,
  type ComposerStash,
  type ComposerStashEntry,
  type StashedAttachment,
} from '@ion/shared/composer-stash'
import type { FileAttachment } from '@ion/shared/types'
import { host } from '../../host/host-instance'
import { rInfo, rWarn } from '../../rendererLogger'

const SETTING_KEY = 'studioComposerStash'

interface ComposerStashState {
  stash: ComposerStash
  /** Read the persisted stash and follow later changes. Returns the unsubscribe. */
  connect: () => () => void
  push: (projectKey: string, text: string, attachments: readonly FileAttachment[]) => void
  remove: (projectKey: string, entryId: string) => void
}

function toStashed(a: FileAttachment): StashedAttachment {
  // The inline preview is dropped: it can be megabytes, and it is rebuilt from
  // the path when the attachment is staged again.
  return { id: a.id, type: a.type === 'image' ? 'image' : 'file', name: a.name, path: a.path, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }
}

function persist(next: ComposerStash, reason: string): void {
  void host.shell.studioSetSetting(SETTING_KEY, next)
    .then((ok) => { if (!ok) rWarn('composer', 'stash persist rejected by validator', { reason }) })
    .catch((err) => rWarn('composer', 'stash persist failed', { reason, error: String(err) }))
}

export const useComposerStashStore = create<ComposerStashState>((set, get) => ({
  stash: EMPTY_COMPOSER_STASH,

  connect: () => {
    const accept = (value: unknown, source: string): void => {
      const parsed = parseComposerStash(value)
      if (parsed) set({ stash: parsed })
      else rWarn('composer', 'ignored an invalid persisted stash', { source })
    }
    void host.shell.studioGetSettings()
      .then((settings) => accept(settings.studioComposerStash, 'load'))
      .catch((err) => rWarn('composer', 'stash load failed', { error: String(err) }))
    return host.shell.onSettingsChanged((key, value) => { if (key === SETTING_KEY) accept(value, 'settings-changed') })
  },

  push: (projectKey, text, attachments) => {
    const entry: ComposerStashEntry = {
      id: crypto.randomUUID(),
      text,
      attachments: attachments.map(toStashed),
      createdAt: Date.now(),
    }
    const next = pushStashEntry(get().stash, projectKey, entry)
    set({ stash: next })
    rInfo('composer', 'prompt stashed', { project: projectKey, chars: text.length, attachments: attachments.length })
    persist(next, 'push')
  },

  remove: (projectKey, entryId) => {
    const next = removeStashEntry(get().stash, projectKey, entryId)
    set({ stash: next })
    persist(next, 'remove')
  },
}))
