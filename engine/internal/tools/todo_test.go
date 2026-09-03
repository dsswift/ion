package tools

import (
	"context"
	"strings"
	"testing"
)

// TodoWrite is the API-backend task-list tool. It must be a default built-in
// (so every API-runloop run is offered it) and PlanModeSafe (so it survives the
// plan-mode tool filter). This pins the registration the user's fix depends on:
// without it, an API-backend model is handed no task-list tool and the desktop
// TodoListPanel stays empty.
func TestTodoWriteIsDefaultBuiltinAndPlanModeSafe(t *testing.T) {
	def := GetTool("TodoWrite")
	if def == nil {
		t.Fatal("TodoWrite is not a registered built-in tool")
		return
	}
	if !def.PlanModeSafe {
		t.Error("TodoWrite must be PlanModeSafe so it survives plan-mode filtering")
	}

	found := false
	for _, td := range GetToolDefs() {
		if td.Name == "TodoWrite" {
			found = true
			if !td.PlanModeSafe {
				t.Error("TodoWrite tool def lost PlanModeSafe through GetToolDefs")
			}
		}
	}
	if !found {
		t.Error("TodoWrite absent from GetToolDefs — API-backend runs would not be offered it")
	}
}

func TestTodoWriteExecuteAcceptsFullList(t *testing.T) {
	input := map[string]any{
		"todos": []any{
			map[string]any{"content": "First step", "status": "completed"},
			map[string]any{"content": "Second step", "status": "in_progress"},
			map[string]any{"content": "Third step", "status": "pending"},
		},
	}
	res, err := executeTodoWrite(context.Background(), input, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("expected success, got error result: %s", res.Content)
	}
	// The ack must report the counts so a headless consumer and the model both
	// see the recorded state reflected back.
	for _, want := range []string{"3 item", "1 completed", "1 in progress", "1 pending"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("ack %q missing %q", res.Content, want)
		}
	}
}

func TestTodoWriteExecuteRejectsMissingArray(t *testing.T) {
	res, err := executeTodoWrite(context.Background(), map[string]any{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Error("expected an error result when 'todos' is absent")
	}
}

func TestTodoWriteExecuteRejectsEmptyContent(t *testing.T) {
	input := map[string]any{
		"todos": []any{
			map[string]any{"content": "  ", "status": "pending"},
		},
	}
	res, err := executeTodoWrite(context.Background(), input, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Error("expected an error result when a todo has empty content")
	}
}

// An unknown status is coerced to pending rather than rejected, so a lenient
// model call still yields a usable list.
func TestTodoWriteExecuteCoercesUnknownStatus(t *testing.T) {
	input := map[string]any{
		"todos": []any{
			map[string]any{"content": "Step", "status": "banana"},
		},
	}
	res, err := executeTodoWrite(context.Background(), input, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("expected success with coerced status, got: %s", res.Content)
	}
	if !strings.Contains(res.Content, "1 pending") {
		t.Errorf("expected unknown status coerced to pending, got %q", res.Content)
	}
}
