package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// AskUserQuestionName is the tool name used to identify the ask-user-question sentinel.
const AskUserQuestionName = "AskUserQuestion"

// AskUserQuestionTool is a sentinel tool available in all runs that lets the
// LLM pause the run to ask the user a clarifying question. The engine
// intercepts calls to this tool unconditionally (see runloop_tools.go),
// records a PermissionDenial with the question payload, and terminates the
// run so the client can surface the question and feed the user's answer back
// as the next prompt.
func AskUserQuestionTool() *types.ToolDef {
	return &types.ToolDef{
		Name: AskUserQuestionName,
		Description: `Ask the user a question to gather information, clarify ambiguity, or get a decision. The run pauses until the user responds. Use this instead of guessing when requirements are unclear.

When the question has a finite set of reasonable answers, ALWAYS provide options — this is faster for the user than typing. The user can always type a custom answer even when options are provided. Only omit options for genuinely open-ended questions (e.g. "What should the project be called?").

IMPORTANT: The question is displayed in a small UI card — keep it to 1-2 sentences containing only the decision point. Any necessary context, explanation, or narrative should be written as regular assistant text BEFORE calling this tool. Do not put background information, analysis, or reasoning into the question field.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"question": map[string]any{
					"type":        "string",
					"description": "The question to ask the user. Must be 1-2 concise sentences containing only the decision point, ending with a question mark. Do not include background context, narrative, or explanation — put that in your regular message text before calling this tool.",
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
