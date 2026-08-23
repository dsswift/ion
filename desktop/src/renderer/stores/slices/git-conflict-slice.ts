/**
 * Git conflict alerts — the store model behind "a sync failed and you need to
 * know".
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A conflicted sync used to fail into the log file and nowhere else: the
 * result carried `hasConflicts: true` and an operator-facing message, and the
 * UI discarded both. The operator pressed "Sync from josh", saw nothing, and
 * reasonably believed it succeeded — while the worktree sat mid-rebase with
 * its work invisible. This slice is where that signal becomes visible state.
 *
 * ── Sources ─────────────────────────────────────────────────────────────────
 * Alerts are keyed by DIRECTORY (the checkout that is conflicted), fed by:
 *   - sync/land results with `hasConflicts` (recorded by syncWorktree and the
 *     land path the moment they fail);
 *   - inventory refreshes that find a worktree with `operationState` set
 *     (covers a conflict that happened outside Ion, or before a restart).
 *
 * An alert clears when the directory's operation completes or aborts — the
 * inventory refresh notices `operationState` is gone — or when the operator
 * dismisses the toast. Dismissing hides the TOAST only; the row badge and
 * panel banner derive from live inventory state, not from this map, so the
 * truth stays visible until the conflict is actually resolved.
 *
 * ── AI Assisted ─────────────────────────────────────────────────────────────
 * `openConflictAssist` is ONE store action (ATV multi-step rule): create a
 * FRESH conversation in the conflicted directory, then submit the fixed
 * prompt. Always a new tab — commandeering an existing conversation would
 * interrupt it and let its context sway the fix. A component handler chaining
 * these calls would run in whichever window hosts it and decide against stale
 * mirror state.
 *
 * The assist prefers the Desktop-managed `workbench-sync` tier and logs a
 * fallback to `standard` when it is unconfigured. It refuses only when both
 * are absent. The fresh conversation is pinned to the resolved model and
 * forced into auto mode — a plan-mode default would park the fix writing a plan.
 */
import type {
  StoreSet,
  StoreGet,
  State,
  GitConflictAlert,
} from "../session-store-types";
import { rInfo, rDebug, rWarn } from "../../rendererLogger";
import { usePreferencesStore } from "../../preferences";
import { applyPermissionModeForTab } from "./tab-slice-permission-mode";
import { resolveWorkbenchTier } from "../resolve-workbench-tier";
import {
  findActiveAutoFix,
  getInflight,
  setInflight,
  clearInflight,
} from "./conflict-assist-dedupe";
import {
  aiAssistWorkflow,
  effectiveAiAssistTemplate,
  renderAiAssistTemplate,
  type AiAssistWorkflowId,
} from "../../../shared/ai-assist-workflows";

/**
 * The exact prompt the AI Assisted button sends, parameterized by the
 * operation actually in progress. Hardcoding "rebase" was wrong the moment the
 * bench resolve-once flow started opening the dialog on an in-progress MERGE:
 * the model was told to fix a rebase that did not exist.
 *
 * ── The bench arm ───────────────────────────────────────────────────────────
 * A conflict in an integration bench has context a conflict in a worktree does
 * not: the bench knows which members contributed the file, what each one's
 * pinned version says, and what was decided about the same file last time. Three
 * read-only engine tools answer those, and they are offered ONLY in a bench — so
 * the prompt names them only there. Naming them in a worktree rebase would point
 * the model at tools it does not have.
 *
 * This is worth stating in the prompt rather than trusting discovery, because the
 * measured failure was an agent that HAD attribution, used it once, and then
 * spent twelve shell calls reading one file out of eight sibling worktrees
 * anyway. The tool being available is not the same as it being reached for.
 *
 * The hard constraints are unchanged and stay verbatim: each was added for a
 * recorded defect (an aborted operation, a `--continue` bundled with other work,
 * a resolution left merely staged).
 */
export function conflictAssistPrompt(
  operation: "rebasing" | "merging" | "cherry-picking" | null,
  /** True when the conflicted directory is an integration bench. */
  inBench = false,
  directory = ".",
): string {
  const workflowId = conflictWorkflowId(operation);
  const result = renderAiAssistTemplate(
    workflowId,
    aiAssistWorkflow(workflowId).defaultTemplate,
    conflictTemplateValues(directory, inBench),
  );
  if (!result.ok) throw new Error(result.error);
  return result.prompt;
}

