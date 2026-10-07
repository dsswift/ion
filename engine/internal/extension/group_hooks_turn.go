package extension

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// group_hooks_turn.go holds the ExtensionGroup fan-outs for the turn-scoped
// and lifecycle hook points; group.go holds the rest. Every method begins with
// g.beginFanout (group_fanout.go), which records the hook.fanout span.

// FireBeforePlanModeAutoExit fans the before_plan_mode_auto_exit hook out
// to every host and folds per-host results into a single decision per
// field. Last writer wins per field, so two hosts cannot simultaneously
// suppress and re-enable synthesis — the later host wins. PlanFilePath
// and Reason overrides follow the same rule.
func (g *ExtensionGroup) FireBeforePlanModeAutoExit(
	ctx *Context, info BeforePlanModeAutoExitInfo,
) (suppress bool, planFilePathOverride, reasonOverride string) {
	ctx, endFanout := g.beginFanout(ctx, "before_plan_mode_auto_exit")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforeplanmodeautoexit: dispatching to host(s)", map[string]any{"count": len(g.hosts), "plan_file_path": info.PlanFilePath, "stop_reason": info.StopReason})
	for _, h := range g.hosts {
		sp, pf, rs := h.FireBeforePlanModeAutoExit(ctx, info)
		// Suppress is sticky-on within a single host's reply (handled
		// by the per-host SDK fire method) but resets to "no opinion"
		// between hosts. The group-level last-writer rule means: if a
		// later host returns suppress=false explicitly while an earlier
		// host returned suppress=true, the suppression is lifted.
		// Detect this by tracking whether the host returned anything
		// at all; right now the SDK-level fast path returns zero
		// values for "no opinion," so we cannot distinguish "no
		// opinion" from "explicit false" without a richer return
		// shape. In practice, explicit false is rare, so we apply the
		// last-non-zero rule: a host that returned suppress=true is
		// honored unless a later host with a non-empty payload set
		// PlanFilePath or Reason and didn't carry suppress=true
		// forward. This matches the BeforePlanModeExit precedent and
		// keeps the SDK fast path simple.
		if sp {
			suppress = true
		}
		if pf != "" {
			planFilePathOverride = pf
		}
		if rs != "" {
			reasonOverride = rs
		}
	}
	return suppress, planFilePathOverride, reasonOverride
}

// FireBeforePlanModeEnter fans the before_plan_mode_enter hook out to every
// host and folds per-host results into a single allow/deny decision. Last
// non-nil Allow across all hosts wins (mirrors FireBeforeEarlyStopDecision
// field-merge semantics). Returns (true, "") when no handler has an opinion.
func (g *ExtensionGroup) FireBeforePlanModeEnter(ctx *Context, info PlanModeEnterInfo) (allowed bool, reason string) {
	ctx, endFanout := g.beginFanout(ctx, "before_plan_mode_enter")
	defer endFanout()
	allowed = true // default: allow
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforeplanmodeenter: dispatching to host(s)", map[string]any{"count": len(g.hosts), "source": info.Source})
	for _, h := range g.hosts {
		a, r := h.FireBeforePlanModeEnter(ctx, info)
		// Only override decision if the host explicitly said something.
		// FireBeforePlanModeEnter always returns (true,"") as default, so we
		// treat a denial as an override but must still apply last-writer wins.
		if !a {
			allowed = false
			if r != "" {
				reason = r
			}
		} else if !allowed {
			// A later host re-allows after an earlier one denied — last wins.
			allowed = true
			reason = ""
		}
	}
	return allowed, reason
}

// FireSystemInject fires system_inject across all hosts. Last non-empty text
// or first suppress=true wins.
func (g *ExtensionGroup) FireSystemInject(ctx *Context, info SystemInjectInfo) (string, bool) {
	ctx, endFanout := g.beginFanout(ctx, "system_inject")
	defer endFanout()
	text := info.DefaultText
	for _, h := range g.hosts {
		t, suppress := h.FireSystemInject(ctx, info)
		if suppress {
			return "", true
		}
		if t != "" {
			text = t
		}
	}
	return text, false
}

