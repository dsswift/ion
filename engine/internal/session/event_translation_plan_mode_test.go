package session

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// The source and rejection fields are read by clients off the engine wire;
// pin their JSON names.
func TestTranslate_PlanModeSourceAndRejection(t *testing.T) {
	changed := translateToEngineEvent(types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true, PlanFilePath: "/p/plans/a-b-c.md", Source: "wire"}}, 0)
	b, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"engine_plan_mode_changed"`, `"planModeSource":"wire"`, `"planModeEnabled":true`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("missing %s in %s", want, b)
		}
	}

	rejected := translateToEngineEvent(types.NormalizedEvent{Data: &types.PlanModeChangeRejectedEvent{RequestedEnabled: true, Source: "extension", Reason: "no"}}, 0)
	b, err = json.Marshal(rejected)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"engine_plan_mode_change_rejected"`, `"planModeRequestedEnabled":true`, `"planModeSource":"extension"`, `"planModeRejectReason":"no"`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("missing %s in %s", want, b)
		}
	}
}
