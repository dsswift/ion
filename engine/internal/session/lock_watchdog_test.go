package session

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// TestLockWatchdog_ReportsHeldLockWithDump pins the diagnostic that did not
// exist when start_session sat behind a single m.mu holder for 3h44m: a hold
// past the threshold must be reported, and the report must carry a goroutine
// dump that names the holder.
func TestLockWatchdog_ReportsHeldLockWithDump(t *testing.T) {
	var mu sync.RWMutex

	type stall struct {
		name   string
		waited time.Duration
		dump   []byte
	}
	stalls := make(chan stall, 4)

	w := newLockWatchdog("test_lock", func() {
		mu.RLock()
		mu.RUnlock() //nolint:staticcheck // probe: acquire-and-release is the point
	})
	w.interval = 10 * time.Millisecond
	w.threshold = 50 * time.Millisecond
	w.onStall = func(name string, waited time.Duration, dump []byte) {
		stalls <- stall{name: name, waited: waited, dump: dump}
	}

	// Hold the write lock in a named function so the dump has a symbol the
	// operator could act on — that identification is the point of the dump.
	release := make(chan struct{})
	held := make(chan struct{})
	go holdLockForTest(&mu, held, release)
	<-held

	w.start()
	defer w.stop()

	var got stall
	select {
	case got = <-stalls:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("watchdog did not report a lock held past the threshold")
	}

	if got.name != "test_lock" {
		t.Errorf("stall name = %q, want %q", got.name, "test_lock")
	}
	if got.waited < w.threshold {
		t.Errorf("reported wait %v shorter than threshold %v", got.waited, w.threshold)
	}
	if !strings.Contains(string(got.dump), "holdLockForTest") {
		t.Errorf("goroutine dump does not name the lock holder; dump head:\n%s",
			string(got.dump[:min(len(got.dump), 2000)]))
	}

	close(release)
}

// TestLockWatchdog_HealthyLockNeverReports guards against the watchdog
// crying wolf: a lock that is only ever held briefly must produce no report,
// because an ERROR per probe would be noise in every healthy engine.
func TestLockWatchdog_HealthyLockNeverReports(t *testing.T) {
	var mu sync.RWMutex
	reports := make(chan struct{}, 4)

	w := newLockWatchdog("healthy_lock", func() {
		mu.RLock()
		mu.RUnlock() //nolint:staticcheck // probe: acquire-and-release is the point
	})
	w.interval = 5 * time.Millisecond
	w.threshold = 50 * time.Millisecond
	w.onStall = func(string, time.Duration, []byte) { reports <- struct{}{} }

	w.start()

	// Churn the write lock the way real dispatch does: many short holds.
	stopChurn := make(chan struct{})
	churnDone := make(chan struct{})
	go func() {
		defer close(churnDone)
		for {
			select {
			case <-stopChurn:
				return
			default:
				mu.Lock()
				mu.Unlock() //nolint:staticcheck // churn: hold-and-release is the point
				time.Sleep(time.Millisecond)
			}
		}
	}()

	time.Sleep(300 * time.Millisecond)
	close(stopChurn)
	<-churnDone
	w.stop()

	if len(reports) != 0 {
		t.Fatalf("watchdog reported %d stalls on a healthy lock", len(reports))
	}
}

// TestLockWatchdog_StopWithoutStart asserts stop() on a never-started
// watchdog returns instead of blocking forever on a doneCh nobody closes.
// Shutdown calls stop() unconditionally, so this is the path a Manager that
// failed early would take.
func TestLockWatchdog_StopWithoutStart(t *testing.T) {
	w := newLockWatchdog("unstarted", func() {})
	done := make(chan struct{})
	go func() {
		w.stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop() on an unstarted watchdog blocked")
	}
}

// holdLockForTest holds mu's write lock until release is closed. A named
// function so the goroutine dump assertion has a stable symbol to match.
func holdLockForTest(mu *sync.RWMutex, held chan<- struct{}, release <-chan struct{}) {
	mu.Lock()
	defer mu.Unlock()
	close(held)
	<-release
}
