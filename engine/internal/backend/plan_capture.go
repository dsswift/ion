package backend

import (
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// This file is the shared bridge between the delegated-CLI backends' NATIVE
// plan output (plan text captured from Claude's ExitPlanMode argument, codex's
// plan item, cursor's ACP plan update) and Ion's file-centric plan-mode
// contract (PlanFilePath + PlanFileWrittenEvent + PlanProposalEvent). The
// ApiBackend does not use it — its plan mode is authored directly into the
// plan file by the model via the Write/Edit gates (runloop_plan_mode_gates.go)
// and remains the reference implementation.

// defaultPlanFileMaxBytes bounds a captured native plan before it is written
// to the plan file. Large enough for any real implementation plan; a bound
// against a runaway native emission. Callers pass 0 to inherit it.
const defaultPlanFileMaxBytes = 256 * 1024

// planTruncationMarker is appended when a captured plan exceeds the byte cap,
// so the file stays valid markdown and readers see the truncation explicitly.
const planTruncationMarker = "\n\n[plan truncated: exceeded size cap]"

// PlanCaptureResult reports what capturePlanMarkdown did, for logging and
// telemetry. Operation is empty when the capture was a no-op.
type PlanCaptureResult struct {
	// Operation is "created" or "updated"; empty when nothing was written
	// (empty markdown or no plan file path allocated).
	Operation    string
	PlanFilePath string
	PlanSlug     string
	BytesWritten int
}

// capturePlanMarkdown writes native plan markdown captured from a delegated-CLI
// backend to the run's canonical plan file and emits the Ion plan-mode events
// in contract order: PlanFileWrittenEvent first, then (when emitProposal)
// PlanProposalEvent{Kind:"exit"}. It is the single normalization point that
// lets file-centric consumers (the desktop reads the plan file; iOS pages its
// content) work unchanged against backends that emit plan TEXT natively.
//
// Concurrency: this function does file IO and emits events. Backends must NOT
// call it while holding their mutex — stash the captured markdown on the run
// under lock, then call this after releasing it (the existing "translate under
// lock, emit after" pattern).
//
//	runID         — the engine request ID; bound into the emitted events and
//	                used to name the temp file.
//	markdown      — the native plan text. Empty is a no-op (prevents an
//	                unactionable approval card).
//	planFilePath  — RunOptions.PlanFilePath for this run. Empty is a no-op.
//	emitProposal  — emit PlanProposalEvent{Kind:"exit"} after the file event.
//	                Pass false for intermediate captures that are not yet a
//	                proposal; the delegated-CLI backends pass true at the
//	                native proposal boundary.
//	maxBytes      — byte cap for the written file; 0 inherits
//	                defaultPlanFileMaxBytes.
//	emit          — the backend's normalized-event sink.
func capturePlanMarkdown(
	runID, markdown, planFilePath string,
	emitProposal bool,
	maxBytes int,
	emit func(string, types.NormalizedEvent),
) (PlanCaptureResult, error) {
	if markdown == "" || planFilePath == "" {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_capture", "capture no-op", map[string]any{
			"run_id":        runID,
			"have_markdown": markdown != "",
			"have_path":     planFilePath != "",
		})
		return PlanCaptureResult{}, nil
	}

	if maxBytes <= 0 {
		maxBytes = defaultPlanFileMaxBytes
	}
	if len(markdown) > maxBytes {
		cut := maxBytes
		// Back up to a rune boundary so the truncated file stays valid UTF-8.
		for cut > 0 && !utf8.RuneStart(markdown[cut]) {
			cut--
		}
		utils.LogWithFields(utils.LevelWarn, "backend.plan_capture", "plan truncated to size cap", map[string]any{
			"run_id":    runID,
			"original":  len(markdown),
			"max_bytes": maxBytes,
		})
		markdown = markdown[:cut] + planTruncationMarker
	}

	// Stat BEFORE writing to compute the created-vs-updated discriminator —
	// same semantics as the ApiBackend's write gate (planFileHadContent).
	hadContent := false
	if info, err := os.Stat(planFilePath); err == nil && info.Size() > 0 {
		hadContent = true
	}
	operation := "created"
	if hadContent {
		operation = "updated"
	}

	// Atomic write: temp file in the same directory, then rename onto the
	// canonical path. Rename is atomic on the same filesystem, so a consumer
	// reading the plan file never observes a partial write.
	dir := filepath.Dir(planFilePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		utils.LogWithFields(utils.LevelError, "backend.plan_capture", "mkdir failed", map[string]any{
			"run_id": runID, "dir": dir, "error": err.Error(),
		})
		return PlanCaptureResult{}, err
	}
	tmpPath := planFilePath + ".tmp-" + runID
	if err := os.WriteFile(tmpPath, []byte(markdown), 0644); err != nil {
		utils.LogWithFields(utils.LevelError, "backend.plan_capture", "temp write failed", map[string]any{
			"run_id": runID, "path": tmpPath, "error": err.Error(),
		})
		return PlanCaptureResult{}, err
	}
	if err := os.Rename(tmpPath, planFilePath); err != nil {
		_ = os.Remove(tmpPath)
		utils.LogWithFields(utils.LevelError, "backend.plan_capture", "rename failed", map[string]any{
			"run_id": runID, "path": planFilePath, "error": err.Error(),
		})
		return PlanCaptureResult{}, err
	}

	slug := types.PlanSlugFromPath(planFilePath)
	utils.LogWithFields(utils.LevelInfo, "backend.plan_capture", "native plan captured", map[string]any{
		"run_id":    runID,
		"path":      planFilePath,
		"slug":      slug,
		"operation": operation,
		"bytes":     len(markdown),
		"proposal":  emitProposal,
	})

	emit(runID, types.NormalizedEvent{Data: &types.PlanFileWrittenEvent{
		Operation:    operation,
		PlanFilePath: planFilePath,
		PlanSlug:     slug,
	}})
	if emitProposal {
		emit(runID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: planFilePath,
			PlanSlug:     slug,
		}})
	}

	return PlanCaptureResult{
		Operation:    operation,
		PlanFilePath: planFilePath,
		PlanSlug:     slug,
		BytesWritten: len(markdown),
	}, nil
}

