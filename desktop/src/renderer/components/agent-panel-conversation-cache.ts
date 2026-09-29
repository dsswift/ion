import { useCallback, useState } from "react";
import { host } from "../host/host-instance";
import { rDebug, rError } from "../rendererLogger";
import { mapConversationMessages } from "@ion/shared/transcript/agent-conversation-mapper";
import type { Message } from "@ion/shared/types";

export interface AgentPanelConversationCache {
  convMessages: Map<string, Message[]>;
  convLoading: Map<string, boolean>;
  /** Force-refetch a conversation, bypassing the "already loaded" guard. */
  refetchConversation: (convId: string, showLoading?: boolean) => Promise<void>;
  /** One-shot load: fetch the conversation only if it hasn't been loaded yet. */
  loadSingleConversation: (convId: string) => Promise<void>;
}

/**
 * Per-conversation transcript cache (file-backed snapshots via
 * `getConversation`), extracted from AgentPanel.tsx so that file stays under
 * the 600-line cap. Mirrors `useDispatchTranscript.ts`'s identical mechanism
 * under this component's own state naming.
 *
 *  `showLoading` gates the "Loading conversation..." placeholder. It is set
 *  only for the initial one-shot load, when there is nothing to show yet. A
 *  BACKGROUND reconcile (the 12s poller, the terminal-transition refetch)
 *  must NOT raise the loading flag: the popup already has a cached transcript
 *  (plus the live push transcript) to display, and flipping loading true on
 *  every poll cycle blanks the panel to the placeholder while the fetch is in
 *  flight — the ~12s flashing between content and "Loading conversation...".
 *  Per the View readiness principle, no loading placeholder for data we have.
 */
export function useAgentPanelConversationCache(): AgentPanelConversationCache {
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(
    new Map(),
  );
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(
    new Map(),
  );

  const refetchConversation = useCallback(
    async (convId: string, showLoading = false) => {
      if (!convId) return;
      if (showLoading) {
        setConvLoading((prev) => {
          const next = new Map(prev);
          next.set(convId, true);
          return next;
        });
      }
      try {
        rDebug("agent-panel", "fetching conversation", {
          conversation_id: convId,
          show_loading: showLoading,
        });
        const data = await host.shell.getConversation(convId, 0, 200);
        const msgs: Message[] = mapConversationMessages(data.messages || []);
        rDebug("agent-panel", "loaded conversation messages", {
          conversation_id: convId,
          count: msgs.length,
        });
        setConvMessages((prev) => {
          const next = new Map(prev);
          next.set(convId, msgs);
          return next;
        });
      } catch (err) {
        rError("agent-panel", "loadConversation error", { error: String(err) });
      } finally {
        if (showLoading) {
          setConvLoading((prev) => {
            const next = new Map(prev);
            next.set(convId, false);
            return next;
          });
        }
      }
    },
    [],
  );

  const loadSingleConversation = useCallback(
    async (convId: string) => {
      if (!convId || convMessages.has(convId)) return;
      // First load for this conversation — nothing cached yet, so surface the
      // loading placeholder. Background reconciles refetch silently.
      return refetchConversation(convId, true);
    },
    [convMessages, refetchConversation],
  );

  return { convMessages, convLoading, refetchConversation, loadSingleConversation };
}
