/**
 * The managed-default policy class: an enterprise value that seeds a
 * user-editable preference when its policy is not locked.
 *
 * A client remembers the last policy value it applied to each preference (the
 * watermark). A policy value that differs from the watermark overwrites the
 * preference. A policy value equal to the watermark leaves the preference
 * alone, so a person who changed away from the default keeps their choice
 * until an administrator publishes a different value.
 *
 * `assets/managed-default-parity.json` pins this rule for every client.
 */

export type ManagedDefaultDecision =
  /** The policy carries no value for this preference. Nothing to do. */
  | 'absent'
  /** The policy is locked. The lock path enforces it; the watermark is not involved. */
  | 'locked'
  /** The policy value is the one already applied. The preference is the person's. */
  | 'keep'
  /** The policy value is new to this installation. Overwrite and record it. */
  | 'apply'

export interface ManagedDefaultInput {
  /** The policy's value for the preference. Empty or missing means the policy does not set it. */
  policyValue: string | null | undefined
  locked: boolean
  /** The watermark: the last policy value applied to this preference, if any. */
  applied: string | null | undefined
}

export function decideManagedDefault(input: ManagedDefaultInput): ManagedDefaultDecision {
  if (!input.policyValue) return 'absent'
  if (input.locked) return 'locked'
  return input.policyValue === input.applied ? 'keep' : 'apply'
}

/** Watermarks, keyed by the preference each one belongs to. */
export type ManagedDefaultWatermarks = Record<string, string>

/** A stored watermark map as read from disk. Anything malformed is dropped, which re-applies that default once. */
export function sanitizeManagedDefaultWatermarks(raw: unknown): ManagedDefaultWatermarks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ManagedDefaultWatermarks = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}
