/**
 * Re-export of the connection phase types (spec 12). Moved to
 * `desktop/src/shared/types-connections.ts` so the renderer's `StudioHost`
 * can use the same types without importing from `main/` (desktop CLAUDE.md:
 * renderer code must not import Electron-bound code from `main/`). This file
 * keeps the `./phases` import path working for every existing main-side
 * caller (broker.ts, studio-bridge.ts).
 */
export type { ConnectionTransportKind, ConnectionPhase, ConnectionPhaseSnapshot } from '../../shared/types-connections'