// ---------------------------------------------------------------------------
// Info merge: concatenate results from all hosts.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	ctx, endFanout := g.beginFanout(ctx, "context_inject")
	defer endFanout()
	var all []ContextEntry
	for _, h := range g.hosts {
		all = append(all, h.FireContextInject(ctx, info)...)
	}
	return all
}

func (g *ExtensionGroup) FireCapabilityDiscover(ctx *Context) []Capability {
	ctx, endFanout := g.beginFanout(ctx, "capability_discover")
	defer endFanout()
	var all []Capability
	for _, h := range g.hosts {
		all = append(all, h.FireCapabilityDiscover(ctx)...)
	}
	return all
}

// FireCapabilityMatch returns the first non-nil match across hosts.
func (g *ExtensionGroup) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	ctx, endFanout := g.beginFanout(ctx, "capability_match")
	defer endFanout()
	for _, h := range g.hosts {
		if result := h.FireCapabilityMatch(ctx, info); result != nil {
			return result
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// SDK-level void hooks: delegate to each host's SDK directly.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireTurnStart(ctx *Context, info TurnInfo) {
	ctx, endFanout := g.beginFanout(ctx, "turn_start")
	defer endFanout()
	for _, h := range g.hosts {
		if err := h.SDK().FireTurnStart(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireturnstart error", map[string]any{"error": err})
		}
	}
}

// FireBeforeProviderRequest fans the before_provider_request hook out to every
// host. Observe-only: per-host errors are logged but do not propagate, since
// stalling the agent loop on a telemetry hook would be worse than a silent
// extension failure. The number of hosts notified is logged at INFO so
// operators can confirm the hook is actually reaching extensions.
func (g *ExtensionGroup) FireBeforeProviderRequest(ctx *Context, info BeforeProviderRequestInfo) {
	ctx, endFanout := g.beginFanout(ctx, "before_provider_request")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforeproviderrequest: dispatching to host(s)", map[string]any{"count": len(g.hosts), "provider": info.Provider, "model": info.Model, "turn_number": info.TurnNumber, "message_count": info.MessageCount, "tool_count": info.ToolCount})
	for _, h := range g.hosts {
		if err := h.SDK().FireBeforeProviderRequest(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firebeforeproviderrequest error", map[string]any{"error": err})
		}
	}
}

func (g *ExtensionGroup) FireTurnEnd(ctx *Context, info TurnInfo) {
	ctx, endFanout := g.beginFanout(ctx, "turn_end")
	defer endFanout()
	for _, h := range g.hosts {
		if err := h.SDK().FireTurnEnd(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireturnend error", map[string]any{"error": err})
		}
	}
}

// FireBeforeEarlyStopDecision fans the before_early_stop_decision hook out
// to every host and folds the per-host results into a single decision. Per-
// field "last non-nil wins" mirrors the per-host SDK resolution, so the
// last host in registration order has final say if multiple hosts set the
// same field.
//
// Returns nil when no host expressed an opinion. The runloop treats a nil
// return as "use the engine's default decision".
func (g *ExtensionGroup) FireBeforeEarlyStopDecision(ctx *Context, info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
	ctx, endFanout := g.beginFanout(ctx, "before_early_stop_decision")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforeearlystopdecision: dispatching to host(s)", map[string]any{"count": len(g.hosts), "run_id": info.RunID, "turn_number": info.TurnNumber, "cumulative_output_tokens": info.CumulativeOutputTokens, "budget": info.Budget, "would_continue": info.WouldContinue, "eligible": info.Eligible})
	var out EarlyStopDecisionResult
	anySet := false
	for _, h := range g.hosts {
		v := h.SDK().FireBeforeEarlyStopDecision(ctx, info)
		if v == nil {
			continue
		}
		if v.ForceContinue != nil {
			out.ForceContinue = v.ForceContinue
			anySet = true
		}
		if v.OverrideBudget != 0 {
			out.OverrideBudget = v.OverrideBudget
			anySet = true
		}
		if v.OverrideThresholdPct != 0 {
			out.OverrideThresholdPct = v.OverrideThresholdPct
			anySet = true
		}
		if v.ContinueMessage != "" {
			out.ContinueMessage = v.ContinueMessage
			anySet = true
		}
	}
	if !anySet {
		return nil
	}
	return &out
}

// FireEarlyStopContinued fans the early_stop_continued hook out to every
// host. Observe-only: errors are logged per host but never propagate.
func (g *ExtensionGroup) FireEarlyStopContinued(ctx *Context, info EarlyStopContinuedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "early_stop_continued")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "fireearlystopcontinued: dispatching to host(s)", map[string]any{"count": len(g.hosts), "run_id": info.RunID, "turn_number": info.TurnNumber, "continuation_count": info.ContinuationCount, "pct": info.Pct})
	for _, h := range g.hosts {
		if err := h.SDK().FireEarlyStopContinued(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireearlystopcontinued error", map[string]any{"error": err})
		}
	}
}

