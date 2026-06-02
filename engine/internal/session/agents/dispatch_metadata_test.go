package agents

import "testing"

func TestUpdateDispatchEntry(t *testing.T) {
	t.Run("updates matching entry", func(t *testing.T) {
		metadata := map[string]interface{}{
			"dispatches": []interface{}{
				map[string]interface{}{"id": "agent-1", "status": "running"},
				map[string]interface{}{"id": "agent-2", "status": "running"},
			},
		}

		UpdateDispatchEntry(metadata, "agent-1", "done", 1.5, "conv-abc")

		dispatches := metadata["dispatches"].([]interface{})
		dm := dispatches[0].(map[string]interface{})
		if dm["status"] != "done" {
			t.Errorf("expected status done, got %v", dm["status"])
		}
		if dm["elapsed"] != 1.5 {
			t.Errorf("expected elapsed 1.5, got %v", dm["elapsed"])
		}
		if dm["conversationId"] != "conv-abc" {
			t.Errorf("expected conversationId conv-abc, got %v", dm["conversationId"])
		}

		// Second entry should be untouched.
		dm2 := dispatches[1].(map[string]interface{})
		if dm2["status"] != "running" {
			t.Errorf("second entry should be untouched, got status %v", dm2["status"])
		}
	})

	t.Run("skips conversationId when empty", func(t *testing.T) {
		metadata := map[string]interface{}{
			"dispatches": []interface{}{
				map[string]interface{}{"id": "agent-1", "status": "running"},
			},
		}

		UpdateDispatchEntry(metadata, "agent-1", "error", 2.0, "")

		dm := metadata["dispatches"].([]interface{})[0].(map[string]interface{})
		if dm["status"] != "error" {
			t.Errorf("expected status error, got %v", dm["status"])
		}
		if _, exists := dm["conversationId"]; exists {
			t.Error("conversationId should not be set when empty")
		}
	})

	t.Run("no-op when id not found", func(t *testing.T) {
		metadata := map[string]interface{}{
			"dispatches": []interface{}{
				map[string]interface{}{"id": "agent-1", "status": "running"},
			},
		}

		UpdateDispatchEntry(metadata, "agent-99", "done", 1.0, "conv-x")

		dm := metadata["dispatches"].([]interface{})[0].(map[string]interface{})
		if dm["status"] != "running" {
			t.Errorf("entry should be untouched, got status %v", dm["status"])
		}
	})

	t.Run("no-op when dispatches missing", func(t *testing.T) {
		metadata := map[string]interface{}{"task": "something"}

		// Should not panic.
		UpdateDispatchEntry(metadata, "agent-1", "done", 1.0, "")
	})
}
