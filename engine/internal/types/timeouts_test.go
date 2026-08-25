package types

import (
	"testing"
	"time"
)

// TestToolDefault_SixtyMinuteDefault pins the shipped tool-execution ceiling at
// 60 minutes. Revert-check: changing the fallback back to 300000 fails this.
func TestToolDefault_SixtyMinuteDefault(t *testing.T) {
	if got := (*TimeoutsConfig)(nil).ToolDefault(); got != 60*time.Minute {
		t.Errorf("nil ToolDefault() = %s, want 60m", got)
	}
	if got := (&TimeoutsConfig{}).ToolDefault(); got != 60*time.Minute {
		t.Errorf("empty ToolDefault() = %s, want 60m", got)
	}
	if got := (&TimeoutsConfig{ToolDefaultMs: 1000}).ToolDefault(); got != time.Second {
		t.Errorf("configured ToolDefault() = %s, want 1s", got)
	}
}

// TestStreamIdle_NinetySecondDefault pins the shipped per-event SSE idle
// deadline: unset/zero StreamIdleMs → 90s enabled; positive → that value
// enabled; negative → disabled (the sign carries the disable signal, like
// HumanWait). Revert-check: changing the fallback fails the default case.
func TestStreamIdle_NinetySecondDefault(t *testing.T) {
	if d, enabled := (*TimeoutsConfig)(nil).StreamIdle(); !enabled || d != 90*time.Second {
		t.Errorf("nil StreamIdle() = (%s, %v), want (90s, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{}).StreamIdle(); !enabled || d != 90*time.Second {
		t.Errorf("empty StreamIdle() = (%s, %v), want (90s, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{StreamIdleMs: 5000}).StreamIdle(); !enabled || d != 5*time.Second {
		t.Errorf("configured StreamIdle() = (%s, %v), want (5s, true)", d, enabled)
	}
	if _, enabled := (&TimeoutsConfig{StreamIdleMs: -1}).StreamIdle(); enabled {
		t.Error("negative StreamIdleMs must disable the deadline")
	}
}

// TestHumanWait_IndefiniteByDefault pins the core human-wait guarantee: unset or
// zero ElicitationMs means WAIT INDEFINITELY (isFinite=false). Revert-check:
// restoring a 300000 default would make the unset case report finite.
func TestHumanWait_IndefiniteByDefault(t *testing.T) {
	cases := []struct {
		name string
		cfg  *TimeoutsConfig
	}{
		{"nil receiver", nil},
		{"empty struct", &TimeoutsConfig{}},
		{"explicit zero", &TimeoutsConfig{ElicitationMs: 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d, finite := c.cfg.HumanWait()
			if finite {
				t.Errorf("HumanWait() finite=true, want false (indefinite) for %s", c.name)
			}
			if d != 0 {
				t.Errorf("HumanWait() d=%s, want 0 for %s", d, c.name)
			}
		})
	}
}

// TestHumanWait_FiniteWhenConfigured pins that a positive ElicitationMs opts into
// a finite human-wait for headless deployments.
func TestHumanWait_FiniteWhenConfigured(t *testing.T) {
	d, finite := (&TimeoutsConfig{ElicitationMs: 300000}).HumanWait()
	if !finite {
		t.Fatal("HumanWait() finite=false, want true for ElicitationMs=300000")
	}
	if d != 5*time.Minute {
		t.Errorf("HumanWait() d=%s, want 5m", d)
	}
}

// TestPermissionTimeoutAction_DefaultsDeny pins the fail-closed default and the
// allow override. Unrecognized values fall back to deny.
func TestPermissionTimeoutAction_DefaultsDeny(t *testing.T) {
	cases := []struct {
		name string
		cfg  *TimeoutsConfig
		want string
	}{
		{"nil receiver", nil, "deny"},
		{"empty", &TimeoutsConfig{}, "deny"},
		{"explicit deny", &TimeoutsConfig{PermissionTimeoutDecision: "deny"}, "deny"},
		{"allow", &TimeoutsConfig{PermissionTimeoutDecision: "allow"}, "allow"},
		{"garbage falls back to deny", &TimeoutsConfig{PermissionTimeoutDecision: "maybe"}, "deny"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.cfg.PermissionTimeoutAction(); got != c.want {
				t.Errorf("PermissionTimeoutAction() = %q, want %q", got, c.want)
			}
		})
	}
}

// TestMergeTimeouts_PermissionTimeoutDecision pins the new merge clause: a
// non-empty src value overrides dst; an empty src preserves dst.
func TestMergeTimeouts_PermissionTimeoutDecision(t *testing.T) {
	// src overrides
	dst := &TimeoutsConfig{PermissionTimeoutDecision: "deny"}
	MergeTimeouts(dst, &TimeoutsConfig{PermissionTimeoutDecision: "allow"})
	if dst.PermissionTimeoutDecision != "allow" {
		t.Errorf("after merge = %q, want allow", dst.PermissionTimeoutDecision)
	}
	// empty src preserves dst
	dst2 := &TimeoutsConfig{PermissionTimeoutDecision: "allow"}
	MergeTimeouts(dst2, &TimeoutsConfig{})
	if dst2.PermissionTimeoutDecision != "allow" {
		t.Errorf("after no-op merge = %q, want allow preserved", dst2.PermissionTimeoutDecision)
	}
}

// TestMergeTimeouts_ElicitationMs pins that the human-wait knob still merges as a
// numeric field (non-zero src overrides, zero src preserves).
func TestMergeTimeouts_ElicitationMs(t *testing.T) {
	dst := &TimeoutsConfig{ElicitationMs: 1000}
	MergeTimeouts(dst, &TimeoutsConfig{ElicitationMs: 2000})
	if dst.ElicitationMs != 2000 {
		t.Errorf("after merge = %d, want 2000", dst.ElicitationMs)
	}
	dst2 := &TimeoutsConfig{ElicitationMs: 1000}
	MergeTimeouts(dst2, &TimeoutsConfig{})
	if dst2.ElicitationMs != 1000 {
		t.Errorf("after no-op merge = %d, want 1000 preserved", dst2.ElicitationMs)
	}
}

// TestMergeTimeouts_ElicitationMs_ReassertIndefinite pins the negative-sentinel
// escape hatch: because 0 means "indefinite" AND is the merge-skip value, an
// overlay restores indefinite waiting over a finite base by setting a negative
// value. The negative overrides the merge, and HumanWait() maps it to indefinite
// (same as 0). Without the sentinel an overlay could never re-assert indefinite
// over a finite base — the asymmetry this fix closes.
func TestMergeTimeouts_ElicitationMs_ReassertIndefinite(t *testing.T) {
	// A finite base (e.g. a headless default of 5min) ...
	dst := &TimeoutsConfig{ElicitationMs: 300000}
	// ... is overridden back to indefinite by a negative-sentinel overlay.
	MergeTimeouts(dst, &TimeoutsConfig{ElicitationMs: -1})
	if dst.ElicitationMs >= 0 {
		t.Fatalf("after re-assert merge = %d, want a negative sentinel to survive", dst.ElicitationMs)
	}
	// And the accessor reports indefinite, identical to a literal 0.
	if d, finite := dst.HumanWait(); finite || d != 0 {
		t.Errorf("HumanWait after negative sentinel = (%v, finite=%v), want (0, false) indefinite", d, finite)
	}
	// Sanity: a literal-0 receiver is also indefinite (the equivalence).
	zero := &TimeoutsConfig{ElicitationMs: 0}
	if _, finite := zero.HumanWait(); finite {
		t.Errorf("HumanWait for ElicitationMs=0 reported finite, want indefinite")
	}
}

// TestBashMax_TenMinuteDefault pins the shipped ceiling for a per-call Bash
// `timeout`: unset/zero BashMaxMs → 10min enabled; positive → that value;
// negative → disabled (the sign carries the disable signal, like StreamIdle).
// Revert-check: removing the ceiling makes the default case report disabled.
func TestBashMax_TenMinuteDefault(t *testing.T) {
	if d, enabled := (*TimeoutsConfig)(nil).BashMax(); !enabled || d != 10*time.Minute {
		t.Errorf("nil BashMax() = (%s, %v), want (10m, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{}).BashMax(); !enabled || d != 10*time.Minute {
		t.Errorf("empty BashMax() = (%s, %v), want (10m, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{BashMaxMs: 5000}).BashMax(); !enabled || d != 5*time.Second {
		t.Errorf("configured BashMax() = (%s, %v), want (5s, true)", d, enabled)
	}
	if _, enabled := (&TimeoutsConfig{BashMaxMs: -1}).BashMax(); enabled {
		t.Error("negative BashMaxMs must disable the ceiling")
	}
}

// TestBashBlockingSleep_TwoSecondDefault pins the leading-sleep gate
// threshold: unset/zero → 2s enabled; positive → that value; negative →
// disabled. Below the threshold a sleep is pacing, not waiting.
func TestBashBlockingSleep_TwoSecondDefault(t *testing.T) {
	if d, enabled := (*TimeoutsConfig)(nil).BashBlockingSleep(); !enabled || d != 2*time.Second {
		t.Errorf("nil BashBlockingSleep() = (%s, %v), want (2s, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{}).BashBlockingSleep(); !enabled || d != 2*time.Second {
		t.Errorf("empty BashBlockingSleep() = (%s, %v), want (2s, true)", d, enabled)
	}
	if d, enabled := (&TimeoutsConfig{BashBlockingSleepMs: 60000}).BashBlockingSleep(); !enabled || d != time.Minute {
		t.Errorf("configured BashBlockingSleep() = (%s, %v), want (1m, true)", d, enabled)
	}
	if _, enabled := (&TimeoutsConfig{BashBlockingSleepMs: -1}).BashBlockingSleep(); enabled {
		t.Error("negative BashBlockingSleepMs must disable the gate")
	}
}

// TestMergeTimeouts_BashCeilingAndSleepGate pins both new fields in the merge:
// non-zero src overrides, zero src preserves dst, and the negative disable
// sentinel survives a merge (it is non-zero, so it wins — the same escape
// hatch ElicitationMs documents).
func TestMergeTimeouts_BashCeilingAndSleepGate(t *testing.T) {
	dst := &TimeoutsConfig{BashMaxMs: 1000, BashBlockingSleepMs: 1000}
	MergeTimeouts(dst, &TimeoutsConfig{BashMaxMs: 2000, BashBlockingSleepMs: 3000})
	if dst.BashMaxMs != 2000 {
		t.Errorf("BashMaxMs after merge = %d, want 2000", dst.BashMaxMs)
	}
	if dst.BashBlockingSleepMs != 3000 {
		t.Errorf("BashBlockingSleepMs after merge = %d, want 3000", dst.BashBlockingSleepMs)
	}

	preserve := &TimeoutsConfig{BashMaxMs: 1000, BashBlockingSleepMs: 1000}
	MergeTimeouts(preserve, &TimeoutsConfig{})
	if preserve.BashMaxMs != 1000 || preserve.BashBlockingSleepMs != 1000 {
		t.Errorf("no-op merge changed values: max=%d sleep=%d, want 1000/1000",
			preserve.BashMaxMs, preserve.BashBlockingSleepMs)
	}

	disable := &TimeoutsConfig{BashMaxMs: 600000, BashBlockingSleepMs: 2000}
	MergeTimeouts(disable, &TimeoutsConfig{BashMaxMs: -1, BashBlockingSleepMs: -1})
	if _, enabled := disable.BashMax(); enabled {
		t.Error("negative BashMaxMs overlay did not survive the merge")
	}
	if _, enabled := disable.BashBlockingSleep(); enabled {
		t.Error("negative BashBlockingSleepMs overlay did not survive the merge")
	}
}

// TestCommandTimeouts_DefaultOverrideAndMerge pins the command dispatch
// observability and response deadlines. Zero remains the configuration merge
// sentinel, while nil and empty configs resolve to the compiled defaults.
func TestCommandTimeouts_DefaultOverrideAndMerge(t *testing.T) {
	if got := (*TimeoutsConfig)(nil).CommandStall(); got != 10*time.Second {
		t.Errorf("nil CommandStall() = %s, want 10s", got)
	}
	if got := (&TimeoutsConfig{}).CommandDispatch(); got != 25*time.Second {
		t.Errorf("empty CommandDispatch() = %s, want 25s", got)
	}
	configured := &TimeoutsConfig{CommandStallMs: 2000, CommandDispatchMs: 5000}
	if got := configured.CommandStall(); got != 2*time.Second {
		t.Errorf("configured CommandStall() = %s, want 2s", got)
	}
	if got := configured.CommandDispatch(); got != 5*time.Second {
		t.Errorf("configured CommandDispatch() = %s, want 5s", got)
	}
	if got := (&TimeoutsConfig{CommandStallMs: -1}).CommandStall(); got != 10*time.Second {
		t.Errorf("negative CommandStall() = %s, want 10s", got)
	}
	if got := (&TimeoutsConfig{CommandDispatchMs: -1}).CommandDispatch(); got != 25*time.Second {
		t.Errorf("negative CommandDispatch() = %s, want 25s", got)
	}

	dst := &TimeoutsConfig{CommandStallMs: 1000, CommandDispatchMs: 2000}
	MergeTimeouts(dst, &TimeoutsConfig{CommandStallMs: 3000, CommandDispatchMs: 4000})
	if dst.CommandStallMs != 3000 || dst.CommandDispatchMs != 4000 {
		t.Errorf("merged command timeouts = %d/%d, want 3000/4000", dst.CommandStallMs, dst.CommandDispatchMs)
	}
	MergeTimeouts(dst, &TimeoutsConfig{})
	if dst.CommandStallMs != 3000 || dst.CommandDispatchMs != 4000 {
		t.Errorf("empty merge changed command timeouts to %d/%d", dst.CommandStallMs, dst.CommandDispatchMs)
	}
}
