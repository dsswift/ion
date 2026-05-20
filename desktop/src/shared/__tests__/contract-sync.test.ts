/**
 * Cross-Language Contract Sync Tests
 *
 * Validates that TypeScript type definitions stay in sync with the Go engine's
 * contract manifest (engine/internal/types/testdata/contracts.json).
 *
 * The Go manifest is auto-generated via reflection. This test maintains an
 * explicit field-name map for each TS type (since TS types are erased at
 * runtime) and asserts bidirectional coverage against the Go manifest.
 *
 * When you update a TS type, update the corresponding map here in the same PR.
 * If you forget, CI fails.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ─── Load Go manifest ───

interface ContractManifest {
  normalizedEvents: Record<string, string[] | null>
  engineEvent: string[]
  sharedTypes: Record<string, string[]>
}

const manifestPath = resolve(
  __dirname,
  '../../../../engine/internal/types/testdata/contracts.json',
)
const manifest: ContractManifest = JSON.parse(
  readFileSync(manifestPath, 'utf-8'),
)

// ─── TS NormalizedEvent field map ───
// Each key is the `type` discriminator; each value is the list of non-type
// fields for that variant. Keep sorted to match the Go manifest.

const TS_NORMALIZED_EVENTS: Record<string, string[]> = {
  session_init: [
    'isWarmup',
    'mcpServers',
    'model',
    'sessionId',
    'skills',
    'tools',
    'version',
  ],
  text_chunk: ['text'],
  tool_call: ['index', 'toolId', 'toolName'],
  tool_call_update: ['partialInput', 'toolId'],
  tool_call_complete: ['index'],
  tool_result: ['content', 'isError', 'toolId'],
  task_update: ['message'],
  task_complete: [
    'costUsd',
    'durationMs',
    'numTurns',
    'permissionDenials',
    'result',
    'sessionId',
    'usage',
  ],
  error: [
    'errorCode',
    'httpStatus',
    'isError',
    'message',
    'retryAfterMs',
    'retryable',
    'sessionId',
  ],
  session_dead: ['exitCode', 'signal', 'stderrTail'],
  rate_limit: ['rateLimitType', 'resetsAt', 'status'],
  usage: ['usage'],
  permission_request: [
    'options',
    'questionId',
    'toolDescription',
    'toolInput',
    'toolName',
  ],
  plan_mode_changed: ['enabled', 'planFilePath'],
  stream_reset: [],
  compacting: ['active', 'clearedBlocks', 'messagesAfter', 'messagesBefore', 'strategy', 'summary'],
  tool_stalled: ['elapsed', 'toolId', 'toolName'],
}

// ─── TS SharedTypes field map ───

const TS_SHARED_TYPES: Record<string, string[]> = {
  StatusFields: [
    // Note: TS also has `backend` which is a desktop-only concept not in Go.
    // It is intentionally excluded from the contract.
    'contextPercent',
    'contextWindow',
    'extensionName',
    'label',
    'model',
    'permissionDenials',
    'sessionId',
    'state',
    'team',
    'totalCostUsd',
  ],
  EngineConfig: [
    'extensions',
    'maxTokens',
    'model',
    'profileId',
    'sessionId',
    'systemHint',
    'thinking',
    'workingDirectory',
  ],
  MessageEndUsage: ['contextPercent', 'cost', 'inputTokens', 'outputTokens'],
  PermissionOpt: ['id', 'kind', 'label'],
  McpServerInfo: ['name', 'status'],
  UsageData: [
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'input_tokens',
    'output_tokens',
    'service_tier',
  ],
  AgentStateUpdate: ['metadata', 'name', 'status'],
  ModelEntry: [
    'contextWindow',
    'costPer1kInput',
    'costPer1kOutput',
    'id',
    'isCustom',
    'providerId',
    'supportsCaching',
    'supportsImages',
    'supportsThinking',
  ],
  ProviderEntry: [
    'apiKeyRef',
    'authSource',
    'baseURL',
    'hasAuth',
    'id',
  ],
}

// ─── Tests ───

describe('Contract sync: NormalizedEvent variants', () => {
  it('every Go variant exists in TS map', () => {
    const missing: string[] = []
    for (const variant of Object.keys(manifest.normalizedEvents)) {
      if (!(variant in TS_NORMALIZED_EVENTS)) {
        missing.push(variant)
      }
    }
    expect(
      missing,
      `Go NormalizedEvent variants missing from TS map: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every TS variant exists in Go manifest', () => {
    const extra: string[] = []
    for (const variant of Object.keys(TS_NORMALIZED_EVENTS)) {
      if (!(variant in manifest.normalizedEvents)) {
        extra.push(variant)
      }
    }
    expect(
      extra,
      `TS NormalizedEvent variants not present in Go manifest: ${extra.join(', ')}`,
    ).toEqual([])
  })

  it('fields match for each variant', () => {
    const mismatches: string[] = []
    for (const [variant, goFields] of Object.entries(
      manifest.normalizedEvents,
    )) {
      const tsFields = TS_NORMALIZED_EVENTS[variant]
      if (!tsFields) continue // covered by variant-presence test

      const goSorted = (goFields ?? []).slice().sort()
      const tsSorted = tsFields.slice().sort()

      if (JSON.stringify(goSorted) !== JSON.stringify(tsSorted)) {
        const goOnly = goSorted.filter((f) => !tsSorted.includes(f))
        const tsOnly = tsSorted.filter((f) => !goSorted.includes(f))
        const parts: string[] = []
        if (goOnly.length)
          parts.push(`Go-only: [${goOnly.join(', ')}]`)
        if (tsOnly.length)
          parts.push(`TS-only: [${tsOnly.join(', ')}]`)
        mismatches.push(`  ${variant}: ${parts.join('; ')}`)
      }
    }
    expect(
      mismatches,
      `NormalizedEvent field mismatches:\n${mismatches.join('\n')}`,
    ).toEqual([])
  })
})

describe('Contract sync: SharedTypes', () => {
  it('every Go shared type exists in TS map', () => {
    const missing: string[] = []
    for (const typeName of Object.keys(manifest.sharedTypes)) {
      if (!(typeName in TS_SHARED_TYPES)) {
        missing.push(typeName)
      }
    }
    expect(
      missing,
      `Go shared types missing from TS map: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every TS shared type exists in Go manifest', () => {
    const extra: string[] = []
    for (const typeName of Object.keys(TS_SHARED_TYPES)) {
      if (!(typeName in manifest.sharedTypes)) {
        extra.push(typeName)
      }
    }
    expect(
      extra,
      `TS shared types not present in Go manifest: ${extra.join(', ')}`,
    ).toEqual([])
  })

  it('fields match for each shared type', () => {
    const mismatches: string[] = []
    for (const [typeName, goFields] of Object.entries(manifest.sharedTypes)) {
      const tsFields = TS_SHARED_TYPES[typeName]
      if (!tsFields) continue

      const goSorted = goFields.slice().sort()
      const tsSorted = tsFields.slice().sort()

      if (JSON.stringify(goSorted) !== JSON.stringify(tsSorted)) {
        const goOnly = goSorted.filter((f) => !tsSorted.includes(f))
        const tsOnly = tsSorted.filter((f) => !goSorted.includes(f))
        const parts: string[] = []
        if (goOnly.length)
          parts.push(`Go-only: [${goOnly.join(', ')}]`)
        if (tsOnly.length)
          parts.push(`TS-only: [${tsOnly.join(', ')}]`)
        mismatches.push(`  ${typeName}: ${parts.join('; ')}`)
      }
    }
    expect(
      mismatches,
      `SharedType field mismatches:\n${mismatches.join('\n')}`,
    ).toEqual([])
  })
})
