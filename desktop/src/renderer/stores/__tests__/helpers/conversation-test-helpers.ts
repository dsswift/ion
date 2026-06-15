/**
 * Test helpers for the unified conversation-container model.
 *
 * After the dual-storage unification, per-conversation state (messages,
 * permissionDenied, permissionQueue, draftInput, modelOverride, sessionModel,
 * planFilePath, …) lives on a `ConversationInstance` inside `conversationPanes`, not
 * on `TabState`. Tests that previously seeded those fields on the tab now seed
 * the tab's `main` instance and assert against it. These helpers centralize
 * that so fixtures stay terse.
 */

import { MAIN_INSTANCE_ID } from '../../../../shared/session-key'
import { makeMainPane } from '../../conversation-instance'
import type { ConversationInstance, ConversationPane } from '../../../../shared/types-engine'

/**
 * Build an `conversationPanes` map seeding a single `main` instance for `tabId`,
 * applying `instanceOverrides` to that instance. Mirrors the production
 * eager-materialization (2A): every tab owns a `main` ConversationInstance.
 */
export function seedMainPane(
  tabId: string,
  instanceOverrides: Partial<ConversationInstance> = {},
): Map<string, ConversationPane> {
  return new Map([[tabId, makeMainPane(instanceOverrides)]])
}

/** Read the `main` instance for a tab out of an `conversationPanes` map. */
export function mainInstance(
  conversationPanes: Map<string, ConversationPane>,
  tabId: string,
): (ConversationInstance & { id: string; label: string }) | undefined {
  const pane = conversationPanes.get(tabId)
  return pane?.instances.find((i) => i.id === MAIN_INSTANCE_ID) as any
}
