package utils

import (
	"sync"
	"time"
)

// Per-message rate limit for the engine logger.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// A misbehaving client writes one *message identity* at whatever rate it calls.
// Two such floods were found in one investigation: a desktop render loop issuing
// stop_session at roughly 450 calls per second (109,801 INFO lines for about 60
// real teardowns), and a relay token-refresh timer polling oidc_token 79,368
// times. Together they rotated every generation of engine.jsonl within the
// investigation window and destroyed the evidence they were being traced from.
// A flood is not merely noise: it deletes the observability the logging policy
// exists to guarantee.
//
// The call sites that caused those two are fixed at the root. This is the
// backstop, because the next one is not yet written and it must not be able to
// erase the record of itself.
//
// ── Why the key is (level, tag, msg) ────────────────────────────────────────
// Exact-line dedupe would have caught neither flood — both carried a varying
// key or expiry in fields, so no two lines were identical. What repeats is the
// *call site*, and msg is its stable identity: ADR-019 forbids interpolating
// values into msg, which is precisely what makes msg usable as a map key.
//
// ── Why this costs no observability ─────────────────────────────────────────
// The first logRateWindowLimit occurrences per window pass through verbatim, so
// a storm's onset is always fully recorded with its fields. Beyond that, lines
// are counted rather than dropped and the count is emitted as its own log line,
// so "this call site fired 26,431 times in ten seconds" is more legible than
// 26,431 copies of it were. Nothing is discarded silently (AGENTS.md § "No
// silent failures").
//
// LevelError is never limited: errors are rare by construction, they are what a
// post-mortem reads first, and an error storm is itself the signal.

const (
	// logRateWindow is the length of one accounting window.
	logRateWindow = 10 * time.Second

	// logRateWindowLimit is how many lines per message identity pass through
	// verbatim in one window. Far above any legitimate call site's steady rate,
	// far below the rate at which a loop threatens rotation.
	logRateWindowLimit = 50

	// logRateMaxKeys bounds the tracked identities. Reached only when a call
	// site interpolates a value into msg (which ADR-019 forbids); the cap keeps
	// that mistake from becoming an unbounded map inside the logger.
	logRateMaxKeys = 2048
)

type logRateWindowState struct {
	windowStart time.Time
	emitted     int
	suppressed  int64
}

var (
	logRateMu      sync.Mutex
	logRateWindows = map[logRateKey]*logRateWindowState{}
)

type logRateKey struct {
	level LogLevel
	tag   string
	msg   string
}

// admitLogLine accounts for one log line and reports whether the caller should
// write it, plus the withheld count of a window this call just closed (0 when
// none closed). The closed-window count is reported on the first line of the
// NEXT window, so a storm's tail is always accounted for by its successor.
//
// now is a parameter rather than a time.Now call so the accounting is testable
// without manipulating the clock.
func admitLogLine(level LogLevel, tag, msg string, now time.Time) (allow bool, closedSuppressed int64) {
	if level == LevelError {
		return true, 0
	}

	key := logRateKey{level: level, tag: tag, msg: msg}

	logRateMu.Lock()
	defer logRateMu.Unlock()

	state, ok := logRateWindows[key]
	if !ok {
		if len(logRateWindows) >= logRateMaxKeys {
			evictIdleLogRateKeys(now)
		}
		logRateWindows[key] = &logRateWindowState{windowStart: now, emitted: 1}
		return true, 0
	}

	if now.Sub(state.windowStart) >= logRateWindow {
		withheld := state.suppressed
		state.windowStart = now
		state.emitted = 1
		state.suppressed = 0
		return true, withheld
	}

	if state.emitted < logRateWindowLimit {
		state.emitted++
		return true, 0
	}

	state.suppressed++
	return false, 0
}

// evictIdleLogRateKeys drops identities whose window closed at least a full
// window ago. A key holding an outstanding withheld count is kept, because
// dropping it would discard the count its successor line must report.
//
// Caller holds logRateMu.
func evictIdleLogRateKeys(now time.Time) {
	for key, state := range logRateWindows {
		if state.suppressed == 0 && now.Sub(state.windowStart) >= 2*logRateWindow {
			delete(logRateWindows, key)
		}
	}
}

// LogSuppression is one withheld run of a single message identity.
type LogSuppression struct {
	Level      LogLevel
	Tag        string
	Msg        string
	Count      int64
	WindowSecs float64
}

// DrainLogSuppressions reports and clears every outstanding withheld count.
//
// Called on the shutdown path: a storm that stops just before exit has no
// successor line to carry its count, and losing it would be the one case where
// this limiter genuinely hid something.
func DrainLogSuppressions() []LogSuppression {
	logRateMu.Lock()
	defer logRateMu.Unlock()
	out := make([]LogSuppression, 0, len(logRateWindows))
	for key, state := range logRateWindows {
		if state.suppressed == 0 {
			continue
		}
		out = append(out, LogSuppression{
			Level:      key.level,
			Tag:        key.tag,
			Msg:        key.msg,
			Count:      state.suppressed,
			WindowSecs: logRateWindow.Seconds(),
		})
		state.suppressed = 0
	}
	return out
}

// ResetLogRateLimitForTest clears all accounting state between test cases.
func ResetLogRateLimitForTest() {
	logRateMu.Lock()
	defer logRateMu.Unlock()
	logRateWindows = map[logRateKey]*logRateWindowState{}
}
