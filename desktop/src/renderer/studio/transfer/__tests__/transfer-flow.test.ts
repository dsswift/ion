/**
 * transfer-flow: the pure export -> import -> remove orchestration (spec 15
 * §Acceptance Criteria). Exercises the flow against two fake environments --
 * no Electron/IPC boundary, no real server -- since the individual steps
 * (transfer.export/import/remove semantics) are pinned by
 * `server/src/transfer/__tests__/*.test.ts` and the broker-level relay is
 * pinned by `main/connections/__tests__/transfer.test.ts`. What this file
 * verifies is the FLOW: which step runs when, which step a failure is
 * attributed to, and that a retried removal is idempotent.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ExportFileResult, ImportFileResult } from '@ion/shared/types-transfer'
import { runTransfer, retryRemoval, runWorktreeMove, runLocalMove, type TransferFlowDeps } from '../transfer-flow'

function okExport(filePath = '/tmp/export.zip', totalBytes = 10, rootConversationId = 'root-1'): ExportFileResult {
  return { ok: true, filePath, totalBytes, rootConversationId }
}
function okImport(tabId = 'target-tab-1', rootConversationId = 'root-1'): ImportFileResult {
  return { ok: true, rootConversationId, tabId }
}

describe('runTransfer', () => {
  it('runs export, then import with the exported file, then removes the source, and selects the new tab', async () => {
    const calls: string[] = []
    const deps: TransferFlowDeps = {
      exportToFile: vi.fn(async (environmentId, tabId, targetEnvironmentId) => {
        calls.push(`export:${environmentId}:${tabId}:${targetEnvironmentId}`)
        return okExport('/tmp/archive.zip')
      }),
      importFromFile: vi.fn(async (environmentId, tabId, filePath) => {
        calls.push(`import:${environmentId}:${tabId}:${filePath}`)
        return okImport('new-tab-9')
      }),
      action: vi.fn(async (environmentId, name, args) => {
        calls.push(`action:${environmentId}:${name}:${JSON.stringify(args)}`)
        return { transferredTo: { environmentId: 'env-target', at: Date.now() } }
      }),
    }

    const result = await runTransfer('env-source', 'tab-1', 'env-target', deps)

    expect(result).toEqual({ ok: true, targetEnvironmentId: 'env-target', targetTabId: 'new-tab-9' })
    expect(calls).toEqual([
      'export:env-source:tab-1:env-target',
      'import:env-target:tab-1:/tmp/archive.zip',
      'action:env-source:transfer.remove:[{"tabId":"tab-1","targetEnvironmentId":"env-target","retireWorktree":false}]',
    ])
  })

  it('stops at export and reports refusal{running} without touching import or the removal', async () => {
    const importFromFile = vi.fn()
    const action = vi.fn()
    const deps: TransferFlowDeps = {
      exportToFile: async () => ({ ok: false, refusal: { code: 'running', message: 'tab is running' } }),
      importFromFile,
      action,
    }

    const result = await runTransfer('env-source', 'tab-2', 'env-target', deps)

    expect(result).toEqual({ ok: false, step: 'exporting', refusal: { code: 'running', message: 'tab is running' } })
    expect(importFromFile).not.toHaveBeenCalled()
    expect(action).not.toHaveBeenCalled()
  })

  it('stops at import for any other refusal code, leaving the source untouched (no removal call)', async () => {
    const action = vi.fn()
    const deps: TransferFlowDeps = {
      exportToFile: async () => okExport(),
      importFromFile: async () => ({ ok: false, refusal: { code: 'invalid_args', message: 'transferId and totalBytes are required' } }),
      action,
    }

    const result = await runTransfer('env-source', 'tab-3', 'env-target', deps)

    expect(result).toEqual({
      ok: false,
      step: 'importing',
      refusal: { code: 'invalid_args', message: 'transferId and totalBytes are required' },
    })
    expect(action).not.toHaveBeenCalled()
  })

  it('treats import refusal{conversation_exists} as already landed and proceeds to the removal', async () => {
    const action = vi.fn(async () => ({ transferredTo: { environmentId: 'env-target', at: Date.now() } }))
    const deps: TransferFlowDeps = {
      exportToFile: async () => okExport(),
      importFromFile: async () => ({ ok: false, refusal: { code: 'conversation_exists', message: 'conversation already exists locally' } }),
      action,
    }

    const result = await runTransfer('env-source', 'tab-3b', 'env-target', deps)

    expect(result).toEqual({ ok: true, targetEnvironmentId: 'env-target' })
    expect(action).toHaveBeenCalledWith('env-source', 'transfer.remove', [{ tabId: 'tab-3b', targetEnvironmentId: 'env-target', retireWorktree: false }])
  })

  it('still fails at sealing when the already-landed recovery path hits a removal refusal', async () => {
    const deps: TransferFlowDeps = {
      exportToFile: async () => okExport(),
      importFromFile: async () => ({ ok: false, refusal: { code: 'conversation_exists', message: 'conversation already exists locally' } }),
      action: async () => {
        const err = new Error('no transfer is in flight for this tab') as Error & { code: string }
        err.code = 'not_found'
        throw err
      },
    }

    const result = await runTransfer('env-source', 'tab-3c', 'env-target', deps)

    expect(result).toEqual({ ok: false, step: 'removing', refusal: { code: 'not_found', message: 'no transfer is in flight for this tab' } })
  })

  it('reports a removal failure with the action refusal code when transfer.remove is refused', async () => {
    const deps: TransferFlowDeps = {
      exportToFile: async () => okExport(),
      importFromFile: async () => okImport(),
      action: async () => {
        const err = new Error('no transfer is in flight for this tab') as Error & { code: string }
        err.code = 'not_found'
        throw err
      },
    }

    const result = await runTransfer('env-source', 'tab-4', 'env-target', deps)

    expect(result).toEqual({ ok: false, step: 'removing', refusal: { code: 'not_found', message: 'no transfer is in flight for this tab' } })
  })
})

describe('retryRemoval', () => {
  it('calls transfer.remove again for an unfinished transfer and succeeds', async () => {
    const action = vi.fn(async () => ({ transferredTo: { environmentId: 'env-target', at: Date.now() } }))
    const result = await retryRemoval('env-source', 'tab-5', 'env-target', { action })

    expect(result).toEqual({ ok: true, targetEnvironmentId: 'env-target' })
    expect(action).toHaveBeenCalledWith('env-source', 'transfer.remove', [{ tabId: 'tab-5', targetEnvironmentId: 'env-target' }])
  })

  it('surfaces the refusal code when a retried seal still fails', async () => {
    const action = vi.fn(async () => {
      const err = new Error('conversation was transferred to a different target') as Error & { code: string }
      err.code = 'seal_mismatch'
      throw err
    })
    const result = await retryRemoval('env-source', 'tab-6', 'env-target', { action })

    expect(result).toEqual({
      ok: false,
      step: 'removing',
      refusal: { code: 'seal_mismatch', message: 'conversation was transferred to a different target' },
    })
  })
})

describe('runLocalMove', () => {
  // A move within one machine is one step: the conversation is repointed,
  // nothing is exported, and nothing is removed.
  it('asks transfer.relocate and reports where the conversation lives now', async () => {
    const action = vi.fn(async () => ({ ok: true, tabId: 'tab-1', workingDirectory: '/wt/new', worktreePath: '/wt/new' }))
    const result = await runLocalMove('env-a', 'tab-1', { kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'main' }, { action })
    expect(action).toHaveBeenCalledWith('env-a', 'transfer.relocate', [{ tabId: 'tab-1', landing: { kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'main' } }])
    expect(result).toEqual({ ok: true, targetEnvironmentId: 'env-a', targetTabId: 'tab-1', workingDirectory: '/wt/new' })
  })

  it('reports a refusal as a failed move, with its code', async () => {
    const action = vi.fn(async () => { throw Object.assign(new Error('the conversation already lives in /src/ion'), { code: 'same_place' }) })
    const result = await runLocalMove('env-a', 'tab-1', { kind: 'checkout', dir: '/src/ion' }, { action })
    expect(result).toEqual({ ok: false, step: 'moving', refusal: { code: 'same_place', message: 'the conversation already lives in /src/ion' } })
  })
})

describe('runWorktreeMove', () => {
  function deps(failOn?: string): TransferFlowDeps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      exportToFile: vi.fn(async (_env, tabId): Promise<ExportFileResult> => { calls.push(`export:${tabId}`); return failOn === tabId ? { ok: false, refusal: { code: 'running', message: 'busy' } } : okExport(`/tmp/${tabId}.zip`) }),
      importFromFile: vi.fn(async (_env, tabId): Promise<ImportFileResult> => { calls.push(`import:${tabId}`); return okImport(`dest-${tabId}`) }),
      action: vi.fn(async (_env, _name, args) => {
        const arg = (args as [{ tabId: string; retireWorktree?: boolean }])[0]
        calls.push(`remove:${arg.tabId}${arg.retireWorktree ? ':retire' : ''}`)
        return {}
      }),
    }
  }

  // A worktree moves whole: every conversation in it, in order, each
  // through export -> import -> remove, with the first destination tab
  // reported for "Open there".
  it('moves every conversation in order and reports the first destination tab', async () => {
    const d = deps()
    const result = await runWorktreeMove('env-a', ['tab-1', 'tab-2', 'tab-3'], 'env-b', d)
    expect(result).toEqual({ ok: true, targetEnvironmentId: 'env-b', moved: ['tab-1', 'tab-2', 'tab-3'], targetTabId: 'dest-tab-1' })
    expect(d.calls).toEqual(['export:tab-1', 'import:tab-1', 'remove:tab-1', 'export:tab-2', 'import:tab-2', 'remove:tab-2', 'export:tab-3', 'import:tab-3', 'remove:tab-3:retire'])
  })

  // Each conversation's export packages the worktree, so the checkout must
  // still exist for every conversation but the last. Retiring it on the
  // first removal deleted the checkout the second export needed.
  it('retires the source worktree with the last conversation only', async () => {
    const d = deps()
    await runWorktreeMove('env-a', ['tab-1', 'tab-2'], 'env-b', d)
    expect(d.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:tab-1', 'remove:tab-2:retire'])
  })

  it('stops at the first failure and says which conversations are already across', async () => {
    const d = deps('tab-2')
    const result = await runWorktreeMove('env-a', ['tab-1', 'tab-2', 'tab-3'], 'env-b', d)
    expect(result).toEqual({ ok: false, targetEnvironmentId: 'env-b', moved: ['tab-1'], targetTabId: 'dest-tab-1', failed: { tabId: 'tab-2', step: 'exporting', refusal: { code: 'running', message: 'busy' } } })
    expect(d.calls).not.toContain('export:tab-3')
  })
})