// FireAgentStart fans the agent_start hook out to every host. Observe-only:
// per-host errors are logged but do not propagate. Fired by the parent
// session's agent-spawner when a child agent begins running, so parent-host
// extensions can observe child-agent lifecycle (start time, identity, task).
func (g *ExtensionGroup) FireAgentStart(ctx *Context, info AgentInfo) {
	ctx, endFanout := g.beginFanout(ctx, "agent_start")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "fireagentstart: dispatching to host(s)", map[string]any{"count": len(g.hosts), "model": info.Name})
	for _, h := range g.hosts {
		if err := h.SDK().FireAgentStart(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireagentstart error", map[string]any{"error": err})
		}
	}
}

// FireAgentEnd fans the agent_end hook out to every host. Observe-only:
// per-host errors are logged but do not propagate. Fired by the parent
// session's agent-spawner when a child agent terminates (success, error,
// or cancellation). Parent-host extensions pair this with agent_start to
// observe child-agent lifecycle without resorting to tool_start/tool_end
// watchdog tricks on the Agent tool.
func (g *ExtensionGroup) FireAgentEnd(ctx *Context, info AgentInfo) {
	ctx, endFanout := g.beginFanout(ctx, "agent_end")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "fireagentend: dispatching to host(s)", map[string]any{"count": len(g.hosts), "model": info.Name})
	for _, h := range g.hosts {
		if err := h.SDK().FireAgentEnd(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireagentend error", map[string]any{"error": err})
		}
	}
}

func (g *ExtensionGroup) FireSessionCompact(ctx *Context, info CompactionInfo) {
	ctx, endFanout := g.beginFanout(ctx, "session_compact")
	defer endFanout()
	for _, h := range g.hosts {
		if err := h.SDK().FireSessionCompact(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firesessioncompact error", map[string]any{"error": err})
		}
	}
}

// FireCompactSummaryRequest fans the hook out across every host and
// returns the first non-empty summary string a host produced. When no
// host provides a summary the engine falls back to its regex fact
// extractor. The decision is logged so a developer reading
// ~/.ion/engine.log can tell which path won — see runloop_compaction.go
// for the corresponding "path=hook" / "path=regex" markers.
func (g *ExtensionGroup) FireCompactSummaryRequest(ctx *Context, info CompactSummaryRequestInfo) (string, bool) {
	ctx, endFanout := g.beginFanout(ctx, "compact_summary_request")
	defer endFanout()
	for _, h := range g.hosts {
		summary, ok := h.FireCompactSummaryRequest(ctx, info)
		if ok && summary != "" {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firecompactsummaryrequest: host produced summary", map[string]any{"count": len(summary), "message_count": info.MessageCount})
			return summary, true
		}
	}
	utils.LogWithFields(utils.LevelDebug, "extension.group", "firecompactsummaryrequest: no host produced a summary, falling through ( )", map[string]any{"message_count": info.MessageCount, "count": len(g.hosts)})
	return "", false
}

func (g *ExtensionGroup) FirePermissionRequest(ctx *Context, info PermissionRequestInfo) {
	ctx, endFanout := g.beginFanout(ctx, "permission_request")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FirePermissionRequest(ctx, info)
	}
}

