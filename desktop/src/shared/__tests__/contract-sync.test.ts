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
  tool_result: ['content', 'images', 'isError', 'toolId'],
  task_update: ['message'],
  task_complete: [
    'conversationTurns',
    'costUsd',
    'durationMs',
    'lastText',
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
    'stderrTail',
  ],
  session_dead: ['exitCode', 'signal', 'stderrTail'],
  rate_limit: ['rateLimitType', 'resetsAt', 'status'],
  usage: ['entryId', 'usage', 'userEntryId'],
  permission_request: [
    'options',
    'questionId',
    'toolDescription',
    'toolInput',
    'toolName',
  ],
  plan_mode_changed: ['enabled', 'planFilePath', 'planSlug'],
  plan_file_written: ['operation', 'planFilePath', 'planSlug'],
  plan_proposal: ['kind', 'planFilePath', 'planSlug'],
  plan_mode_auto_exit: [
    'planFilePath',
    'planSlug',
    'reason',
    'runId',
    'sessionId',
    'stopReason',
  ],
  stream_reset: [],
  compacting: ['active', 'clearedBlocks', 'messagesAfter', 'messagesBefore', 'microOnly', 'strategy', 'summary'],
  tool_stalled: ['elapsed', 'toolId', 'toolName'],
  steer_injected: ['messageLength'],
  prompt_injected: ['kind', 'origin', 'prompt'],
  model_fallback: ['fallbackModel', 'reason', 'requestedModel'],
  capability_unsupported: ['backend', 'capability', 'reason'],
  run_stalled: ['lastActivity', 'stalledDuration'],
  task_suspend: ['awaitingDispatchIds'],
  engine_plan_content: ['content', 'hasMore', 'offset', 'planFilePath', 'totalBytes'],
  thinking_block_start: [],
  thinking_delta: ['text'],
  thinking_block_end: ['elapsedSeconds', 'redacted', 'totalTokens'],
  // Extension-surface events (WI-001: single-path collapse)
  message_end: ['contextPercent', 'cost', 'entryId', 'inputTokens', 'outputTokens', 'userEntryId'],
  user_turn_persisted: ['entryId'],
  agent_state: ['agents'],
  harness_message: ['dedupKey', 'dedupMode', 'message', 'source'],
  working_message: ['message'],
  notify: ['level', 'message'],
  dialog: ['defaultValue', 'dialogId', 'method', 'options', 'title'],
  extension_died: ['extensionName'],
  extension_respawned: ['attemptNumber', 'extensionName'],
  extension_dead_permanent: ['attemptNumber', 'extensionName'],
  events_dropped: ['count'],
  image_content: ['mediaType', 'path', 'source', 'toolId'],
  // Per-category token breakdown. Emitted after prompt assembly and again
  // after first usage-event reconciliation. Tier encodes the resolution path.
  context_breakdown: [
    'aggregateCostUsd',
    'apiReportedTotal',
    'cacheCreationTokens',
    'cacheReadTokens',
    'categories',
    'contextWindow',
    'model',
    'modelBreakdown',
    'totalTokens',
    'unaccounted',
  ],
}

// ─── TS SharedTypes field map ───

