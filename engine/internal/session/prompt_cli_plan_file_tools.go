package session

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prompt_cli_plan_file_tools.go — handlers for the WritePlan/EditPlan pair the
// engine exposes to a delegated claude-code plan-mode run.
//
// These handlers live in the session package rather than beside their tool
// contracts in internal/backend because both need two things only the manager
// has: the session's canonical plan file path, and the event sink that carries
// PlanFileWrittenEvent to consumers.
//
// Resolving the path HERE, per call, is what makes the pair safe and what makes
// it correct across runs. Safe, because the model has no path parameter to
// supply — the write target is engine state the model cannot address, so there
// is nothing for it to redirect. Correct, because the lookup reads live session
// state at call time: a plan authored on one run and revised on a later run
// resolves to the same file, with no dependence on which run happened to enter
// plan mode.

// registerPlanFileTools registers the WritePlan/EditPlan pair on a run's MCP
// ToolServer and returns their wire names for the tool-alias directive.
//
// Both plan-mode registration paths call this — the plan-mode spawn
// (wirePlanModeToolServer) and the auto-mode spawn that may enter plan mode
// mid-run (wireEnterPlanModeToolServer) — so the model has the same authoring
// surface whichever way the session reached plan mode.
func (m *Manager) registerPlanFileTools(ts *backend.ToolServer, key string) []string {
	writeName, writeDesc, writeSchema := backend.CliWritePlanTool()
	ts.RegisterTool(writeName, writePlanToolHandler(m, key), writeDesc, writeSchema)

	editName, editDesc, editSchema := backend.CliEditPlanTool()
	ts.RegisterTool(editName, editPlanToolHandler(m, key), editDesc, editSchema)

	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-file authoring tools registered on ToolServer", map[string]any{
		"key": key, "tools": []string{writeName, editName},
	})
	return []string{writeName, editName}
}

// resolvePlanFilePathForTools returns the session's canonical plan file path
// for a plan-authoring tool call, or an error result the model can act on.
//
// An empty path means the session is not in plan mode, or plan mode was entered
// without a file being allocated. Either way the correct answer is to tell the
// model plainly rather than to invent a target.
func (m *Manager) resolvePlanFilePathForTools(key, tool string) (string, *types.ToolResult) {
	_, planFilePath := m.GetPlanModeState(key)
	if planFilePath == "" {
		utils.LogWithFields(utils.LevelError, "session.plan_mode", "plan-file tool called with no plan file allocated for the session", map[string]any{
			"key": key, "tool": tool,
		})
		return "", &types.ToolResult{
			Content: fmt.Sprintf("%s is unavailable: this session has no plan file allocated. You are not in plan mode.", tool),
			IsError: true,
		}
	}
	return planFilePath, nil
}

// writePlanToolHandler returns the handler for the injected WritePlan MCP tool.
//
// It replaces the whole plan file with the supplied content and emits
// PlanFileWrittenEvent (created or updated) so consumers refresh the plan
// preview the moment the model authors it — the same signal the ApiBackend
// produces when a plan-mode Write lands on the canonical file.
//
// No proposal is emitted. Writing a plan is not proposing it; ExitPlanMode
// remains the single point where a plan is presented for approval.
func writePlanToolHandler(m *Manager, key string) backend.ToolHandler {
	return func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		content, _ := input["content"].(string) //nolint:errcheck // empty/absent content handled by the guard below

		planFilePath, errResult := m.resolvePlanFilePathForTools(key, backend.CliWritePlanToolName)
		if errResult != nil {
			return errResult, nil
		}
		if content == "" {
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "WritePlan called with empty content; refusing to blank the plan file", map[string]any{
				"key": key, "plan_file_path": planFilePath,
			})
			return &types.ToolResult{
				Content: "WritePlan requires non-empty `content`. Pass the full plan markdown, or use EditPlan to change part of an existing plan.",
				IsError: true,
			}, nil
		}

		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "WritePlan invoked by claude-code plan-mode model", map[string]any{
			"key": key, "plan_file_path": planFilePath, "bytes": len(content),
		})

		result, err := backend.CapturePlanFileWrite(key, content, planFilePath, func(runID string, ev types.NormalizedEvent) {
			m.emit(key, translateToEngineEvent(ev, 0))
		})
		if err != nil {
			utils.LogWithFields(utils.LevelError, "session.plan_mode", "WritePlan failed to persist the plan file", map[string]any{
				"key": key, "plan_file_path": planFilePath, "error": err.Error(),
			})
			return &types.ToolResult{
				Content: fmt.Sprintf("Writing the plan file failed: %s. The plan was not saved.", err.Error()),
				IsError: true,
			}, nil
		}

		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "WritePlan persisted the plan file", map[string]any{
			"key": key, "plan_file_path": planFilePath,
			"operation": result.Operation, "bytes": result.BytesWritten,
		})
		return &types.ToolResult{
			Content: fmt.Sprintf("Plan file %s (%d bytes). Continue planning, revise with EditPlan, or call ExitPlanMode when the plan is ready — ExitPlanMode does not need the plan text, it reads this file.", result.Operation, result.BytesWritten),
			IsError: false,
		}, nil
	}
}