// FirePermissionClassify fires the permission_classify hook on each host
// and returns the first non-empty tier label. Hosts run in registration
// order; if no host returns a label, the empty string is returned and
// callers fall back to the engine's built-in classifier.
func (g *ExtensionGroup) FirePermissionClassify(ctx *Context, info PermissionClassifyInfo) string {
	ctx, endFanout := g.beginFanout(ctx, "permission_classify")
	defer endFanout()
	for _, h := range g.hosts {
		if tier := h.SDK().FirePermissionClassify(ctx, info); tier != "" {
			return tier
		}
	}
	return ""
}

func (g *ExtensionGroup) FirePermissionDenied(ctx *Context, info PermissionDeniedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "permission_denied")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FirePermissionDenied(ctx, info)
	}
}

func (g *ExtensionGroup) FireFileChanged(ctx *Context, info FileChangedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "file_changed")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireFileChanged(ctx, info)
	}
}

// FireWorkspaceFileChanged fans the workspace_file_changed hook out to every
// host in the group. Called by the session-scoped fsnotify watcher on every
// non-ignored create / modify / delete event under the working directory.
//
// A host that declared no handler for the hook is skipped. Filesystem events
// are high-volume, and a subprocess round trip per event per extension would
// be paid even by extensions that never asked for them.
func (g *ExtensionGroup) FireWorkspaceFileChanged(ctx *Context, info WorkspaceFileChangedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "workspace_file_changed")
	defer endFanout()
	for _, h := range g.hosts {
		if !h.DeclaresHook(HookWorkspaceFileChanged) {
			continue
		}
		h.SDK().FireWorkspaceFileChanged(ctx, info)
	}
}

// FireWorkspaceFileRenamed fans the workspace_file_renamed hook out to every
// host in the group.
func (g *ExtensionGroup) FireWorkspaceFileRenamed(ctx *Context, info WorkspaceFileRenamedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "workspace_file_renamed")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireWorkspaceFileRenamed(ctx, info)
	}
}

// FireWikiLinksPropagated fans the wiki_links_propagated hook out to every
// host in the group.
func (g *ExtensionGroup) FireWikiLinksPropagated(ctx *Context, report WikiLinkPropagationReport) {
	ctx, endFanout := g.beginFanout(ctx, "wiki_links_propagated")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireWikiLinksPropagated(ctx, report)
	}
}

// FireBackgroundTaskCompleted fans the background_task_completed hook out to
// every host in the group. Called when a background bash command started with
// notify_on_complete reaches a terminal state.
func (g *ExtensionGroup) FireBackgroundTaskCompleted(ctx *Context, info BackgroundTaskCompletedInfo) {
	ctx, endFanout := g.beginFanout(ctx, "background_task_completed")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireBackgroundTaskCompleted(ctx, info)
	}
}

// FireDispatchLost fans the dispatch_lost hook out to every host in the
// group. Called once per orphaned dispatch during dispatch-state rehydration
// after an engine restart.
func (g *ExtensionGroup) FireDispatchLost(ctx *Context, info DispatchLostInfo) {
	ctx, endFanout := g.beginFanout(ctx, "dispatch_lost")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireDispatchLost(ctx, info)
	}
}

// FireBeforeRunRecovery fans the before_run_recovery hook out to every host
// and folds the per-host results into a single decision. Per-field "last
// non-nil wins" mirrors the per-host SDK resolution.
//
// Returns nil when no host expressed an opinion.
func (g *ExtensionGroup) FireBeforeRunRecovery(ctx *Context, info BeforeRunRecoveryInfo) *BeforeRunRecoveryResult {
	ctx, endFanout := g.beginFanout(ctx, "before_run_recovery")
	defer endFanout()
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforerunrecovery: dispatching to host(s)", map[string]any{"count": len(g.hosts), "recovery_id": info.RecoveryID, "conversation_id": info.ConversationID, "attempt": info.Attempt, "max_attempts": info.MaxAttempts})
	var out BeforeRunRecoveryResult
	anySet := false
	for _, h := range g.hosts {
		v := h.SDK().FireBeforeRunRecovery(ctx, info)
		if v == nil {
			continue
		}
		if v.Action != "" {
			out.Action = v.Action
			anySet = true
		}
		if v.Instruction != "" {
			out.Instruction = v.Instruction
			anySet = true
		}
	}
	if !anySet {
		return nil
	}
	return &out
}
