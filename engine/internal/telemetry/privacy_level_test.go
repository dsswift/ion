package telemetry

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCollectorPrivacyLevel_DefaultsToMinimal pins Collector.PrivacyLevel's
// default-when-unset behavior (child 01 §1): an operator who never sets
// privacyLevel gets "minimal", the most conservative collection tier,
// matching normalizeTelemetryConfig's own default pattern for other fields.
func TestCollectorPrivacyLevel_DefaultsToMinimal(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	if got := c.PrivacyLevel(); got != "minimal" {
		t.Errorf("PrivacyLevel() = %q, want %q when unset", got, "minimal")
	}
}

// TestCollectorPrivacyLevel_ReturnsConfiguredValue pins that an explicitly
// configured level is returned verbatim, not overridden by the default.
func TestCollectorPrivacyLevel_ReturnsConfiguredValue(t *testing.T) {
	for _, level := range []string{"minimal", "standard", "full"} {
		c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}, PrivacyLevel: level})
		if got := c.PrivacyLevel(); got != level {
			t.Errorf("PrivacyLevel() = %q, want %q", got, level)
		}
	}
}
