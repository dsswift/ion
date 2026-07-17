// @vitest-environment node
// Read-only smoke test of the FULL v4 pipeline (unify → split → externalize)
// against the operator's REAL tabs-api.json when present. Skipped in CI / on
// machines without the file. NEVER touches the real file — copies to a temp
// dir first, and the content store is pointed at that temp dir via the
// settings-store mock.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

const { settingsDirRef } = vi.hoisted(() => ({ settingsDirRef: { value: '' } }))
vi.mock('../settings-store', () => ({
  get SETTINGS_DIR() { return settingsDirRef.value },
}))

import { runTabUnifyMigration } from '../tab-migration-unify-runner'
import { runTabSplitMigration } from '../tab-migration-split-runner'
import { runTabExternalizeMigration } from '../tab-migration-externalize-runner'
import { mergeExternalContent, loadInstanceContent, listContentTabIds } from '../tab-content-store'

const REAL = join(homedir(), '.ion', 'tabs-api.json')

describe.skipIf(!existsSync(REAL))('REAL tabs-api.json v4 pipeline smoke (read-only)', () => {
  it('runs unify → split → externalize on a temp copy and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-real-v4-'))
    settingsDirRef.value = dir
    try {
      const tmp = join(dir, 'tabs.json')
      copyFileSync(REAL, tmp)
      const originalBytes = statSync(tmp).size

      const unify = runTabUnifyMigration(tmp)
      expect(['success', 'already-unified']).toContain(unify.reason)
      const split = runTabSplitMigration(tmp)
      expect(['success', 'no-multi', 'already-split']).toContain(split.reason)

      const beforeExt = JSON.parse(readFileSync(tmp, 'utf-8'))
      const inputInstanceMessages = new Map<number, unknown>()
      beforeExt.tabs.forEach((t: any, i: number) => {
        const msgs = t.conversationPane?.instances?.[0]?.messages
        if (Array.isArray(msgs) && msgs.length > 0) inputInstanceMessages.set(i, msgs)
      })

      const ext = runTabExternalizeMigration(tmp)
      expect(ext.reason).toBe('success')

      const thin = JSON.parse(readFileSync(tmp, 'utf-8'))
      const thinBytes = statSync(tmp).size
      expect(thin.schemaVersion).toBe(4)
      expect(thin.tabs.length).toBe(beforeExt.tabs.length)
      // No inline messages anywhere in the thin manifest.
      for (const t of thin.tabs) {
        expect(t.conversationPane?.instances?.[0]?.messages).toBeUndefined()
      }
      // One content file per messaged instance.
      expect(listContentTabIds().length).toBe(inputInstanceMessages.size)

      // Round-trip through the REAL load-path merge: message counts and
      // first/last boundary rows identical to the pre-externalize state.
      const merged = mergeExternalContent(thin, loadInstanceContent)
      for (const [i, msgs] of inputInstanceMessages) {
        const mergedMsgs = (merged.tabs as any)[i].conversationPane.instances[0].messages
        expect(mergedMsgs.length).toBe((msgs as unknown[]).length)
        expect(mergedMsgs[0]).toEqual((msgs as unknown[])[0])
        expect(mergedMsgs[mergedMsgs.length - 1]).toEqual((msgs as unknown[])[(msgs as unknown[]).length - 1])
      }

      // The headline: the thin manifest is dramatically smaller.
      // eslint-disable-next-line no-console
      console.log(`[real-v4-smoke] ${beforeExt.tabs.length} tabs, ${inputInstanceMessages.size} content files, ${Math.round(originalBytes / 1024)}KB -> ${Math.round(thinBytes / 1024)}KB thin`)
      expect(thinBytes).toBeLessThan(originalBytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
