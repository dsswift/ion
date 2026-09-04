import type { SurfaceConversationPersisted } from "../../../shared/studio-surface-types";
import { rDebug, rInfo, rWarn } from "../../rendererLogger";
import { useSessionStore } from "../../stores/sessionStore";
import { usePreferencesStore } from "../../preferences";
import type { SurfaceState } from "./surface-store";
import { openFileTabIn } from "./surface-file-tabs";
import { panelEmptiedByClose } from "./surface-store-project";
import {
  createScratchDocument,
  removeScratchDocument,
  scratchProjectKey,
  updateScratchDocument,
} from "./surface-scratch";

type ScratchActions = Pick<
  SurfaceState,
  | "createScratch"
  | "updateScratch"
  | "toggleScratchPreview"
  | "toggleScratchWordWrap"
  | "setScratchSaveError"
  | "deleteScratch"
  | "requestScratchClose"
  | "cancelScratchClose"
  | "confirmScratchClose"
  | "promoteScratch"
>;

type SetSurface = (partial: Partial<SurfaceState>) => void;
type GetSurface = () => SurfaceState;

type Dependencies = {
  set: SetSurface;
  get: GetSurface;
  project(state: SurfaceState): Partial<SurfaceState>;
  schedulePersist(get: GetSurface): void;
  emptyConversation(): SurfaceConversationPersisted;
};

function currentContext(
  state: SurfaceState,
): { conversationId: string; projectKey: string } | null {
  const session = useSessionStore.getState();
  const conversationId = state.currentConversationId ?? session.activeTabId;
  const tab = session.tabs.find((item) => item.id === conversationId);
  const projectKey = scratchProjectKey(tab);
  return conversationId && projectKey ? { conversationId, projectKey } : null;
}

function existingEditorNames(): string[] {
  return [...useSessionStore.getState().fileEditorStates.values()].flatMap(
    (state) => state.files.map((file) => file.fileName),
  );
}

