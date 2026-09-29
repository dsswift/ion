/**
 * paired-subject — which principal a paired device acts as.
 *
 * A Studio Server install belongs to one OS account: its data dir is that
 * account's `~/.ion`, its daemons run as that account, and the SSH login
 * that installed it proved that account. Identity is therefore partitioned
 * by the account on the host, and a device is only ever a device.
 *
 *   - Shared tenancy (one person's install): every paired device acts as the
 *     install's own local principal (`local:<username>`) -- the same subject
 *     the person has sitting at the host. Git credentials, engine and model
 *     configuration, and per-principal state are shared across all of that
 *     person's devices, and pairing a second laptop adds a device row, not a
 *     second identity.
 *   - Isolated tenancy (several humans on one install): the subject is the
 *     human named on the pairing link (`user:<name>`), so two of a person's
 *     devices share one partition while two people do not. A bearer that
 *     accompanied the pairing names the human authoritatively and wins over
 *     the link. With neither, the device is its own principal
 *     (`paired:<deviceId>`, or `paired:<clientId>` for a device that did not
 *     identify itself) -- the pre-identity shape, kept so an unnamed pairing
 *     still works.
 */
import { localPrincipal } from './local-principal'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('paired-subject', msg, fields)
}

export const PAIRED_SUBJECT_PREFIX = 'paired:'
export const USER_SUBJECT_PREFIX = 'user:'

/** A human name a pairing link may carry (`pair --as`): short, printable, no separators that would read as another subject scheme. */
const PAIR_AS_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/

export function isValidPairAsName(name: string): boolean {
  return PAIR_AS_NAME.test(name)
}

export function userSubject(name: string): string {
  return `${USER_SUBJECT_PREFIX}${name}`
}

/** True for a subject minted by a pre-identity pairing (`paired:*`): the device-as-principal shape a shared install folds into its host identity. */
export function isDeviceSubject(subject: string): boolean {
  return subject.startsWith(PAIRED_SUBJECT_PREFIX)
}

/** The subject every paired device of a shared-tenancy install acts as: the install's own OS account. */
export function hostSubject(): string {
  return localPrincipal().subject
}

export interface ResolvePairedSubjectInput {
  clientId: string
  sharedTenancy: boolean
  /** Set when a bearer accompanied the pairing: the human is already authenticated by an identity provider. */
  accompanyingSubject?: string
  /** The human the pairing link was minted for (`pair --as <name>`). */
  linkSubject?: string
  /** The device's stable id. */
  deviceId?: string
}

/** Decides a new pairing's subject per the module comment. Logs the branch taken. */
export function resolvePairedSubject(input: ResolvePairedSubjectInput): string {
  if (input.accompanyingSubject) {
    log('subject from accompanying bearer', { client_id: input.clientId, subject: input.accompanyingSubject })
    return input.accompanyingSubject
  }
  if (input.sharedTenancy) {
    const subject = hostSubject()
    log('subject is the host identity (shared tenancy)', { client_id: input.clientId, subject })
    return subject
  }
  if (input.linkSubject) {
    log('subject from the pairing link', { client_id: input.clientId, subject: input.linkSubject })
    return input.linkSubject
  }
  const deviceId = input.deviceId?.trim()
  const subject = deviceId ? `${PAIRED_SUBJECT_PREFIX}${deviceId}` : `${PAIRED_SUBJECT_PREFIX}${input.clientId}`
  log('subject is the device itself (isolated tenancy, no human named)', { client_id: input.clientId, subject, has_device_id: !!deviceId })
  return subject
}
