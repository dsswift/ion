/**
 * The send decision, extracted from InputBar.handleSend so the ordering it
 * enforces is testable without mounting the whole input surface.
 *
 * The ordering IS the contract: acceptance is decided first, against one store
 * snapshot, and the operator's text is destroyed only after the prompt has
 * been accepted. The defect this replaces did the reverse — cleared the input
 * and the persisted draft, then called submit(), which could refuse. The
 * prompt was gone, no user message appeared, and the attachments stayed
 * attached (only submit() consumes them), so the send looked like it had
 * happened and hadn't.
 *
 * ── The gate alone is not enough across the mirror boundary ─────────────────
 *
 * The pre-check above reads THIS window's store. `submit` is a FORWARDED action
 * (shared/studio-mirror-actions.ts), so when the Studio presentation is active
 * the InputBar runs in the MIRROR and the authoritative guard runs in the
 * OWNER, against owner state. The two can disagree — an owner that has not
 * applied a run's completion still reads 'connecting' while the mirror reads
 * 'completed' — and the mirror would then clear the text for a prompt the owner
 * refuses. That is how a real operator instruction was destroyed.
 *
 * So the clear is also REVERSIBLE: submit() returns its outcome, and a refusal
 * restores the text and the draft. The pre-check remains, because avoiding the
 * flicker of a clear-then-restore is worth keeping for the common case where
 * both windows agree.
 */
import { resolveAttachmentPrompt } from '../../shared/attachment-prompt'
import { promptRefusal, type PromptAcceptanceTab } from '../../shared/prompt-acceptance'
import type { PromptSubmitResult } from '../../shared/prompt-submit-result'

export interface SendSnapshot {
  tabs: Array<{ id: string } & PromptAcceptanceTab>
  activeTabId: string | null
  tabsReady: boolean
}

export interface SendGateDeps {
  /** Read once. Both the gate and submit() must see the same instant. */
  getSnapshot: () => SendSnapshot
  clearInput: () => void
  clearDraft: (tabId: string) => void
  /**
   * Returns the authoritative outcome. In the mirror this resolves over IPC
   * from the owner, so it is the only way this window learns that the owner
   * refused.
   */
  submit: (tabId: string, text: string) => PromptSubmitResult | Promise<PromptSubmitResult> | void
  /** Put the operator's text back after a refusal the pre-check could not see. */
  restoreInput: (text: string) => void
  warn: (msg: string, fields: Record<string, unknown>) => void
}

export type SendOutcome =
  | { accepted: true; tabId: string }
  | { accepted: false; reason: string }

/**
 * Decide, then clear, then submit — and restore on a refusal only the owner
 * could see.
 *
 * `attachmentCount` only shapes the fallback prompt text and the refusal log —
 * the attachments themselves are read from the tab inside submit().
 */
export function dispatchSend(
  prompt: string,
  attachmentCount: number,
  deps: SendGateDeps,
): SendOutcome {
  const snap = deps.getSnapshot()
  const currentTab = snap.tabs.find((t) => t.id === snap.activeTabId)
  const refusal = promptRefusal({ tab: currentTab, tabsReady: snap.tabsReady })

  // `!currentTab` is also what promptRefusal reports as 'no-tab'; it is
  // repeated because that correlation is not expressible to the type checker,
  // and an assertion would be a claim rather than a check.
  if (refusal || !currentTab) {
    const reason = refusal?.reason ?? 'no-tab'
    deps.warn('send refused, keeping operator text', {
      tab_id: (currentTab?.id ?? '').slice(0, 8),
      count: prompt.length,
      attachments: attachmentCount,
      reason,
      detail: refusal?.detail ?? 'no active conversation resolved',
    })
    return { accepted: false, reason }
  }

  const text = resolveAttachmentPrompt(prompt, attachmentCount)
  deps.clearInput()
  deps.clearDraft(currentTab.id)
  const outcome = deps.submit(currentTab.id, text)

  // A refusal that only the owner's guard could see arrives here — synchronously
  // in the owner window, or as a promise from the mirror's IPC round trip.
  // Either way the operator's text goes back rather than being destroyed.
  const settle = (result: PromptSubmitResult | void): void => {
    if (!result || result.accepted) return
    deps.warn('send refused by the authoritative guard, restoring operator text', {
      tab_id: currentTab.id.slice(0, 8), count: prompt.length, reason: result.reason,
    })
    deps.restoreInput(prompt)
  }
  if (outcome && typeof (outcome as Promise<PromptSubmitResult>).then === 'function') {
    void (outcome as Promise<PromptSubmitResult>).then(settle).catch(() => {
      // A transport failure is already reported by the mirror's forwarding
      // wrapper (studio.mirror 'forwarded action did not complete'). Restore
      // regardless: an unanswered submit must not cost the operator their text.
      deps.restoreInput(prompt)
    })
  } else {
    settle(outcome as PromptSubmitResult | void)
  }

  return { accepted: true, tabId: currentTab.id }
}