// editPlanToolHandler returns the handler for the injected EditPlan MCP tool.
//
// The read-modify-write runs through backend.ApplyPlanFileEdit (which enforces
// the exactly-once match) and then backend.CapturePlanFileWrite, so a revision
// persists through the same atomic write and emits the same PlanFileWrittenEvent
// as a full rewrite. Consumers therefore see plan revisions without knowing
// which tool produced them.
//
// Every failure arm returns IsError with prose naming the specific problem, so
// the model corrects its anchor instead of falling back to resending the whole
// plan.
func editPlanToolHandler(m *Manager, key string) backend.ToolHandler {
	return func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		oldString, _ := input["old_string"].(string) //nolint:errcheck // empty anchor handled by ApplyPlanFileEdit
		newString, _ := input["new_string"].(string) //nolint:errcheck // empty replacement is a legal deletion

		planFilePath, errResult := m.resolvePlanFilePathForTools(key, backend.CliEditPlanToolName)
		if errResult != nil {
			return errResult, nil
		}

		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EditPlan invoked by claude-code plan-mode model", map[string]any{
			"key": key, "plan_file_path": planFilePath,
			"old_bytes": len(oldString), "new_bytes": len(newString),
		})

		updated, matches, err := backend.ApplyPlanFileEdit(planFilePath, oldString, newString)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EditPlan could not apply the edit", map[string]any{
				"key": key, "plan_file_path": planFilePath,
				"matches": matches, "error": err.Error(),
			})
			return &types.ToolResult{
				Content: planEditFailureMessage(err, matches),
				IsError: true,
			}, nil
		}

		result, writeErr := backend.CapturePlanFileWrite(key, updated, planFilePath, func(runID string, ev types.NormalizedEvent) {
			m.emit(key, translateToEngineEvent(ev, 0))
		})
		if writeErr != nil {
			utils.LogWithFields(utils.LevelError, "session.plan_mode", "EditPlan failed to persist the revised plan file", map[string]any{
				"key": key, "plan_file_path": planFilePath, "error": writeErr.Error(),
			})
			return &types.ToolResult{
				Content: fmt.Sprintf("Applying the edit failed while saving: %s. The plan file is unchanged.", writeErr.Error()),
				IsError: true,
			}, nil
		}

		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EditPlan persisted the revised plan file", map[string]any{
			"key": key, "plan_file_path": planFilePath, "bytes": result.BytesWritten,
		})
		return &types.ToolResult{
			Content: fmt.Sprintf("Plan file updated (%d bytes). Continue revising, or call ExitPlanMode when the plan is ready — ExitPlanMode does not need the plan text, it reads this file.", result.BytesWritten),
			IsError: false,
		}, nil
	}
}

// planEditFailureMessage turns an ApplyPlanFileEdit sentinel into prose that
// tells the model exactly how to correct the call. Each arm names the real
// cause; none of them suggests resending the whole plan, which is the cost
// EditPlan exists to avoid.
func planEditFailureMessage(err error, matches int) string {
	switch err {
	case backend.ErrPlanFileMissing:
		return "The plan file has no content yet, so there is nothing to edit. Use WritePlan to author the plan first."
	case backend.ErrPlanEditNoMatch:
		return "`old_string` does not appear in the current plan file. Read the plan file to see its exact current text, then retry with an anchor copied from it."
	case backend.ErrPlanEditAmbiguous:
		return fmt.Sprintf("`old_string` matched %d times in the plan file, so the intended edit is ambiguous. Retry with more surrounding text so the anchor is unique.", matches)
	default:
		return fmt.Sprintf("Reading the plan file failed: %s.", err.Error())
	}
}
