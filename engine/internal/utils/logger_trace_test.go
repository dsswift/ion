package utils

import (
	"testing"
)

// TestParseLevelTrace verifies "trace" parses to the lowest level constant.
func TestParseLevelTrace(t *testing.T) {
	if got := ParseLevel("trace"); got != LevelTrace {
		t.Errorf("ParseLevel(%q) = %v, want LevelTrace (%v)", "trace", got, LevelTrace)
	}
	// Case-insensitive.
	if got := ParseLevel("TRACE"); got != LevelTrace {
		t.Errorf("ParseLevel(%q) = %v, want LevelTrace (%v)", "TRACE", got, LevelTrace)
	}
}

// TestLevelOrdering asserts LevelTrace is strictly less than LevelDebug, which
// is strictly less than LevelInfo. Any breakage here would cause TRACE lines
// to be filtered out at DEBUG or higher levels.
func TestLevelOrdering(t *testing.T) {
	if LevelTrace >= LevelDebug {
		t.Errorf("LevelTrace (%d) must be < LevelDebug (%d)", LevelTrace, LevelDebug)
	}
	if LevelDebug >= LevelInfo {
		t.Errorf("LevelDebug (%d) must be < LevelInfo (%d)", LevelDebug, LevelInfo)
	}
	if LevelInfo >= LevelWarn {
		t.Errorf("LevelInfo (%d) must be < LevelWarn (%d)", LevelInfo, LevelWarn)
	}
	if LevelWarn >= LevelError {
		t.Errorf("LevelWarn (%d) must be < LevelError (%d)", LevelWarn, LevelError)
	}
}

// TestTraceLineSerializesLevelTRACE verifies that a Trace() call emits a
// "level":"TRACE" JSON field (not "DEBUG-4" or any other form).
func TestTraceLineSerializesLevelTRACE(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	// Trace is below Debug; must raise the filter to capture it.
	SetLevel(LevelTrace)

	Trace("trace-tag", "trace message")

	obj := readLastLine(t, dir)
	if got := obj["level"]; got != "TRACE" {
		t.Errorf("level = %v, want TRACE", got)
	}
	if got := obj["tag"]; got != "trace-tag" {
		t.Errorf("tag = %v, want trace-tag", got)
	}
	if got := obj["msg"]; got != "trace message" {
		t.Errorf("msg = %v, want 'trace message'", got)
	}
}

// TestINFODefaultSuppressesTRACE confirms that at the default INFO level a
// Trace() call produces no output (the level gate blocks it before writing).
func TestINFODefaultSuppressesTRACE(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	// Default level is INFO; explicitly assert that here.
	SetLevel(LevelInfo)

	// Install a test sink to detect whether Trace ever reaches logAtFull.
	var traceReceived bool
	SetTestSink(func(level LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if level == LevelTrace {
			traceReceived = true
		}
	})
	defer SetTestSink(nil)

	Trace("should-be-suppressed", "should not appear")

	if traceReceived {
		t.Error("Trace() reached the sink despite INFO min-level; level gate is broken")
	}
}

// TestSetLevelTraceEmitsTrace verifies that after SetLevel(LevelTrace),
// Trace() calls do pass the level gate and reach the sink.
func TestSetLevelTraceEmitsTrace(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)
	SetLevel(LevelTrace)

	var traceReceived bool
	SetTestSink(func(level LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if level == LevelTrace {
			traceReceived = true
		}
	})
	defer SetTestSink(nil)

	Trace("emit-tag", "should appear")

	if !traceReceived {
		t.Error("Trace() did not reach the sink after SetLevel(LevelTrace)")
	}
}
