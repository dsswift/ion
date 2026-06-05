package backend

import (
	"strings"
	"testing"
)

// shouldInjectPlanModeReminder gates the sparse plan-mode reminder. The
// reminder must fire on turn 2 (first post-entry turn), then again only
// after planModeReminderInterval turns have elapsed since the last
// injection. Turn 1 is the user's first prompt; reminders never fire on
// it. lastReminderTurn=0 means "no reminder has fired yet on this run".
func TestShouldInjectPlanModeReminder_FirstTurn_NoInject(t *testing.T) {
	if shouldInjectPlanModeReminder(1, 0) {
		t.Error("turn 1 should not get a reminder (it's the user's prompt turn)")
	}
}

func TestShouldInjectPlanModeReminder_FirstPostEntry(t *testing.T) {
	if !shouldInjectPlanModeReminder(2, 0) {
		t.Error("turn 2 with no prior reminder should inject")
	}
}

func TestShouldInjectPlanModeReminder_ThrottleWindow(t *testing.T) {
	// Reminder fired on turn 2. Throttle silences turns 3..6 (delta 1..4),
	// then unblocks on turn 7 (delta = planModeReminderInterval = 5).
	cases := []struct {
		turn   int
		want   bool
		reason string
	}{
		{3, false, "delta=1 within throttle window"},
		{4, false, "delta=2 within throttle window"},
		{5, false, "delta=3 within throttle window"},
		{6, false, "delta=4 within throttle window"},
		{7, true, "delta=5 hits interval, must inject"},
	}
	for _, c := range cases {
		got := shouldInjectPlanModeReminder(c.turn, 2)
		if got != c.want {
			t.Errorf("turn=%d lastReminderTurn=2 want=%v got=%v (%s)", c.turn, c.want, got, c.reason)
		}
	}
}

func TestShouldInjectPlanModeReminder_ResetOnReEntry(t *testing.T) {
	// After EnterPlanMode resets planModeReminderTurn to 0, the next
	// post-entry turn (whatever turn number it lands on) must inject —
	// the throttle from the previous plan-mode session must not silence
	// the first reminder of the new session.
	if !shouldInjectPlanModeReminder(10, 0) {
		t.Error("turn 10 with lastReminderTurn reset to 0 should inject (re-entry)")
	}
}

func TestShouldInjectPlanModeReminder_IntervalConstant(t *testing.T) {
	// Lock the interval at 5 — anything else changes the throttle behavior
	// the tests above assume.
	if planModeReminderInterval != 5 {
		t.Errorf("planModeReminderInterval changed: want=5 got=%d (update tests if intentional)", planModeReminderInterval)
	}
}

// --- shouldInjectPlanModeReminderForRun (Fix 2: mature-session turn-1 gate) ---

// TestShouldInjectPlanModeReminderForRun_FreshTurn1_NoInject verifies that
// turn 1 of a brand-new plan-mode session (small message count) does NOT
// get a reminder — the full prompt was just injected at plan-mode entry.
func TestShouldInjectPlanModeReminderForRun_FreshTurn1_NoInject(t *testing.T) {
	if shouldInjectPlanModeReminderForRun(1, 0, 2) {
		t.Error("turn=1, msgCount=2 should not inject (fresh session already has full prompt)")
	}
}

// TestShouldInjectPlanModeReminderForRun_MatureTurn1_Inject verifies that
// turn 1 of a mature plan-mode session (many messages) DOES get a reminder
// — the full prompt is far back in context and the model needs the rule.
func TestShouldInjectPlanModeReminderForRun_MatureTurn1_Inject(t *testing.T) {
	if !shouldInjectPlanModeReminderForRun(1, 0, 20) {
		t.Error("turn=1, msgCount=20 should inject (mature session, full prompt is far back)")
	}
}

// TestShouldInjectPlanModeReminderForRun_Turn2_Injects verifies that turn 2
// still fires (existing behavior preserved for multi-turn runs).
func TestShouldInjectPlanModeReminderForRun_Turn2_Injects(t *testing.T) {
	if !shouldInjectPlanModeReminderForRun(2, 0, 2) {
		t.Error("turn=2, lastTurn=0 should inject (first post-entry turn)")
	}
}

// TestShouldInjectPlanModeReminderForRun_IntervalRollover verifies that the
// interval throttle still fires on turn 7 when the last injection was turn 2.
func TestShouldInjectPlanModeReminderForRun_IntervalRollover(t *testing.T) {
	if !shouldInjectPlanModeReminderForRun(7, 2, 5) {
		t.Error("turn=7, lastTurn=2 should inject (delta=5 hits interval)")
	}
}

// TestShouldInjectPlanModeReminderForRun_ThrottleHolds verifies that turn 3
// is silenced when the last injection was turn 2 (delta < interval).
func TestShouldInjectPlanModeReminderForRun_ThrottleHolds(t *testing.T) {
	if shouldInjectPlanModeReminderForRun(3, 2, 5) {
		t.Error("turn=3, lastTurn=2 should be throttled (delta=1 < interval)")
	}
}

// TestShouldInjectPlanModeReminderForRun_ThresholdBoundary verifies the
// exact boundary of the mature-session threshold.
func TestShouldInjectPlanModeReminderForRun_ThresholdBoundary(t *testing.T) {
	// At threshold (not strictly greater), should NOT inject.
	if shouldInjectPlanModeReminderForRun(1, 0, planModeFirstTurnReminderThreshold) {
		t.Errorf("turn=1, msgCount=%d (exactly threshold) should not inject", planModeFirstTurnReminderThreshold)
	}
	// One above threshold, should inject.
	if !shouldInjectPlanModeReminderForRun(1, 0, planModeFirstTurnReminderThreshold+1) {
		t.Errorf("turn=1, msgCount=%d (threshold+1) should inject", planModeFirstTurnReminderThreshold+1)
	}
}

// --- Prompt content snapshot tests (Fix 1) ---

// TestBuildPlanModePrompt_ContainsForbiddenProseCallout asserts that the
// full plan-mode prompt includes the negative-example callout for anti-pattern
// phrases. Guards against silent regression of Fix 1.
func TestBuildPlanModePrompt_ContainsForbiddenProseCallout(t *testing.T) {
	result := buildPlanModePrompt("/tmp/test-plan.md", false, nil)
	phrases := []string{
		"Should I proceed",
		"ExitPlanMode",
		"Forbidden Prose Patterns",
	}
	for _, phrase := range phrases {
		if !strings.Contains(result, phrase) {
			t.Errorf("buildPlanModePrompt output missing expected phrase %q", phrase)
		}
	}
}

// TestBuildPlanModeSparseReminder_ContainsForbiddenProseCallout asserts that
// the sparse reminder also includes the one-liner anti-pattern callout.
func TestBuildPlanModeSparseReminder_ContainsForbiddenProseCallout(t *testing.T) {
	result := buildPlanModeSparseReminder("/tmp/test-plan.md")
	phrases := []string{
		"Should I proceed",
		"ExitPlanMode",
		"Forbidden as prose",
	}
	for _, phrase := range phrases {
		if !strings.Contains(result, phrase) {
			t.Errorf("buildPlanModeSparseReminder output missing expected phrase %q", phrase)
		}
	}
}
