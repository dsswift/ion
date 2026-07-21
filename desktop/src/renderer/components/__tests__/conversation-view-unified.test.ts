/**
 * Structural guards for the conversation-view unification (#256 follow-up).
 *
 * After the merge there is exactly ONE conversation view component for every
 * tab type — the former EngineView and the former plain ConversationView are
 * collapsed into a single `ConversationView`. These guards fail if the merge
 * regresses (a re-introduced EngineView, a re-introduced `isEngine` view/mount
 * fork in App.tsx, or a lingering submitEnginePrompt symbol).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const COMPONENTS = resolve(__dirname, '..')
const RENDERER = resolve(__dirname, '../..')

describe('conversation view is unified — structural guards', () => {
  it('there is no EngineView.tsx file', () => {
    expect(existsSync(resolve(COMPONENTS, 'EngineView.tsx'))).toBe(false)
  })

  it('exactly one ConversationView component exists', () => {
    const cv = resolve(COMPONENTS, 'ConversationView.tsx')
    expect(existsSync(cv)).toBe(true)
    const src = readFileSync(cv, 'utf8')
    expect(src).toMatch(/export function ConversationView\(/)
    // The unified view renders the agent panel from data (no tab-type gate).
    expect(src).toContain('<AgentPanel')
    expect(src).not.toContain('export function EngineView')
  })

  it('App.tsx mounts one ConversationView for non-terminal tabs with no isEngine view fork', () => {
    const app = readFileSync(resolve(RENDERER, 'App.tsx'), 'utf8')
    // No engine-view mount and no engine-specific view/layout flags.
    expect(app).not.toContain('<EngineView')
    expect(app).not.toMatch(/\bisEngine\b/)
    expect(app).not.toMatch(/\bisEngineTall\b/)
    // The single conversation mount is data-agnostic (keyed on activeTabId so
    // React remounts on tab switch, resetting local state). key={activeTabId}
    // is part of the fix for the tab-switch stale-renderOffset bug.
    expect(app).toContain('<ConversationView key={activeTabId} tabId={activeTabId} />')
  })

  it('submitEnginePrompt is gone from the renderer source tree', () => {
    // Walk the store slices + components for the deleted action symbol.
    const files = [
      resolve(RENDERER, 'stores/session-store-types.ts'),
      resolve(RENDERER, 'stores/slices/engine-slice-submit.ts'),
      resolve(RENDERER, 'stores/slices/send-slice.ts'),
      resolve(RENDERER, 'components/InputBar.tsx'),
      resolve(RENDERER, 'components/ConversationView.tsx'),
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Allow the word inside prose comments that document the removal, but no
      // live identifier usage: assert there is no `submitEnginePrompt:` action
      // definition or `.submitEnginePrompt(` call.
      expect(src).not.toMatch(/submitEnginePrompt\s*:/)
      expect(src).not.toMatch(/\.submitEnginePrompt\(/)
    }
  })
})
