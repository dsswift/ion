/**
 * ConversationTelemetry — the client tool a retro opens with.
 *
 * ── One name, two behaviours, exactly one declared ──────────────────────────
 * The desktop knows at start_session whether a session's working directory is
 * inside a registered worktree, so it picks the behaviour then. The agent sees
 * one tool with one name and no parameters, and never chooses a scope: the
 * scope is a property of where the work is happening, not a decision the model
 * should be making. Only the description differs, so the model knows what it
 * will get before it calls.
 *
 * ── Metrics, never prose ────────────────────────────────────────────────────
 * The payload carries counts, timestamps, money, and file paths. An agent that
 * wants to read what was said opens the paths. That two-stage shape is the
 * point: the metrics are cheap enough to open with, and the reading is
 * targeted instead of a whole-transcript sweep.
 */
import { log as _log, error as _error } from '../logger'
import type { ClientToolResult } from '../integration/bench-agent-tools'
import { scanConversation, type ScanPaths } from './conversation-telemetry-scan'
import { conversationsDir, selectConversations, worktreeForCwd } from './conversation-telemetry-select'
import type { RegistryEntry } from '../worktree/registry'
import type {
  ConversationTelemetry,
  TelemetryPayload,
  TelemetryTotals,
} from './conversation-telemetry-types'

const TAG = 'telemetry.tool'

export const CONVERSATION_TELEMETRY_TOOL_NAME = 'ConversationTelemetry'

/**
 * The part of the description that is true in both variants.
 *
 * The steer guard is stated here rather than left to the caller's judgement: a
 * steer count read as friction is the specific misreading this data invites,
 * and a tool that hands a number over without saying what it means invites it
 * every time.
 */
const SHARED_DESCRIPTION =
  'Returns measurements only — counts, timestamps, cost, and the file paths of the conversation records. '
  + 'It returns no message text; read the returned treePath / llmPath / memoryPath when you need what was actually said. '
  + 'Prompt counts cover the conversation\'s whole life, including turns before a /clear that are no longer in any context window. '
  + 'Read `courseCorrections` and `stops` as operator redirects: a recorded stop followed by a fresh prompt. '
  + 'Do NOT read `steerCount` as a course correction — a steer is context the operator added mid-turn, '
  + 'either something missing from the opening prompt or a task appended while work was already running. '
  + 'It measures prompt completeness, not agent error. '
  + '`steerCount` already excludes machine-authored steers (a background dispatch completion, a check-in '
  + 'arriving mid-turn) — those are counted separately in `machineSteerCount` and carry no operator intent.'

export const SELF_SCOPED_DESCRIPTION =
  'Measure this conversation. Covers the conversation you are running in and the chain it was cleared and continued from. '
  + SHARED_DESCRIPTION

export const WORKTREE_SCOPED_DESCRIPTION =
  'Measure every conversation in this worktree. This session is working in a registered Ion worktree, '
  + 'so the result covers the conversations that worked in it — a piece of work usually spans several — ordered oldest first. '
  + 'A long-lived checkout can hold more than one call returns; `totals.matchedConversations` and `totals.truncated` state whether any were left out, and the least recently active are the ones dropped. '
  + SHARED_DESCRIPTION

export interface TelemetryTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  planModeSafe: boolean
}

/**
 * The declaration for a session, chosen by its working directory.
 *
 * Zero parameters on purpose. Everything the executor needs — which directory,
 * which conversation — is supplied by the engine's own request, never accepted
 * from the model, so there is nothing for a call to get wrong.
 *
 * The registry defaults to the live one and is injectable so a test can name a
 * worktree without writing into the operator's own `~/.ion`.
 */
export function conversationTelemetryTool(
  workingDirectory: string,
  registry?: RegistryEntry[],
): TelemetryTool {
  const inWorktree = (registry ? worktreeForCwd(workingDirectory, registry) : worktreeForCwd(workingDirectory)) !== null
  return {
    name: CONVERSATION_TELEMETRY_TOOL_NAME,
    description: inWorktree ? WORKTREE_SCOPED_DESCRIPTION : SELF_SCOPED_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    planModeSafe: true,
  }
}

/**
 * Execute a call.
 *
 * `cwd` and `conversationId` come from the gate request and the session
 * registry. A conversation that has never saved has no record to measure, and
 * saying so is more useful than an empty payload that reads like a finding.
 */
