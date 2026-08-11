package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/session/agents"
)

// The rate limit is what keeps the advisory from becoming the flood it
// reports. In the incident this guards against, a wedged payload clamped on
// every one of 1,873 emissions across 15 hours; without throttling that is
// 1,873 events describing one unchanging condition.
func TestClampAdvisory_SuppressesRepeatsWithinWindow(t *testing.T) {
	s := &engineSession{}
	rep := agents.ClampReport{AgentName: "a", Scope: "value", OriginalBytes: 3145728}
	now := time.Now()

	if !s.shouldEmitClampAdvisory(rep, now) {
		t.Fatal("first advisory must be emitted")
	}
	if s.shouldEmitClampAdvisory(rep, now.Add(time.Second)) {
		t.Error("identical repeat inside the window must be suppressed")
	}
	if s.shouldEmitClampAdvisory(rep, now.Add(30*time.Second)) {
		t.Error("identical repeat still inside the window must be suppressed")
	}
}

func TestClampAdvisory_EmitsAgainAfterWindow(t *testing.T) {
	s := &engineSession{}
	rep := agents.ClampReport{AgentName: "a", Scope: "value", OriginalBytes: 100}
	now := time.Now()

	s.shouldEmitClampAdvisory(rep, now)
	if !s.shouldEmitClampAdvisory(rep, now.Add(clampAdvisoryInterval+time.Second)) {
		t.Error("advisory should resume once the window has elapsed")
	}
}

// A payload that changed size by an order of magnitude is new information,
// not a repeat — suppressing it would hide a growing leak behind the throttle.
func TestClampAdvisory_MateriallyDifferentSizeBypassesWindow(t *testing.T) {
	s := &engineSession{}
	now := time.Now()

	s.shouldEmitClampAdvisory(agents.ClampReport{AgentName: "a", Scope: "value", OriginalBytes: 1000}, now)

	grew := agents.ClampReport{AgentName: "a", Scope: "value", OriginalBytes: 5000}
	if !s.shouldEmitClampAdvisory(grew, now.Add(time.Second)) {
		t.Error("a 5x size change should emit even inside the window")
	}
}

// The limit is per (agent, scope): two agents clamping simultaneously are two
// separate conditions and each deserves its own advisory.
func TestClampAdvisory_IsScopedPerAgentAndScope(t *testing.T) {
	s := &engineSession{}
	now := time.Now()

	if !s.shouldEmitClampAdvisory(agents.ClampReport{AgentName: "a", Scope: "value", OriginalBytes: 100}, now) {
		t.Fatal("first advisory for agent a must emit")
	}
	if !s.shouldEmitClampAdvisory(agents.ClampReport{AgentName: "b", Scope: "value", OriginalBytes: 100}, now) {
		t.Error("a different agent must not be throttled by agent a's advisory")
	}
	if !s.shouldEmitClampAdvisory(agents.ClampReport{AgentName: "a", Scope: "entry", OriginalBytes: 100}, now) {
		t.Error("a different scope on the same agent is a distinct condition")
	}
}

func TestMateriallyDifferent(t *testing.T) {
	cases := []struct {
		prev, cur int
		want      bool
	}{
		{1000, 1000, false},
		{1000, 1500, false},
		{1000, 2000, true}, // doubled
		{1000, 500, true},  // halved
		{0, 100, true},     // first real measurement
		{0, 0, false},
	}
	for _, c := range cases {
		if got := materiallyDifferent(c.prev, c.cur); got != c.want {
			t.Errorf("materiallyDifferent(%d, %d) = %v, want %v", c.prev, c.cur, got, c.want)
		}
	}
}
