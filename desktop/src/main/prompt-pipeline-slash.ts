/**
 * prompt-pipeline-slash.ts — the slash branch of the unified prompt pipeline.
 *
 * Extracted from prompt-pipeline.ts to keep that orchestrator under the 600-line
 * cap, following the same one-way-seam pattern already used for
 * prompt-pipeline-renderer.ts and prompt-pipeline-prose.ts. This file owns:
 *
 *   - handleSlash — sends one command invocation to the engine. The engine owns
 *     the complete precedence chain: registered extension command, built-in,
 *     markdown command or skill, then unknown-command failure.
 *
 * The two module-local functions handleSlash needs from the orchestrator
 * (engineKey, submitAsPrompt) are injected via SlashDeps so the seam stays
 * one-way (orchestrator → this file → engine bridge / renderer helpers) and this
 * file does not import back into prompt-pipeline.ts.
 */

import { log as _log } from "./logger";
import { sessionPlane, engineBridge } from "./state";
import { type ParsedSlash } from "./slash-parse";
import { dispatchExtensionCommand } from "./slash-classify";
import { handleLocalClearShortCircuit } from "./slash-clear";
import {
  emitRemoteMessageAdded,
  insertRendererSystemMessage,
  clearConnectingStatus,
  insertRendererRemoteUserMessage,
} from "./prompt-pipeline-renderer";
// Type-only import: the IncomingPrompt shape lives with the orchestrator. A
// type import creates no runtime dependency, so the runtime seam stays one-way
// (orchestrator → this file → engine bridge / renderer helpers).
import type { IncomingPrompt } from "./prompt-pipeline";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

/** Orchestrator-supplied helpers the slash branch needs. Injected to keep the
 *  seam one-way (this file never imports prompt-pipeline.ts). */
export interface SlashDeps {
  engineKey: (p: IncomingPrompt) => string;
}

/**
 * Handle `/plugin install <source>`, `/plugin list`, `/plugin remove <name>`.
 * These are engine wire commands dispatched directly — not extension slash commands.
 * Results are surfaced as system messages in the renderer.
 */
