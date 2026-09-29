/**
 * new-conversation-machine-control — what a project row says about machines.
 *
 * Two separate jobs, deliberately kept on two separate parts of the row.
 *
 * WHERE IT OPENS is stated in the row's second line, by colouring the machine
 * name: this machine in the accent, any other machine in `iconPurple`.
 * Colour carries it because the row already spends its right-hand side on the
 * offer below, and a second badge there made a list of remote projects read
 * as a wall of identical pills. Colour also scales: nine rows on one other
 * machine are nine tinted words, not nine badges.
 *
 * `iconPurple` rather than the `statusRunning` orange the Inbox's
 * EnvironmentBadge wears for the same idea. That badge can afford the orange
 * because colour is not its only signal -- it has an icon, a border and a
 * background tint, and it appears on remote rows alone. Here colour IS the
 * whole signal, so it has to differ from the accent in every theme, and
 * `statusRunning` IS the accent in Classic and HUD. Purple is the only hue
 * distinct from every palette's accent.
 *
 * WHERE ELSE IT COULD OPEN is the control on the right, and it offers only
 * machines the row is not already using — never the one it is.
 *
 * An earlier version put the destination in a badge on the right instead.
 * That was legible but heavy, and it collided with the offer: a project on
 * two machines had to show one badge for where it goes and another for where
 * else it could, side by side, which is exactly the clutter the badge was
 * introduced to remove.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { MergedProjectRow, ProjectHolder } from '../studio/connection/environment-projects'

export type MachineControl =
  /** Nothing to offer: no other machine has it, or the section already is the picker. */
  | { kind: 'none' }
  /** Exactly one other machine has it: one chip, one click, no menu. */
  | { kind: 'alternative'; holder: ProjectHolder }
  /** Several others have it: one counted button opening a menu. */
  | { kind: 'alternatives'; alternatives: ProjectHolder[] }

/** Whether a machine is the one this desktop runs on, which is what the row's colour says. */
export function isLocalEnvironment(environmentId: string): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID
}

/**
 * The machine a row acts on, resolved against its holders. Falls back to the
 * first holder when the requested machine is not one of them, so a row always
 * names something real.
 */
export function actingHolder(row: MergedProjectRow, actingEnvironmentId: string): ProjectHolder | undefined {
  return row.holders.find((holder) => holder.environmentId === actingEnvironmentId) ?? row.holders[0]
}

/**
 * `inMachineSection` is a per-machine section of the list. The sections there
 * ARE how you choose a machine, so offering one per row would be the same UI
 * twice.
 */
export function machineControlFor(
  row: MergedProjectRow,
  actingEnvironmentId: string,
  options: { inMachineSection?: boolean } = {},
): MachineControl {
  const acting = actingHolder(row, actingEnvironmentId)
  if (!acting || options.inMachineSection) return { kind: 'none' }
  const alternatives = row.holders.filter((holder) => holder.environmentId !== acting.environmentId)
  if (alternatives.length === 0) return { kind: 'none' }
  if (alternatives.length === 1) return { kind: 'alternative', holder: alternatives[0] }
  return { kind: 'alternatives', alternatives }
}
