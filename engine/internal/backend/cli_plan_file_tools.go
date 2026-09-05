package backend

import (
	"fmt"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// cli_plan_file_tools.go — the plan-file authoring pair for delegated-CLI plan
// mode.
//
// The ApiBackend gives a plan-mode model the real Write and Edit tools and
// restricts them per call by TARGET path (applyPlanModeWriteGate): a write to
// the canonical plan file runs, a plan-shaped write elsewhere is redirected
// onto it, anything else is blocked. That is what lets the native path treat
// the plan file as the single source of truth and keep ExitPlanMode a bare
// signal.
//
// A delegated claude-code plan run cannot use that mechanism. Its read-only
// boundary is --disallowedTools, fixed at spawn (buildClaudeArgs), and it
// filters by tool NAME with no per-call seam — so the only options it offers
// are "Write is available for every path in the repo" or "Write is gone". The
// engine chose gone, which historically left the ExitPlanMode `plan` argument
// as the sole channel a plan could travel on, and made the model re-emit the
// entire plan as tool arguments even when it had already authored it.
//
// WritePlan and EditPlan restore the native behavior without reopening the
// boundary. They are engine-owned MCP tools with NO path parameter: the target
// is resolved from session state inside the handler, so the model cannot name a
// file at all. There is no path to validate, no traversal to defend against,
// and no gate that can be talked around — the property the ApiBackend gets by
// checking a path, these get by never accepting one.
//
// This file owns the tool contracts (names, descriptions, schemas) and the
// pure edit mechanics. The handlers live in the session package, which is where
// the session-scoped plan path and the event sink are reachable.

const (
	// CliWritePlanToolName authors or replaces the whole plan file.
	CliWritePlanToolName = "WritePlan"
	// CliEditPlanToolName revises part of the plan file in place.
	CliEditPlanToolName = "EditPlan"
)

// CliWritePlanTool returns the metadata for the engine-owned WritePlan tool
// registered on a delegated claude-code plan-mode run's MCP ToolServer.
//
// The schema deliberately carries only `content`. The plan file is resolved
// from session state by the handler, so the model never supplies, and cannot
// influence, the write target.
func CliWritePlanTool() (name, description string, inputSchema map[string]any) {
	return CliWritePlanToolName,
		"Write your plan to this session's plan file, replacing whatever it currently holds. This is the only file you can write in plan mode, and its path is fixed by the engine — you do not choose it. Use this for the first draft, or when a revision is large enough that rewriting is clearer than editing. For a targeted change to an existing plan, prefer EditPlan: it does not require resending the whole document.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"content": map[string]any{
					"type":        "string",
					"description": "The complete plan markdown. This replaces the entire file.",
				},
			},
			"required": []string{"content"},
		}
}

// CliEditPlanTool returns the metadata for the engine-owned EditPlan tool.
//
// EditPlan exists so a revision turn costs the size of the change rather than
// the size of the plan. Without it a model refining a large plan would have to
// resend the whole document through WritePlan on every pass, which is the exact
// cost the ExitPlanMode `plan` argument used to impose.
//
// Like WritePlan it takes no path. `old_string` must match exactly once, which
// is the same uniqueness contract the core Edit tool enforces.
func CliEditPlanTool() (name, description string, inputSchema map[string]any) {
	return CliEditPlanToolName,
		"Revise part of this session's plan file in place. The path is fixed by the engine — you do not choose it. `old_string` must appear exactly once in the current plan; include enough surrounding text to make it unique. Prefer this over WritePlan when revising an existing plan, so you do not resend the whole document.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"old_string": map[string]any{
					"type":        "string",
					"description": "Exact text to replace. Must occur exactly once in the current plan file.",
				},
				"new_string": map[string]any{
					"type":        "string",
					"description": "Replacement text. Use an empty string to delete the matched text.",
				},
			},
			"required": []string{"old_string", "new_string"},
		}
}

// CapturePlanFileWrite writes plan markdown to the session's canonical plan
// file and emits PlanFileWrittenEvent, without emitting a proposal.
//
// It is the exported seam for the WritePlan/EditPlan handlers in the session
// package, and delegates to capturePlanMarkdown so the atomic temp-file-then-
// rename write, the size cap, and the created-vs-updated discriminator stay in
// one implementation shared with the native-plan capture path.
//
// emitProposal is deliberately false: authoring the plan is not proposing it.
// The proposal is ExitPlanMode's job, which keeps "the plan changed" and "the
// plan is ready for approval" as separate signals — a model may write and
// revise many times before it exits.
func CapturePlanFileWrite(
	runID, markdown, planFilePath string,
	emit func(string, types.NormalizedEvent),
) (PlanCaptureResult, error) {
	return capturePlanMarkdown(runID, markdown, planFilePath, false, 0, emit)
}

// ErrPlanFileMissing reports that EditPlan ran before any plan content existed.
var ErrPlanFileMissing = fmt.Errorf("plan file has no content yet")

// ErrPlanEditNoMatch reports that EditPlan's old_string was not found.
var ErrPlanEditNoMatch = fmt.Errorf("old_string not found in the plan file")

// ErrPlanEditAmbiguous reports that EditPlan's old_string matched more than
// once, so the intended edit is undetermined.
var ErrPlanEditAmbiguous = fmt.Errorf("old_string matched more than once in the plan file")

// ApplyPlanFileEdit reads the plan file and returns its content with the single
// occurrence of oldString replaced by newString. It does NOT write — the caller
// persists the result through CapturePlanFileWrite, so every plan mutation
// lands through the same atomic write and emits the same event.
//
// The uniqueness requirement matches the core Edit tool: a match count other
// than one is an error the model can correct, never a guess. Returning the
// count alongside the sentinel lets the handler tell the model exactly how many
// times its anchor matched.
func ApplyPlanFileEdit(planFilePath, oldString, newString string) (content string, matches int, err error) {
	raw, err := os.ReadFile(planFilePath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", 0, ErrPlanFileMissing
		}
		return "", 0, err
	}
	current := string(raw)
	if current == "" {
		return "", 0, ErrPlanFileMissing
	}
	if oldString == "" {
		return "", 0, ErrPlanEditNoMatch
	}

	matches = strings.Count(current, oldString)
	switch matches {
	case 0:
		return "", 0, ErrPlanEditNoMatch
	case 1:
		return strings.Replace(current, oldString, newString, 1), 1, nil
	default:
		return "", matches, ErrPlanEditAmbiguous
	}
}
