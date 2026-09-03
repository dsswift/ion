package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// validTodoStatuses is the closed set of states a todo item may hold. The
// desktop TodoListPanel renders exactly these three; an unknown status is
// coerced to "pending" so a lenient model call still produces a usable list.
var validTodoStatuses = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"completed":   true,
}

// TodoWriteTool returns the built-in TodoWrite tool. It gives an API-backend
// run the same task-list capability a delegated CLI backend brings natively:
// the model records a checklist of multi-step work and updates it as it goes,
// and clients render it (the desktop TodoListPanel reads the last successful
// TodoWrite call from message history as the full snapshot).
//
// The tool is a snapshot echo. The model sends the COMPLETE list on every call
// and the engine acknowledges it; the engine holds no todo state, because the
// list already lives in the tool-call event stream that every consumer sees.
// This keeps the engine opinionless — it transports the list, it does not own
// or persist it.
//
// PlanModeSafe is set: maintaining a plan checklist is useful while planning,
// and the tool mutates no files or session state, so it survives the plan-mode
// tool filter.
func TodoWriteTool() *types.ToolDef {
	return &types.ToolDef{
		Name: "TodoWrite",
		Description: "Record and update a checklist of the current multi-step task. " +
			"Use it to plan work with three or more steps and to track progress as you go. " +
			"Send the COMPLETE list on every call — it replaces the previous list, it is not a delta. " +
			"Each item has 'content' (imperative description) and 'status' (pending, in_progress, or completed). " +
			"Keep exactly one item in_progress at a time and mark an item completed as soon as it is done. " +
			"Skip it for a single trivial step.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"todos": map[string]any{
					"type":        "array",
					"description": "The full checklist. Each entry replaces any prior list.",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"content": map[string]any{"type": "string", "description": "Imperative description of the step"},
							"status":  map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed"}, "description": "Current state of the step"},
						},
						"required": []string{"content", "status"},
					},
				},
			},
			"required": []string{"todos"},
		},
		PlanModeSafe: true,
		Execute:      executeTodoWrite,
	}
}

func executeTodoWrite(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: TodoWrite cancelled.", IsError: true}, nil
	}

	rawList, ok := input["todos"].([]any)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "tools.todo", "TodoWrite rejected: missing todos array", map[string]any{
			"got": fmt.Sprintf("%T", input["todos"]),
		})
		return &types.ToolResult{Content: "Error: TodoWrite requires a 'todos' array.", IsError: true}, nil
	}

	var pending, inProgress, completed int
	for _, entry := range rawList {
		item, ok := entry.(map[string]any)
		if !ok {
			return &types.ToolResult{Content: "Error: each todo must be an object with 'content' and 'status'.", IsError: true}, nil
		}
		content, contentOk := item["content"].(string)
		if !contentOk || strings.TrimSpace(content) == "" {
			return &types.ToolResult{Content: "Error: each todo requires a non-empty 'content'.", IsError: true}, nil
		}
		status, statusOk := item["status"].(string)
		if !statusOk || !validTodoStatuses[status] {
			status = "pending"
		}
		switch status {
		case "in_progress":
			inProgress++
		case "completed":
			completed++
		default:
			pending++
		}
	}

	total := len(rawList)
	utils.LogWithFields(utils.LevelInfo, "tools.todo", "TodoWrite recorded task list", map[string]any{
		"total":       total,
		"pending":     pending,
		"in_progress": inProgress,
		"completed":   completed,
	})

	return &types.ToolResult{
		Content: fmt.Sprintf("Todo list updated: %d item(s) — %d completed, %d in progress, %d pending.",
			total, completed, inProgress, pending),
	}, nil
}