// resolveCliPlanModeAutoExit resolves the auto-exit safety net for a
// delegated-CLI plan-mode run: the RunOptions.PlanModeAutoExit pointer wins,
// else the built-in default (true). The delegated-CLI backends carry no
// RunConfig, so the engine.json LimitsConfig.PlanModeAutoExitOnEndTurn layer
// that the ApiBackend consults does not apply here — a documented asymmetry.
func resolveCliPlanModeAutoExit(opts *types.RunOptions) bool {
	if opts != nil && opts.PlanModeAutoExit != nil {
		return *opts.PlanModeAutoExit
	}
	return true
}

// defaultCodexDeveloperInstructions is the engine's generic plan-mode framing
// sent as codex collaborationMode developer_instructions. It states what plan
// mode IS (read-only investigation producing a written plan) and, critically,
// tells the model to wrap its final plan in a <proposed_plan> block — the
// convention codex's app-server parses into a structured plan item, which is
// what the engine captures (item/completed, type "plan"). Without that block
// codex may run in plan mode but never emit a plan item, so this is the
// mechanics-bearing part. The workflow/tone around it is an opinion a harness
// overrides via RunOptions.PlanModePrompt (ADR-017); an override should keep
// the <proposed_plan> convention or codex will not surface a plan to capture.
func defaultCodexDeveloperInstructions() string {
	return "You are in plan mode. Investigate the task using read-only, " +
		"non-mutating actions only — read and search files, inspect " +
		"configuration, run analysis or dry-run commands. Do not edit files, " +
		"apply patches, or run mutating commands while plan mode is active.\n\n" +
		"Produce a complete, decision-ready implementation plan: the goal, the " +
		"changes to make (files, interfaces, data flow), edge cases, and how to " +
		"verify the result. Leave no open decisions for the implementer.\n\n" +
		"When the plan is ready, present it as your final message wrapped in a " +
		"proposed-plan block so it can be captured for review:\n\n" +
		"<proposed_plan>\n# Title\n\n...markdown plan...\n</proposed_plan>\n\n" +
		"Put the opening and closing tags on their own lines with the markdown " +
		"plan in between. Propose the plan; do not implement it."
}

// resolveCodexPlanInstructions resolves the developer_instructions prose for a
// codex plan-mode turn: the harness override (RunOptions.PlanModePrompt) wins,
// else the engine's generic default. The plan_mode_prompt hook layer does not
// reach delegated-CLI backends — it rides on RunConfig.Hooks, which the hybrid
// router forwards only to the ApiBackend (StartRunWithConfig falls back to
// StartRun for subscription-routed runs, cfg ignored). For CLI backends the
// precedence is therefore two layers: wire field, then engine default.
func resolveCodexPlanInstructions(opts *types.RunOptions) string {
	if opts != nil && opts.PlanModePrompt != "" {
		return opts.PlanModePrompt
	}
	return defaultCodexDeveloperInstructions()
}
