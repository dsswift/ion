package backend

import (
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// The engine owns the question tools end to end on the claude-code CLI backend,
// exactly as it owns ExitPlanMode (see claude_code_plan_mode.go). Headless
// `claude -p` exposes no tool for pausing to ask the operator a question, so the
// engine exposes AskUserQuestion / AskUserQuestions through the per-session MCP
// ToolServer, captures the streamed tool_use here, and records a
// PermissionDenial carrying the full input. That denial is the SAME sentinel the
// ApiBackend produces (runloop_tools.go for AskUserQuestion, the human-wait park
// for AskUserQuestions): the run ends, the session idles, the engine retains the
// denial across restarts, and the operator's next message is the answer. Both
// tools are therefore identical on every backend — one carries a single
// question, the other a batch — with no blocking wire round-trip.

// mcpAskUserQuestionToolName / mcpAskUserQuestionsToolName are the wire names of
// the question tools as advertised through the ion-extensions MCP server. The
// claude-code model calls the MCP-prefixed name; the bare alias is offered via
// buildToolAliasDirective, and both forms are matched here.
var (
	mcpAskUserQuestionToolName  = "mcp__" + McpServerName + "__" + tools.AskUserQuestionName
	mcpAskUserQuestionsToolName = "mcp__" + McpServerName + "__" + tools.AskUserQuestionsName
)

// canonicalQuestionToolName maps a streamed tool_use name (bare or MCP-prefixed)
// to the bare canonical question-tool name, or "" when the block is not a
// question tool. Consumers match the bare names (temporary_auto_plan.go, the
// desktop QuestionsCoordinator, event-wiring-status.ts), so the retained denial
// must carry the bare form regardless of which alias the model called.
func canonicalQuestionToolName(name string) string {
	switch name {
	case tools.AskUserQuestionName, mcpAskUserQuestionToolName:
		return tools.AskUserQuestionName
	case tools.AskUserQuestionsName, mcpAskUserQuestionsToolName:
		return tools.AskUserQuestionsName
	}
	return ""
}

// handleQuestionAssistant scans a streamed assistant message for a question
// tool_use (AskUserQuestion or AskUserQuestions, bare or MCP-prefixed) and
// stashes a PermissionDenial carrying the full tool input. Runs in ALL modes — a
// clarifying question is valid in plan mode and normal mode alike. The denial is
// injected onto the result event by injectQuestionDenials so the session's
// existing retained-denial machinery surfaces it, identical to the ApiBackend.
func (b *ClaudeCodeBackend) handleQuestionAssistant(run *claudeCodeRun, e *types.TaskUpdateEvent) {
	for _, block := range e.Message.Content {
		if block.Type != "tool_use" {
			continue
		}
		canonical := canonicalQuestionToolName(block.Name)
		if canonical == "" {
			continue
		}
		run.pendingQuestionDenials = append(run.pendingQuestionDenials, types.PermissionDenial{
			ToolName:  canonical,
			ToolUseID: block.ID,
			ToolInput: block.Input,
		})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "question tool_use captured from stream", map[string]any{
			"run_id": run.requestID, "tool": canonical, "wire_name": block.Name, "tool_use_id": block.ID,
		})
	}
}

// injectQuestionDenials appends any question denials captured from the assistant
// stream onto the CLI's result event BEFORE it is emitted. The claude-code MCP
// handler auto-acknowledges the call (questionAckToolHandler returns a plain
// result), so — exactly like an auto-approved ExitPlanMode — the CLI never emits
// a permission_denial of its own; the engine injects it here from the reliable
// stream signal. The session then retains the denial, idles, and treats the next
// prompt as the answer.
func (b *ClaudeCodeBackend) injectQuestionDenials(run *claudeCodeRun, e *types.TaskCompleteEvent) {
	if len(run.pendingQuestionDenials) == 0 {
		return
	}
	e.PermissionDenials = append(e.PermissionDenials, run.pendingQuestionDenials...)
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "question denials injected onto result event", map[string]any{
		"run_id": run.requestID, "count": len(run.pendingQuestionDenials),
	})
}
