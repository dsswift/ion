// Tests for the engine.json -> subsystem config translation seams
// webhookConfigFrom / scheduleConfigFrom (async_lifecycle.go).
//
// These pin the symptom from issue #242: when the merged
// EngineRuntimeConfig carries a Webhooks / Scheduling block, the
// translation must propagate every field into the webhooks.Config /
// scheduling.Config. The original bug dropped the block at the merge
// layer, so these funcs received rc.Webhooks == nil and returned a
// zero Config -- the webhook listener then bound the loopback default
// (127.0.0.1:7421) and logged "port=0 bind=". A regression that
// reintroduces a zero return (or drops a field in translation) turns
// these tests red.

package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestWebhookConfigFrom_CarriesEngineJSONBlock pins that a populated
// Webhooks block propagates every field into the webhooks.Config. This
// is the exact path that was broken in #242 (rc.Webhooks dropped ->
// zero Config -> port=0 bind=).
func TestWebhookConfigFrom_CarriesEngineJSONBlock(t *testing.T) {
	const fireMs int64 = 12000
	rc := &types.EngineRuntimeConfig{
		Webhooks: &types.WebhooksConfig{
			Port:                8765,
			BindInterface:       "0.0.0.0",
			DefaultMaxBodyBytes: 2 << 20, // 2 MiB
			FireTimeoutMs:       fireMs,
		},
	}

	cfg := webhookConfigFrom(rc)

	if cfg.Port != 8765 {
		t.Errorf("Port = %d, want 8765 (block dropped or not translated)", cfg.Port)
	}
	if cfg.BindInterface != "0.0.0.0" {
		t.Errorf("BindInterface = %q, want \"0.0.0.0\"", cfg.BindInterface)
	}
	if cfg.DefaultMaxBodyBytes != 2<<20 {
		t.Errorf("DefaultMaxBodyBytes = %d, want %d", cfg.DefaultMaxBodyBytes, int64(2<<20))
	}
	if want := millisToDuration(fireMs); cfg.FireTimeout != want {
		t.Errorf("FireTimeout = %v, want %v", cfg.FireTimeout, want)
	}
}

// TestWebhookConfigFrom_NilBlockReturnsZero pins the intended
// "auto-default" behavior: a nil Webhooks block (and a nil rc) yields
// the zero webhooks.Config so the package defaults (port 7421,
// loopback bind) apply. This is correct behavior, not the bug -- the
// bug was that a *populated* block also produced a zero config.
func TestWebhookConfigFrom_NilBlockReturnsZero(t *testing.T) {
	var zero = webhookConfigFrom(&types.EngineRuntimeConfig{}) // Webhooks == nil
	if zero.Port != 0 || zero.BindInterface != "" || zero.DefaultMaxBodyBytes != 0 || zero.FireTimeout != 0 {
		t.Errorf("nil Webhooks block: expected zero Config, got %+v", zero)
	}

	if nilRC := webhookConfigFrom(nil); nilRC.Port != 0 || nilRC.BindInterface != "" {
		t.Errorf("nil rc: expected zero Config, got %+v", nilRC)
	}
}

// TestScheduleConfigFrom_CarriesEngineJSONBlock pins that a populated
// Scheduling block propagates DefaultTz, FireTimeout, and CatchUpEnabled
// into the scheduling.Config, and that PersistDir is set to the
// engine's default scheduler directory.
func TestScheduleConfigFrom_CarriesEngineJSONBlock(t *testing.T) {
	const fireMs int64 = 45000
	catchUp := false
	rc := &types.EngineRuntimeConfig{
		Scheduling: &types.SchedulingConfig{
			DefaultTz:      "America/Chicago",
			FireTimeoutMs:  fireMs,
			CatchUpEnabled: &catchUp,
		},
	}

	cfg := scheduleConfigFrom(rc)

	if cfg.DefaultTz != "America/Chicago" {
		t.Errorf("DefaultTz = %q, want \"America/Chicago\" (block dropped or not translated)", cfg.DefaultTz)
	}
	if want := millisToDuration(fireMs); cfg.FireTimeout != want {
		t.Errorf("FireTimeout = %v, want %v", cfg.FireTimeout, want)
	}
	if cfg.CatchUpEnabled == nil || *cfg.CatchUpEnabled != false {
		t.Errorf("CatchUpEnabled = %v, want pointer to false", cfg.CatchUpEnabled)
	}
	if want := defaultSchedulerPersistDir(); cfg.PersistDir != want {
		t.Errorf("PersistDir = %q, want %q", cfg.PersistDir, want)
	}
}

// TestScheduleConfigFrom_NilBlockReturnsZero pins that a nil Scheduling
// block (and a nil rc) yields the zero scheduling.Config so the package
// defaults apply.
func TestScheduleConfigFrom_NilBlockReturnsZero(t *testing.T) {
	zero := scheduleConfigFrom(&types.EngineRuntimeConfig{}) // Scheduling == nil
	if zero.DefaultTz != "" || zero.FireTimeout != 0 || zero.CatchUpEnabled != nil || zero.PersistDir != "" {
		t.Errorf("nil Scheduling block: expected zero Config, got %+v", zero)
	}

	if nilRC := scheduleConfigFrom(nil); nilRC.DefaultTz != "" || nilRC.PersistDir != "" {
		t.Errorf("nil rc: expected zero Config, got %+v", nilRC)
	}
}
