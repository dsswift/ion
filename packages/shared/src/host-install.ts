/**
 * Host self-install: a server restarts itself, installs a release, or
 * installs a build a client sent, on its own machine. A deploy is a command
 * to the host over its Studio connection, so it works over a relay and from
 * a phone.
 *
 * A Studio Server bundle does it with its own `ion studio` command. A server
 * that a desktop runs cannot replace the app that runs it, so it asks that
 * desktop, which is connected to it on the host.
 */

/** What the host is asked to do. */
export type HostInstallRequest =
  | { kind: 'restart' }
  /** Install a release: `version`, or the newest when absent. */
  | { kind: 'release'; version?: string }
  /** Install the build at `path` on the host. */
  | { kind: 'artifact'; path: string }

/** A step of a host install, published on `ion:host-install-progress`. */
export interface HostInstallProgress {
  /** `requested`: handed to the installer. `refused`: it will not run, `code` says why. `downloading`, `installing`, `restarting`: under way. `failed`: it stopped. `completed`: the host is back up after it. */
  stage: 'requested' | 'refused' | 'downloading' | 'installing' | 'restarting' | 'failed' | 'completed'
  kind: HostInstallRequest['kind']
  /** The server version the host runs once it is back, for `completed`. */
  version?: string
  /** Why a refused or failed install did not happen, in a sentence a person reads. */
  message?: string
  /** A stable word for the refusal (see `HOST_INSTALL_REFUSALS`). */
  code?: string
  /** Unix ms. */
  at: number
}

export const HOST_INSTALL_PROGRESS_CHANNEL = 'ion:host-install-progress'

/** Whether a step ends an install: nothing follows it. */
export function hostInstallEnded(stage: HostInstallProgress['stage']): boolean {
  return stage === 'refused' || stage === 'failed' || stage === 'completed'
}

/** An install heard nothing of for this long is no longer shown as under way. */
export const HOST_INSTALL_STALE_MS = 30 * 60_000

/** Sent to the desktop that runs the server: do this on the host. Delivered to that one connection, never broadcast. */
export const HOST_INSTALL_REQUESTED_CHANNEL = 'ion:host-install-requested'

/** A desktop advertises this when it can carry out a host install for the server it runs. */
export const HOST_INSTALL_CAPABILITY = 'host-install'

/** Why a host will not install on itself. */
export const HOST_INSTALL_REFUSALS = {
  /** A server started from a checkout or by hand: nothing here can replace or restart it. */
  no_bundle: 'this server is not installed from a Studio Server bundle or run by a desktop; restart or update it the way it was started',
  /** The services run as the system and restarting them needs a sudo password. */
  needs_sudo: 'this server runs as system services, and restarting them needs sudo with a password; update it over SSH',
  /** The desktop that runs the server is not connected to it. */
  host_app_unreachable: 'the desktop that runs this server is not answering; update it on the machine itself',
  /** Device policy turns the desktop\'s own updates off. */
  updates_disabled: 'updates are turned off on this machine by its device management',
  /** The signed-in person cannot replace the app. */
  not_admin: 'the person signed in on this machine cannot replace the app; updates come from its device management',
  /** A Windows install for every user needs an administrator to approve it. */
  needs_administrator: 'this Windows install is for every user, which needs an administrator; deploy it with ion fleet over SSH',
  /** A development build has no installed app to replace. */
  not_packaged: 'this desktop is a development build with no installed app to replace',
} as const

export type HostInstallRefusal = keyof typeof HOST_INSTALL_REFUSALS
