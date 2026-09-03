package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// AskUserQuestionName is the tool name used to identify the ask-user-question sentinel.
const AskUserQuestionName = "AskUserQuestion"

// AskUserQuestionsName is the tool name of the multi-question sibling. The tool
// itself is harness-declared (its schema arrives via the client-tool runtime,
// not an engine ToolDef), but its name is a shared identity the engine matches
// in several places (retained-denial handling, delegated-CLI tool_use capture),
// so it lives here as the single source of truth rather than as a bare literal.
const AskUserQuestionsName = "AskUserQuestions"

// AskUserQuestionTool is a sentinel tool available in all runs that lets the
// LLM pause the run to ask the user a clarifying question. The engine
// intercepts calls to this tool unconditionally (see runloop_tools.go),
// records a PermissionDenial with the question payload, and terminates the
// run so the client can surface the question and feed the user's answer back
// as the next prompt.
func AskUserQuestionTool() *types.ToolDef {
	return &types.ToolDef{
		Name: AskUserQuestionName,
		Description: `Ask the user ONE question to gather information, clarify ambiguity, or get a decision. The run ends until the user responds with their next prompt — this tool carries a single question and does not batch. Use this instead of guessing when requirements are unclear. If a richer structured-questions tool is available in this session, prefer it for multi-question rounds and reserve this one for a single isolated decision.

When the question has a finite set of reasonable answers, ALWAYS provide options — this is faster for the user than typing. The user can always type a custom answer even when options are provided. Only omit options for genuinely open-ended questions (e.g. "What should the project be called?").

IMPORTANT: The question is displayed in a small UI card — keep it to 1-2 sentences containing only the decision point. Any context the user needs in order to answer must be written as regular assistant text BEFORE calling this tool, in the same turn. The user sees only visible assistant text alongside the question — private/extended reasoning is never shown to them, so context that exists only in reasoning does not reach the user. Do not put background information, analysis, or reasoning into the question field.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"question": map[string]any{
					"type":        "string",
					"description": "The question to ask the user. Must be 1-2 concise sentences containing only the decision point, ending with a question mark. Do not include background context, narrative, or explanation — put that in visible assistant text before this tool call (private reasoning is not shown to the user).",
				},
				"options": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type":        "string",
						"description": "A concise choice label (1-5 words).",
					},
					"description": "2-5 predefined choices for the user. Provide options whenever the question has a finite set of reasonable answers. Each option should be distinct. The user can always provide a custom answer instead.",
				},
			},
			"required": []string{"question"},
		},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			// This should never be called directly — the engine intercepts
			// AskUserQuestion before executeTools reaches this point.
			return &types.ToolResult{
				Content: "Question sent to user. Awaiting response.",
				IsError: false,
			}, nil
		},
	}
}
