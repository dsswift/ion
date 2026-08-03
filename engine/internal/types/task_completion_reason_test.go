package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTaskCompleteReasonWireCompatibility(t *testing.T) {
	withReason, err := json.Marshal(NormalizedEvent{Data: &TaskCompleteEvent{Reason: TaskCompletionReasonNormal}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withReason), `"reason":"normal"`) {
		t.Fatalf("reason missing: %s", withReason)
	}

	absent, err := json.Marshal(NormalizedEvent{Data: &TaskCompleteEvent{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(absent), `"reason"`) {
		t.Fatalf("empty reason must remain absent: %s", absent)
	}

	var decoded NormalizedEvent
	if err := json.Unmarshal([]byte(`{"type":"task_complete","reason":"future_reason"}`), &decoded); err != nil {
		t.Fatal(err)
	}
	got := decoded.Data.(*TaskCompleteEvent).Reason
	if got != TaskCompletionReason("future_reason") {
		t.Fatalf("unknown reason = %q", got)
	}
}
