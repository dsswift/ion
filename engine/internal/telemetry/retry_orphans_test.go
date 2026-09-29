package telemetry

import (
	"os"
	"path/filepath"
	"testing"
)

// A queue file is created under the engine's data root (ION_DATA_DIR), never
// the home ~/.ion: an engine with its own data root once wrote its queues into
// the operator's ~/.ion, where nothing ever drained them.
func TestRetryQueuePathFollowsDataDir(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)
	t.Setenv("HOME", t.TempDir())
	if got := retryQueuePath("http", "", "https://collector.example.org"); filepath.Dir(got) != dataDir {
		t.Fatalf("queue path = %s, want it under %s", got, dataDir)
	}
}

// The sweep removes a queue no collector in the process uses and keeps the
// live queue, quarantine files, and anything else in the directory.
func TestSweepOrphanRetryQueues(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	batch := `[{"events":[{"name":"run.complete"},{"name":"llm.call"}],"next_retry_at_ms":1,"enqueued_at_ms":1000}]`
	orphan := write("http-retry-0123456789abcdef.jsonl", batch)
	orphanHub := write("eventhub-retry-fedcba9876543210.jsonl", batch)
	live := write("http-retry-aaaaaaaaaaaaaaaa.jsonl", batch)
	quarantine := write("http-retry-0123456789abcdef.quarantine.jsonl", "{}\n")
	other := write("telemetry.jsonl", "{}\n")
	registerLiveRetryQueue(live)
	t.Cleanup(func() { liveRetryQueues.Delete(live) })

	if got := SweepOrphanRetryQueues(dir); got != 2 {
		t.Fatalf("removed %d, want 2", got)
	}
	for _, p := range []string{orphan, orphanHub} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("orphan %s still present", p)
		}
	}
	for _, p := range []string{live, quarantine, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s must be kept: %v", p, err)
		}
	}
}
