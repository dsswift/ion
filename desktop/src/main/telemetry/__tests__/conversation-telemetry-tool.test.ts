import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RegistryEntry } from '../../worktree/registry'
import {
  CONVERSATION_TELEMETRY_TOOL_NAME,
  conversationTelemetryTool,
  executeConversationTelemetry,
} from '../conversation-telemetry-tool'

const registry = [
  {
    worktreePath: '/wt/work',
    repoPath: '/repo',
    branchName: 'wt/work',
    sourceBranch: 'main',
    createdAt: 1,
  } as RegistryEntry,
]

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ion-telemetry-tool-'))
  writeFileSync(
    join(dir, 'conv-1.tree.jsonl'),
    JSON.stringify({ meta: true, id: 'conv-1', leafId: 'e1', version: 2, workingDirectory: '/plain/repo' }) + '\n'
    + JSON.stringify({ id: 'e1', parentId: null, type: 'message', timestamp: 5, data: { role: 'user', content: [{ type: 'text', text: 'TOP-SECRET' }] } }) + '\n',
  )
  writeFileSync(
    join(dir, 'conv-1.llm.jsonl'),
    JSON.stringify({ meta: true, id: 'conv-1', version: 2, createdAt: 5, model: 'm', totalCost: 0.25 }) + '\n',
  )
  return dir
}

describe('ConversationTelemetry declaration', () => {
  it('declares one zero-parameter tool whose description follows the session directory', () => {
    const plain = conversationTelemetryTool('/plain/repo', registry)
    const worktree = conversationTelemetryTool('/wt/work/src', registry)

    expect(plain.name).toBe(CONVERSATION_TELEMETRY_TOOL_NAME)
    expect(worktree.name).toBe(CONVERSATION_TELEMETRY_TOOL_NAME)
    // No scope argument: where the work is happening decides the scope, and
    // the model is never asked to pick.
    expect(plain.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(plain.planModeSafe).toBe(true)

    expect(plain.description).toContain('Measure this conversation')
    expect(worktree.description).toContain('Measure every conversation in this worktree')
    expect(plain.description).not.toBe(worktree.description)
  })

  it('tells the caller in both variants that a steer is not a course correction', () => {
    for (const tool of [conversationTelemetryTool('/plain/repo', registry), conversationTelemetryTool('/wt/work', registry)]) {
      expect(tool.description).toContain('Do NOT read `steerCount` as a course correction')
      expect(tool.description).toContain('courseCorrections')
    }
  })
})

describe('ConversationTelemetry execution', () => {
  it('returns metrics and paths, and no message text', () => {
    const dir = fixtureDir()

    const result = executeConversationTelemetry('/plain/repo', 'conv-1', { conversationsDir: dir })

    expect(result.isError).toBe(false)
    expect(result.content).not.toContain('TOP-SECRET')
    const payload = JSON.parse(result.content) as {
      scope: string
      totals: { conversations: number; userPrompts: number; costUsd: number }
      conversations: Array<{ treePath: string }>
    }
    expect(payload.scope).toBe('self')
    expect(payload.totals.conversations).toBe(1)
    expect(payload.totals.userPrompts).toBe(1)
    expect(payload.totals.costUsd).toBe(0.25)
    expect(payload.conversations[0]?.treePath).toBe(join(dir, 'conv-1.tree.jsonl'))
  })

  it('says so plainly when a session has no record on disk yet', () => {
    const result = executeConversationTelemetry('/plain/repo', 'never-saved', {
      conversationsDir: mkdtempSync(join(tmpdir(), 'ion-telemetry-empty-')),
    })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('No conversation records found')
  })
})
