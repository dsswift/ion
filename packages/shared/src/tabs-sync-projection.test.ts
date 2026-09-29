import { describe, expect, it } from 'vitest'
import { tabForStudioSync } from './tabs-sync-projection'
import type { PersistedTab } from './types-persistence'

const task = 'x'.repeat(10_000)

function tab(): PersistedTab {
  return {
    id: 'tab-1',
    title: 'Conversation',
    workingDirectory: '/tmp/project',
    hasChosenDirectory: true,
    conversationPane: {
      activeInstanceId: 'main',
      instances: [{
        id: 'main',
        label: 'main',
        conversationIds: ['conv-1'],
        draftInput: 'unsent',
        permissionMode: 'plan',
        agentStates: [{ name: 'writer', status: 'done', metadata: { task } }],
        dispatchTelemetry: [{ dispatchId: 'd1', dispatchAgent: 'writer', dispatchSessionId: 's', dispatchModel: 'm', dispatchTask: task, dispatchDepth: 1, dispatchParentId: '' }],
      }],
    },
  } as unknown as PersistedTab
}

describe('tabForStudioSync', () => {
  it('drops the sub-agent roster and dispatch records and keeps what clients read', () => {
    const synced = tabForStudioSync(tab())
    const inst = synced.conversationPane!.instances[0]
    expect(inst).not.toHaveProperty('agentStates')
    expect(inst).not.toHaveProperty('dispatchTelemetry')
    expect(inst).toMatchObject({ id: 'main', draftInput: 'unsent', permissionMode: 'plan', conversationIds: ['conv-1'] })
    expect(JSON.stringify(synced).length).toBeLessThan(1_000)
  })

  it('leaves the persisted record untouched', () => {
    const original = tab()
    tabForStudioSync(original)
    expect(original.conversationPane!.instances[0].agentStates).toHaveLength(1)
  })

  it('returns a tab with nothing to drop as-is', () => {
    const plain = { id: 'tab-2', title: 't', workingDirectory: '/', hasChosenDirectory: true } as unknown as PersistedTab
    expect(tabForStudioSync(plain)).toBe(plain)
  })
})
