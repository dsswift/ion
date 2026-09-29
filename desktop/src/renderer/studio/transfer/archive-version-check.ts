/**
 * archive-version-check — refuse a transfer between two servers that write
 * different transfer archive formats, before anything is exported.
 *
 * The destination refuses an archive in a format it does not read, but only
 * after the source has exported it, and an older source marks the
 * conversation as mid-transfer when it exports. Asking both ends first
 * means a mismatch touches nothing. A server that does not report a format
 * predates the field and writes format 1.
 */
import type { TransferDescription, TransferPreflight } from '@ion/shared/types-environment-admin'
import type { TransferCheck } from './useTransferPreflight'

export function archiveVersionCheck(
  description: TransferDescription | null,
  preflight: TransferPreflight | null,
  targetLabel: string,
): TransferCheck | null {
  if (!description || !preflight) return null
  const source = description.archiveVersion ?? 1
  const target = preflight.archiveVersion ?? 1
  if (source === target) return null
  const older = source < target ? "The conversation's machine" : targetLabel
  return {
    id: 'version',
    state: 'blocked',
    label: `${older} runs an older Ion server`,
    detail: `The two servers write different transfer formats (${source} and ${target}). Update the older server, then transfer. Nothing has moved.`,
  }
}
