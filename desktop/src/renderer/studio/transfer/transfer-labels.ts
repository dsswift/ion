/** Shared step labels for the transfer progress card and its failure text. */
import type { TransferStep } from './transfer-flow'

export const STEP_LABEL: Record<TransferStep, string> = {
  exporting: 'Exporting',
  importing: 'Importing',
  removing: 'Removing the original',
  moving: 'Moving',
}
