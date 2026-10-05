package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A backend's usage limit report reaches the socket as engine_rate_limit
// with every window it named.
func TestTranslateRateLimit(t *testing.T) {
	used := 0.24
	ee := translateToEngineEvent(types.NormalizedEvent{Data: &types.RateLimitNormalizedEvent{
		Status:        "allowed",
		ResetsAt:      1791048000,
		RateLimitType: "five_hour",
		Utilization:   &used,
		Windows: map[string]types.RateLimitWindow{
			"five_hour": {Utilization: 0.24, ResetsAt: 1791048000},
			"seven_day": {Utilization: 0.64, ResetsAt: 1791234000},
		},
	}}, 0)
	if ee.Type != "engine_rate_limit" {
		t.Fatalf("type = %q, want engine_rate_limit", ee.Type)
	}
	rl := ee.RateLimit
	if rl == nil {
		t.Fatal("RateLimit payload is nil")
	}
	if rl.Status != "allowed" || rl.RateLimitType != "five_hour" || rl.ResetsAt != 1791048000 {
		t.Errorf("payload = %+v", rl)
	}
	if rl.Utilization == nil || *rl.Utilization != 0.24 {
		t.Errorf("utilization = %v, want 0.24", rl.Utilization)
	}
	if got := rl.Windows["seven_day"]; got.Utilization != 0.64 || got.ResetsAt != 1791234000 {
		t.Errorf("seven_day window = %+v", got)
	}
}