function conflictWorkflowId(
  operation: "rebasing" | "merging" | "cherry-picking" | null,
): AiAssistWorkflowId {
  if (operation === "merging") return "merge-resolution";
  if (operation === "cherry-picking") return "cherry-pick-resolution";
  return "rebase-resolution";
}

function conflictTemplateValues(
  directory: string,
  inBench: boolean,
): Record<string, string> {
  return {
    directory,
    benchContext: inBench
      ? [
          "This is an integration bench.",
          "Before reasoning about the merge, call BenchResolutionHistory for the conflicted paths: the same file often conflicts once per member, and a previous resolution of it carries the reasoning git rerere cannot replay across members.",
          "Read each side with BenchMemberFile rather than opening a member worktree directly, because a worktree holds work done since its pin and the bench merges the pin.",
          "Use WorkspaceAttribution to decide which member owns a hunk when that is unclear.",
        ].join(" ")
      : "",
  };
}

/** Back-compat name for the default (rebase) prompt. */
export const CONFLICT_ASSIST_PROMPT = conflictAssistPrompt(null);

export function createGitConflictSlice(
  set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    /**
     * Record that a directory is conflicted. Called from the sync/land failure
     * paths (source 'sync' / 'land') and from inventory refreshes that find an
     * in-progress operation (source 'detected').
     *
     * Re-recording the same directory updates the message but keeps the alert
     * un-dismissed only if it was not already dismissed — a poll must not
     * resurrect a toast the operator closed.
     */
    recordConflictAlert: (directory, alert) => {
      set((s) => {
        const existing = s.gitConflictAlerts.get(directory);
        const next: GitConflictAlert = {
          ...alert,
          // A fresh sync/land failure is new information and re-raises the
          // toast; a periodic 'detected' record keeps a prior dismissal.
          dismissed:
            alert.source === "detected"
              ? (existing?.dismissed ?? false)
              : false,
          recordedAt: Date.now(),
        };
        rInfo("git.conflicts", "conflict alert recorded", {
          directory,
          source: alert.source,
          operation: alert.operationState ?? "",
          re_raised: !next.dismissed,
        });
        return {
          gitConflictAlerts: new Map(s.gitConflictAlerts).set(directory, next),
        };
      });
    },

    /** Drop a directory's alert entirely — its operation completed or aborted. */
    clearConflictAlert: (directory) => {
      set((s) => {
        if (!s.gitConflictAlerts.has(directory)) return {};
        rDebug("git.conflicts", "conflict alert cleared", { directory });
        const next = new Map(s.gitConflictAlerts);
        next.delete(directory);
        return { gitConflictAlerts: next };
      });
    },

    /** Hide the toast for a directory. The row badge stays until resolved. */
    dismissConflictAlert: (directory) => {
      set((s) => {
        const existing = s.gitConflictAlerts.get(directory);
        if (!existing || existing.dismissed) return {};
        rDebug("git.conflicts", "conflict toast dismissed", { directory });
        return {
          gitConflictAlerts: new Map(s.gitConflictAlerts).set(directory, {
            ...existing,
            dismissed: true,
          }),
        };
      });
    },

    /**
     * AI Assisted resolution: a FRESH conversation in the conflicted
     * directory with the fixed prompt.
     *
     * Always a new tab, never a focused existing one. The first version
     * focused an existing conversation in the directory (the bench-conversation
     * re-entry pattern), which was wrong twice over: submitting into a live
     * development conversation interrupts it mid-thread, and the accumulated
     * context can sway how the model resolves the rebase. The fix needs a
     * clean context whose entire instruction is the one prompt. The operator's
     * development conversation stays untouched.
     */
    openConflictAssist: async (directory) => {
      const existing = findActiveAutoFix(get().tabs, directory);
      if (existing) {
        rInfo("git.conflicts", "assist: reusing existing auto-fix tab", {
          directory,
          tab_id: existing.slice(0, 8),
        });
        get().selectTab(existing);
        return existing;
      }

      const pending = getInflight(directory);
      if (pending) {
        rDebug(
          "git.conflicts",
          "assist: awaiting in-flight creation for directory",
          {
            directory,
          },
        );
        return pending;
      }

      const creation = (async () => {
        try {
          return await openConflictAssistInner(directory, set, get);
        } finally {
          clearInflight(directory);
        }
      })();
      setInflight(directory, creation);
      return creation;
    },
  };
}

