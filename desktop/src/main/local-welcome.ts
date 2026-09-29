/**
 * The local Environment's first live `studio_welcome`, which carries the
 * enterprise policy this process acts on at startup (the auto-update kill
 * switch, the operator identity provider). A fresh install has no cached
 * welcome, so policy read from the cache is missing on first launch.
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { IonDesktopPolicyFields } from '@ion/shared/types-engine'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { ConnectionPhase } from './connections/phases'
import { log } from './logger'

export type StudioWelcome = Extract<StudioFrame, { type: 'studio_welcome' }>

type WelcomeSource = {
  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void
  onPhase(cb: (environmentId: string, phase: ConnectionPhase) => void): () => void
}

/**
 * Resolves with the local Environment's first welcome, or null once its
 * connection gives up (offline). Subscribe before connecting: a welcome
 * delivered earlier is missed.
 */
export function firstLocalWelcome(source: WelcomeSource): Promise<StudioWelcome | null> {
  return new Promise((resolve) => {
    const settle = (welcome: StudioWelcome | null): void => {
      offFrame()
      offPhase()
      log('app_lifecycle', welcome ? 'local environment policy received' : 'local environment offline before its policy arrived')
      resolve(welcome)
    }
    const offFrame = source.onFrame((environmentId, frame) => {
      if (environmentId === LOCAL_ENVIRONMENT_ID && frame.type === 'studio_welcome') settle(frame)
    })
    const offPhase = source.onPhase((environmentId, phase) => {
      if (environmentId === LOCAL_ENVIRONMENT_ID && phase.phase === 'offline') settle(null)
    })
  })
}

export function disableAutoUpdateFrom(welcome: StudioWelcome): boolean {
  const fields = (welcome.enterprisePolicy?.customFields?.['ion-desktop'] ?? {}) as IonDesktopPolicyFields
  return fields.disableAutoUpdate === true
}
