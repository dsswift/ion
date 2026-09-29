import { existsSync, readFileSync } from "fs";
import { log as _log, debug as _debug } from "../../logger";
import { sessionPlane } from "../../state";
import { useSessionStore } from "../../store/sessionStore";
import { usePreferencesStore } from "../../persistence/preferences";
import { commitInstance, activeInstance } from "../../store/conversation-instance";
import { processIncomingPrompt } from "../../engine/prompt-pipeline";
import { echoUserTurn } from "../../user-turn-echo";
import { handleSetPermissionMode } from "./tabs";
import { planSlugFromPath } from "@ion/shared/clear-divider";
import { getAutomationRuntime } from "@ion/server/automation/runtime";
import type { RemoteCommand } from "../protocol";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug("main", msg, fields);
}

/**
 * Handles implement_plan from iOS.
 *
 * iOS sends this command instead of building a prompt string. The server
 * runs the same implement pipeline that the store's implementPlan
 * (implement-slice.ts) runs — no plan body crosses the wire.
 *
 * Pipeline steps (mirrors implementPlan exactly):
 *   1. Resolve planFilePath from the session store (instance.planFilePath
 *      or permissionDenied.tools[ExitPlanMode].toolInput.planFilePath).
 *   2. Read plan content from disk.
 *   3. setPermissionMode → auto (flips the engine's plan mode off).
 *   4. Store mutations: model switch (planModelSplitEnabled), group
 *      auto-move, insert implement divider, clear plan state. Run as direct
 *      store calls — the store lives in this same process.
 *   5. If clearContext: resetTabSession + archive conversationId.
 *   6. Send the implement prompt through processIncomingPrompt with
 *      implementationPhase=true and the plan file as an attachment.
 *
 * NON-NEGOTIABLE: processIncomingPrompt IS the single implement seam. No
 * second copy of the pipeline. The store's implementPlan action also reaches
 * the engine via `submit` → sessionPlane.submitPrompt; this handler reaches
 * the engine through the
 * same processIncomingPrompt path that handlePrompt uses (main-process
 * pipeline, no renderer round-trip for the send step).
 */
