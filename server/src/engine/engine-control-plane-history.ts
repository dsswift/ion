import type { EngineBridge } from './engine-bridge'

/**
 * Session-history / persistence read delegators for EngineControlPlane.
 *
 * These are thin pass-throughs to the EngineBridge's session-store reads,
 * extracted from engine-control-plane.ts as a cohesive cluster to keep that
 * file under the 600-line cap (see root AGENTS.md § "File-size caps").
 * The EngineControlPlane methods delegate here; the public API shape
 * is unchanged.
 */

export function listStoredSessions(bridge: EngineBridge, limit?: number): Promise<any[]> {
  return bridge.listStoredSessions(limit)
}

export function loadSessionHistory(bridge: EngineBridge, sessionId: string): Promise<any[]> {
  return bridge.loadSessionHistory(sessionId)
}

export function loadChainHistory(bridge: EngineBridge, sessionIds: string[]): Promise<any[]> {
  return bridge.loadChainHistory(sessionIds)
}

export function getConversation(
  bridge: EngineBridge,
  conversationId: string,
  offset = 0,
  limit = 50,
): Promise<any> {
  return bridge.getConversation(conversationId, offset, limit)
}

export function saveSessionLabel(
  bridge: EngineBridge,
  sessionId: string,
  label: string,
): Promise<{ ok: boolean; error?: string }> {
  return bridge.saveSessionLabel(sessionId, label)
}
