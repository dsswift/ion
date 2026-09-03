import { useSessionStore } from "../../stores/sessionStore";
import type {
  LegacySurfacePersisted,
  PinnableSingletonId,
  SurfaceConversationPersisted,
  SurfaceTab,
} from "../../../shared/studio-surface-types";
import {
  emptySurfacePersisted,
  parseSurfacePersisted,
} from "../../../shared/studio-surface-persistence";
import { rDebug, rInfo, rWarn } from "../../rendererLogger";
import { materializeConversation } from "./surface-tab-lifecycle";
import { emptyConversation, project } from "./surface-store-project";
import type { SurfaceState } from "./surface-store";

let hydrationPromise: Promise<void> | null = null;

export function resetSurfaceHydration(): void {
  hydrationPromise = null;
}

/** Create the Surface State hydration action. */
export function createSurfaceHydrationActions(
  set: (partial: Partial<SurfaceState>) => void,
  get: () => SurfaceState,
  schedulePersist: (get: () => SurfaceState) => void,
): Pick<SurfaceState, "hydrate"> {
  return {
  hydrate: async () => {
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = (async () => {
      try {
        const settings = await window.ion.studioGetSettings();
        const parsed = parseSurfacePersisted(settings?.studioSurface);
        const currentConversationId = useSessionStore.getState().activeTabId;
        // The restore side was entirely unlogged, so a tab that came back
        // missing gave no way to tell whether it failed to persist, failed to
        // parse, or was stored under a key this session never looks up.
        const stored =
          parsed && "conversations" in parsed ? parsed.conversations : {};
        const mine = stored[currentConversationId ?? ""];
        rInfo("studio.surface", "hydrating surface state", {
          conversation_id: currentConversationId ?? "none",
          parsed: parsed !== null,
          stored_conversations: Object.keys(stored).length,
          my_record: mine
            ? `${mine.tabs.length} tabs${mine.visible ? " +open" : ""}`
            : "ABSENT",
          my_tab_kinds: mine
            ? mine.tabs.map((tab: { kind: string }) => tab.kind).join(",")
            : "",
        });
        if (!parsed) {
          const empty = emptySurfacePersisted();
          set({
            ...project({
              pinnedTabs: empty.pinnedTabs,
              notification: empty.notification,
              scratchProjects: empty.scratchProjects,
              conversations: {},
              currentConversationId,
              visible: false,
            }),
            pinnedTabs: empty.pinnedTabs,
            notification: empty.notification,
            scratchProjects: empty.scratchProjects,
            currentConversationId,
            hydrated: true,
          });
          rDebug(
            "studio.surface",
            "no persisted surface, starting with default pins",
          );
          return;
        }
        if (parsed.version === 1) {
          const legacy = parsed as LegacySurfacePersisted;
          const legacyVisible =
            settings?.studioLayout &&
            typeof settings.studioLayout === "object" &&
            (settings.studioLayout as { surfaceVisible?: unknown })
              .surfaceVisible === true;
          const conversations: Record<string, SurfaceConversationPersisted> =
            currentConversationId
              ? {
                  [currentConversationId]: {
                    tabs: legacy.tabs,
                    activeTabId: legacy.activeTabId,
                    visible: legacyVisible,
                    agentBrowserInstanceId: null,
                  },
                }
              : {};
          const pinnedTabs: PinnableSingletonId[] = ["plan"];
          const local = currentConversationId
            ? conversations[currentConversationId]!
            : emptyConversation();
          for (const pin of pinnedTabs)
            local.tabs = local.tabs.filter((tab: SurfaceTab) => tab.id !== pin);
          if (currentConversationId)
            conversations[currentConversationId] = local;
          const state = {
            pinnedTabs,
            notification: null,
            scratchProjects: {},
            conversations,
            currentConversationId,
            visible: legacyVisible,
          };
          set({
            ...project(state),
            pinnedTabs,
            currentConversationId,
            hydrated: true,
          });
          rInfo(
            "studio.surface",
            "legacy surface migrated to conversation state",
            {
              tab_id: currentConversationId ?? "",
              tab_count: legacy.tabs.length,
            },
          );
          schedulePersist(get);
          return;
        }
        const conversations = Object.fromEntries(
          Object.entries(parsed.conversations).map(([id, conversation]) => [
            id,
            materializeConversation(conversation),
          ]),
        );
        const initial = {
          pinnedTabs: parsed.pinnedTabs,
          notification: parsed.notification,
          scratchProjects: parsed.scratchProjects,
          conversations,
          currentConversationId,
          visible: false,
        };
        const current = currentConversationId
          ? conversations[currentConversationId]
          : null;
        // Restoring the panel as the operator left it is correct in both
        // modes: 'preserve' is about keeping it pinned across tab switches,
        // not about discarding it across restarts.
        initial.visible = current?.visible ?? false;
        set({
          ...project(initial),
          pinnedTabs: parsed.pinnedTabs,
          notification: parsed.notification,
          scratchProjects: parsed.scratchProjects,
          currentConversationId,
          hydrated: true,
        });
        rDebug("studio.surface", "surface hydrated", {
          conversation_count: Object.keys(conversations).length,
          pinned_count: parsed.pinnedTabs.length,
          tab_id: currentConversationId ?? "",
        });
      } catch (err) {
        const currentConversationId = useSessionStore.getState().activeTabId;
        const empty = emptySurfacePersisted();
        set({
          ...project({
            pinnedTabs: empty.pinnedTabs,
            notification: empty.notification,
            scratchProjects: empty.scratchProjects,
            conversations: {},
            currentConversationId,
            visible: false,
          }),
          pinnedTabs: empty.pinnedTabs,
          notification: empty.notification,
          scratchProjects: empty.scratchProjects,
          currentConversationId,
          hydrated: true,
        });
        rWarn(
          "studio.surface",
          "surface hydrate failed, starting with default pins",
          { error: String(err) },
        );
      }
    })();
    return hydrationPromise;
  },
  };
}
