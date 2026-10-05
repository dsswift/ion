/**
 * What a browser Studio client cannot do, said in one place: it has one
 * environment (the origin that served it), no catalog to add another to, no
 * `ion` command or SSH keys, and no binary channel for a file transfer.
 * `BrowserStudioHost` extends this, so each of these answers "no" the same
 * way wherever a shared component asks.
 */
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import type { FleetRunProgress, FleetRunRequest, FleetRunSnapshot, FleetRunStart } from '@ion/shared/types-fleet-run'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import type { ExportFileResult, ImportFileResult, TransferProgress } from '@ion/shared/types-transfer'
import { rWarn } from '../rendererLogger'

export abstract class BrowserUnsupported {
  async pairEnvironment(_link: string, _label?: string): Promise<{ ok: true; target: EnvironmentTarget } | { ok: false; error: string }> {
    // A browser client has exactly one environment -- the origin that served
    // it -- and no catalog to add a paired server to (see `catalog.ts`).
    rWarn('BrowserStudioHost', 'pairEnvironment refused: a browser client cannot add environments')
    return { ok: false, error: 'A browser Studio client cannot pair with other environments.' }
  }

  async sshAddEnvironment(_destination: string, _label?: string): Promise<SshAddEnvironmentResult> {
    // Same reason as pairEnvironment: a browser client has no catalog and no ssh binary.
    rWarn('BrowserStudioHost', 'sshAddEnvironment refused: a browser client cannot add environments')
    return { ok: false, error: 'A browser Studio client cannot add environments over SSH.' }
  }

  async browseNearby(): Promise<NearbyStudioServer[]> {
    // A browser tab cannot do mDNS, and a browser client adds no environments.
    return []
  }

  onSshProgress(_cb: (progress: SshAddEnvironmentProgress) => void): () => void {
    return () => {}
  }

  /** A browser has no `ion` command, checkout, or SSH keys to deploy with. */
  fleetRun(_request: FleetRunRequest): Promise<FleetRunStart> {
    return Promise.resolve({ ok: false, error: 'Deploying from source needs the Ion desktop app.' })
  }

  cancelFleetRun(_runId: string): void {}

  fleetRuns(): Promise<FleetRunSnapshot[]> {
    return Promise.resolve([])
  }

  onFleetProgress(_cb: (progress: FleetRunProgress) => void): () => void {
    return () => {}
  }

  /** A browser client has one environment and no catalog file. */
  onCatalogChangedOnDisk(_cb: () => void): () => void {
    return () => {}
  }

  async exportToFile(): Promise<ExportFileResult> {
    return { ok: false, refusal: { code: 'unsupported', message: 'file transfer is not available in a browser Studio client' } }
  }

  async importFromFile(): Promise<ImportFileResult> {
    return { ok: false, refusal: { code: 'unsupported', message: 'file transfer is not available in a browser Studio client' } }
  }

  onTransferProgress(_cb: (progress: TransferProgress) => void): () => void {
    // No binary channel is opened over this socket (see handleMessage) — transfer never produces progress here.
    return () => {}
  }

  async cancelTransfer(): Promise<boolean> {
    // Nothing can be in flight: exportToFile/importFromFile are refused above.
    return false
  }
}