export function createScratchSurfaceActions(
  deps: Dependencies,
): ScratchActions {
  const commitProjects = (
    scratchProjects: SurfaceState["scratchProjects"],
  ): void => {
    const state = deps.get();
    deps.set({
      ...deps.project({ ...state, scratchProjects }),
      scratchProjects,
    });
    deps.schedulePersist(deps.get);
  };

  return {
    createScratch: () => {
      const state = deps.get();
      const context = currentContext(state);
      if (!context) {
        rWarn(
          "studio.scratch",
          "scratch create refused: active project unavailable",
        );
        return;
      }
      const scratchNames = Object.values(state.scratchProjects).flatMap(
        (project) => project.documents.map((document) => document.fileName),
      );
      const { projects, document } = createScratchDocument(
        state.scratchProjects,
        context.projectKey,
        [...existingEditorNames(), ...scratchNames],
        crypto.randomUUID(),
      );
      const current =
        state.conversations[context.conversationId] ?? deps.emptyConversation();
      const conversations = {
        ...state.conversations,
        [context.conversationId]: {
          ...current,
          activeTabId: `scratch:${document.id}`,
          visible: true,
        },
      };
      const next = {
        ...state,
        scratchProjects: projects,
        conversations,
        currentConversationId: context.conversationId,
        visible: true,
      };
      deps.set({
        ...deps.project(next),
        scratchProjects: projects,
        conversations,
        currentConversationId: context.conversationId,
        visible: true,
      });
      deps.schedulePersist(deps.get);
      rInfo("studio.scratch", "scratch document created", {
        project_key: context.projectKey,
        document_id: document.id,
        file_name: document.fileName,
      });
    },

    updateScratch: (projectKey, documentId, content) => {
      const projects = updateScratchDocument(
        deps.get().scratchProjects,
        projectKey,
        documentId,
        (document) => ({ ...document, content, saveError: undefined }),
      );
      if (projects) commitProjects(projects);
    },

    toggleScratchPreview: (projectKey, documentId) => {
      const projects = updateScratchDocument(
        deps.get().scratchProjects,
        projectKey,
        documentId,
        (document) => ({ ...document, isPreview: !document.isPreview }),
      );
      if (projects) commitProjects(projects);
    },

    toggleScratchWordWrap: (projectKey, documentId) => {
      const defaultWrap = usePreferencesStore.getState().editorWordWrap;
      const projects = updateScratchDocument(
        deps.get().scratchProjects,
        projectKey,
        documentId,
        (document) => ({
          ...document,
          wordWrap: !(document.wordWrap ?? defaultWrap),
        }),
      );
      if (projects) commitProjects(projects);
    },

    setScratchSaveError: (projectKey, documentId, saveError) => {
      const projects = updateScratchDocument(
        deps.get().scratchProjects,
        projectKey,
        documentId,
        (document) => ({ ...document, saveError }),
      );
      if (projects) commitProjects(projects);
    },

    deleteScratch: (projectKey, documentId) => {
      const projects = removeScratchDocument(
        deps.get().scratchProjects,
        projectKey,
        documentId,
      );
      if (!projects) return;
      commitProjects(projects);
      deps.set({ pendingScratchCloseId: null });
      rInfo("studio.scratch", "scratch document discarded", {
        project_key: projectKey,
        document_id: documentId,
      });
      const state = deps.get();
      if (panelEmptiedByClose(state.tabs, state.visible))
        state.setVisible(false);
    },

    requestScratchClose: (projectKey, documentId) => {
      const document = deps
        .get()
        .scratchProjects[projectKey]?.documents.find(
          (item) => item.id === documentId,
        );
      if (!document) return;
      if (document.content === document.savedContent) {
        deps.get().deleteScratch(projectKey, documentId);
        return;
      }
      deps.set({ pendingScratchCloseId: documentId });
      rDebug("studio.scratch", "scratch discard confirmation requested", {
        project_key: projectKey,
        document_id: documentId,
      });
    },

    cancelScratchClose: () => deps.set({ pendingScratchCloseId: null }),

    confirmScratchClose: () => {
      const state = deps.get();
      const documentId = state.pendingScratchCloseId;
      if (!documentId) return;
      for (const [projectKey, project] of Object.entries(
        state.scratchProjects,
      )) {
        if (project.documents.some((document) => document.id === documentId)) {
          state.deleteScratch(projectKey, documentId);
          return;
        }
      }
      deps.set({ pendingScratchCloseId: null });
    },

    promoteScratch: (projectKey, documentId, filePath, conversationId) => {
      const state = deps.get();
      const projects = removeScratchDocument(
        state.scratchProjects,
        projectKey,
        documentId,
      );
      const session = useSessionStore.getState();
      const targetTab = session.tabs.find((tab) => tab.id === conversationId);
      if (
        !projects ||
        !targetTab ||
        scratchProjectKey(targetTab) !== projectKey
      ) {
        rWarn(
          "studio.scratch",
          "scratch promotion refused: document or conversation unavailable",
          {
            project_key: projectKey,
            document_id: documentId,
            tab_id: conversationId,
          },
        );
        return;
      }
      session.openFileInEditor(projectKey, conversationId, filePath);
      const current =
        state.conversations[conversationId] ?? deps.emptyConversation();
      const conversations = {
        ...state.conversations,
        [conversationId]: openFileTabIn(
          current,
          filePath,
          projectKey,
          conversationId,
        ),
      };
      const next = { ...state, scratchProjects: projects, conversations };
      deps.set({
        ...deps.project(next),
        scratchProjects: projects,
        conversations,
      });
      deps.schedulePersist(deps.get);
      rInfo("studio.scratch", "scratch document promoted to saved file", {
        project_key: projectKey,
        document_id: documentId,
        file_path: filePath,
        tab_id: conversationId,
      });
    },
  };
}
