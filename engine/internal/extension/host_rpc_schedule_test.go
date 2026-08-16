package extension

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func scheduleRPCPayload(t *testing.T, method, jobID string) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method,
		"params": map[string]string{"id": jobID},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestFireScheduleUsesRequestContext(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	called := ""
	ctx := &Context{FireSchedule: func(id string) error { called = id; return nil }}
	h.rpcFireSchedule(ctx, 1, scheduleRPCPayload(t, "ext/fire_schedule", "morning"))
	if resp := readResponse(t, ch, time.Second); resp["error"] != nil {
		t.Fatalf("response: %#v", resp)
	}
	if called != "morning" {
		t.Fatalf("active call=%q", called)
	}
}

func TestFireScheduleUsesPersistentFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	called := ""
	h.SetPersistentScheduleControl(func(id string) error { called = id; return nil }, nil)
	h.rpcFireSchedule(nil, 1, scheduleRPCPayload(t, "ext/fire_schedule", "evening"))
	if resp := readResponse(t, ch, time.Second); resp["error"] != nil {
		t.Fatalf("response: %#v", resp)
	}
	if called != "evening" {
		t.Fatalf("persistent call=%q", called)
	}
}

func TestFireScheduleReportsPersistentFailure(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentScheduleControl(func(string) error { return errors.New("scheduler offline") }, nil)
	h.rpcFireSchedule(nil, 1, scheduleRPCPayload(t, "ext/fire_schedule", "evening"))
	resp := readResponse(t, ch, time.Second)
	if resp["error"] == nil {
		t.Fatalf("response=%#v, want error", resp)
	}
}

func TestFireScheduleRejectsWithoutContextOrFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.rpcFireSchedule(nil, 1, scheduleRPCPayload(t, "ext/fire_schedule", "evening"))
	resp := readResponse(t, ch, time.Second)
	if resp["error"] == nil {
		t.Fatalf("response=%#v, want error", resp)
	}
}

func TestScheduleStatusUsesPersistentFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentScheduleControl(nil, func(id string) ([]ScheduleStatusEntry, error) {
		return []ScheduleStatusEntry{{ID: id, Kind: "daily"}}, nil
	})
	h.rpcGetScheduleStatus(nil, 1, scheduleRPCPayload(t, "ext/get_schedule_status", "morning"))
	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("response: %#v", resp)
	}
	items, ok := resp["result"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("result=%#v", resp["result"])
	}
}
