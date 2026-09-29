/**
 * pairing-access — how this connection pairs a device with a server, which
 * depends on what it may do there.
 *
 * An admin mints links with the server's pairing defaults, sees every
 * pairing, and can offer a typed discovery code. Anyone else pairs only
 * their own devices: the link makes the device act as them with their own
 * scopes, they see only their own devices, and the discovery actions that
 * produce a code are admin-only, so they offer the QR code alone.
 */
import { environmentClient, type MintedPairingLink } from '../../environment/environment-client'

export interface PairingAccess {
  kind: 'admin' | 'own'
  mint(environmentId: string, label: string): Promise<MintedPairingLink>
  /** The live pairings this connection can see. One beyond them is the device being paired. */
  pairedIds(environmentId: string): Promise<string[]>
  /** Whether a typed discovery code may be offered beside the QR code. */
  offersCode: boolean
}

export const ADMIN_PAIRING: PairingAccess = {
  kind: 'admin',
  // No scopes: the device gets the server's own pairing defaults, the same
  // as any other device, so an admin phone can run the server.
  mint: (env, label) => environmentClient.mintPairingLink(env, label),
  pairedIds: async (env) => (await environmentClient.listClients(env)).filter((c) => !c.revokedAt).map((c) => c.clientId),
  offersCode: true,
}

export const OWN_PAIRING: PairingAccess = {
  kind: 'own',
  mint: (env, label) => environmentClient.mintOwnPairingLink(env, label),
  pairedIds: async (env) => (await environmentClient.listOwnDevices(env)).map((d) => d.clientId),
  offersCode: false,
}