export async function handleImplementPlan(
  cmd: Extract<RemoteCommand, { type: "desktop_implement_plan" }>,
): Promise<void> {
  const { tabId, questionId, instanceId, clearContext = false } = cmd;
  log("handle_implement_plan", {
    tab_id: tabId.slice(0, 8),
    question_id: questionId.slice(0, 12),
    clear_context: clearContext,
  });

  // Step 1: Resolve planFilePath — same two-source lookup as implementPlan.
  let planFilePath: string | null = null;
  {
    const inst = activeInstance(useSessionStore.getState().conversationPanes, tabId);
    if (!inst) {
      log("handle_implement_plan: plan file lookup rejected", {
        error: "conversation instance unavailable",
      });
    } else if (inst.planFilePath) {
      planFilePath = inst.planFilePath;
    } else {
      const denial = inst.permissionDenied?.tools.find(
        (t) => t.toolName === "ExitPlanMode" && t.toolInput?.planFilePath,
      );
      if (denial) planFilePath = denial.toolInput!.planFilePath as string;
    }
  }
  log("handle_implement_plan: plan file path", { path: planFilePath ?? "" });

  // Step 2: Read plan content from disk (mirrors implementPlan).
  let planContent: string | null = null;
  if (planFilePath && existsSync(planFilePath)) {
    try {
      planContent = readFileSync(planFilePath, "utf-8");
    } catch (err) {
      log("handle_implement_plan: plan read failed", {
        error: (err as Error).message,
      });
    }
  }

  // Step 3: Set permission mode → auto (same as implementPlan).
  await handleSetPermissionMode({ tabId, mode: "auto" });

  // Step 4: Model switch + group auto-move (mirrors implementPlan). Prefs-driven.
  try {
    const s = useSessionStore.getState();
    const p = usePreferencesStore.getState();
    if (p.planModelSplitEnabled && p.implementModeModel) {
      s.setTabAutomaticModel(tabId, p.implementModeModel);
    }
  } catch (err) {
    log("handle_implement_plan: model step failed", {
      error: (err as Error).message,
    });
  }

  // Approval resolves the plan question, so release the engine's retention of
  // the ExitPlanMode denial. Parity with the renderer's implementPlan: without
  // this, a heartbeat during the reset/submit window re-offers the card iOS
  // just approved. Runs before the reset so the notify reaches the session
  // that still holds the retention.
  sessionPlane.resolvePermissionDenials(tabId);

  // Step 5: clearContext branch — reset engine session before implementing.
  // Matches the implementPlan clearContext branch. The main-process resetTabSession call
  // must happen before the renderer state mutation so the engine session is
  // already gone when the store clears conversationId.
  if (clearContext) {
    sessionPlane.resetTabSession(tabId);
  }

  // Step 6: Store mutations — insert divider, clear plan state.
  // Mirrors implementPlan. Both clearContext branches handled here.
  try {
    // Carry the resolved plan path + slug onto the divider so the renderer
    // (and the snapshot projection that mirrors it to iOS) renders the slug as
    // a clickable link to the plan preview — same treatment as the desktop
    // onImplement path and the plan-created / plan-updated dividers.
    const planSlug = planSlugFromPath(planFilePath);
    const divider =
      `── Implementing plan at ${new Date().toLocaleTimeString()}` +
      (planSlug ? ` · ${planSlug}` : "") +
      ` ──`;

    const s0 = useSessionStore.getState();
    if (!s0.conversationPanes.get(tabId)) {
      log("handle_implement_plan: state mutation rejected", {
        reason: "conversation pane unavailable",
      });
    } else {
      const conversationPanes = commitInstance(
        s0.conversationPanes,
        tabId,
        (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            {
              id: `impl-remote-${Date.now()}`,
              role: "system" as const,
              content: divider,
              timestamp: Date.now(),
              ...(planFilePath ? { planFilePath } : {}),
            },
          ],
          planFilePath: null,
          permissionQueue: [],
          permissionDenied: null,
        }),
      );
      if (clearContext) {
        const tab = s0.tabs.find((t) => t.id === tabId);
        const convId = tab?.conversationId;
        const hist = tab?.historicalSessionIds ?? [];
        const newHist =
          convId && !hist.includes(convId) ? [...hist, convId] : hist;
        useSessionStore.setState({
          conversationPanes,
          tabs: s0.tabs.map((t) =>
            t.id !== tabId
              ? t
              : {
                  ...t,
                  historicalSessionIds: newHist,
                  conversationId: null,
                  lastResult: null,
                  currentActivity: "",
                  queuedPrompts: [],
                },
          ),
        });
      } else {
        useSessionStore.setState({
          conversationPanes,
          tabs: s0.tabs.map((t) =>
            t.id !== tabId
              ? t
              : { ...t, lastResult: null, currentActivity: "", queuedPrompts: [] },
          ),
        });
      }
    }
  } catch (err) {
    log("handle_implement_plan: state mutation failed", {
      error: (err as Error).message,
    });
  }

  // Step 7: Determine tab type for processIncomingPrompt routing.
  let hasExtensions = false;
  let resolvedInstanceId: string | null = instanceId || null;
  let worktree: {
    worktreePath?: string;
    repoPath?: string;
    branchName?: string;
    sourceBranch?: string;
  } | null = null;
  try {
    const s = useSessionStore.getState();
    const tab = s.tabs.find((t) => t.id === tabId);
    if (tab) {
      const pane = s.conversationPanes.get(tabId);
      hasExtensions = !!tab.engineProfileId;
      if (!resolvedInstanceId) resolvedInstanceId = pane?.activeInstanceId || null;
      worktree = tab.worktree || null;
    }
  } catch (err) {
    // Probe failure degrades to defaults (no extensions, caller-supplied
    // instanceId); log so the degraded routing is diagnosable.
    debug("implement_plan: tab-info probe failed", {
      tab_id: tabId,
      error: String(err),
    });
  }

  // Step 8: Build prompt + attachment — same as implementPlan.
  // The plan body is resolved desktop-side; no plan text was in the command.
  const implementPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : "Implement the plan.";

  const reqId = `remote-impl-${Date.now()}`;

  await getAutomationRuntime().triggerPlanImplemented(tabId, {
    worktreePath: worktree?.worktreePath ?? "",
    repoPath: worktree?.repoPath ?? "",
    branchName: worktree?.branchName ?? "",
    sourceBranch: worktree?.sourceBranch ?? "",
    planFilePath: planFilePath ?? "",
    clearContext,
    source: "remote",
  });
  log("handle_implement_plan: automation trigger delivered", {
    tab_id: tabId.slice(0, 8),
    plan_file_path: planFilePath ?? "",
  });

  // Echo the user message to the Studio mirror so it shows the intent.
  // Through the funnel: one classification rule for every user-turn echo.
  echoUserTurn({
    tabId,
    id: reqId,
    content: implementPrompt,
    implementationPhase: true,
  });

  // Send through the unified pipeline — same path as handlePrompt → processIncomingPrompt.
  // implementationPhase=true suppresses EnterPlanMode injection on the engine side.
  // planFilePath is the separate IncomingPrompt field (not in attachments) that the
  // engine bridge uses to restore plan-file state after a desktop restart.
  void processIncomingPrompt({
    tabId,
    text: implementPrompt,
    reqId,
    source: "remote",
    hasExtensions,
    instanceId: resolvedInstanceId || undefined,
    implementationPhase: true,
    planFilePath: planFilePath || undefined,
  }).catch((err: unknown) => {
    log("handle_implement_plan: pipeline error", {
      error: (err as Error).message,
    });
  });
}
