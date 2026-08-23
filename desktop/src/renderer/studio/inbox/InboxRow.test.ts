import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'InboxRow.tsx'), 'utf8')

describe('InboxRow status restraint', () => {
  it('does not render a separate unread dot', () => {
    expect(source).not.toContain("width: 6, height: 6, borderRadius: 3")
  })

  it('does not calculate or render context capacity', () => {
    expect(source).not.toContain('contextCapacityStatus')
    expect(source).not.toContain('context-capacity')
    expect(source).not.toContain('useModelStore')
    expect(source).not.toContain('usePreferencesStore')
  })

  it('keeps unread state in the title and trailing status', () => {
    expect(source).toContain(": unread ? 'Done'")
    expect(source).toContain('fontWeight: unread || isActive || selected ? 600 : 400')
  })

  it('shows the latest activity including run completion', () => {
    expect(source).toContain('latestConversationActivityAt(tab)')
    expect(source).toContain('formatRelativeShort(latestActivityAt)')
  })

  it('uses the entire row as the conversation hover target', () => {
    const cardOpen = source.indexOf('<ConversationHoverCard')
    const rowOpen = source.indexOf('<div\n      {...handlers}', cardOpen)
    const cardClose = source.indexOf('</ConversationHoverCard>', rowOpen)

    expect(cardOpen).toBeGreaterThan(-1)
    expect(rowOpen).toBeGreaterThan(cardOpen)
    expect(cardClose).toBeGreaterThan(rowOpen)
    expect(source.indexOf('aria-label="Settle conversation"', rowOpen)).toBeLessThan(cardClose)
    expect(source).toContain("width: '100%', boxSizing: 'border-box'")
  })

  it('keeps the distinct expired-snooze indicator', () => {
    expect(source).toContain('<WarningCircle size={11} />Woke')
  })

  it('shows automatic settlement and friendly worktree titles', () => {
    expect(source).toContain("tab.settledOverride === 'auto'")
    expect(source).toContain('>Auto</span>')
    expect(source).toContain('const worktreeTitle = tab.worktree ? inboxWorktreeFor(tab, benches, inventory).label : null')
  })
})
