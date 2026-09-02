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
 *
 * The pre-check alone cannot cover the mirror boundary: it reads THIS window's
 * store, while `submit` forwards to the OWNER, whose guard is authoritative and
 * can disagree. The final block pins the restore path that answers that case.
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatchSend, type SendGateDeps, type SendSnapshot } from '../InputBarSend'
import { PROMPT_ACCEPTED, promptRefused } from '../../../shared/prompt-submit-result'

function deps(snap: SendSnapshot, submitResult: unknown = undefined) {
  const calls: string[] = []
  const d: SendGateDeps = {
    getSnapshot: () => snap,
    clearInput: vi.fn(() => { calls.push('clearInput') }),
    clearDraft: vi.fn((id: string) => { calls.push(`clearDraft:${id}`) }),
    submit: vi.fn((id: string, text: string) => {
      calls.push(`submit:${id}:${text}`)
      return submitResult as never
    }),
    restoreInput: vi.fn((text: string) => { calls.push(`restoreInput:${text}`) }),
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

  it('submits a normal prompt at full context so the engine can auto-compact', () => {
    const { d } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 100, contextLimit: 100 }],
      activeTabId: 'tab-aaaaaaaa', tabsReady: true,
    })
    expect(dispatchSend('continue', 2, d)).toEqual({ accepted: true, tabId: 'tab-aaaaaaaa' })
    expect(d.clearInput).toHaveBeenCalledOnce()
    expect(d.clearDraft).toHaveBeenCalledWith('tab-aaaaaaaa')
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', 'continue')
  })

  it('also sends explicit context recovery commands at full context', () => {
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

  it('substitutes an actionable attachment-only prompt', () => {
    const { d } = deps(idle)
    dispatchSend('', 2, d)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', 'Analyze the attached files.')
  })

  it('sends an empty prompt as empty when there is nothing attached', () => {
    const { d } = deps(idle)
    dispatchSend('', 0, d)
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', '')
  })

  it('keeps full-context sends on the same acceptance path', () => {
    const { d, calls } = deps({
      tabs: [{ id: 'tab-aaaaaaaa', status: 'idle', contextTokens: 167_000, contextLimit: 167_000 }],
      activeTabId: 'tab-aaaaaaaa',
      tabsReady: true,
    })

    expect(dispatchSend('the prompt remains editable', 2, d)).toEqual({ accepted: true, tabId: 'tab-aaaaaaaa' })
    expect(calls).toEqual([
      'clearInput',
      'clearDraft:tab-aaaaaaaa',
      'submit:tab-aaaaaaaa:the prompt remains editable',
    ])
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

  // ── The authoritative refusal: only the owner's guard can see it ───────────
  //
  // These pin the cross-window case. The pre-check passes (this window's tab
  // looks idle), the text is cleared, and then the OWNER refuses. Without the
  // restore the operator's instruction is destroyed — which is exactly what
  // happened to a real `/roadmap --sync` against a tab the owner still
  // believed was 'connecting'.

  it('restores the operator text when the owner refuses synchronously', () => {
    const { d, calls } = deps(idle, promptRefused('connecting'))

    const out = dispatchSend('/roadmap --sync', 0, d)

    // The gate still reports accepted: it did admit and dispatch.
    expect(out).toEqual({ accepted: true, tabId: 'tab-aaaaaaaa' })
    // But the text came back rather than being lost.
    expect(d.restoreInput).toHaveBeenCalledWith('/roadmap --sync')
    expect(calls).toEqual([
      'clearInput',
      'clearDraft:tab-aaaaaaaa',
      'submit:tab-aaaaaaaa:/roadmap --sync',
      'warn:send refused by the authoritative guard, restoring operator text',
      'restoreInput:/roadmap --sync',
    ])
  })

  it('restores the operator text when the owner refuses over the mirror round trip', async () => {
    const { d } = deps(idle, Promise.resolve(promptRefused('connecting')))

    dispatchSend('/roadmap --sync', 0, d)
    // The mirror's forwarded call resolves a tick later.
    await Promise.resolve()
    await Promise.resolve()

    expect(d.restoreInput).toHaveBeenCalledWith('/roadmap --sync')
  })

  it('restores the operator text when the forwarded submit never completes', async () => {
    const { d } = deps(idle, Promise.reject(new Error('owner window wedged')))

    dispatchSend('keep me', 0, d)
    await Promise.resolve()
    await Promise.resolve()

    // An unanswered submit must not cost the operator their text either.
    expect(d.restoreInput).toHaveBeenCalledWith('keep me')
  })

  it('leaves the input clear when the owner accepts', () => {
    const { d } = deps(idle, PROMPT_ACCEPTED)

    dispatchSend('hello', 0, d)

    expect(d.restoreInput).not.toHaveBeenCalled()
  })

  it('leaves the input clear when submit reports nothing', () => {
    // A caller that returns no outcome (older shape) must not trigger a
    // spurious restore that would duplicate text the operator already sent.
    const { d } = deps(idle, undefined)

    dispatchSend('hello', 0, d)

    expect(d.restoreInput).not.toHaveBeenCalled()
  })

  it('restores the substituted attachment prompt, not the empty raw text', () => {
    const { d } = deps(idle, promptRefused('connecting'))

    dispatchSend('', 2, d)

    // submit() received the substitute; the operator typed nothing, so there is
    // nothing to put back in the box.
    expect(d.submit).toHaveBeenCalledWith('tab-aaaaaaaa', 'Analyze the attached files.')
    expect(d.restoreInput).toHaveBeenCalledWith('')
  })
})
