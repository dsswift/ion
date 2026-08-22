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
 */
import { promptRefusal, type PromptAcceptanceTab } from '../../shared/prompt-acceptance'

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
  submit: (tabId: string, text: string) => void
  warn: (msg: string, fields: Record<string, unknown>) => void
}

export type SendOutcome =
  | { accepted: true; tabId: string }
  | { accepted: false; reason: string }

/**
 * Decide, then clear, then submit.
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
  const refusal = promptRefusal({ tab: currentTab, tabsReady: snap.tabsReady, text: prompt })

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

  deps.clearInput()
  deps.clearDraft(currentTab.id)
  deps.submit(currentTab.id, prompt || (attachmentCount > 0 ? 'See attached files' : ''))
  return { accepted: true, tabId: currentTab.id }
}
