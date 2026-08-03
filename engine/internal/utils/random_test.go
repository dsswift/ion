package utils

import (
	"regexp"
	"testing"
)

// W3C trace-context §3.2.2.3 (trace-id) and §3.2.2.4 (parent-id): both are
// lowercase-hex of fixed width, and the all-zero value of either is invalid —
// a consumer receiving one MUST ignore the whole traceparent.
var (
	traceIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanIDPattern  = regexp.MustCompile(`^[0-9a-f]{16}$`)
	allZeroTraceID = "00000000000000000000000000000000"
	allZeroSpanID  = "0000000000000000"
)

func TestNewTraceIDIsW3CValid(t *testing.T) {
	for i := 0; i < 100; i++ {
		got := NewTraceID()
		if !traceIDPattern.MatchString(got) {
			t.Fatalf("NewTraceID() = %q, want 32 lowercase hex chars", got)
		}
		if got == allZeroTraceID {
			t.Fatalf("NewTraceID() returned the all-zero trace-id, which W3C trace-context requires consumers to reject")
		}
	}
}

func TestRandomIDIsW3CValidSpanID(t *testing.T) {
	for i := 0; i < 100; i++ {
		got := RandomID()
		if !spanIDPattern.MatchString(got) {
			t.Fatalf("RandomID() = %q, want 16 lowercase hex chars", got)
		}
		if got == allZeroSpanID {
			t.Fatalf("RandomID() returned the all-zero span-id, which W3C trace-context requires consumers to reject")
		}
	}
}

// TestDegradedIDBytesNeverAllZero exercises the crypto/rand failure fallback
// directly. This is the arm that regressed: the previous implementation
// returned a literal all-zero string here, so a machine whose entropy source
// failed emitted trace IDs that every W3C-conformant consumer discards —
// correlation silently died at the exact moment something was already wrong.
//
// crypto/rand cannot be made to fail from a test without patching the package,
// so the fallback is exercised through the helper it delegates to. Against the
// pre-fix code this test does not compile (degradedIDBytes did not exist),
// which is the strongest possible form of "fails without the fix".
func TestDegradedIDBytesNeverAllZero(t *testing.T) {
	for _, size := range []int{8, 16} {
		b := make([]byte, size)
		degradedIDBytes(b)

		allZero := true
		for _, c := range b {
			if c != 0 {
				allZero = false
				break
			}
		}
		if allZero {
			t.Fatalf("degradedIDBytes(%d bytes) produced an all-zero value, which is invalid under W3C trace-context", size)
		}
	}
}

// TestDegradedIDBytesAreDistinct pins the other half of the contract: the
// fallback must still yield *different* IDs for different calls. An all-zero
// (or otherwise constant) fallback collapses every concurrent run onto one
// identifier, which is worse than useless for correlation — it actively
// merges unrelated traces.
func TestDegradedIDBytesAreDistinct(t *testing.T) {
	const n = 1000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		b := make([]byte, 16)
		degradedIDBytes(b)
		key := string(b)
		if _, dup := seen[key]; dup {
			t.Fatalf("degradedIDBytes produced a duplicate value after %d iterations; the fallback must stay locally unique", i)
		}
		seen[key] = struct{}{}
	}
}
