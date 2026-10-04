package backend

import (
	"os"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// planGateResult is what the API runloop's plan gate reports to the per-tool
// dispatch.
//
// handled means results[i] is set and a ToolResultEvent was emitted, so the
// caller returns. The other fields describe a write to the canonical plan
// file: planWriteOverwrite latches the post-execution overwrite warning,
// redirectNotice is appended to a redirected write's result, and
// planWriteToCanonical with planFileHadContentBefore drive the
// engine_plan_file_written marker (created versus updated). They are computed
// before execution because that is the only point the file's prior state is
// observable.
type planGateResult struct {
	handled                  bool
	planWriteOverwrite       bool
	redirectNotice           string
	planWriteToCanonical     bool
	planFileHadContentBefore bool
}

// planPolicy assembles the plan policy for this run from its current state.
func (run *activeRun) planPolicy(cwd string) PlanPolicy {
	p := PlanPolicy{
		AllowedTools:  run.planModeTools,
		PlanSafe:      run.toolIsPlanSafe,
		BashAllowlist: run.planModeAllowedBashCommands,
		PlanFilePath:  run.planFilePath,
		Cwd:           cwd,
	}
	if run.opts != nil {
		if len(p.AllowedTools) == 0 {
			p.AllowedTools = run.opts.PlanModeTools
		}
		if len(p.BashAllowlist) == 0 {
			p.BashAllowlist = effectiveBashAllowlist(*run.opts)
		}
		p.McpAllowlist = effectiveMcpAllowlist(*run.opts)
	}
	if len(p.AllowedTools) == 0 {
		p.AllowedTools = defaultPlanModeTools
	}
	return p
}

// toolIsPlanSafe reports whether the named tool declares itself callable in
// plan mode, across every source a run's tool list is assembled from.
func (run *activeRun) toolIsPlanSafe(name string) bool {
	if t := tools.GetTool(name); t != nil && t.PlanModeSafe {
		return true
	}
	if run.cfg != nil {
		for _, td := range run.cfg.ExternalTools {
			if td.Name == name {
				return td.PlanModeSafe
			}
		}
		if run.cfg.HumanWaitClientTools[name] {
			// A human-wait tool ends the turn and hands off to the operator;
			// it mutates nothing.
			return true
		}
	}
	if run.opts != nil {
		for _, td := range run.opts.CapabilityTools {
			if td.Name == name {
				return td.PlanModeSafe
			}
		}
		for _, ct := range run.opts.ClientTools {
			if ct.Name == name {
				return ct.PlanModeSafe
			}
		}
	}
	return false
}

// applyPlanPolicy enforces plan mode on one tool call. It is a no-op when the
// run is not planning.
//
// A redirect rewrites block.Input["file_path"] in place. The map is shared
// with the executor and the post-execution file_changed hook, so both see the
// canonical path.
func (b *ApiBackend) applyPlanPolicy(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	cwd string,
) planGateResult {
	if !run.planMode {
		return planGateResult{}
	}
	decision := run.planPolicy(cwd).Decide(block.Name, block.Input)

	if decision.Denied() {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan policy refused tool call", map[string]any{
			"run_id":    run.requestID,
			"tool":      block.Name,
			"rule":      decision.Rule,
			"plan_file": run.planFilePath,
		})
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   decision.Reason,
			IsError:   true,
		}
		b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: decision.Reason,
			IsError: true,
		}})
		return planGateResult{handled: true}
	}

	utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "plan policy allowed tool call", map[string]any{
		"run_id": run.requestID,
		"tool":   block.Name,
		"rule":   decision.Rule,
	})
	if !decision.PlanFileWrite {
		return planGateResult{}
	}

	// A write to the canonical plan file. Any non-empty file counts as "had
	// content"; a missing or zero-byte file is "created".
	hadContent := false
	if info, err := os.Stat(run.planFilePath); err == nil && info.Size() > 0 {
		hadContent = true
	}
	res := planGateResult{
		planWriteOverwrite:       block.Name == "Write" && hadContent,
		planWriteToCanonical:     true,
		planFileHadContentBefore: hadContent,
	}
	if decision.Verdict == planRedirect {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "redirected_plan_write", map[string]any{
			"run_id":    run.requestID,
			"target":    block.Input["file_path"],
			"canonical": decision.RedirectPath,
		})
		block.Input["file_path"] = decision.RedirectPath
		res.redirectNotice = decision.Notice
	}
	return res
}