async function handlePluginSlash(
  p: IncomingPrompt,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] || "";
  log("pipeline_slash: plugin command", { sub, args });

  if (sub === "install") {
    const source = parts[1] || "";
    if (!source) {
      await insertRendererSystemMessage(
        p,
        "Usage: /plugin install <owner/repo>",
      );
      return;
    }
    await insertRendererSystemMessage(p, `Installing plugin ${source}...`);
    try {
      const result = await engineBridge.request("plugin_install", { source });
      if (result?.ok) {
        const d = result.data as
          { name?: string; version?: string } | undefined;
        await insertRendererSystemMessage(
          p,
          `Installed plugin: ${d?.name ?? source} (${d?.version ?? ""})`,
        );
      } else {
        await insertRendererSystemMessage(
          p,
          `Plugin install failed: ${result?.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      await insertRendererSystemMessage(
        p,
        `Plugin install error: ${(err as Error).message}`,
      );
    }
    return;
  }

  if (sub === "list") {
    try {
      const result = await engineBridge.request("plugin_list", {});
      if (result?.ok) {
        const plugins = (result.data ?? []) as Array<{
          name: string;
          source: string;
          version: string;
        }>;
        if (plugins.length === 0) {
          await insertRendererSystemMessage(p, "No plugins installed.");
        } else {
          const lines = plugins
            .map((pl) => `  ${pl.name}  (${pl.source}@${pl.version})`)
            .join("\n");
          await insertRendererSystemMessage(p, `Installed plugins:\n${lines}`);
        }
      } else {
        await insertRendererSystemMessage(
          p,
          `Plugin list failed: ${result?.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      await insertRendererSystemMessage(
        p,
        `Plugin list error: ${(err as Error).message}`,
      );
    }
    return;
  }

  if (sub === "remove") {
    const name = parts[1] || "";
    if (!name) {
      await insertRendererSystemMessage(p, "Usage: /plugin remove <name>");
      return;
    }
    try {
      const result = await engineBridge.request("plugin_remove", {
        label: name,
      });
      if (result?.ok) {
        await insertRendererSystemMessage(p, `Removed plugin: ${name}`);
      } else {
        await insertRendererSystemMessage(
          p,
          `Plugin remove failed: ${result?.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      await insertRendererSystemMessage(
        p,
        `Plugin remove error: ${(err as Error).message}`,
      );
    }
    return;
  }

  await insertRendererSystemMessage(
    p,
    "Usage: /plugin install <owner/repo> | /plugin list | /plugin remove <name>",
  );
}

export async function handleSlash(
  p: IncomingPrompt,
  slash: ParsedSlash,
  deps: SlashDeps,
): Promise<void> {
  // Echo the raw slash text to iOS so the optimistic timestamp is corrected.
  if (p.source === "remote") {
    emitRemoteMessageAdded(p, p.text, "user");
  }

  // ── Plugin management short-circuit ─────────────────────────────────────
  // `/plugin install <owner/repo>`, `/plugin list`, `/plugin remove <name>`
  // are engine wire commands, not extension slash commands. Intercept them
  // here and dispatch through the plugin IPC handlers directly so they work
  // without a session and return results as system messages.
  if (slash.command === "plugin") {
    await handlePluginSlash(p, slash.args ?? "");
    await clearConnectingStatus(p);
    return;
  }

  const tabStatus = sessionPlane.getTabStatus(p.tabId)
  const workingDirectory = p.runOptions?.projectPath ?? p.projectPath ?? process.cwd()
  const ensureResult = await sessionPlane.ensureSession(p.tabId, {
    workingDirectory,
    conversationId: p.runOptions?.sessionId,
    permissionMode: tabStatus?.permissionMode,
    extensions: p.runOptions?.extensions,
    model: p.runOptions?.model,
    maxTokens: p.runOptions?.maxTokens,
    thinking: p.runOptions?.thinking,
  })
  if (!ensureResult.ok) {
    const message = ensureResult.error ?? `Could not start the session for /${slash.command}`
    log("pipeline_slash: session start failed", { tab_id: p.tabId, command: slash.command, error: message })
    await insertRendererSystemMessage(p, message)
    if (p.source === "remote") emitRemoteMessageAdded(p, message, "system")
    await clearConnectingStatus(p)
    return
  }

  const temporaryAutoFromPlan =
    slash.command !== "clear" && tabStatus?.permissionMode === "plan";
  p.temporaryAutoFromPlan = temporaryAutoFromPlan;
  const promptArgs = {
    key: deps.engineKey(p),
    text: p.text,
    model: p.runOptions?.model ?? p.model,
    appendSystemPrompt: p.runOptions?.appendSystemPrompt ?? p.appendSystemPrompt,
    imageAttachments: p.runOptions?.imageAttachments ?? p.imageAttachments,
    implementationPhase: p.implementationPhase,
    thinkingEffort: p.runOptions?.thinkingEffort ?? p.thinkingEffort,
    enterPlanModeDescription: p.runOptions?.enterPlanModeDescription,
    planModeSparseReminder: p.runOptions?.planModeSparseReminder,
    planFilePath: p.runOptions?.planFilePath ?? p.planFilePath,
    bashAllowlistAdditionsForThisPrompt: p.bashAllowlistAdditionsForThisPrompt,
    temporaryAutoFromPlan,
    injectionKind: p.injectionKind,
    clientWorkspaceContext: p.runOptions?.clientWorkspaceContext ?? p.clientWorkspaceContext,
    deliveryId: p.runOptions?.deliveryId ?? p.reqId,
  }
  const result = await dispatchExtensionCommand(slash, promptArgs);
  if (result.commandError === "") {
    // The engine resolved the command through its single precedence chain. It may
    // start a run; `/clear` remains a checkpoint and never creates a user row.
    if (slash.command !== "clear") {
      // For remote-originated prompts, insert the user message into the desktop
      // renderer store. The renderer's submit() was never called for this prompt
      // (the pipeline handled it directly), so the store has no user bubble.
      // Without this, the desktop shows assistant text with no preceding user
      // turn, and iOS history reads (which pull from the renderer store) also
      // miss it. The iOS device already has the message from the
      // desktop_message_added echo in tabs-prompt.ts; this insert is for the
      // desktop renderer only. /clear is excluded: it is a checkpoint that
      // renders as a divider, not a user turn.
      if (p.source === "remote") {
        const rawInvocation =
          "/" + slash.command + (slash.args ? " " + slash.args : "");
        void insertRendererRemoteUserMessage(
          p,
          rawInvocation,
          "/" + slash.command,
          slash.args,
        );
      }
    }

    // Clear the optimistic 'connecting' state because no run will follow for a
    // pure command. (Extensions that DO start a run will set status='running'
    // via run_start before this clear executes, and the clear is a no-op when
    // status isn't 'connecting'.)
    log("pipeline_slash: ext cmd success", {
      key: deps.engineKey(p),
      command: slash.command,
    });
    await clearConnectingStatus(p);
    return;
  }

  if (result.commandError === "unknown_command") {
    if (slash.command === "clear") {
      await handleLocalClearShortCircuit(p, deps.engineKey(p));
      return;
    }
    const msg = `Unknown command: /${slash.command}`;
    await insertRendererSystemMessage(p, msg);
    if (p.source === "remote") emitRemoteMessageAdded(p, msg, "system");
    await clearConnectingStatus(p);
    return;
  }

  // Extension error, timeout, or other failure shape.
  log("pipeline_slash: ext cmd failed", {
    key: deps.engineKey(p),
    command: slash.command,
    error: result.commandError,
  });
  const errMsg =
    result.message ||
    `Command failed: /${slash.command}: ${result.commandError}`;
  await insertRendererSystemMessage(p, errMsg);
  if (p.source === "remote") emitRemoteMessageAdded(p, errMsg, "system");
  await clearConnectingStatus(p);
}
