/**
 * The desktop's opinion on telemetry delivery health: interrupt the operator
 * with an OS notification.
 *
 * The server retains the state, writes the sentence and decides once
 * whether a report is worth a notification (`server/src/engine/
 * telemetry-health.ts`, `notify`); this file only decides whether THIS
 * desktop shows one, which the enterprise policy on the local Environment's
 * welcome may switch off. It hooks the broker's frame stream beside the
 * attention beacon, so it sees the local server's reports and nothing else.
 */
import { Notification } from 'electron'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { readEnvCache } from './env-cache'
import { log as _log } from './logger'

const CHANNEL = 'ion:telemetry-health'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('telemetry_health', msg, fields)
}

/** The switch rides the desktop-owned enterprise policy; absent policy means on. */
export function telemetryHealthNotificationsEnabled(policy: EnterprisePolicy | null | undefined): boolean {
  return !policy?.disableTelemetryHealthNotifications
}

function localPolicy(): EnterprisePolicy | null {
  const welcome = readEnvCache(LOCAL_ENVIRONMENT_ID)?.welcome
  return welcome && welcome.type === 'studio_welcome' ? welcome.enterprisePolicy : null
}

/** Injectable for tests: defaults to Electron's Notification. */
export interface NotifierDeps {
  show: (body: string) => void
  enabled: () => boolean
}

const defaultDeps: NotifierDeps = {
  show: (body) => {
    if (!Notification.isSupported()) return
    new Notification({ title: 'Ion', body }).show()
  },
  enabled: () => telemetryHealthNotificationsEnabled(localPolicy()),
}

/** One frame in; a notification out when the local server says so and policy allows. */
export function notifyTelemetryHealth(environmentId: string, frame: StudioFrame, deps: NotifierDeps = defaultDeps): void {
  if (environmentId !== LOCAL_ENVIRONMENT_ID || frame.type !== 'studio_event' || frame.channel !== CHANNEL) return
  const report = frame.payload as { notify?: boolean; message?: string; state?: { target?: string } } | undefined
  if (!report?.notify || typeof report.message !== 'string') return
  if (!deps.enabled()) {
    log('notification suppressed by enterprise policy', { target: report.state?.target ?? 'unknown' })
    return
  }
  log('notifying operator', { target: report.state?.target ?? 'unknown' })
  deps.show(report.message)
}
