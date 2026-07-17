import { describe, it, expect } from 'vitest'
import {
  migrateTabStateToExternalized,
  isExternalizedSchema,
  EXTERNALIZE_SCHEMA_VERSION,
} from '../tab-migration-externalize'
import { SPLIT_SCHEMA_VERSION } from '../tab-migration-split'
import type { PersistedTab, PersistedTabState } from '../../shared/types-persistence'

// Pure v3→v4 transform: instance messages move to per-tab content entries,
// reloadable editor buffers empty, everything else byte-identical.

let mintCounter = 0
const mintId = () => `minted-${++mintCounter}`

function msg(content: string, role = 'harness') {
  return { role, content, timestamp: 1 }
}

function tabWithMessages(id: string | undefined, messages: ReturnType<typeof msg>[]): PersistedTab {
  return {
    ...(id ? { id } : {}),
    conversationId: 'conv-' + (id ?? 'x'),
    title: 'T',
    customTitle: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    additionalDirs: [],
    conversationPane: {
      instances: [{
        id: 'main',
        label: 'Main',
        ...(messages.length > 0 ? { messages } : {}),
        messageCount: messages.length,
        draftInput: 'unsent text',
      }],
      activeInstanceId: 'main',
    },
  } as PersistedTab
}

function v3(tabs: PersistedTab[], extra?: Partial<PersistedTabState>): PersistedTabState {
  return { schemaVersion: SPLIT_SCHEMA_VERSION, activeSessionId: null, tabs, ...extra }
}

describe('migrateTabStateToExternalized', () => {
  it('moves instance messages to a per-tab content entry and marks the thin instance', () => {
    const messages = [msg('Session bootstrapped: hello'), msg('real work', 'user')]
    const input = v3([tabWithMessages('tab-1', messages)])
    const { thin, contentByTabId } = migrateTabStateToExternalized(input, mintId)

    expect(thin.schemaVersion).toBe(EXTERNALIZE_SCHEMA_VERSION)
    const inst = thin.tabs[0].conversationPane!.instances[0]
    expect(inst.messages).toBeUndefined()
    expect(inst.hasExternalContent).toBe(true)
    expect(inst.messageCount).toBe(2)
    // Non-message fields untouched.
    expect(inst.draftInput).toBe('unsent text')

    const content = contentByTabId.get('tab-1')!
    expect(content).toBeDefined()
    expect(content.instanceId).toBe('main')
    expect(content.messages).toEqual(messages)
    // Deep-cloned, not shared references.
    expect(content.messages).not.toBe(messages)
  })

  it('leaves count-only instances unmarked and writes no content for them', () => {
    const input = v3([tabWithMessages('tab-empty', [])])
    const { thin, contentByTabId } = migrateTabStateToExternalized(input, mintId)
    const inst = thin.tabs[0].conversationPane!.instances[0]
    expect(inst.hasExternalContent).toBeUndefined()
    expect(contentByTabId.size).toBe(0)
  })

  it('stamps a durable tab id on id-less tabs that externalize', () => {
    const input = v3([tabWithMessages(undefined, [msg('a')])])
    const { thin, contentByTabId } = migrateTabStateToExternalized(input, mintId)
    const stamped = thin.tabs[0].id!
    expect(stamped).toMatch(/^minted-/)
    expect(contentByTabId.get(stamped)).toBeDefined()
  })

  it('is a no-op at schemaVersion >= 4', () => {
    const already: PersistedTabState = { schemaVersion: 4, activeSessionId: null, tabs: [] }
    const { thin, contentByTabId } = migrateTabStateToExternalized(already, mintId)
    expect(thin).toBe(already)
    expect(contentByTabId.size).toBe(0)
    expect(isExternalizedSchema(already)).toBe(true)
  })

  it('strips reloadable editor buffers and keeps dirty/scratch inline', () => {
    const input = v3([], {
      editorStates: {
        '/proj': {
          activeFileIndex: 0,
          files: [
            { filePath: '/proj/clean.ts', fileName: 'clean.ts', content: 'BIG', savedContent: 'BIG', isDirty: false, isReadOnly: false, isPreview: false },
            { filePath: '/proj/dirty.ts', fileName: 'dirty.ts', content: 'EDITED', savedContent: 'ORIG', isDirty: true, isReadOnly: false, isPreview: false },
            { filePath: null, fileName: 'scratch', content: 'only copy', savedContent: '', isDirty: false, isReadOnly: false, isPreview: false },
          ],
        },
      },
    })
    const { thin } = migrateTabStateToExternalized(input, mintId)
    const files = thin.editorStates!['/proj'].files
    expect(files[0].content).toBe('')
    expect(files[0].savedContent).toBe('')
    expect(files[1].content).toBe('EDITED')
    expect(files[1].savedContent).toBe('ORIG')
    expect(files[2].content).toBe('only copy')
  })

  it('preserves the tab count', () => {
    const input = v3([
      tabWithMessages('a', [msg('x')]),
      tabWithMessages('b', []),
      tabWithMessages('c', [msg('y'), msg('z')]),
    ])
    const { thin, contentByTabId } = migrateTabStateToExternalized(input, mintId)
    expect(thin.tabs).toHaveLength(3)
    expect(contentByTabId.size).toBe(2)
  })
})