async function openConflictAssistInner(
  directory: string,
  set: StoreSet,
  get: StoreGet,
): Promise<string> {
  const tier = await resolveWorkbenchTier({
    workflow: "conflict-resolution",
    directory,
  });
  if (!tier.ok) throw new Error(tier.error);

  rInfo(
    "git.conflicts",
    "assist: opening fresh conversation in conflicted directory",
    {
      directory,
      tier: tier.tier,
      model: tier.model,
    },
  );

  // Name the operation actually in progress — a bench resolve-once leaves
  // a MERGE, a conflicted sync leaves a rebase — so the model is not told
  // to fix an operation that does not exist. Probe failure falls back to
  // the rebase wording rather than blocking the assist.
  let operation: "rebasing" | "merging" | "cherry-picking" | null = null;
  try {
    const op = await window.ion.gitOpState(directory);
    if (op.ok) operation = op.state ?? null;
  } catch (err) {
    rWarn(
      "git.conflicts",
      "assist could not probe operation state, defaulting to rebase wording",
      {
        directory,
        error: String(err),
      },
    );
  }

  const inBench = [...get().benchWorkspaces.values()].some((list) =>
    list.some((workspace) => workspace.benchPath === directory),
  );
  const workflowId = conflictWorkflowId(operation);
  const { template, overridden } = effectiveAiAssistTemplate(
    workflowId,
    usePreferencesStore.getState().aiAssistPromptOverrides,
  );
  const rendered = renderAiAssistTemplate(
    workflowId,
    template,
    conflictTemplateValues(directory, inBench),
  );
  if (!rendered.ok) {
    rWarn("git.conflicts", "assist prompt validation failed", {
      directory,
      workflow: workflowId,
      overridden,
      error: rendered.error,
    });
    throw new Error(
      `AI-assisted workflow prompt is invalid: ${rendered.error}`,
    );
  }
  rInfo("git.conflicts", "assist prompt rendered", {
    directory,
    workflow: workflowId,
    overridden,
  });

  // useWorktree=false: the directory IS the checkout to fix; a nested
  // worktree would point the conversation somewhere else entirely.
  // skipDuplicateCheck=true: a blank tab reuse is fine, but an existing
  // NON-blank conversation must never be commandeered — and the duplicate
  // check's blank-reuse path is only safe because a blank tab has no
  // context to sway the fix. Skipping keeps the guarantee unconditional.
  const tabId = await get().createTabInDirectory(directory, false, true);

  // Select the workflow tier on the fresh conversation. Automatic model
  // selection yields to slash-command frontmatter on any later command.
  get().setTabAutomaticModel(tabId, tier.model);

  // Force auto mode regardless of the operator's default. The assist's
  // whole job is to EXECUTE the fix; a plan-mode default would park it
  // writing a plan for work that was already requested verbatim.
  applyPermissionModeForTab(set, get, tabId, "auto", "conflict_assist");

  // Tag role + lock BEFORE the machine prompt goes in: the auto-fix
  // lifecycle (event-slice-auto-fix-lifecycle.ts) keys its close/retain
  // decision on `tabRole === 'conflict-auto-fix'`, and a fast completion
  // could otherwise race ahead of the tagging and be missed. The lock is
  // part of the same atomic set: this tab's entire instruction set is the
  // one prompt below. A follow-up message would graft an open-ended
  // conversation onto a checkout that exists to be fixed — often an
  // integration bench, where development conversations do not belong (the
  // work belongs in the member worktree that owns the file). The
  // conversation stays readable and abortable; submit() and the InputBar
  // both honor the flag, and role + lock persist across restarts.
  set((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            tabRole: "conflict-auto-fix" as const,
            inputLocked: true,
            inputLockReason: "automated-workflow" as const,
          }
        : t,
    ),
  }));

  const prompt = rendered.prompt;
  // 'machine' source: the one submission allowed through the lock this
  // flow just installed (see send-slice submit guard).
  get().submit(tabId, prompt, { source: "machine" });

  rInfo("git.conflicts", "assist prompt submitted", {
    directory,
    tab_id: tabId.slice(0, 8),
    model: tier.model,
    operation: operation ?? "unknown",
    in_bench: inBench,
    input_locked: true,
  });
  return tabId;
}