const TS_SHARED_TYPES: Record<string, string[]> = {
  StatusFields: [
    'backgroundAgents',
    'contextPercent',
    'contextWindow',
    'conversationCostUsd',
    'conversationTurns',
    'extensionName',
    'label',
    'model',
    'numTurns',
    'permissionDenials',
    'runCostUsd',
    'sessionId',
    'state',
    'team',
  ],
  SessionStatus: [
    'backgroundAgentCount',
    'contextPercent',
    'contextWindow',
    'conversationCostUsd',
    'extensionName',
    'hasInflightRun',
    'key',
    'lastEmittedAt',
    'model',
    'permissionDenialsPending',
    'runCostUsd',
    'sessionId',
    'state',
    'stateSince',
  ],
  EngineConfig: [
    'claudeCompat',
    'extensions',
    'forceNewConversation',
    'maxTokens',
    'model',
    'parentConversationId',
    'profileId',
    'sessionId',
    'systemHint',
    'thinking',
    'workingDirectory',
    'workspaceWatchIgnore',
  ],
  MessageEndUsage: ['contextPercent', 'cost', 'entryId', 'inputTokens', 'outputTokens', 'userEntryId'],
  PermissionOpt: ['id', 'kind', 'label'],
  McpServerInfo: ['name', 'status'],
  UsageData: [
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'input_tokens',
    'output_tokens',
    'service_tier',
  ],
  AgentStateUpdate: ['id', 'metadata', 'name', 'status'],
  ModelEntry: [
    'contextWindow',
    'costPer1kInput',
    'costPer1kOutput',
    'id',
    'isCustom',
    'maxOutputTokens',
    'providerId',
    'supportsCaching',
    'supportsImages',
    'supportsThinking',
    'thinkingEfforts',
    'thinkingMode',
    'tokenizer',
  ],
  ProviderEntry: [
    'apiKeyRef',
    'authSource',
    'backend',
    'baseURL',
    'cli',
    'hasAuth',
    'id',
  ],
  // Delegated-CLI install/auth status carried on ProviderEntry.cli. Mirrors
  // Go's ProviderCliStatus.
  ProviderCliStatus: [
    'authMethod',
    'authenticated',
    'backend',
    'binaryPath',
    'email',
    'installed',
    'label',
    'planType',
    'probedAt',
    'version',
  ],
  // Payload of engine_provider_login (EngineEvent.providerLogin). Mirrors Go's
  // ProviderLoginUpdate.
  ProviderLoginUpdate: [
    'authUrl',
    'backend',
    'loginError',
    'loginId',
    'provider',
    'stage',
    'userCode',
    'verificationUrl',
  ],
  // Slash-command listing carried inside engine_command_registry snapshots.
  // The desktop's prompt pipeline reads this off the wire to populate a
  // routing-hint cache keyed by session — see desktop/src/main/prompt-pipeline.ts.
  EngineCommandListing: ['description', 'name'],
  // Per-category token breakdown category row (one entry per category in
  // ContextBreakdownPayload.categories). Mirrors Go's ContextBreakdownCategory.
  ContextBreakdownCategory: ['kind', 'name', 'path', 'tier', 'tokens'],
  // Wire payload for engine_context_breakdown. Mirrors Go's ContextBreakdownPayload.
  ContextBreakdownPayload: [
    'aggregateCostUsd',
    'apiReportedTotal',
    'cacheCreationTokens',
    'cacheReadTokens',
    'categories',
    'contextWindow',
    'model',
    'modelBreakdown',
    'totalTokens',
    'unaccounted',
  ],
  // Per-model cost breakdown row. Mirrors Go's ModelBreakdown in types/model_breakdown.go.
  ModelBreakdown: ['conversations', 'costUsd', 'inputTokens', 'isSelf', 'model', 'outputTokens'],
  // Go SessionMessage ↔ TS SessionLoadMessage (types-session.ts). The TS type
  // also carries `userExecuted`, a desktop-only concept intentionally
  // excluded from the contract.
  SessionMessage: [
    'attachments',
    'content',
    'id',
    'internal',
    'isError',
    'markerClearedBlocks',
    'markerKind',
    'markerMessageLength',
    'markerMessagesAfter',
    'markerMessagesBefore',
    'markerMicroOnly',
    'markerPlanFilePath',
    'markerPlanOperation',
    'markerPlanSlug',
    'markerStrategy',
    'markerSummary',
    'role',
    'slashArgs',
    'slashCommand',
    'slashSource',
    'timestamp',
    'toolId',
    'toolInput',
    'toolName',
  ],
  SessionMessageAttachment: ['id', 'mimeType', 'name', 'path', 'type'],
  // Wire shape for content blocks carried inside LlmMessage payloads.
  // The compact_boundary variant (gentle-knitting-cup plan) added the
  // optional summary / trigger / messages* / clearedBlocks / tokensBefore
  // / factCount / recentFiles fields; the existing tool/image/text
  // variants share the same struct so every variant shows up here.
  LlmContentBlock: [
    'clearedBlocks',
    'content',
    'contextPaths',
    'factCount',
    'id',
    'input',
    'is_error',
    'messagesAfter',
    'messagesBefore',
    'messagesSummarized',
    'name',
    'recentFiles',
    'source',
    'summary',
    'text',
    'thinking',
    'tokensBefore',
    'tool_use_id',
    'trigger',
    'type',
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

// ─── EngineEvent dispatch fields ───
// The EngineEvent union (engine/internal/types/engine_event.go) carries all
// dispatch telemetry fields. This suite pins the fields consumed by
// dispatch_start / dispatch_end normalized events so drift between Go and
// TS/Swift is caught at PR time.

describe('Contract sync: EngineEvent dispatch fields', () => {
  // Fields that the engine emits on dispatch_start / dispatch_end events and
  // that the desktop (and iOS) decode. Any field absent from the Go manifest
  // means the engine stopped emitting it (breaking change); any field present
  // in the manifest but not in this set is a new Go field the desktop hasn't
  // yet adopted (tracked as a gap comment).
  const DISPATCH_FIELDS_CONSUMED: string[] = [
    'dispatchAgent',
    'dispatchConversationId',
    'dispatchCost',
    'dispatchDepth',
    'dispatchElapsed',
    'dispatchExitCode',
    'dispatchId',
    'dispatchInputTokens',
    'dispatchOutputTokens',
    'dispatchToolCount',
    'dispatchModel',
    'dispatchParentId',
    'dispatchSessionId',
    'dispatchTask',
  ]

  it('all consumed dispatch fields are present in the Go EngineEvent manifest', () => {
    const goFields = new Set(manifest.engineEvent)
    const missing = DISPATCH_FIELDS_CONSUMED.filter((f) => !goFields.has(f))
    expect(
      missing,
      `Go EngineEvent is missing dispatch fields consumed by desktop/iOS: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

