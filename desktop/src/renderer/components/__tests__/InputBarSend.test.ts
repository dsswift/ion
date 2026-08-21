/**
 * Regression test for the input-drop defect.
 *
 * Reported symptom: a prompt typed while the conversation was input-locked
 * disappeared from the input box on submit, no user message ever appeared, the
 * conversation never ran again, and the image attachment stayed attached.
 *
 * The cause was ordering: handleSend cleared the input and the persisted draft
 * BEFORE submit() decided whether to accept the prompt. Every assertion below
 * that names an order (`clear` after `accept`, no clear on refusal) goes red if
 * the clears move back above the decision.
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatchSend, type SendGateDeps, type SendSnapshot } from '../InputBarSend'

function deps(snap: SendSnapshot) {
  const calls: string[] = []
  const d: SendGateDeps = {
    getSnapshot: () => snap,
    clearInput: vi.fn(() => { calls.push('clearInput') }),
    clearDraft: vi.fn((id: string) => { calls.push(`clearDraft:${id}`) }),
    submit: vi.fn((id: string, text: string) => { calls.push(`submit:${id}:${text}`) }),
    warn: vi.fn((msg: string) => { calls.push(`warn:${msg}`) }),
  }
  return { d, calls }
}

const idle: SendSnapshot = {
  tabs: [{ id: 'tab-aaaaaaaa', status: 'idle' }],
  activeTabId: 'tab-aaaaaaaa',
  tabsReady: true,
}

describe('dispatchSend', () => {
  it('clears and submits when the conversation accepts the prompt', () => {
    const { d, calls } = deps(idle)
    const out = dispatchSend('hello', 0, d)

    expect(out).toEqual({ accepted: true, tabId: 'tab-aaaaaaaa' })
    expect(calls).toEqual([
      'clearInput',
      'clearDraft:tab-aaaaaaaa',
      'submit:tab-aaaaaaaa:hello',
    ])
    expect(d.warn).not.toHaveBeenCalled()
  })

  it('keeps the operator text when the conversation is input-locked', () => {
    const { d, calls } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', inputLocked: true, inputLockReason: 'landed-worktree' }],
      activeTabId: 'tab-aaaaaaaa',
      tabsReady: true,
    })
    const out = dispatchSend('the prompt that used to vanish', 1, d)

    expect(out).toEqual({ accepted: false, reason: 'input-locked' })
    // The defect: any clear here destroys text that was never sent.
    expect(d.clearInput).not.toHaveBeenCalled()
    expect(d.clearDraft).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
    expect(calls).toEqual(['warn:send refused, keeping operator text'])
  })

  it('reports the refusal with the reason, length, and attachment count', () => {
    const { d } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'connecting' }],
      activeTabId: 'tab-aaaaaaaa',
      tabsReady: true,
    })
    dispatchSend('hi', 2, d)

    expect(d.warn).toHaveBeenCalledWith('send refused, keeping operator text', {
      tab_id: 'tab-aaaa',
      count: 2,
      attachments: 2,
      reason: 'connecting',
      detail: 'session is still connecting',
    })
  })

  it('keeps the text when no tab resolves', () => {
    const { d } = deps({ tabs: [], activeTabId: 'tab-gone', tabsReady: true })
    const out = dispatchSend('hello', 0, d)

    expect(out).toEqual({ accepted: false, reason: 'no-tab' })
    expect(d.clearInput).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
    expect(d.warn).toHaveBeenCalledWith('send refused, keeping operator text', expect.objectContaining({
      reason: 'no-tab',
      detail: 'no active conversation resolved',
    }))
  })

  it('keeps the text while tab state is still restoring', () => {
    const { d } = deps({ ...idle, tabsReady: false })
    expect(dispatchSend('hello', 0, d).accepted).toBe(false)
    expect(d.clearInput).not.toHaveBeenCalled()
  })

  it('keeps the draft and attachments when context is full', () => {
    const { d } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 100, contextLimit: 100 }],
      activeTabId: 'tab-aaaaaaaa', tabsReady: true,
    })
    expect(dispatchSend('continue', 2, d)).toEqual({ accepted: false, reason: 'context-full' })
    expect(d.clearInput).not.toHaveBeenCalled()
    expect(d.clearDraft).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('sends context recovery commands at the capacity block', () => {
    const { d } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 100, contextLimit: 100 }],
      activeTabId: 'tab-aaaaaaaa', tabsReady: true,
    })
    expect(dispatchSend('/compact', 0, d).accepted).toBe(true)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', '/compact')
  })

  it('submits to the resolved tab, not the one the caller last rendered', () => {
    // The gate and submit() read ONE snapshot, so an attachment-bearing send
    // cannot clear tab A's draft and submit to tab B.
    const { d, calls } = deps({
      tabs: [{ id: 'tab-old', status: 'idle' }, { id: 'tab-new', status: 'idle' }],
      activeTabId: 'tab-new',
      tabsReady: true,
    })
    dispatchSend('hello', 0, d)
    expect(calls).toEqual(['clearInput', 'clearDraft:tab-new', 'submit:tab-new:hello'])
  })

  it('substitutes the attachment-only prompt text', () => {
    const { d } = deps(idle)
    dispatchSend('', 2, d)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', 'See attached files')
  })

  it('sends an empty prompt as empty when there is nothing attached', () => {
    const { d } = deps(idle)
    dispatchSend('', 0, d)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', '')
  })

  it('keeps the draft and attachments when context is full', () => {
    const { d, calls } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 167_000, contextLimit: 167_000 }],
      activeTabId: 'tab-aaaaaaaa',
      tabsReady: true,
    })

    expect(dispatchSend('the prompt remains editable', 2, d)).toEqual({ accepted: false, reason: 'context-full' })
    expect(d.clearInput).not.toHaveBeenCalled()
    expect(d.clearDraft).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
    expect(calls).toEqual(['warn:send refused, keeping operator text'])
  })

  it('allows /compact and /clear when context is full', () => {
    const snap: SendSnapshot = {
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 167_000, contextLimit: 167_000 }],
      activeTabId: 'tab-aaaaaaaa',
      tabsReady: true,
    }
    expect(dispatchSend('/compact', 0, deps(snap).d).accepted).toBe(true)
    expect(dispatchSend('/clear', 0, deps(snap).d).accepted).toBe(true)
  })

  it('accepts a mid-turn steer on a running conversation', () => {
    const { d } = deps({ ...idle, tabs: [{ id: 'tab-aaaaaaaa', status: 'running' }] })
    expect(dispatchSend('steer', 0, d).accepted).toBe(true)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', 'steer')
  })
})
