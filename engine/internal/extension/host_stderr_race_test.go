package extension

import (
	"io"
	"sync"
	"testing"
)

// TestLaunchStderrDrain_NameSnapshotNoRace is the regression test for the
// stderr-goroutine name race (SHA 461acb0f). launchStderrDrain must snapshot
// h.name into a local BEFORE launching the goroutine. parseInitResult writes
// h.name (when the init message carries a name different from the manifest),
// so a goroutine that reads h.name directly races that write.
//
// This test launches the stderr drain and concurrently mutates h.name — the
// exact interleaving spawnAndInit produces when init runs while stderr is
// still being drained. Under `-race`, an in-goroutine read of h.name trips the
// detector; the pre-launch snapshot does not. Reverting launchStderrDrain to
// read h.name inside the goroutine makes this test fail under -race.
func TestLaunchStderrDrain_NameSnapshotNoRace(t *testing.T) {
	h := NewHost()
	h.name = "manifest-name"

	// Feed the drain a stream of lines so its goroutine is actively reading
	// (and, in the reverted version, actively reading h.name) while the main
	// goroutine writes h.name.
	pr, pw := io.Pipe()
	h.launchStderrDrain(pr)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Write several lines so the drain goroutine loops (each iteration is
		// where the reverted code reads h.name for the debug tag).
		for i := 0; i < 200; i++ {
			if _, err := pw.Write([]byte("stderr line\n")); err != nil {
				return
			}
		}
		pw.Close()
	}()

	// Concurrently mutate h.name — this is what parseInitResult does when the
	// init handshake reports a different name than the manifest.
	for i := 0; i < 200; i++ {
		h.name = "init-reported-name"
	}

	wg.Wait()
}
