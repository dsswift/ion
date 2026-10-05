/**
 * compat/registry — the Studio server's Format Versions: every versioned
 * format the server (and the `@ion/shared` code it runs) reads or writes,
 * with the rule that decides whether two builds can work together over it.
 *
 * The engine keeps the matching registry for its own formats
 * (engine/internal/compat). `__tests__/registry.test.ts` scans the server and
 * shared sources for version constants, so a new one fails the build until it
 * is registered here or named as not a format.
 */
import type { FormatVersion } from '@ion/shared/format-versions'
import { CHART_SCHEMA_VERSION } from '@ion/shared/chart-schema'
import { E2E_KEY_DERIVATION_VERSION } from '@ion/shared/e2e'
import { HUB_PROTOCOL_VERSION } from '@ion/shared/fleet-hub'
import { RELAY_ENVELOPE_VERSION } from '@ion/shared/studio-wire/relay-envelope'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import { UNIFIED_SCHEMA_VERSION } from '@ion/shared/tab-migration-unify'
import { TELEMETRY_FRAME_VERSION } from '@ion/shared/telemetry-frame'
import { EXTERNALIZE_SCHEMA_VERSION, SPLIT_SCHEMA_VERSION } from '@ion/shared/types-persistence'
import { MANIFEST_VERSION } from '../conversation-backup/manifest'
import { EXTERNAL_CONTENT_SCHEMA_VERSION } from '../persistence/tab-content-store'
import { QUESTION_RECORD_VERSION } from '../questions/questions-persistence'
import { TRANSFER_MANIFEST_VERSION } from '../transfer/manifest'

/** A registry entry with the constant it reads, which the registry test checks. */
export interface RegisteredFormat extends FormatVersion {
  constant: string
}

function entry(id: string, value: number | string, constant: string, rule: FormatVersion['rule'], meaning: string): RegisteredFormat {
  return { id, owner: 'server', version: String(value), rule, meaning, constant }
}

export const SERVER_FORMAT_REGISTRY: readonly RegisteredFormat[] = [
  entry('transfer-archive', TRANSFER_MANIFEST_VERSION, 'TRANSFER_MANIFEST_VERSION', 'exact',
    'Archive a conversation travels in between two servers; both must write the same one'),
  entry('backup-archive', MANIFEST_VERSION, 'MANIFEST_VERSION', 'exact',
    'Conversation backup zip; the importing server must read the same version'),
  entry('studio-wire', PROTOCOL_VERSION, 'PROTOCOL_VERSION', 'accepts-previous',
    'Studio wire protocol; a server accepts clients at its version or one below'),
  entry('relay-envelope', RELAY_ENVELOPE_VERSION, 'RELAY_ENVELOPE_VERSION', 'exact',
    'Sealed frame format on a relay channel; both ends must share it'),
  entry('relay-key-derivation', E2E_KEY_DERIVATION_VERSION, 'E2E_KEY_DERIVATION_VERSION', 'exact',
    'How a pairing derives its encryption key; both ends must share it'),
  entry('fleet-hub-link', HUB_PROTOCOL_VERSION, 'HUB_PROTOCOL_VERSION', 'exact',
    'Frames between a server and a Fleet Hub it reports to; both must share it'),
  entry('telemetry-frame', TELEMETRY_FRAME_VERSION, 'TELEMETRY_FRAME_VERSION', 'reader-at-least',
    'Compact telemetry frame the server and desktop read'),
  entry('chart-schema', CHART_SCHEMA_VERSION, 'CHART_SCHEMA_VERSION', 'reader-at-least',
    'Chart spec a conversation carries; a client renders versions up to its own'),
  entry('tab-store-split', SPLIT_SCHEMA_VERSION, 'SPLIT_SCHEMA_VERSION', 'host-storage',
    'Stored tab records, split layout'),
  entry('tab-store-externalized', EXTERNALIZE_SCHEMA_VERSION, 'EXTERNALIZE_SCHEMA_VERSION', 'host-storage',
    'Stored tab records, externalized content layout'),
  entry('tab-store-unified', UNIFIED_SCHEMA_VERSION, 'UNIFIED_SCHEMA_VERSION', 'host-storage',
    'Stored tab records, unified layout'),
  entry('tab-content', EXTERNAL_CONTENT_SCHEMA_VERSION, 'EXTERNAL_CONTENT_SCHEMA_VERSION', 'host-storage',
    'Stored per-tab content files'),
  entry('question-records', QUESTION_RECORD_VERSION, 'QUESTION_RECORD_VERSION', 'host-storage',
    'Stored Guided Questions workflows'),
]

/** The server's formats as published: the registry without its source constants. */
export function serverFormats(): FormatVersion[] {
  return SERVER_FORMAT_REGISTRY.map(({ id, owner, version, rule, meaning }) => ({ id, owner, version, rule, meaning }))
}
