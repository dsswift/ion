package utils

import (
	"testing"
	"time"
)

// Each assertion here fails against an unlimited logger: without the limiter
// every call is admitted, so `allow` is never false and no withheld count is
// ever reported.

func TestAdmitLogLineAllowsUpToWindowLimit(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < logRateWindowLimit; i++ {
		allow, withheld := admitLogLine(LevelInfo, "session", "stopsession", now)
		if !allow {
			t.Fatalf("line %d of the window was withheld; the onset of a storm must be recorded verbatim", i+1)
		}
		if withheld != 0 {
			t.Fatalf("line %d reported %d withheld with no closed window", i+1, withheld)
		}
	}

	allow, _ := admitLogLine(LevelInfo, "session", "stopsession", now)
	if allow {
		t.Fatal("line past the window limit was admitted; the limiter is not engaged")
	}
}

func TestAdmitLogLineReportsWithheldCountOnNextWindow(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	now := time.Unix(1_700_000_000, 0)
	const storm = 500
	for i := 0; i < storm; i++ {
		admitLogLine(LevelInfo, "session", "stopsession", now)
	}

	// The withheld run is reported by the first line of the next window, so the
	// count is never lost — it is aggregated into one legible line.
	allow, withheld := admitLogLine(LevelInfo, "session", "stopsession", now.Add(logRateWindow))
	if !allow {
		t.Fatal("first line of a fresh window was withheld")
	}
	if want := int64(storm - logRateWindowLimit); withheld != want {
		t.Fatalf("withheld count = %d, want %d", withheld, want)
	}

	// And it is reported exactly once.
	if _, again := admitLogLine(LevelInfo, "session", "stopsession", now.Add(logRateWindow)); again != 0 {
		t.Fatalf("withheld count reported twice (%d on the second read)", again)
	}
}

func TestAdmitLogLineKeysOnCallSiteNotWholeLine(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	// Distinct messages have independent budgets: one storming call site must
	// not silence an unrelated one.
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < logRateWindowLimit+10; i++ {
		admitLogLine(LevelInfo, "session", "stopsession", now)
	}
	if allow, _ := admitLogLine(LevelInfo, "session", "startsession", now); !allow {
		t.Fatal("an unrelated message identity was suppressed by another's storm")
	}
	// Same msg under a different tag is also a different call site.
	if allow, _ := admitLogLine(LevelInfo, "server", "stopsession", now); !allow {
		t.Fatal("same msg under a different tag shares a budget; the key must include tag")
	}
}

func TestAdmitLogLineNeverLimitsErrors(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	// Errors are what a post-mortem reads first, and an error storm is itself
	// the signal. Never withhold one.
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < logRateWindowLimit*10; i++ {
		if allow, _ := admitLogLine(LevelError, "session", "run failed", now); !allow {
			t.Fatalf("ERROR line %d was withheld", i+1)
		}
	}
}

func TestDrainLogSuppressionsReportsTheTailOfAStorm(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	now := time.Unix(1_700_000_000, 0)
	const storm = 200
	for i := 0; i < storm; i++ {
		admitLogLine(LevelInfo, "server.oidc", "client token issued", now)
	}

	// A storm that stops with no successor line still has its count reported,
	// via the shutdown drain.
	drained := DrainLogSuppressions()
	if len(drained) != 1 {
		t.Fatalf("drained %d suppressions, want 1", len(drained))
	}
	if want := int64(storm - logRateWindowLimit); drained[0].Count != want {
		t.Fatalf("drained count = %d, want %d", drained[0].Count, want)
	}
	if drained[0].Msg != "client token issued" || drained[0].Tag != "server.oidc" {
		t.Fatalf("drained the wrong identity: %+v", drained[0])
	}

	// Draining clears, so a second drain does not double-report.
	if again := DrainLogSuppressions(); len(again) != 0 {
		t.Fatalf("second drain returned %d suppressions, want 0", len(again))
	}
}

func TestAdmitLogLineEvictsIdleKeys(t *testing.T) {
	ResetLogRateLimitForTest()
	t.Cleanup(ResetLogRateLimitForTest)

	// A call site that interpolates a value into msg (which ADR-019 forbids)
	// would otherwise grow the map without bound. The cap holds.
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < logRateMaxKeys+200; i++ {
		admitLogLine(LevelInfo, "leaky", string(rune('a'+i%26))+time.Duration(i).String(), now.Add(3*logRateWindow*time.Duration(i)))
	}
	logRateMu.Lock()
	size := len(logRateWindows)
	logRateMu.Unlock()
	if size > logRateMaxKeys {
		t.Fatalf("tracked %d keys, cap is %d", size, logRateMaxKeys)
	}
}