export function executeConversationTelemetry(
  cwd: string,
  conversationId: string,
  paths: ScanPaths = { conversationsDir: conversationsDir() },
): ClientToolResult {
  const started = Date.now()
  try {
    const selection = selectConversations(cwd, conversationId, paths)
    const conversations: ConversationTelemetry[] = []
    for (const id of selection.conversationIds) {
      const record = scanConversation(id, paths)
      if (record) conversations.push(record)
    }
    if (conversations.length === 0) {
      _log(TAG, 'no conversations to measure', { cwd, conversation_id: conversationId, scope: selection.scope })
      return {
        content: 'No conversation records found on disk for this session yet.',
        isError: false,
      }
    }

    linkChildren(conversations)
    conversations.sort((a, b) => a.conversationId.localeCompare(b.conversationId))

    const totals = totalsOf(conversations)
    totals.matchedConversations = selection.matchedCount
    totals.truncated = selection.truncated
    const payload: TelemetryPayload = {
      scope: selection.scope,
      totals,
      conversations,
    }
    if (selection.worktree) {
      payload.worktree = {
        worktreePath: selection.worktree.worktreePath,
        repoPath: selection.worktree.repoPath,
        branchName: selection.worktree.branchName,
        sourceBranch: selection.worktree.sourceBranch,
        ...(selection.worktree.title ? { title: selection.worktree.title } : {}),
        createdAt: selection.worktree.createdAt,
        ...(selection.worktree.landedAt ? { landedAt: selection.worktree.landedAt } : {}),
      }
    }

    const content = JSON.stringify(payload, null, 2)
    _log(TAG, 'telemetry returned', {
      cwd,
      conversation_id: conversationId,
      scope: selection.scope,
      conversations: conversations.length,
      matched: selection.matchedCount,
      truncated: selection.truncated,
      content_len: content.length,
      latency_ms: Date.now() - started,
    })
    return { content, isError: false }
  } catch (err) {
    _error(TAG, 'telemetry execution failed', { cwd, conversation_id: conversationId, error: String(err) })
    return { content: `ConversationTelemetry failed: ${String(err)}`, isError: true }
  }
}

/** Fill childIds from the parent links inside the selected set. */
function linkChildren(conversations: ConversationTelemetry[]): void {
  const byId = new Map(conversations.map((record) => [record.conversationId, record]))
  for (const record of conversations) {
    if (!record.parentId) continue
    byId.get(record.parentId)?.childIds.push(record.conversationId)
  }
}

function totalsOf(conversations: ConversationTelemetry[]): TelemetryTotals {
  const sumValues = (counter: Record<string, number>): number =>
    Object.values(counter).reduce((sum, n) => sum + n, 0)

  let firstActivityAt = 0
  let lastActivityAt = 0
  const totals: TelemetryTotals = {
    conversations: conversations.length,
    matchedConversations: conversations.length,
    truncated: false,
    userPrompts: 0,
    assistantTurns: 0,
    courseCorrections: 0,
    steers: 0,
    machineSteers: 0,
    toolCalls: 0,
    toolErrors: 0,
    dispatches: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelUsage: [],
    firstActivityAt: 0,
    lastActivityAt: 0,
    spanMs: 0,
  }
  for (const record of conversations) {
    totals.userPrompts += record.userPromptCount
    totals.assistantTurns += record.assistantTurnCount
    totals.courseCorrections += record.courseCorrections
    totals.steers += record.steerCount
    totals.machineSteers += record.machineSteerCount
    totals.toolCalls += sumValues(record.toolCalls)
    totals.toolErrors += sumValues(record.toolErrors)
    totals.dispatches += record.dispatches.count
    totals.inputTokens += record.inputTokens
    totals.outputTokens += record.outputTokens
    totals.costUsd += record.costUsd
    for (const usage of record.modelUsage) {
      let row = totals.modelUsage.find((entry) => entry.model === usage.model)
      if (!row) {
        row = { ...usage }
        totals.modelUsage.push(row)
        continue
      }
      row.assistantTurns += usage.assistantTurns
      row.inputTokens += usage.inputTokens
      row.outputTokens += usage.outputTokens
      if (usage.firstAt < row.firstAt) row.firstAt = usage.firstAt
      if (usage.lastAt > row.lastAt) row.lastAt = usage.lastAt
    }
    const start = record.firstPromptAt || record.createdAt
    if (start > 0 && (firstActivityAt === 0 || start < firstActivityAt)) firstActivityAt = start
    if (record.lastActivityAt > lastActivityAt) lastActivityAt = record.lastActivityAt
  }
  totals.firstActivityAt = firstActivityAt
  totals.lastActivityAt = lastActivityAt
  totals.spanMs = lastActivityAt > firstActivityAt ? lastActivityAt - firstActivityAt : 0
  return totals
}
