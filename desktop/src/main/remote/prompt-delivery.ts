const pendingRemotePrompts = new Map<string, { deviceId: string; tabId: string }>()

export function registerRemotePromptDelivery(requestId: string, deviceId: string, tabId: string): void {
  pendingRemotePrompts.set(requestId, { deviceId, tabId })
}

export function takeRemotePromptDelivery(requestId: string): { deviceId: string; tabId: string } | undefined {
  const pending = pendingRemotePrompts.get(requestId)
  pendingRemotePrompts.delete(requestId)
  return pending
}
